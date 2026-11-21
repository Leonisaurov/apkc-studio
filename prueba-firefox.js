// Segundo navegador: comprueba en Firefox lo que en Chromium cubre prueba-sitio.js. Firefox no
// entiende los flag de CDP, así que se conduce por WebDriver (geckodriver) con la API W3C de HTTP.
// El servidor es el estático sin cabeceras: la página tiene que aislarse sola con el service worker.
//
// uso: GECKODRIVER=/ruta/geckodriver CHROME_BIN=/ruta/firefox \
//   SITIO_DIR=../sitio ANDROID_JAR=/.../android.jar node prueba-firefox.js
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = process.env.GECKODRIVER || "geckodriver";
const FIREFOX = process.env.FIREFOX_BIN || process.env.CHROME_BIN || "firefox";
const JAR = process.env.ANDROID_JAR || "";
const PUERTO = Number(process.env.SITIO_SERVIDOR_PORT || 8796);
const DRIVER_PORT = Number(process.env.GECKODRIVER_PORT || 4455);
const BASE = `http://127.0.0.1:${DRIVER_PORT}`;
const URL_PAGINA = `http://127.0.0.1:${PUERTO}/index.html`;
const TMP = process.env.PREFIX ? process.env.PREFIX + "/tmp" : "/tmp";

let hechos = 0, fallos = 0;
function comprueba(nombre, cond, detalle) {
  if (cond) { hechos++; console.log("  ok   " + nombre + (detalle ? " — " + detalle : "")); }
  else { fallos++; console.log("  FALLA " + nombre + (detalle ? " — " + detalle : "")); }
}
function falta(que) {
  console.error("falta " + que);
  process.exit(2);
}
if (!fs.existsSync(DRIVER)) falta("GECKODRIVER con el binario de geckodriver");
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const sitio = path.resolve(process.env.SITIO_DIR || path.join(__dirname, "..", "sitio"));
const servidor = spawn(process.execPath, [path.join(__dirname, "servidor-estatico.js"), String(PUERTO)], {
  cwd: __dirname, env: { ...process.env, SITIO_DIR: sitio, ANDROID_JAR: JAR }, stdio: "ignore",
});
const driver = spawn(DRIVER, ["--port", String(DRIVER_PORT)], { stdio: "ignore" });
function apagar() {
  try { driver.kill("SIGKILL"); } catch (e) { /* */ }
  try { servidor.kill("SIGKILL"); } catch (e) { /* */ }
}
process.on("exit", apagar);

async function wd(method, ruta, cuerpo) {
  const respuesta = await fetch(BASE + ruta, {
    method, headers: { "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(method + " " + ruta + ": " + JSON.stringify(datos).slice(0, 300));
  return datos.value !== undefined ? datos.value : datos;
}

(async () => {
  for (let i = 0; i < 60; i++) {
    try { await wd("GET", "/status"); break; } catch (e) { await esperar(250); }
  }
  const sesion = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": { binary: FIREFOX, args: ["-headless"] },
      },
    },
  });
  const id = sesion.sessionId || (sesion.session && sesion.session.sessionId) || sesion.value?.sessionId;
  if (!id) throw new Error("geckodriver no devolvió sessionId: " + JSON.stringify(sesion).slice(0, 300));
  const S = "/session/" + id;
  await wd("POST", S + "/timeouts", { script: 180000, "page load": 180000 });
  const js = async (expresion, args = []) =>
    wd("POST", S + "/execute/sync", { script: expresion, args });

  await wd("POST", S + "/url", { url: URL_PAGINA });
  let estado = null;
  for (let i = 0; i < 80; i++) {
    try {
      estado = await js(`return {
        listo: !!document.getElementById("codigo") && typeof correr === "function",
        aislada: crossOriginIsolated,
        controlado: !!navigator.serviceWorker.controller,
        recarga: sessionStorage.getItem("apkc-coi-reintento")
      }`);
      if (estado.listo && estado.aislada) break;
    } catch (e) { /* aún carga o se está recargando */ }
    await esperar(500);
  }
  comprueba("Firefox se recargó sola y el SW le dio crossOriginIsolated",
    estado && estado.listo && estado.aislada && estado.controlado && estado.recarga === "1",
    JSON.stringify(estado));

  const opfs = await js(`return (async () => {
    const a = new Uint8Array([7, 8, 9]);
    const r = await hospedador.escribir("/sdk/prueba-firefox.bin", a);
    const leido = await hospedador.leer("/sdk/prueba-firefox.bin");
    await hospedador.limpiar("/sdk/prueba-firefox.bin");
    return { escrito: r.tipo, bytes: leido.bytes ? leido.bytes.length : 0 };
  })()`);
  comprueba("el worker escribe y lee OPFS en Firefox", opfs.bytes === 3, JSON.stringify(opfs));

  if (JAR && fs.existsSync(JAR)) {
    // El servidor de desarrollo sirve el jar en /android-jar del mismo origen; así no hay que
    // meter 26 MB en base64 por el protocolo de WebDriver, que se ahoga con ese cuerpo.
    const Jur = await js(`return (async () => {
      await ponerJarDeUrl("/android-jar");
      const aviso = document.getElementById("estado-jar");
      for (let i = 0; i < 120; i++) {
        if (/android\\.jar listo/.test(aviso.textContent)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const bytes = await hospedador.bytes("/sdk/android.jar");
      return { bytes: bytes ? bytes.length : 0 };
    })()`);
    comprueba("el android.jar entra en OPFS en Firefox", Jur.bytes > 1000000, JSON.stringify(Jur));

    const compilado = await js(`return (async () => {
      await hospedador.limpiar("/proyecto");
      await correr(["create", "/proyecto"]);
      await compilarDebug();
      const apk = await hospedador.bytes("/proyecto/build/app.apk");
      return { bytes: apk ? apk.length : 0,
        veredicto: document.getElementById("estado-verificacion").textContent };
    })()`);
    comprueba("compila y firma entero en Firefox",
      compilado.bytes > 5000 && /v1 \(JAR signing\): ok/.test(compilado.veredicto),
      JSON.stringify(compilado).slice(0, 240));
  } else {
    console.log("  --- sin ANDROID_JAR: no se prueba la compilación completa en Firefox");
  }

  await wd("DELETE", S);
  console.log(hechos + " comprobaciones bien, " + fallos + " mal");
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error("la prueba no terminó: " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
