// Prueba del sitio publicado, o de una copia local servida SIN cabeceras ni endpoints de desarrollo.
// Comprueba lo que solo se ve en un host estático: el service worker pone COOP/COEP, la página se
// recarga sola, el android.jar entra por el selector de fichero (sin /android-jar) y el apk que
// sale de la pestaña verifica con apksigner por fuera. Cero peticiones fuera del origen.
//
// uso local:  SITIO_DIR=../sitio ANDROID_JAR=/.../android.jar APKSIGNER=/.../apksigner node prueba-sitio.js
// en vivo:    SITIO_URL=https://apkc-studio.surge.sh/ ... node prueba-sitio.js
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || "chromium-browser";
const URL_SITIO = process.env.SITIO_URL || "";
const PUERTO = Number(process.env.SITIO_SERVIDOR_PORT || 8792);
const CDP = process.env.SITIO_PORT || "9346";
const URL_BASE = URL_SITIO || `http://127.0.0.1:${PUERTO}/`;
const ORIGEN = new URL(URL_BASE).origin;
const JAR = process.env.ANDROID_JAR || "";
const APKSIGNER = process.env.APKSIGNER || "";
const TMP = process.env.PREFIX ? process.env.PREFIX + "/tmp" : os.tmpdir();
const SALIDA = process.env.SITIO_APK || path.join(TMP, "sitio-compilado.apk");

let hechos = 0, fallos = 0;
function comprueba(nombre, condicion, detalle) {
  if (condicion) { hechos++; console.log("  ok   " + nombre + (detalle ? " — " + detalle : "")); }
  else { fallos++; console.log("  FALLA " + nombre + (detalle ? " — " + detalle : "")); }
}
function falta(que) {
  console.error("falta " + que + ": esta prueba no puede jurar nada sin él");
  process.exit(2);
}
if (!JAR || !fs.existsSync(JAR)) falta("ANDROID_JAR con el android.jar del SDK");
if (!APKSIGNER || !fs.existsSync(APKSIGNER)) falta("APKSIGNER con el apksigner de build-tools");

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let servidor = null;
if (!URL_SITIO) {
  const sitio = path.resolve(process.env.SITIO_DIR || path.join(__dirname, "..", "sitio"));
  servidor = spawn(process.execPath, [path.join(__dirname, "servidor-estatico.js"), String(PUERTO)], {
    cwd: __dirname, env: { ...process.env, SITIO_DIR: sitio }, stdio: ["ignore", "pipe", "pipe"],
  });
  let arranque = "";
  servidor.stderr.on("data", (d) => { arranque += d; });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(URL_BASE); if (r.ok) break; } catch (e) { /* aún no escucha */ }
    await esperar(200);
  }
  if (!arranque && !fs.existsSync(path.join(sitio, "index.html"))) {
    console.error("no hay index.html en " + sitio);
    process.exit(2);
  }
}

const PERFIL = path.join(TMP, "sitio-chrome-perfil");
fs.rmSync(PERFIL, { recursive: true, force: true });
const navegador = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
  "--disable-dev-shm-usage", "--remote-allow-origins=*",
  "--no-first-run", "--disable-extensions", "--disable-sync",
  "--user-data-dir=" + PERFIL, "--remote-debugging-port=" + CDP, URL_BASE,
], { stdio: ["ignore", "pipe", "pipe"] });
let salidaNavegador = "";
navegador.stderr.on("data", (d) => { salidaNavegador += d; });

function apagar() {
  try { navegador.kill("SIGKILL"); } catch (e) { /* */ }
  try { servidor && servidor.kill("SIGKILL"); } catch (e) { /* */ }
}
process.on("exit", apagar);

async function conductor() {
  let objetivo = null;
  for (let i = 0; i < 90; i++) {
    try {
      const lista = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
      objetivo = lista.find((t) => t.type === "page" && t.url.startsWith(ORIGEN));
      if (objetivo) break;
    } catch (e) { /* aún no escucha */ }
    await esperar(500);
  }
  if (!objetivo) throw new Error("chromium no subió el debugger:\n" + salidaNavegador.slice(0, 500));
  const ws = new WebSocket(objetivo.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket falló")); });
  let id = 0;
  const colas = new Map();
  const peticiones = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && colas.has(m.id)) { colas.get(m.id)(m); colas.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") peticiones.push(m.params.request.url);
  });
  const exec = (method, params) => new Promise((res) => {
    const n = ++id;
    colas.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const evaluarPlazo = async (expression) => {
    const r = await exec("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error(String((ex.exception && ex.exception.description) || ex.text).slice(0, 400));
    return r.result.result.value;
  };
  const evaluar = (expression) => Promise.race([
    evaluarPlazo(expression),
    esperar(180000).then(() => { throw new Error("plazo agotado en: " + expression.slice(0, 70)); }),
  ]);
  await exec("Network.enable");
  await exec("Runtime.enable");
  for (let i = 0; i < 100; i++) {
    try { if (await evaluar(`!!document.getElementById("codigo") && typeof correr === "function"`)) break; }
    catch (e) { /* aún carga */ }
    await esperar(300);
  }
  return { exec, evaluar, peticiones };
}

(async () => {
  const { exec, evaluar, peticiones } = await conductor();

  // En un host remoto la primera carga, el registro del SW y la recarga pueden tardar varios
  // segundos: esperar al aislamiento antes de tocar el DOM, o la recarga destruye el contexto
  // en mitad de una evaluación y el fallo parece un error del selector de fichero.
  let aislamiento = null;
  for (let i = 0; i < 80; i++) {
    try {
      aislamiento = await evaluar(`({
        aislada: crossOriginIsolated,
        controlado: !!navigator.serviceWorker.controller,
        recarga: sessionStorage.getItem("apkc-coi-reintento")
      })`);
      if (aislamiento.aislada && aislamiento.controlado) break;
    } catch (e) { /* la recarga puede caer en mitad de la lectura */ }
    await esperar(500);
  }
  aislamiento = aislamiento || { aislada: false, controlado: false, recarga: null };
  comprueba("la página se recargó sola y el service worker la controla",
    aislamiento.recarga === "1" && aislamiento.controlado === true, JSON.stringify(aislamiento));
  comprueba("el sitio es crossOriginIsolated sin cabeceras del servidor",
    aislamiento.aislada === true, JSON.stringify(aislamiento));

  const endpoints = await evaluar(`(async () => {
    const r = await fetch("/android-jar-info");
    return { estado: r.status, texto: (await r.text()).slice(0, 40) };
  })()`);
  comprueba("no hay endpoints de desarrollo en el sitio", endpoints.estado === 404, JSON.stringify(endpoints));

  const pwa = await evaluar(`(async () => {
    const r = await fetch("/manifest.webmanifest");
    const m = await r.json();
    const estados = await Promise.all((m.icons || []).map(async (i) =>
      (await fetch(i.src)).status));
    return { tipo: r.headers.get("content-type"), id: m.id, display: m.display,
      iconos: m.icons ? m.icons.length : 0, estados };
  })()`);
  comprueba("el manifiesto PWA y sus dos iconos se sirven",
    pwa.id === "/" && pwa.display === "standalone" && pwa.iconos === 2 &&
      pwa.estados.every((s) => s === 200),
    JSON.stringify(pwa));

  // El módulo de la pestaña publica sus funciones en window al terminar de cargar; esperar a
  // que estén antes de tocar nada, porque la recarga del SW puede haber invalidado un contexto
  // previo donde sí estaban.
  const listo = await evaluar(`(async () => {
    for (let i = 0; i < 60; i++) {
      if (typeof usarJarElegido === "function" && typeof compilarDebug === "function" &&
          typeof hospedador !== "undefined" && typeof correr === "function") return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  })()`);
  comprueba("el módulo de la pestaña está listo tras la recarga", listo === true, String(listo));

  const doc = await exec("DOM.getDocument");
  const entrada = await exec("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#android-jar" });
  const puesto = await exec("DOM.setFileInputFiles", { files: [JAR], nodeId: entrada.result.nodeId });
  comprueba("chromium acepta el android.jar en el selector", !puesto.error && !puesto.result.exceptionDetails,
    JSON.stringify(puesto).slice(0, 160));
  const jar = await evaluar(`(async () => {
    await usarJarElegido();
    const aviso = document.getElementById("estado-jar");
    for (let i = 0; i < 120; i++) {
      if (/android\\.jar listo/.test(aviso.textContent)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const bytes = await hospedador.bytes("/sdk/android.jar");
    return { aviso: aviso.textContent, bytes: bytes ? bytes.length : 0 };
  })()`);
  comprueba("el android.jar entra en OPFS sin servidor que lo sirva", jar.bytes > 1000000,
    jar.bytes + " bytes, aviso " + JSON.stringify(jar.aviso).slice(0, 90));

  const compilado = await evaluar(`(async () => {
    await hospedador.limpiar("/proyecto");
    await correr(["create", "/proyecto"]);
    await compilarDebug();
    const apk = await hospedador.bytes("/proyecto/build/app.apk");
    return {
      bytes: apk ? apk.length : 0,
      veredicto: document.getElementById("estado-verificacion").textContent,
      codigo: document.getElementById("ultimo-codigo").textContent,
    };
  })()`);
  comprueba("compila y firma entero en el sitio estático",
    compilado.bytes > 5000 && compilado.codigo === "0" && /v1 \(JAR signing\): ok/.test(compilado.veredicto),
    JSON.stringify(compilado).slice(0, 260));

  const base64 = await evaluar(`(async () => {
    const a = await hospedador.bytes("/proyecto/build/app.apk");
    let s = "";
    for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
    return btoa(s);
  })()`);
  fs.writeFileSync(SALIDA, Buffer.from(base64, "base64"));
  const verificado = spawnSync(APKSIGNER, ["verify", "--verbose", "--min-sdk-version", "21", SALIDA],
    { encoding: "utf8" });
  const salida = String(verificado.stdout || "") + String(verificado.stderr || "");
  comprueba("apksigner verifica v1 y v2 la apk del sitio",
    verificado.status === 0 && /v1 scheme \(JAR signing\): true/.test(salida) &&
    /v2 scheme \(APK Signature Scheme v2\): true/.test(salida),
    salida.split("\n").filter((l) => /scheme \(/.test(l)).join(" | ").slice(0, 180));

  const fuera = peticiones.filter((u) => { try { return new URL(u).origin !== ORIGEN; } catch (e) { return true; } });
  comprueba("el sitio no pide nada fuera de su origen", fuera.length === 0,
    peticiones.length + " peticiones, " + fuera.length + " fuera");

  console.log(hechos + " comprobaciones bien, " + fallos + " mal");
  console.log("apk: " + SALIDA + " (" + fs.statSync(SALIDA).size + " bytes)");
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error("la prueba no terminó: " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
