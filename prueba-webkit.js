// WebKit (el motor de Safari) sobre el sitio empaquetado. Corre en GitHub Actions con Playwright;
// no es Safari real, pero comprueba el mismo motor en un runner limpio (§181).
// Uso: SITIO_DIR=../sitio node prueba-webkit.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sitio = path.resolve(process.env.SITIO_DIR || path.join(__dirname, "..", "sitio"));
const PUERTO = Number(process.env.SITIO_SERVIDOR_PORT || 8803);
const URL_BASE = `http://127.0.0.1:${PUERTO}/index.html`;

let chromium;
try {
  ({ webkit: chromium } = await import("playwright"));
} catch (e) {
  console.log("sin playwright: se omite la prueba de WebKit (solo corre en CI con la dependencia instalada)");
  process.exit(0);
}

let fallos = 0;
const comprueba = (nombre, cond, detalle) => {
  if (cond) console.log("  ok   " + nombre);
  else { fallos++; console.log("  FALLA " + nombre + (detalle ? " — " + detalle : "")); }
};

const servidor = spawn(process.execPath, [path.join(__dirname, "servidor-estatico.js"), String(PUERTO)], {
  cwd: __dirname, env: { ...process.env, SITIO_DIR: sitio }, stdio: "ignore",
});
const navegador = await chromium.launch({ headless: true });
try {
  const contexto = await navegador.newContext({ viewport: { width: 1280, height: 800 } });
  const pagina = await contexto.newPage();
  const externas = [];
  pagina.on("request", (r) => {
    try { if (new URL(r.url()).origin !== new URL(URL_BASE).origin) externas.push(r.url()); }
    catch (e) { externas.push(r.url()); }
  });
  await pagina.goto(URL_BASE);
  await pagina.waitForFunction(() => crossOriginIsolated && !!navigator.serviceWorker.controller,
    null, { timeout: 30000 });
  comprueba("WebKit aísla el origen con el service worker", true);
  const listo = await pagina.evaluate(() => !!document.getElementById("codigo"));
  comprueba("la página carga en WebKit", listo);
  comprueba("ninguna petición sale del origen", externas.length === 0, JSON.stringify(externas.slice(0, 3)));
} catch (e) {
  fallos++;
  console.log("  FALLA: " + (e && e.message ? e.message : String(e)));
} finally {
  await navegador.close();
  servidor.kill("SIGKILL");
}
console.log(fallos ? "webkit: " + fallos + " problemas" : "webkit: todo en orden");
process.exit(fallos ? 1 : 0);
