// Servidor estático de desarrollo: sirve SOLO el paquete de tools/sitio.sh, sin las rutas de
// prueba de servidor.js y sin COOP/COEP. Es como Surge: la página tiene que conseguir el
// aislamiento ella sola con el service worker y una recarga. No se publica: tools/sitio.sh lo
// quita del paquete.
//
// uso: SITIO_DIR=../sitio node servidor-estatico.js [puerto]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.env.SITIO_DIR || path.join("..", "sitio"));
const PUERTO = Number(process.argv[2] || process.env.SITIO_SERVIDOR_PORT || 8792);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const servidor = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return void res.end("metodo no permitido\n");
  }
  let ruta;
  try { ruta = decodeURIComponent((req.url || "/").split("?")[0]); }
  catch (e) { res.writeHead(400); return void res.end("URL mal formada\n"); }
  const fichero = path.normalize(path.join(DIR, ruta === "/" ? "index.html" : ruta));
  if (fichero !== DIR && !fichero.startsWith(DIR + path.sep)) {
    res.writeHead(403); return void res.end("fuera\n");
  }
  if (!fs.existsSync(fichero) || fs.statSync(fichero).isDirectory()) {
    res.writeHead(404); return void res.end("no existe\n");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(fichero)] || "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : fs.readFileSync(fichero));
});

servidor.listen(PUERTO, "127.0.0.1", () => {
  console.log(`sitio estático (sin cabeceras ni endpoints) en http://127.0.0.1:${PUERTO}/ desde ${DIR}`);
});
