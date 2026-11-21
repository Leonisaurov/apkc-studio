// Service worker de apkc studio: cachea el shell para recargar sin red y, en hosts que no dejan
// fijar cabeceras de servidor (Surge, GitHub Pages), añade COOP/COEP a TODAS las respuestas del
// mismo origen, incluidas las que salen de la caché y la navegación inicial. Sin esas dos
// cabeceras no hay crossOriginIsolated, no hay createSyncAccessHandle y el fs que exige Go no
// arranca. index.html registra este worker y se recarga una vez cuando la página no está aislada.
const VERSION = "apkc-studio-__APKC_VERSION__";
const CACHE = VERSION;

const CABECERAS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  // En desarrollo se permite inline; tools/sitio.sh sustituye el marcador por los hashes SHA-256
  // de los <script> inline de index.html (§172), para que la página publicada no necesite
  // 'unsafe-inline'. Surge no deja fijar cabeceras, así que el SW las añade también aquí.
  "Content-Security-Policy": "__APKC_CSP__",
};

// Las respuestas que vienen de Cache no traen las cabeceras que pusimos al guardarlas: se añaden
// siempre al servir, no al cachear. Las peticiones de otro origen se descartan antes (no se pueden
// reescribir respuestas opacas), y la página no hace ninguna (regla 4 del repo).
function conCabeceras(respuesta) {
  if (!respuesta) return respuesta;
  const cabeceras = new Headers(respuesta.headers);
  for (const [nombre, valor] of Object.entries(CABECERAS)) cabeceras.set(nombre, valor);
  return new Response(respuesta.body, {
    status: respuesta.status, statusText: respuesta.statusText, headers: cabeceras,
  });
}

// No cachea el jar del SDK, los keystores ni el proyecto (OPFS no pasa por HTTP). El binario wasm
// y wasm_exec.js sí se intentan cachear en la instalación; si el host no los sirve, se cachean la
// primera vez que se usan.
const SHELL = [
  "./", "./index.html", "./style.css", "./main.js", "./offline.js",
  "./app.js", "./historial.js", "./fusion.js", "./pestana.js", "./vistas.js",
  "./diagnostico.js", "./temas.js", "./apkc.wasm", "./wasm_exec.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
];

const SOLO_RED = [
  /^\/android-jar(\/|$)/, /^\/android-jar-info$/, /^\/keystore/,
  /^\/apk-ejemplo$/, /^\/aab-ejemplo$/, /^\/apkc-test\.wasm$/,
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((ruta) =>
        cache.add(ruta).catch(() => { /* un estático que falte no rompe la instalación */ }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (evento) => {
  const peticion = evento.request;
  if (peticion.method !== "GET") return;
  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;
  if (SOLO_RED.some((patron) => patron.test(url.pathname))) return;

  // El shell y los módulos van a la red primero: así una actualización no se queda servida por
  // una caché vieja. La caché es el respaldo para cuando no hay red. El wasm y las imágenes sí
  // son cache-first porque son grandes y cambian poco.
  const redPrimero = peticion.mode === "navigate" || /\.(?:html|js|css|json)$/.test(url.pathname);
  if (redPrimero) {
    evento.respondWith(
      fetch(peticion)
        .then((respuesta) => {
          if (respuesta && respuesta.ok) {
            const copia = respuesta.clone();
            const clave = peticion.mode === "navigate" ? "./index.html" : peticion;
            caches.open(CACHE).then((cache) => cache.put(clave, copia)).catch(() => {});
          }
          return conCabeceras(respuesta);
        })
        .catch(() => caches.match(peticion, { ignoreSearch: true })
          .then((cacheada) => cacheada || caches.match("./index.html"))
          .then((respuesta) => conCabeceras(respuesta)))
    );
    return;
  }

  evento.respondWith(
    caches.match(peticion, { ignoreSearch: true }).then((cacheada) => {
      if (cacheada) return conCabeceras(cacheada);
      return fetch(peticion).then((respuesta) => {
        if (respuesta && respuesta.ok) {
          const copia = respuesta.clone();
          caches.open(CACHE).then((cache) => cache.put(peticion, copia)).catch(() => {});
        }
        return conCabeceras(respuesta);
      });
    })
  );
});
