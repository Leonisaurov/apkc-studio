// Sonda CDP de la resolución en reposo. Sirve una copia de studio con el wasm del fork,
// conduce Brave por CDP y comprueba que sin núcleo vivo `resolverPorWisp` usa
// `apkcWispEnReposo`, que dispara `apkc wisp-get` en el worker. No abre ningún relay:
// las CAs son válidas pero la huella entregada es inválida, así que el núcleo se corta
// antes de tocar la red. El recuento CDP cubre la página y sus workers.
//
// uso: APKC_WASM=/ruta/apkc.wasm CHROME_BIN=brave node studio/sonda-wisp-reposo.mjs
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gates from "./wisp-gates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.XDG_CACHE_HOME
  ? path.join(process.env.XDG_CACHE_HOME, "apkc-web")
  : path.join(os.homedir(), ".cache", "apkc-web");
const BASE = path.join(CACHE, "wisp-get-final");
const SITIO = path.join(BASE, "sonda-sitio");
const PERFIL = path.join(BASE, "sonda-perfil-brave");
const WASM = process.env.APKC_WASM || path.join(BASE, "apkc-get.wasm");
const CHROME = process.env.CHROME_BIN || "brave";
const PUERTO = Number(process.env.REPOSO_SERVIDOR_PORT || 8891);
const CDP = Number(process.env.REPOSO_CDP_PORT || 9457);
const ORIGEN = "http://127.0.0.1:" + PUERTO;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0, hechos = 0;
function comprueba(nombre, cond, detalle) {
  if (cond) { hechos++; console.log("  ok   " + nombre + (detalle ? " — " + detalle : "")); }
  else { fallos++; console.log("  FALLA " + nombre + (detalle ? " — " + detalle : "")); }
}

if (!fs.existsSync(WASM)) {
  console.error("falta el wasm: " + WASM);
  process.exit(2);
}
function puertoOcupado(puerto) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(true));
    s.once("listening", () => s.close(() => res(false)));
    s.listen(puerto, "127.0.0.1");
  });
}
if (await puertoOcupado(PUERTO) || await puertoOcupado(CDP)) {
  console.error("puerto ocupado: usa REPOSO_SERVIDOR_PORT y REPOSO_CDP_PORT");
  process.exit(2);
}

// El sitio es una copia: el repo no se toca y el wasm es el que acaba de compilarse.
fs.rmSync(SITIO, { recursive: true, force: true });
fs.cpSync(__dirname, SITIO, { recursive: true });
fs.copyFileSync(WASM, path.join(SITIO, "apkc.wasm"));
fs.copyFileSync(path.join(spawnSync("go", ["env", "GOROOT"], { encoding: "utf8" }).stdout.trim(),
  "lib", "wasm", "wasm_exec.js"), path.join(SITIO, "wasm_exec.js"));

// Un PEM X.509 real: se entrega con una huella falsa para que el núcleo falle antes del relay.
const cert = path.join(BASE, "sonda-ca.pem");
const clave = path.join(BASE, "sonda-ca.key");
const openssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", clave, "-out", cert, "-days", "1", "-subj", "/CN=wisp-reposo"], { encoding: "utf8" });
if (openssl.status !== 0) {
  console.error("no generé el PEM de prueba: " + openssl.stderr);
  process.exit(2);
}
const pem = fs.readFileSync(cert, "utf8");
const huellaReal = createHash("sha256").update(Buffer.from(pem, "utf8")).digest("hex");

const servidor = spawn(process.execPath, [path.join(SITIO, "servidor.js"), String(PUERTO)], {
  cwd: SITIO, env: { ...process.env, SITIO_DIR: SITIO, APKC_WASM: path.resolve(WASM) },
  stdio: ["ignore", "pipe", "pipe"],
});
let salidaServidor = "";
servidor.stdout.on("data", (d) => { salidaServidor += d; });
servidor.stderr.on("data", (d) => { salidaServidor += d; });

fs.rmSync(PERFIL, { recursive: true, force: true });
const navegador = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
  "--disable-dev-shm-usage", "--remote-allow-origins=*", "--no-first-run",
  "--disable-extensions", "--disable-sync", "--window-size=1280,800",
  "--user-data-dir=" + PERFIL, "--remote-debugging-port=" + CDP, ORIGEN + "/index.html",
], { stdio: ["ignore", "pipe", "pipe"] });
let salidaNavegador = "";
navegador.stderr.on("data", (d) => { salidaNavegador += d; });
function apagar() {
  try { navegador.kill("SIGKILL"); } catch (e) { /* */ }
  try { servidor.kill("SIGKILL"); } catch (e) { /* */ }
}
process.on("exit", apagar);

async function target() {
  for (let i = 0; i < 90; i++) {
    try {
      const lista = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
      const p = lista.find((t) => t.type === "page" && t.url.startsWith(ORIGEN));
      if (p) return p;
    } catch (e) { /* aún no escucha */ }
    await esperar(400);
  }
  throw new Error("Brave no subió el debugger:\n" + salidaNavegador.slice(0, 400) +
    "\nservidor:\n" + salidaServidor.slice(0, 400));
}

(async () => {
  const t = await target();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket CDP falló")); });
  let id = 0;
  const colas = new Map();
  const peticiones = [], webSockets = [], sesiones = new Map();
  const exec = (method, params, sessionId) => new Promise((res) => {
    const n = ++id;
    colas.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && colas.has(m.id)) { colas.get(m.id)(m); colas.delete(m.id); return; }
    if (m.method === "Target.attachedToTarget") {
      const sessionId = m.params && m.params.sessionId;
      if (!sessionId) return;
      const tipo = String((m.params.targetInfo || {}).type || "?");
      const pausado = !!(m.params && m.params.waitingForDebugger);
      sesiones.set(sessionId, { tipo, red: "pendiente" });
      (async () => {
        const red = await Promise.race([exec("Network.enable", {}, sessionId), esperar(2000).then(() => null)]);
        const actual = sesiones.get(sessionId);
        if (actual) actual.red = !red ? "no" : red.error ? "no" : "sí";
        if (pausado) await exec("Runtime.runIfWaitingForDebugger", {}, sessionId);
      })();
      return;
    }
    if (m.method === "Target.detachedFromTarget") {
      if (m.params && m.params.sessionId) sesiones.delete(m.params.sessionId);
      return;
    }
    gates.acumularRed({ peticiones, webSockets }, m);
  });

  const auto = await exec("Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const redPagina = await exec("Network.enable");
  sesiones.set("", { tipo: "page", red: redPagina && redPagina.error ? "no" : "sí" });
  await exec("Runtime.enable");
  const evaluar = async (expression) => {
    const r = await exec("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(String((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text));
    }
    return r.result && r.result.result && r.result.result.value;
  };

  let listo = false;
  for (let i = 0; i < 80; i++) {
    try {
      listo = await evaluar("!!document.getElementById('codigo') && " +
        "typeof globalThis.apkcWispEnReposo?.obtener === 'function'");
      if (listo) break;
    } catch (e) { /* aún carga */ }
    await esperar(300);
  }
  comprueba("la página instala el proxy de reposo al cargar", listo === true);
  comprueba("sin núcleo vivo no se anuncia apkcWisp",
    (await evaluar("typeof globalThis.apkcWisp === 'undefined'")) === true);

  const expresion = `(async () => {
    const m = await import("/wisp.js");
    const pem = ${JSON.stringify(pem)};
    const preparado = await m.prepararCAS({ nombre: "sonda-ca.pem", bytes: new TextEncoder().encode(pem) });
    const salida = { huellaCalculada: preparado.huella };
    let motivo = "";
    try {
      await m.resolverPorWisp({
        relay: "wss://wisp.mercurywork.shop/wisp/", coordenada: "com:artefacto:1.0",
        hospedador: { escribir: async () => ({ tipo: "escrito" }) },
        cas: { pem, huella: "0".repeat(64) },
      });
    } catch (e) { motivo = String((e && e.message) || e); }
    salida.motivo = motivo.slice(0, 400);
    salida.consola = String((document.getElementById("consola-pestana") || {}).textContent || "").slice(0, 600);
    return salida;
  })()`;
  const resultado = await Promise.race([
    evaluar(expresion),
    esperar(120000).then(() => { throw new Error("plazo agotado esperando al reposo"); }),
  ]);
  comprueba("las CAs del dispositivo se aceptan y producen su sha256",
    resultado.huellaCalculada === huellaReal, resultado.huellaCalculada);
  comprueba("la huella inválida falla dentro de wisp-get, antes del relay",
    /huella/i.test(resultado.motivo), resultado.motivo.slice(0, 200));
  comprueba("el error del núcleo llega a la página sin línea de marca en la consola",
    !/APKC_WISP_GET:/.test(resultado.consola), resultado.consola.slice(0, 160));

  // Recuento CDP: El gate por defecto prohíbe cualquier petición o WebSocket fuera del origen.
  const fueraPeticiones = peticiones.filter((u) => !String(u).startsWith(ORIGEN) && !String(u).startsWith("data:") && !String(u).startsWith("blob:"));
  const fueraSockets = webSockets.filter((u) => !String(u).startsWith(ORIGEN));
  const conRed = [...sesiones.values()].filter((v) => v.red === "sí");
  console.log("\nrecuento CDP: " + peticiones.length + " peticiones (" + fueraPeticiones.length +
    " fuera de origen), " + webSockets.length + " WebSocket (" + fueraSockets.length +
    " fuera de origen); " + conRed.length + " sesiones con red, " +
    (auto && auto.error ? "auto-attach con aviso" : "auto-attach activo"));
  comprueba("cero peticiones fuera del origen", fueraPeticiones.length === 0,
    JSON.stringify(fueraPeticiones.slice(0, 4)));
  comprueba("cero WebSocket fuera del origen (ningún relay abierto)", fueraSockets.length === 0,
    JSON.stringify(fueraSockets.slice(0, 4)));
  comprueba("la cobertura incluye workers", conRed.some((v) => /worker/.test(v.tipo)),
    conRed.map((v) => v.tipo).join(",") || "ninguna");

  if (fallos) {
    console.error("\nsonda reposo: " + fallos + " fallo(s) de " + (fallos + hechos));
    process.exitCode = 1;
  } else {
    console.log("\nsonda reposo: " + hechos + " comprobaciones en verde; la resolución en reposo " +
      "llega a wisp-get y la huella inválida lo corta sin abrir relays");
  }
  apagar();
})().catch((e) => {
  console.error("sonda reposo: " + (e && e.stack ? e.stack : e));
  apagar();
  process.exitCode = 1;
});
