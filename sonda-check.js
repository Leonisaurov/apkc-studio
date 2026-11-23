// Sonda acotada de D5: cuánto cuesta `apkc check` de verdad en la pestaña.
//
// No es la suite (`prueba-pestana.js`): no comprueba la página entera ni firma ni verifica. Levanta
// el servidor de desarrollo y un chromium headless, crea el proyecto con el propio `apkc create`,
// mete el android.jar desde el origen y mide con `performance.now()` lo que tarda cada comando y
// cada pasada del diagnóstico, incluidas las dos formas de encadenar dos checks (esperar el viejo o
// cancelarlo). Todo queda en el perfil temporal; no toca red externa ni publica nada.
//
// uso:
//   APKC_WASM=$HOME/.cache/apkc-web/d5/apkc-wasm.wasm \
//   ANDROID_JAR=$HOME/opt/android-sdk/platforms/android-34/android.jar \
//   CHROME_BIN=/usr/bin/chromium node studio/sonda-check.js
//
// salida: una línea `medida <nombre> <valor>` por cifra, y al final `resumen <json>`; sale 1 si una
// medición no se pudo hacer.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = process.env.APKC_WASM || "";
const JAR = process.env.ANDROID_JAR ||
  "/home/leonisauro/opt/android-sdk/platforms/android-34/android.jar";
const CHROME = process.env.CHROME_BIN || "/usr/bin/chromium";
const PUERTO = Number(process.env.STUDIO_SERVIDOR_PORT || 8797);
const CDP = Number(process.env.STUDIO_PORT || 9347);
const TMP = process.env.PREFIX ? path.join(process.env.PREFIX, "tmp") : path.join(process.env.HOME || ".", ".cache/apkc-web");
const REPES = Number(process.env.REPES || 3);

if (!WASM || !fs.existsSync(WASM)) {
  console.error("falta APKC_WASM apuntando al binario wasm");
  process.exit(2);
}
if (!fs.existsSync(JAR)) {
  console.error("falta el android.jar en " + JAR + " (o exporta ANDROID_JAR)");
  process.exit(2);
}
fs.mkdirSync(TMP, { recursive: true });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const ocupado = (puerto) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", () => res(true));
  s.once("listening", () => s.close(() => res(false)));
  s.listen(puerto, "127.0.0.1");
});
if (await ocupado(PUERTO)) { console.error("el puerto " + PUERTO + " está ocupado: usa STUDIO_SERVIDOR_PORT"); process.exit(2); }
if (await ocupado(CDP)) { console.error("el puerto CDP " + CDP + " está ocupado: usa STUDIO_PORT"); process.exit(2); }

const servidor = spawn(process.execPath, [path.join(__dirname, "servidor.js"), String(PUERTO)], {
  cwd: __dirname,
  env: { ...process.env, APKC_WASM: path.resolve(WASM), ANDROID_JAR: path.resolve(JAR) },
  stdio: ["ignore", "pipe", "pipe"],
});
let salidaServidor = "";
servidor.stdout.on("data", (d) => { salidaServidor += d; });
servidor.stderr.on("data", (d) => { salidaServidor += d; });

const perfil = path.join(TMP, "d5-sonda-perfil");
fs.rmSync(perfil, { recursive: true, force: true });
const navegador = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
  "--disable-dev-shm-usage", "--remote-allow-origins=*", "--no-first-run",
  "--disable-extensions", "--disable-sync", "--window-size=1280,900",
  "--user-data-dir=" + perfil, "--remote-debugging-port=" + CDP,
  "http://127.0.0.1:" + PUERTO + "/index.html",
], { stdio: ["ignore", "pipe", "pipe"] });
let salidaNavegador = "";
navegador.stderr.on("data", (d) => { salidaNavegador += d; });

const apagar = () => {
  try { navegador.kill("SIGKILL"); } catch (e) { /* ya muerto */ }
  try { servidor.kill("SIGKILL"); } catch (e) { /* ya muerto */ }
};
process.on("exit", apagar);

let evaluar = null;
async function conectar() {
  let destino = null;
  for (let i = 0; i < 120 && !destino; i++) {
    try {
      const lista = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
      destino = lista.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:" + PUERTO));
    } catch (e) { /* aún no escucha */ }
    if (!destino) await esperar(500);
  }
  if (!destino) throw new Error("chromium no subió el debugger:\n" + salidaNavegador.slice(0, 400) + "\n" + salidaServidor.slice(0, 400));
  const ws = new WebSocket(destino.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket falló")); });
  let id = 0;
  const colas = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && colas.has(m.id)) { colas.get(m.id)(m); colas.delete(m.id); }
  });
  evaluar = async (expresion, ms = 180000) => {
    const n = ++id;
    const espera = new Promise((res) => colas.set(n, res));
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate",
      params: { expression: expresion, awaitPromise: true, returnByValue: true } }));
    const r = await Promise.race([espera, esperar(ms).then(() => { throw new Error("plazo agotado: " + expresion.slice(0, 60)); })]);
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error(String((ex.exception && ex.exception.description) || ex.text).slice(0, 500));
    return r.result.result.value;
  };
  for (let i = 0; i < 120; i++) {
    try { if (await evaluar("crossOriginIsolated === true && typeof hospedador === 'object'", 5000)) break; } catch (e) { /* arrancando */ }
    await esperar(400);
  }
}

const resumen = {};
function mide(nombre, valor) {
  resumen[nombre] = valor;
  console.log("medida " + nombre + " " + JSON.stringify(valor));
}

try {
  await conectar();
  console.log("  página aislada:", await evaluar("crossOriginIsolated === true"));

  const preparado = await evaluar(`(async () => {
    await hospedador.limpiar("/proyecto").catch(() => {});
    const create = await correr(["create", "/proyecto"]);
    const jar = await ponerJarDeUrl("/android-jar");
    const fuente = await hospedador.texto("/proyecto/src/com/myapp/MainActivity.java");
    await hospedador.escribir("/suelto/MainActivity.java", new TextEncoder().encode(fuente));
    return { create: create.codigo, jar, fuente: fuente.length };
  })()`);
  mide("preparacion", preparado);

  const base = ["check", "--android-jar", "/sdk/android.jar", "--sdk-version", "34",
    "--codename", "14", "--nombre", "MainActivity.java"];
  // el temporal se escribe una vez por pasada, como hace el diagnóstico
  const serie = (argv, reps) => evaluar(`(async () => {
    const fuente = await hospedador.texto("/proyecto/src/com/myapp/MainActivity.java");
    const tiempos = [];
    for (let i = 0; i < ${reps}; i++) {
      await hospedador.escribir("/proyecto/.apkc-check.java", new TextEncoder().encode(fuente));
      const t = performance.now();
      const r = await hospedador.ejecutar(${JSON.stringify(argv)});
      tiempos.push(performance.now() - t);
      await hospedador.limpiar("/proyecto/.apkc-check.java").catch(() => {});
      if (r.tipo === "error") throw new Error(r.error);
    }
    return tiempos;
  })()`);

  const ordenar = (t) => [...t].sort((a, b) => a - b);
  const mediana = (t) => ordenar(t)[Math.floor(t.length / 2)];

  const arranque = await serie(["version"], REPES);
  mide("version_ms", ordenar(arranque));
  const suelto = await serie([...base, "/suelto/MainActivity.java"], REPES);
  mide("check_sin_proyecto_ms", ordenar(suelto));

  // el escenario caro: sin R.java se enlaza res/ y se lee resources.arsc del android.jar. Va antes
  // del build a propósito: es el estado de un proyecto recién creado.
  const sinR = await serie([...base, "--proyecto", "/proyecto", "/proyecto/.apkc-check.java"], REPES);
  mide("check_sin_R_enlazando_res_ms", ordenar(sinR));

  // encadenar dos checks caros: (a) esperar a que el viejo termine, que es lo que hacía el
  // diagnóstico; (b) cancelar el viejo antes de lanzar el nuevo, que es lo que hace ahora cuando
  // ya lleva más de 250 ms. A y B son el caso caro, donde el despilfarro se nota.
  const lento = [...base, "--proyecto", "/proyecto", "/proyecto/.apkc-check.java"];
  const caro = await evaluar(`(async () => {
    const fuente = await hospedador.texto("/proyecto/src/com/myapp/MainActivity.java");
    const escribir = () => hospedador.escribir("/proyecto/.apkc-check.java", new TextEncoder().encode(fuente));
    await escribir();
    const a = hospedador.ejecutar(${JSON.stringify(lento)});
    await new Promise((r) => setTimeout(r, 300));
    const t = performance.now();
    const r = await hospedador.ejecutar(${JSON.stringify(lento)});
    const esperar = performance.now() - t;
    await a.catch(() => {});
    await escribir();
    const c = hospedador.ejecutar(${JSON.stringify(lento)});
    await new Promise((r) => setTimeout(r, 300));
    const t2 = performance.now();
    const cancelado = hospedador.cancelarSiNadieEspera();
    const r2 = await hospedador.ejecutar(${JSON.stringify(lento)});
    const cancelar = performance.now() - t2;
    await c.catch(() => {});
    return { esperar, cancelar, cancelado, ok: r.tipo === "terminado" && r2.tipo === "terminado" };
  })()`);
  mide("caro_dos_checks_esperando_ms", Math.round(caro.esperar));
  mide("caro_dos_checks_cancelando_ms", Math.round(caro.cancelar));
  mide("cancelacion_disponible", caro.cancelado);
  if (!caro.ok) throw new Error("el check caro encadenado no terminó: " + JSON.stringify(caro));

  // ahora el build deja la R.java escrita: el camino rápido que ve el usuario que ya compiló
  const construido = await evaluar(`(async () => {
    await hospedador.cwd("/proyecto");
    const r = await correr(["build", "--linker", "go", "--compiler", "go",
      "--android-jar", "/sdk/android.jar", "--sdk-version", "34", "--codename", "14"]);
    const bytes = await hospedador.bytes("/proyecto/src/com/myapp/R.java").catch(() => null);
    return { codigo: r.codigo, r: bytes ? bytes.length : 0 };
  })()`);
  mide("build_deja_R", construido);
  if (!construido.r) throw new Error("el build de la pestaña no dejó src/com/myapp/R.java: no hay escenario con R");
  const conR = await serie([...base, "--proyecto", "/proyecto", "/proyecto/.apkc-check.java"], REPES);
  mide("check_con_proyecto_y_R_ms", ordenar(conR));

  // encadenar dos checks rápidos: cancelar aquí cuesta más que esperar (medido), y es la razón de
  // que el diagnóstico solo cancele pasado un umbral.
  const rapido = await evaluar(`(async () => {
    const fuente = await hospedador.texto("/proyecto/src/com/myapp/MainActivity.java");
    const escribir = () => hospedador.escribir("/proyecto/.apkc-check.java", new TextEncoder().encode(fuente));
    await escribir();
    const a = hospedador.ejecutar(${JSON.stringify(lento)});
    await new Promise((r) => setTimeout(r, 120));
    const t = performance.now();
    const r = await hospedador.ejecutar(${JSON.stringify(lento)});
    const esperar = performance.now() - t;
    await a.catch(() => {});
    await escribir();
    const c = hospedador.ejecutar(${JSON.stringify(lento)});
    await new Promise((r) => setTimeout(r, 120));
    const t2 = performance.now();
    const cancelado = hospedador.cancelarSiNadieEspera();
    const r2 = await hospedador.ejecutar(${JSON.stringify(lento)});
    const cancelar = performance.now() - t2;
    await c.catch(() => {});
    return { esperar, cancelar, cancelado, ok: r.tipo === "terminado" && r2.tipo === "terminado" };
  })()`);
  mide("rapido_dos_checks_esperando_ms", Math.round(rapido.esperar));
  mide("rapido_dos_checks_cancelando_ms", Math.round(rapido.cancelar));
  if (!rapido.ok) throw new Error("el check rápido encadenado no terminó: " + JSON.stringify(rapido));

  // el diagnóstico no lanza un check cuando el resultado no puede cambiar: pasar de limpio a
  // añadir espacios de sobra no gasta una pasada; cambiar un token sí.
  const saltos = await evaluar(`(async () => {
    await abrir("/proyecto/src/com/myapp/MainActivity.java");
    const area = document.getElementById("codigo");
    const estado = document.getElementById("diagnostico-vivo-estado");
    const espera = async (re, ms) => {
      for (let i = 0; i < ms / 50; i++) {
        if (re.test(estado.textContent)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    if (!(await espera(/sin errores/, 20000))) return { error: "no llegó a sin errores", estado: estado.textContent };
    const c0 = { pasadas: window.DIAGNOSTICO_VIVO.pasadas(), saltadas: window.DIAGNOSTICO_VIVO.saltadas() };
    const original = area.value;
    area.value = original.split("\\n").map((l) => l + "  ").join("\\n");
    area.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const c1 = { pasadas: window.DIAGNOSTICO_VIVO.pasadas(), saltadas: window.DIAGNOSTICO_VIVO.saltadas() };
    const trasEspacios = estado.textContent;
    area.value = original.replace("R.layout.main", "R.layout.noexiste");
    area.dispatchEvent(new Event("input", { bubbles: true }));
    const corrio = await espera(/1 error/, 20000);
    const c2 = { pasadas: window.DIAGNOSTICO_VIVO.pasadas(), saltadas: window.DIAGNOSTICO_VIVO.saltadas() };
    area.value = original;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    return { pasadas0: c0.pasadas, saltadas0: c0.saltadas, pasadas1: c1.pasadas, saltadas1: c1.saltadas,
      trasEspacios, pasadas2: c2.pasadas, corrio };
  })()`);
  mide("diagnostico_saltos", saltos);
  if (saltos.error) throw new Error("el diagnóstico no llegó a limpio: " + JSON.stringify(saltos));

  console.log("resumen " + JSON.stringify({
    version: mediana(arranque), sinProyecto: mediana(suelto), conR: mediana(conR),
    sinR: mediana(sinR), caroEsperar: caro.esperar, caroCancelar: caro.cancelar,
    rapidoEsperar: rapido.esperar, rapidoCancelar: rapido.cancelar, reps: REPES,
  }, null, 2));
  apagar();
  process.exit(0);
} catch (e) {
  console.error("sonda falló:", (e && e.message) || e);
  console.error("servidor:\n" + salidaServidor.slice(-800));
  console.error("chromium:\n" + salidaNavegador.slice(-600));
  apagar();
  process.exit(1);
}
