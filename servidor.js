// servidor de la pestaña: sin dependencias, para poder cargar apkc.wasm como módulo y usar
// OPFS. No es un servicio ni un backend del build: es lo mínimo para que el navegador trate
// la página como un origen seguro (file:// no deja importar workers ni crear access handles
// sincrónicos) y para que el binario wasm no acabe versionado en el repo.
//
// uso: sh -c 'APKC_WASM=$PREFIX/tmp/apkc-wasm.wasm node servidor.js [puerto]'
//   APKC_WASM   el binario wasm, construido con GOOS=js GOARCH=wasm (obligatorio)
//   GOROOT      de donde se saca wasm_exec.js (por defecto `go env GOROOT`)
//
// lo que sirve y por qué:
//   /                 studio/ (esta carpeta)
//   /apkc.wasm        el binario, con su mime correcto
//   /wasm_exec.js     el del GOROOT de quien corre: no se versiona (regla 2 del repo)
//   /android-jar      el android.jar del SDK local, si está instalado; no se versiona
//   /android-jar-info JSON con versión y tamaño del jar que encuentra (para la pestaña)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
// SITIO_DIR permite servir el paqueta empaquetado por tools/sitio.sh en vez del árbol de desarrollo.
// SIN_CABECERAS=1 simula un host estático que no pone COOP/COEP (Surge): la página tiene que
// conseguirlos ella sola con el service worker y una recarga.
const RAIZ_SITIO = process.env.SITIO_DIR || AQUI;
const PUERTO = Number(process.argv[2] || process.env.STUDIO_SERVIDOR_PORT || 8787);
const WASM = process.env.APKC_WASM || "";
let GOROOT = process.env.GOROOT || "";
if (!GOROOT) {
  try { GOROOT = execSync("go env GOROOT", { encoding: "utf8" }).trim(); } catch (e) { GOROOT = ""; }
}
const EJECUTA = path.join(GOROOT, "lib", "wasm", "wasm_exec.js");

// El android.jar no se puede versionar (26 MB y licencia de la SDK), pero sí se puede leer del
// SDK que ya está instalado en la máquina. Se busca en ANDROID_JAR, ANDROID_HOME, ANDROID_SDK_ROOT
// y ~/Android, **prefiriendo android-34**: es la API con la que la pestaña compila por defecto y la
// única cuya tabla de recursos es densa (el enlazador de Go no lee las tablas ralas de 35 y 36).
// Después, de la más nueva a la más vieja. La página lo pide a su propio origen y lo guarda en
// OPFS: no sale ni una petición a Google desde la pestaña.
function jarDelSdk() {
  if (process.env.ANDROID_JAR && fs.existsSync(process.env.ANDROID_JAR)) return process.env.ANDROID_JAR;
  const raices = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.env.HOME ? path.join(process.env.HOME, "Android") : ""].filter(Boolean);
  const PREFERIDA = 34;
  for (const raiz of raices) {
    const plataformas = path.join(raiz, "platforms");
    if (!fs.existsSync(plataformas)) continue;
    let candidatas;
    try {
      candidatas = fs.readdirSync(plataformas)
        .map((nombre) => ({ nombre, version: Number((/^android-(\d+)$/.exec(nombre) || [])[1]) }))
        .filter((x) => Number.isInteger(x.version))
        .sort((a, b) => (Number(b.version === PREFERIDA) - Number(a.version === PREFERIDA)) ||
          (b.version - a.version));
    } catch (e) { continue; }
    for (const c of candidatas) {
      const jar = path.join(plataformas, c.nombre, "android.jar");
      if (fs.existsSync(jar)) return jar;
    }
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".apk": "application/vnd.android.package-archive",
  ".aab": "application/octet-stream", ".idsig": "application/octet-stream",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

// El service worker de desarrollo. Se genera aquí para no versionar un fichero más ni depender de
// la sustitución de marcadores de tools/sitio.sh. Mismo contrato que sw.js (shell precacheado,
// COOP/COEP en todas las respuestas del mismo origen, jar/keystores/deps fuera de la caché) con
// dos diferencias deliberadas: la versión sale del wasm, así que cada reconstrucción instala una
// caché nueva; y el fetch es red-primero para todo —también el wasm y las imágenes—, de modo que
// lo recién construido nunca se sirve desde una copia vieja. La caché sigue siendo el respaldo
// que necesita el modo sin red de `prueba-pestana.js`/`e2e.sh`.
function serviceWorkerDeDesarrollo() {
  const est = fs.statSync(WASM);
  // tamaño + mtime: dos builds con el mismo tamaño pero otro contenido cambian de mtime, y una
  // reconstrucción cualquiera invalida la caché sin tocar el código del worker.
  const version = `apkc-studio-dev-${est.size}-${Math.floor(est.mtimeMs)}`;
  return String.raw`// service worker de desarrollo de apkc studio: generado por servidor.js, no se versiona.
const VERSION = "${version}";
const CACHE = VERSION;

const CABECERAS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};
// Sin Content-Security-Policy a propósito: en desarrollo index.html lleva <script> inline sin
// hash y tools/sitio.sh solo sustituye el marcador __APKC_CSP__ al publicar. El resto de
// cabeceras del worker real sí van, y siempre al servir: las respuestas de Cache no las traen.

function conCabeceras(respuesta) {
  if (!respuesta) return respuesta;
  const cabeceras = new Headers(respuesta.headers);
  for (const nombre of Object.keys(CABECERAS)) cabeceras.set(nombre, CABECERAS[nombre]);
  return new Response(respuesta.body, {
    status: respuesta.status, statusText: respuesta.statusText, headers: cabeceras,
  });
}

// Todo lo que la página importa o pinta. Lo que no exista en el árbol de desarrollo se omite
// sin romper la instalación, como en el worker real.
const SHELL = [
  "./", "./index.html", "./style.css", "./manifest.webmanifest",
  "./main.js", "./offline.js", "./temas.js",
  "./app.js", "./pestana.js", "./vistas.js", "./diagnostico.js", "./diagnostico-vivo.js",
  "./historial.js", "./fusion.js", "./vista-previa.js", "./vista-xml.js", "./previa-panel.js",
  "./layout-editor.js", "./autocompletado.js", "./autocompletado-datos.js", "./xml-editor.js",
  "./recursos-proyecto.js", "./deps.js", "./ultima-apk.js", "./hospedador.js", "./fs-fragmento.js",
  "./consola.js", "./editor.js", "./busqueda.js", "./ajustes.js", "./proyecto.js", "./paleta.js",
  "./idioma.js", "./tt.js", "./reparar.js", "./muestras.json",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./apkc.wasm", "./wasm_exec.js",
];

const SOLO_RED = [
  /^\/android-jar/, /^\/keystore/, /^\/apk-ejemplo$/, /^\/aab-ejemplo$/,
  /^\/apkc-test\.wasm$/, /^\/deps-index\.json$/, /^\/deps\//,
];

self.addEventListener("install", (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const ruta of SHELL) await cache.add(ruta).catch(() => { /* falta o no se pudo: se salta */ });
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(caches.keys().then((claves) => {
    // Se conserva la caché actual y la anterior: caches.match busca en todas, así que la vieja
    // sirve de respaldo si la instalación nueva se queda a medias o no hay red.
    const versiones = claves.filter((k) => k.indexOf("apkc-studio-") === 0).sort();
    const conservar = new Set([CACHE]);
    if (versiones.length > 1) conservar.add(versiones[versiones.length - 2]);
    return Promise.all(claves.filter((k) => !conservar.has(k)).map((k) => caches.delete(k)));
  }).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (evento) => {
  const peticion = evento.request;
  if (peticion.method !== "GET") return;
  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;
  if (SOLO_RED.some((patron) => patron.test(url.pathname))) return;
  // ?directo pide la red explícitamente, igual que en el worker real.
  if (url.searchParams.has("directo")) {
    evento.respondWith(fetch(peticion).then(conCabeceras));
    return;
  }

  // Red primero para todo, wasm incluido: la pestaña tiene que ver lo que acaba de construir.
  // Si la red falla, la copia cacheada (instalada o guardada en una carga anterior) responde.
  evento.respondWith(
    fetch(peticion).then((respuesta) => {
      if (respuesta && respuesta.ok) {
        const copia = respuesta.clone();
        const clave = peticion.mode === "navigate" ? "./index.html" : peticion;
        caches.open(CACHE).then((cache) => cache.put(clave, copia)).catch(() => {});
      }
      return conCabeceras(respuesta);
    }).catch(() => caches.match(peticion, { ignoreSearch: true })
      .then((cacheada) => cacheada || caches.match("./index.html"))
      .then((respuesta) => conCabeceras(respuesta)))
  );
});
`;
}

if (!WASM || !fs.existsSync(WASM)) {
  console.error("falta APKC_WASM apuntando a un binario wasm construido, por ejemplo:");
  console.error("  sh -c 'cd ../apkc && GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -o \"$PREFIX/tmp/apkc-wasm.wasm\" .'");
  process.exit(2);
}
if (!fs.existsSync(EJECUTA)) {
  console.error("no hay wasm_exec.js en " + EJECUTA + " (GOROOT mal); con GOROOT= lo señalas tú");
  process.exit(2);
}

const servidor = http.createServer((req, res) => {
  // el aislamiento es lo que abre OPFS (createSyncAccessHandle); sin estas dos cabeceras la página
  // carga, el worker arranca y el fs se cae en el primer handle. En modo SIN_CABECERAS se omiten
  // a propósito para comprobar que el service worker de la propia página las pone.
  if (!process.env.SIN_CABECERAS) {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
  }
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return void res.end("método no permitido\n");
  }
  let ruta;
  try { ruta = decodeURIComponent((req.url || "/").split("?")[0]); }
  catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return void res.end("URL mal formada\n");
  }
  let fichero = null, cuerpo = null;
  // Desarrollo: el service worker de producción cachea el wasm y lleva una versión fija, así que
  // una reconstrucción local nunca llegaba a la pestaña (medido: la página pedía el hash nuevo y
  // el worker servía el de la primera build). Aquí se sirve un worker con el mismo contrato que
  // `sw.js` —precarga el shell, pone COOP/COEP en todas las respuestas y deja fuera el jar, los
  // keystores y deps— pero con la versión sacada del binario y red-primero para todo: el wasm
  // recién construido siempre se sirve nuevo y la caché queda como respaldo sin red.
  // Define SW_REAL=1 para probar el service worker verdadero.
  if (ruta === "/sw.js" && !process.env.SW_REAL) {
    const script = serviceWorkerDeDesarrollo();
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    return void res.end(req.method === "HEAD" ? undefined : script);
  }
  if (ruta === "/apkc.wasm") {
    fichero = WASM;
  } else if (ruta === "/wasm_exec.js") {
    fichero = EJECUTA;
  } else if (ruta === "/apkc-test.wasm" && process.env.APKC_TEST_WASM && fs.existsSync(process.env.APKC_TEST_WASM)) {
    fichero = process.env.APKC_TEST_WASM;                  // la suite, conducida desde la pestaña
  } else if (ruta === "/apk-ejemplo" && process.env.APK_EJEMPLO && fs.existsSync(process.env.APK_EJEMPLO)) {
    fichero = process.env.APK_EJEMPLO;                     // solo para la prueba de la pestaña
  } else if (ruta === "/aab-ejemplo" && process.env.AAB_EJEMPLO && fs.existsSync(process.env.AAB_EJEMPLO)) {
    fichero = process.env.AAB_EJEMPLO;                     // idem: el .aab de la prueba
  } else if (ruta === "/keystore-ejemplo" && process.env.KS_EJEMPLO && fs.existsSync(process.env.KS_EJEMPLO)) {
    fichero = process.env.KS_EJEMPLO;                      // idem: el keystore de debug del sitio
  } else if (ruta === "/keystore-release" && process.env.KS_RELEASE && fs.existsSync(process.env.KS_RELEASE)) {
    fichero = process.env.KS_RELEASE;                      // el de release, de usar y tirar: contraseña y alias conocidos
  } else if (ruta === "/android-jar-info") {
    const jar = jarDelSdk();
    const version = jar ? Number((/android-(\d+)/.exec(path.basename(path.dirname(jar))) || [])[1]) : null;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return void res.end(JSON.stringify({
      disponible: !!jar, version, bytes: jar ? fs.statSync(jar).size : 0,
    }));
  } else if (ruta === "/android-jar") {
    const jar = jarDelSdk();
    if (!jar) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return void res.end("no hay android.jar del SDK local; usa el selector de fichero o tools/entorno.sh jar\n");
    }
    fichero = jar;                                          // el jar del SDK, por su origen: la pestaña no habla con nadie más
  } else {
    const dentro = path.normalize(path.join(RAIZ_SITIO, ruta === "/" ? "index.html" : ruta));
    // startsWith(RAIZ_SITIO) dejaría pasar un hermano como /studio-viejo; con el separador, no
    if (dentro !== RAIZ_SITIO && !dentro.startsWith(RAIZ_SITIO + path.sep)) {
      res.writeHead(403); return void res.end("fuera\n");
    }
    if (!fs.existsSync(dentro) || fs.statSync(dentro).isDirectory()) {
      res.writeHead(404); return void res.end("no existe\n");
    }
    fichero = dentro;
  }
  try { cuerpo = fs.readFileSync(fichero); }
  catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return void res.end("no se pudo leer " + path.basename(fichero) + "\n");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(fichero)] || "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : cuerpo);
});

servidor.listen(PUERTO, "127.0.0.1", () => {
  const jar = jarDelSdk();
  console.log(`apkc-studio en http://127.0.0.1:${PUERTO}/ (wasm: ${WASM})`);
  console.log(jar
    ? `android.jar del SDK local: ${jar} (${fs.statSync(jar).size} bytes)`
    : "sin android.jar local: usa el selector de fichero o tools/entorno.sh jar");
});
