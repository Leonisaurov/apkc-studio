// prueba en navegador real (chromium headless, por CDP sin dependencias): lo que node no puede
// ejercitar —el DOM, los manejadores de click, el localStorage— que es justo donde una pagina de
// este tipo se cae. Se sirve por http sin COOP/COEP: la página tiene que registrar el service
// worker, recargarse y recuperar el OPFS ella sola. La pestaña completa se prueba aparte con
// servidor.js y, en un host estático, con prueba-sitio.js.
//
// uso: node prueba-navegador.js   (lanza el servidor, conduce la pagina y apaga todo)
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || "chromium-browser";

// Puertos propios, no fijos: un chromium huérfano de una corrida anterior sigue escuchando en el
// puerto de debug y `target()` se le acoplaría, leyendo su OPFS con el proyecto ya creado (el
// estado de la vista previa saldría «res/layout/main.xml · 2 vistas» en vez de «Abre un
// res/layout…»). Con 0 el sistema elige puertos libres y se leen los reales del propio navegador.
const PUERTO = process.env.STUDIO_PORT || "0";
let HTTP_PORT = Number(process.env.STUDIO_NAV_PORT || 0);
let URL_PAGINA = "";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm",
};
// El SW recupera el aislamiento y el create llega al worker: este servidor mínimo tiene que
// saber servir lo que el worker importa, o el fallo parecería un problema de OPFS.
const WASM = process.env.APKC_WASM || "";
let GOROOT = process.env.GOROOT || "";
if (!GOROOT) {
  try { GOROOT = execSync("go env GOROOT", { encoding: "utf8" }).trim(); } catch (e) { GOROOT = ""; }
}
const WASM_EXEC = path.join(GOROOT, "lib", "wasm", "wasm_exec.js");
const servidor = http.createServer((peticion, respuesta) => {
  const ruta = decodeURIComponent((peticion.url || "/").split("?")[0]);
  let fichero = path.normalize(path.join(__dirname, ruta === "/" ? "index.html" : ruta));
  if (ruta === "/wasm_exec.js" && fs.existsSync(WASM_EXEC)) fichero = WASM_EXEC;
  else if (ruta === "/apkc.wasm" && WASM && fs.existsSync(WASM)) fichero = WASM;
  if ((fichero !== WASM_EXEC && fichero !== WASM && !fichero.startsWith(__dirname + path.sep)) ||
      !fs.existsSync(fichero) || fs.statSync(fichero).isDirectory()) {
    respuesta.writeHead(404); return void respuesta.end("no existe\n");
  }
  respuesta.writeHead(200, { "Content-Type": MIME[path.extname(fichero)] || "application/octet-stream" });
  respuesta.end(fs.readFileSync(fichero));
});
servidor.listen(HTTP_PORT, "127.0.0.1");
await new Promise((listo) => servidor.once("listening", listo));
HTTP_PORT = servidor.address().port;
URL_PAGINA = "http://127.0.0.1:" + HTTP_PORT + "/index.html";

// perfil propio y limpio de ESTA corrida (sufijo por PID): chromium deja un SingletonLock cuando
// muere con SIGKILL y un perfil fijo compartido arrastra el OPFS del intento anterior (su proyecto
// creado), que es justo lo que falsea el arranque «sin proyecto» de la vista previa. TMPDIR de
// Termux, nunca /tmp.
const TMP = process.env.PREFIX ? process.env.PREFIX + "/tmp" : (process.env.TMPDIR || "/tmp");
const PERFIL = path.join(TMP, "studio-chrome-perfil-" + process.pid);
fs.rmSync(PERFIL, { recursive: true, force: true });

const navegador = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
  "--disable-dev-shm-usage", "--remote-allow-origins=*",
  "--no-first-run", "--disable-extensions", "--disable-sync", "--user-data-dir=" + PERFIL,
  // la vista dividida reserva 240..900 px al panel: en la ventana mínima de headless el editor no
  // cabría y el separador no tendría recorrido
  "--window-size=1440,900",
  "--remote-debugging-port=" + PUERTO, URL_PAGINA,
], { stdio: ["ignore", "pipe", "pipe"] });
let salidaNavegador = "";
navegador.stderr.on("data", (d) => { salidaNavegador += d.toString(); });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Puerto de debug real: con `--remote-debugging-port=0` lo elige chromium y lo deja en
// `DevToolsActivePort` del perfil. Leerlo evita acoplarse a un puerto fijo donde podría seguir vivo
// un chromium de otra corrida.
function puertoDevtools() {
  try {
    const primera = fs.readFileSync(path.join(PERFIL, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
    const n = Number(primera);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) { return null; }
}

async function target() {
  for (let i = 0; i < 60; i++) {
    // si el navegador que lanzamos ya murió (p. ej. no pudo abrir el debugger), decirlo en vez de
    // esperar 30 s o, peor, hablar con otro chromium que escuche en el puerto
    if (navegador.exitCode !== null) {
      throw new Error("chromium se cerró antes de abrir el debugger (¿puerto " + PUERTO +
        " ocupado?):\n" + salidaNavegador.slice(0, 2000));
    }
    const puerto = PUERTO === "0" ? puertoDevtools() : Number(PUERTO);
    if (puerto) {
      try {
        const lista = await (await fetch("http://127.0.0.1:" + puerto + "/json/list")).json();
        const p = lista.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:" + HTTP_PORT));
        if (p) return p;
      } catch (e) { /* aun no escucha */ }
    }
    await esperar(500);
  }
  throw new Error("chromium no subio el debugger:\n" + salidaNavegador.slice(0, 2000));
}

const conductor = `(async () => {
  const r = {};
  const sa = (f) => { try { return f(); } catch (e) { return "EXCEPCION: " + e.message; } };
  r.aislada = crossOriginIsolated;
  r.recarga = sessionStorage.getItem("apkc-coi-reintento");
  r.titulo = document.title;
  r.lang = document.documentElement.lang;
  const salto = document.querySelector(".skip-link");
  r.salto = salto ? salto.textContent.trim() : "";
  r.principal = document.getElementById("area-principal")?.tabIndex ?? null;
  r.vistas = [...document.querySelectorAll(".pestana-vista")].map((b) => b.textContent.trim());
  r.actividad = [...document.querySelectorAll(".actividad [data-vista]")].map((b) => b.dataset.vista);

  // el nombre del formulario se refleja en la barra de título y en el explorador
  const nombre = document.querySelector('[name="name"]');
  nombre.value = "Prueba"; nombre.dispatchEvent(new Event("input", { bubbles: true }));
  r.tituloTrasNombre = document.getElementById("titulo-proyecto").textContent;
  const paquete = document.querySelector('[name="package"]');
  paquete.value = "com.prueba.app"; paquete.dispatchEvent(new Event("input", { bubbles: true }));
  r.paqueteLateral = document.getElementById("lateral-proyecto").textContent;
  r.icono = !!document.getElementById("icono");

  // las pestañas cambian la vista sin recargar
  document.querySelector('.pestana-vista[data-vista="pestana"]').click();
  r.editorVisible = document.getElementById("pestana").classList.contains("activa") &&
    !document.getElementById("crear").classList.contains("activa");
  r.estadoBarra = document.getElementById("estado-general").textContent;
  // la tercera vista: pestaña, botón de actividad y su sección, sin wasm (aquí solo es DOM)
  document.querySelector('.pestana-vista[data-vista="vista"]').click();
  r.vistaPreviaVisible = document.getElementById("vista").classList.contains("activa") &&
    !document.getElementById("pestana").classList.contains("activa");
  r.estadoPrevia = document.getElementById("estado-general").textContent;
  r.avisoPrevia = document.getElementById("vista-previa-estado").textContent;
  r.canvasPrevia = !!document.getElementById("vista-previa");
  r.pantalla = {
    modos: [document.getElementById("vista-modo-previa").textContent,
      document.getElementById("vista-modo-emulador").textContent],
    tiradores: document.querySelectorAll("#marco-vista-lado .tirador-previa").length,
    log: !!document.getElementById("vista-log-lista"),
    canvas: !!document.getElementById("vista-layout-canvas"),
  };
  document.querySelector('.pestana-vista[data-vista="crear"]').click();
  r.vueltaInicio = document.getElementById("crear").classList.contains("activa");

  // la vista dividida: editor a la izquierda y teléfono a la derecha, con un separador que se
  // mueve con el teclado y se recuerda. Sin wasm ni OPFS esto es solo DOM: el panel avisa de que
  // no hay layout y la consola de «sin ejecución», sin reventar.
  const previa = (() => {
    const separador = document.getElementById("separador-previa");
    const panel = document.getElementById("previa-lateral");
    const fila = document.getElementById("editor-fila");
    const boton = document.getElementById("previa-alternar");
    const modoVivo = document.getElementById("previa-modo-vivo");
    const modoRender = document.getElementById("previa-modo-render");
    if (!separador || !panel || !fila || !boton || !modoVivo || !modoRender) return null;
    const anchoInicial = separador.getAttribute("aria-valuenow");
    separador.focus();
    separador.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    const trasIzquierda = Number(separador.getAttribute("aria-valuenow"));
    separador.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const trasDerecha = Number(separador.getAttribute("aria-valuenow"));
    const guardado = localStorage.getItem("apkc-studio/previa-ancho");
    modoRender.click();
    const enRender = {
      vivo: document.getElementById("previa-vivo").hidden,
      render: document.getElementById("previa-render").hidden,
      seleccion: [modoVivo.getAttribute("aria-selected"), modoRender.getAttribute("aria-selected")],
      vacio: document.getElementById("previa-log-vacio").textContent,
      vacioVisible: !document.getElementById("previa-log-vacio").hidden,
      cabecera: document.getElementById("previa-log-cabecera").textContent,
      entradas: document.getElementById("previa-log-lista").children.length,
      estado: document.getElementById("previa-render-estado").textContent,
    };
    modoVivo.click();
    const enVivo = {
      vivo: document.getElementById("previa-vivo").hidden,
      render: document.getElementById("previa-render").hidden,
      estado: document.getElementById("previa-vivo-estado").textContent,
      canvas: !!document.getElementById("previa-vivo-canvas"),
      modoGuardado: localStorage.getItem("apkc-studio/previa-modo"),
    };
    const codigo = document.querySelector("#previa-lateral pre");
    boton.click();
    const oculto = {
      panel: panel.hidden,
      separador: separador.hidden,
      expandido: boton.getAttribute("aria-expanded"),
      guardado: localStorage.getItem("apkc-studio/previa-visible"),
    };
    boton.click();
    const visibleOtraVez = !panel.hidden && !separador.hidden &&
      boton.getAttribute("aria-expanded") === "true";
    return {
      rol: separador.getAttribute("role"),
      orientacion: separador.getAttribute("aria-orientation"),
      enfocable: separador.tabIndex,
      minimo: separador.getAttribute("aria-valuemin"),
      anchoInicial, trasIzquierda, trasDerecha, guardado,
      enRender, enVivo, oculto, visibleOtraVez,
      codigoEnPanel: !!codigo,
      editorSigue: !!document.getElementById("codigo"),
      visible: !panel.hidden,
    };
  })();
  r.previa = previa;
  r.tiradoresPrevia = document.querySelectorAll("#marco-previa .tirador-previa").length;
  r.modosPrevia = [document.getElementById("previa-modo-vivo").textContent,
    document.getElementById("previa-modo-render").textContent];
  // el menú de opciones: las dos superficies montan el botón de tres puntos y su desplegable. Sin
  // compilar no hay ejecución, así que pulsarlo pide compilar en vez de inventar un menú; el enganche
  // se comprueba aquí, y los ítems reales en las pruebas de apkc y de la pestaña.
  const botonMenu = document.getElementById("previa-menu-opciones");
  const botonMenuVista = document.getElementById("vista-menu-opciones");
  const listaMenu = document.getElementById("previa-menu-lista");
  if (botonMenu) botonMenu.click();
  r.menu = {
    panel: !!botonMenu,
    vista: !!botonMenuVista,
    lista: !!listaMenu,
    etiqueta: botonMenu ? botonMenu.getAttribute("aria-label") : "",
    titulo: botonMenu ? botonMenu.title : "",
    desplegable: botonMenu ? botonMenu.getAttribute("aria-haspopup") : "",
    controles: botonMenu ? botonMenu.getAttribute("aria-controls") : "",
    expandido: botonMenu ? botonMenu.getAttribute("aria-expanded") : "",
    oculto: listaMenu ? listaMenu.hidden : null,
    estado: document.getElementById("previa-render-estado").textContent,
  };
  r.avisoEstrecho = getComputedStyle(document.getElementById("previa-aviso-estrecho")).display;
  r.cursorOeste = getComputedStyle(document.getElementById("tirador-previa-noroeste")).cursor;
  r.cursorSur = getComputedStyle(document.getElementById("tirador-previa-sur")).cursor;
  r.canvasDeLaPrevia = document.querySelectorAll("canvas.previa-canvas").length;

  // sin cabeceras del servidor, el SW debió aislar la página y el create tiene que funcionar
  document.getElementById("crear-proyecto").click();
  await new Promise((ok) => setTimeout(ok, 1200));
  r.avisoCrear = document.getElementById("estado-crear").textContent;
  r.sinUndefined = !/undefined/.test(document.body.innerText);

  // el rastreo local, que es lo único que la página guarda
  r.localStorage = sa(() => { localStorage.setItem("apkc-studio-prueba", "1");
    const v = localStorage.getItem("apkc-studio-prueba"); localStorage.removeItem("apkc-studio-prueba");
    return v === "1" ? "funciona" : "leyo null"; });

  // el diagnóstico explica una salida real de apkc sin sacarla del navegador
  document.getElementById("salida-apkc").value =
    "[build] aapt2 compile never started: pipe: not implemented on js\\n" +
    "[build] mensaje nuevo sin explicar xyz";
  document.getElementById("analizar-salida").click();
  await new Promise((ok) => setTimeout(ok, 300));
  const resultado = document.getElementById("resultado-analisis");
  r.diagnosticoVisible = !resultado.hidden;
  r.diagnostico = resultado.textContent;
  r.informe = !document.getElementById("descargar-informe").hidden;
  const enlaceInforme = document.getElementById("descargar-informe");
  enlaceInforme.click();
  r.informeTexto = enlaceInforme.href.startsWith("blob:")
    ? (await (await fetch(enlaceInforme.href)).text()).slice(0, 4000) : "";

  // temas: el selector cambia data-tema y la paleta del terminal
  const temaUI = document.getElementById("tema-ui");
  const temaTerm = document.getElementById("tema-consola");
  temaUI.value = "catppuccin";
  temaUI.dispatchEvent(new Event("change", { bubbles: true }));
  temaTerm.value = "rose-pine";
  temaTerm.dispatchEvent(new Event("change", { bubbles: true }));
  CONSOLA.escribir("\u001b[31mrojo\\u001b[0m");
  const colorTerm = document.querySelector(".consola .consola-fg-1");
  const compacto = document.getElementById("botones-iconos");
  compacto.checked = true;
  compacto.dispatchEvent(new Event("change", { bubbles: true }));
  const textoGuardar = document.querySelector("#guardar-fichero .texto-boton");
  r.temas = {
    ui: document.documentElement.dataset.tema,
    term: document.documentElement.dataset.temaConsola,
    opcionesUI: temaUI.options.length,
    opcionesTerm: temaTerm.options.length,
    colorTerm: colorTerm ? getComputedStyle(colorTerm).color : "sin color",
    botones: document.documentElement.dataset.botones,
    oculto: textoGuardar ? getComputedStyle(textoGuardar).display : "sin texto",
  };
  compacto.checked = false;
  compacto.dispatchEvent(new Event("change", { bubbles: true }));
  const fuente = document.getElementById("fuente-editor");
  fuente.value = "16";
  fuente.dispatchEvent(new Event("change", { bubbles: true }));
  r.fuente = getComputedStyle(document.getElementById("codigo")).fontSize;
  r.avisoAlmacenamiento = (document.getElementById("aviso-almacenamiento") || {}).textContent || "";
  return r;
})()`;

let fallos = 0;
function comprueba(cond, msg) { if (!cond) { fallos++; console.log("  FALLO:", msg); } }

(async () => {
  const t = await target();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket fallo")); });
  let id = 0;
  const esperando = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && esperando.has(m.id)) { const { res } = esperando.get(m.id); esperando.delete(m.id); res(m); }
  });
  const exec = (method, params) => new Promise((res) => {
    const n = ++id;
    esperando.set(n, { res });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });

  await exec("Runtime.enable");
  for (let i = 0; i < 20; i++) {
    const probe = await exec("Runtime.evaluate", { expression: "typeof buildProject === 'function' && typeof RULES === 'object'" });
    if (probe.result && probe.result.value === true) break;
    await esperar(400);
  }

  const r = await exec("Runtime.evaluate", { expression: conductor, awaitPromise: true, returnByValue: true });
  const v = r.result && r.result.result && r.result.result.value;
  if (r.result && r.result.exceptionDetails)
    console.log("  FALLO: excepcion en la pagina:", JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails).slice(0, 300));
  if (!v) { console.log("  FALLO: el conductor no devolvio nada", JSON.stringify(r).slice(0, 300)); fallos++; }
  else {
    console.log("  ui:", v.titulo, "| pestañas:", JSON.stringify(v.vistas), "| actividad:", JSON.stringify(v.actividad));
    console.log("  inicio:", v.tituloTrasNombre, "|", v.paqueteLateral, "| editor:", v.editorVisible,
      "| aviso:", String(v.avisoCrear).slice(0, 120));
    comprueba(/apkc studio/.test(v.titulo), "el título no nombra el studio: " + v.titulo);
    comprueba(v.lang === "es" && /Saltar/.test(v.salto) && v.principal === -1,
      "falta el enlace de salto o el destino con foco programable: " +
        JSON.stringify({ lang: v.lang, salto: v.salto, principal: v.principal }));
    comprueba(v.vistas.join(",") === "Inicio,Editor,Pantalla", "las pestañas no son las tres medidas: " + v.vistas);
    comprueba(v.actividad.join(",") === "crear,pestana,vista", "la barra de actividad no tiene las tres vistas: " + v.actividad);
    comprueba(v.tituloTrasNombre === "Prueba", "el nombre no llegó a la barra de título: " + v.tituloTrasNombre);
    comprueba(v.paqueteLateral === "com.prueba.app", "el package no llegó al explorador: " + v.paqueteLateral);
    comprueba(v.editorVisible, "la pestaña Editor no se abrió");
    comprueba(v.estadoBarra === "Editor", "la barra de estado no dijo Editor: " + v.estadoBarra);
    comprueba(v.vistaPreviaVisible && v.estadoPrevia === "Pantalla" && v.canvasPrevia,
      "la vista previa no abre su sección: " + JSON.stringify(v));
    comprueba(/[Cc]ompila/.test(String(v.avisoPrevia)),
      "sin apk, la vista previa no pide compilar: " + JSON.stringify(v.avisoPrevia));
    // la vista Pantalla tiene las mismas dos lecturas y la misma consola que la vista dividida,
    // con sus ocho tiradores para redimensionar
    comprueba(v.pantalla && v.pantalla.modos.join(",") === "Vista previa,Emulador" &&
      v.pantalla.tiradores === 8 && v.pantalla.log === true && v.pantalla.canvas === true,
      "la vista Pantalla no trae los dos modos, la consola y sus tiradores: " + JSON.stringify(v.pantalla));
    comprueba(v.vueltaInicio, "no se pudo volver a Inicio");
    // la vista dividida: el separador es un separador de verdad, se mueve con el teclado, se
    // recuerda, y el panel alterna entre XML y render sin perder el editor
    const pv = v.previa || {};
    comprueba(pv.rol === "separator" && pv.orientacion === "vertical" && pv.enfocable === 0 &&
      pv.minimo === "240" && pv.visible === true && pv.editorSigue === true,
      "el separador de la vista dividida no declara su contrato: " + JSON.stringify(pv).slice(0, 240));
    const ancho0 = Number(pv.anchoInicial);
    comprueba(Number.isFinite(ancho0) && pv.trasIzquierda === ancho0 + 16 &&
      pv.trasDerecha === ancho0 && pv.guardado === String(ancho0),
      "el separador no se mueve con las flechas ni guarda el ancho: " + JSON.stringify({ ancho0,
        izquierda: pv.trasIzquierda, derecha: pv.trasDerecha, guardado: pv.guardado }));
    comprueba(pv.enRender && pv.enRender.vivo === true && pv.enRender.render === false &&
      pv.enRender.seleccion.join(",") === "false,true" && pv.enRender.entradas === 0 &&
      pv.enRender.vacioVisible === true && /[Cc]ompila/.test(String(pv.enRender.vacio)) &&
      pv.enRender.cabecera === "sin ejecución",
      "el modo render no esconde el modo en vivo ni deja la consola con su motivo: " + JSON.stringify(pv.enRender).slice(0, 300));
    comprueba(pv.enVivo && pv.enVivo.vivo === false && pv.enVivo.render === true &&
      pv.enVivo.modoGuardado === "vivo" && pv.enVivo.canvas === true &&
      /[Aa]bre un res\/layout/.test(String(pv.enVivo.estado)),
      "volver a «Vista previa» no restaura su canvas ni guarda el modo: " + JSON.stringify(pv.enVivo).slice(0, 240));
    comprueba(pv.codigoEnPanel === false,
      "el panel de la previa enseña código (un <pre>) en vez del layout dibujado");
    comprueba(pv.oculto && pv.oculto.panel === true && pv.oculto.separador === true &&
      pv.oculto.expandido === "false" && pv.oculto.guardado === "0" && pv.visibleOtraVez === true,
      "el botón Previa no oculta ni vuelve a mostrar el panel: " + JSON.stringify(pv.oculto));
    comprueba(v.canvasDeLaPrevia === 4,
      "faltan canvas (Pantalla en vivo y emulador, y la vista dividida en vivo y emulador: deben ser cuatro): " +
      v.canvasDeLaPrevia);
    comprueba(v.tiradoresPrevia === 8 && v.modosPrevia.join(",") === "Vista previa,Emulador" &&
      v.cursorOeste === "nwse-resize" && v.cursorSur === "row-resize",
      "la vista dividida no tiene sus ocho tiradores, sus nombres o sus cursores: " +
      JSON.stringify({ tiradores: v.tiradoresPrevia, modos: v.modosPrevia,
        cursorOeste: v.cursorOeste, cursorSur: v.cursorSur }));
    // el menú de opciones se monta en las dos superficies y, sin ejecución, pide compilar
    comprueba(v.menu && v.menu.panel && v.menu.vista && v.menu.lista &&
      v.menu.desplegable === "menu" && v.menu.controles === "previa-menu-lista" &&
      v.menu.expandido === "false" && v.menu.oculto === true &&
      /men[uú] de opciones/i.test(String(v.menu.etiqueta)) &&
      /onCreateOptionsMenu/.test(String(v.menu.titulo)) &&
      /[Cc]ompila/.test(String(v.menu.estado)),
      "el menú de opciones del emulador no está montado o no pide compilar sin ejecución: " +
      JSON.stringify(v.menu));
    comprueba(v.icono, "falta el campo del icono");
    // Sin APKC_WASM esta prueba es solo de DOM: basta con que el SW haya aislado la página y el
    // create no culpe a OPFS. Con el binario presente (es lo que hace e2e.sh) tiene que crear.
    const creo = /proyecto creado/.test(String(v.avisoCrear));
    comprueba(v.aislada === true && v.recarga === "1" &&
      (WASM ? creo : !/OPFS/.test(String(v.avisoCrear))),
      "sin cabeceras, el SW no recuperó el aislamiento ni pudo crear: " +
        JSON.stringify({ aislada: v.aislada, recarga: v.recarga, aviso: v.avisoCrear }));
    comprueba(v.sinUndefined, "quedó un 'undefined' visible en la página");
    comprueba(v.localStorage === "funciona", "localStorage en http: " + v.localStorage);
    comprueba(v.diagnosticoVisible && /herramienta-no-arranca/.test(String(v.diagnostico)),
      "el diagnóstico no explicó el muro de aapt2: " + String(v.diagnostico).slice(0, 160));
    comprueba(/navegador no puede hablar con un proceso/.test(String(v.diagnostico)),
      "el diagnóstico no dice por qué el build clásico no corre en wasm: " + String(v.diagnostico).slice(0, 160));
    comprueba(v.informe, "el diagnóstico no ofreció el informe descargable");
    comprueba(/l[ií]neas sin explicar/.test(String(v.informeTexto)) &&
      /sin explicar xyz/.test(String(v.informeTexto)),
      "el informe agregado no contó la línea no reconocida: " + String(v.informeTexto).slice(0, 200));
    comprueba(v.temas && v.temas.ui === "catppuccin" && v.temas.term === "rose-pine",
      "los temas no se aplican: " + JSON.stringify(v.temas));
    comprueba(v.temas && v.temas.opcionesUI >= 4 && v.temas.opcionesTerm >= 4,
      "faltan temas en los selectores: " + JSON.stringify(v.temas));
    comprueba(/235, 111, 146/.test(String(v.temas && v.temas.colorTerm)),
      "el tema de terminal no cambia la paleta ANSI: " + String(v.temas && v.temas.colorTerm));
    comprueba(v.temas && v.temas.botones === "iconos" && v.temas.oculto === "none",
      "el modo solo iconos no oculta el texto: " + JSON.stringify(v.temas));
    comprueba(v.fuente === "16px", "el tamaño del editor no llega al código: " + String(v.fuente));
    comprueba(/OPFS/.test(String(v.avisoAlmacenamiento)) &&
      /Exportar proyecto/.test(String(v.avisoAlmacenamiento)),
      "falta el aviso de que el proyecto vive en este navegador: " + String(v.avisoAlmacenamiento).slice(0, 160));
  }
  ws.close();
  navegador.kill("SIGKILL");
  servidor.close();
  fs.rmSync(PERFIL, { recursive: true, force: true });
  console.log(fallos ? "navegador: " + fallos + " problemas" : "navegador: todo en orden");
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.log("  FALLO: " + e.message);
  navegador.kill("SIGKILL");
  servidor.close();
  fs.rmSync(PERFIL, { recursive: true, force: true });
  process.exit(1);
});
