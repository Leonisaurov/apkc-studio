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

// El android.jar no se versiona: se lee del SDK local, como hace `servidor.js`. La prueba completa
// de la pestaña lo sirve por su propio origen para que el build de wasm pueda compilar.
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

const servidor = http.createServer((peticion, respuesta) => {
  const ruta = decodeURIComponent((peticion.url || "/").split("?")[0]);
  // el jar del SDK y su ficha, solo si hay wasm: sin binario la prueba es de DOM y no compila
  if (WASM && ruta === "/android-jar-info") {
    const jar = jarDelSdk();
    const version = jar ? Number((/android-(\d+)/.exec(path.basename(path.dirname(jar))) || [])[1]) : null;
    respuesta.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return void respuesta.end(JSON.stringify({
      disponible: !!jar, version, bytes: jar ? fs.statSync(jar).size : 0,
    }));
  }
  if (WASM && ruta === "/android-jar") {
    const jar = jarDelSdk();
    if (!jar) {
      respuesta.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return void respuesta.end("no hay android.jar del SDK local\n");
    }
    respuesta.writeHead(200, { "Content-Type": "application/java-archive" });
    return void respuesta.end(fs.readFileSync(jar));
  }
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
// brave deja procesos hijos vivos un instante después del SIGKILL y siguen escribiendo en el
// perfil: sin reintentos, el borrado lanza ENOTEMPTY y convierte un veredicto verde en un fallo
// del propio guion. No oculta nada del veredicto, que ya está calculado cuando se llama.
const borrarPerfil = () => fs.rmSync(PERFIL,
  { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
borrarPerfil();

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
  const HAY_WASM = ${WASM ? "true" : "false"};
  const sa = (f) => { try { return f(); } catch (e) { return "EXCEPCION: " + e.message; } };
  // Abre un desplegable de menú y espera a que la lista tenga contenido. El modelo de la compilación
  // puede llegar un instante después de #ultimo-codigo: si la lista sigue cerrada se reintenta; si
  // está abierta pero vacía, se devuelve vacía (el fallo se explica en la comprobación).
  const abrirMenuYEsperar = async (botonId, listaId, intentos = 8) => {
    const boton = document.getElementById(botonId);
    const lista = document.getElementById(listaId);
    if (!boton || !lista) return [];
    for (let i = 0; i < intentos; i++) {
      if (lista.hidden) boton.click();
      await new Promise((ok) => setTimeout(ok, 900));
      if (!lista.hidden) break;
    }
    return [...lista.children].map((b) => b.textContent);
  };
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
  // la capa del Toast se monta con el panel y empieza oculta; su contenido llega del modelo
  const capaToast = document.getElementById("previa-toast");
  const capaToastVista = document.getElementById("vista-toast");
  r.toastCapa = {
    panel: !!capaToast,
    vista: !!capaToastVista,
    oculto: capaToast ? capaToast.hidden : null,
    rol: capaToast ? capaToast.getAttribute("role") : "",
    vivo: capaToast ? capaToast.getAttribute("aria-live") : "",
    texto: capaToast ? capaToast.textContent : "",
  };
  // soltar un fichero en las tres superficies del emulador: el enganche tiene que estar en los tres
  // canvas, el drop no puede dejar que el navegador se quede el fichero, y un apk soltado en
  // Pantalla tiene que verse (barra con el nombre, después el resultado) y quedar en el registro.
  // La imagen se mide por su efecto: el estado y el registro no cambian y no se importa nada.
  const soltar = {};
  const estados = () => ({
    vista: document.getElementById("vista-previa-estado").textContent,
    panel: document.getElementById("previa-render-estado").textContent,
  });
  const progreso = (id) => {
    const caja = document.getElementById(id);
    if (!caja) return { falta: true };
    const rotulo = caja.querySelector(".previa-progreso-texto");
    return { visible: !caja.hidden, texto: rotulo ? rotulo.textContent : "" };
  };
  const registro = () => String(document.getElementById("vista-log-lista").textContent || "");
  const conFichero = (canvas, archivo) => {
    const dt = new DataTransfer();
    dt.items.add(archivo);
    const sobre = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    canvas.dispatchEvent(sobre);
    const marca = canvas.classList.contains("previa-canvas-recibiendo");
    const salir = new Event("dragleave", { bubbles: true });
    canvas.dispatchEvent(salir);
    return { sobre: sobre.defaultPrevented, marca,
      marcaTrasSalir: canvas.classList.contains("previa-canvas-recibiendo") };
  };
  const apk = (nombre) => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], nombre,
    { type: "application/vnd.android.package-archive" });
  const soltarEn = (canvas, archivo) => {
    const dt = new DataTransfer();
    dt.items.add(archivo);
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: 12, clientY: 12 });
    canvas.dispatchEvent(drop);
    return drop.defaultPrevented;
  };
  for (const id of ["previa-vivo-canvas", "previa-lateral-canvas", "vista-previa"]) {
    const canvas = document.getElementById(id);
    soltar[id] = canvas ? conFichero(canvas, apk(id + ".apk")) : null;
    soltar[id + "-pista"] = canvas ? String(canvas.title) : "";
  }
  const vista = document.getElementById("vista-previa");
  // un fichero que no es apk ni imagen: el drop se cancela (el navegador no lo abre) y no cambia
  // nada de la página, que es el efecto que se mide, no el flag
  const antesImagen = estados();
  const antesRegistro = registro();
  soltar.imagenSoltada = soltarEn(vista, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    "foto.png", { type: "image/png" }));
  await new Promise((ok) => setTimeout(ok, 150));
  soltar.imagen = {
    estadoIgual: JSON.stringify(estados()) === JSON.stringify(antesImagen),
    registroIgual: registro() === antesRegistro,
    progresoOculto: !progreso("vista-previa-progreso").visible,
  };
  // fichero roto: se rechaza con su nombre y su motivo; la barra se ve al menos un instante
  soltar.rotoSoltado = soltarEn(vista, new File([new Uint8Array([1, 2, 3, 4])], "roto.apk",
    { type: "application/octet-stream" }));
  soltar.rotoCarga = progreso("vista-previa-progreso");
  await new Promise((ok) => setTimeout(ok, 120));
  soltar.rotoCarga120 = progreso("vista-previa-progreso");
  await new Promise((ok) => setTimeout(ok, 400));
  soltar.roto = {
    progreso: progreso("vista-previa-progreso"),
    estado: document.getElementById("vista-previa-estado").textContent,
    registro: registro(),
  };
  // apk válido: barra con el nombre en las tres superficies y, al terminar, el resultado en el
  // marco, en la línea de estado y en el registro
  soltar.apk = { soltado: soltarEn(vista, apk("vista-previa.apk")) };
  soltar.apkCarga = {
    vista: progreso("vista-previa-progreso"),
    vivo: progreso("previa-vivo-progreso"),
    lateral: progreso("previa-lateral-progreso"),
  };
  await new Promise((ok) => setTimeout(ok, 120));
  soltar.apkCarga120 = progreso("vista-previa-progreso");
  await new Promise((ok) => setTimeout(ok, 1200));
  soltar.apkFin = {
    progreso: progreso("vista-previa-progreso"),
    estado: document.getElementById("vista-previa-estado").textContent,
    registro: registro(),
  };
  r.soltar = soltar;
  r.avisoEstrecho = getComputedStyle(document.getElementById("previa-aviso-estrecho")).display;
  r.cursorOeste = getComputedStyle(document.getElementById("tirador-previa-noroeste")).cursor;
  r.cursorSur = getComputedStyle(document.getElementById("tirador-previa-sur")).cursor;
  r.canvasDeLaPrevia = document.querySelectorAll("canvas.previa-canvas").length;
  // El detalle del modelo es una línea de solo lectura: no puede capturar el puntero, o la vista
  // del canvas que caiga bajo ella (el botón «id/pulsar» del panel dividido) deja de responder al
  // clic. La caja del inspector y su cabecera ya se declaran transparentes por el mismo motivo.
  r.punteroDetalleModelo = getComputedStyle(document.getElementById("previa-detalle-modelo")).pointerEvents;
  r.punteroInspector = getComputedStyle(document.getElementById("previa-inspector")).pointerEvents;

  // sin cabeceras del servidor, el SW debió aislar la página y el create tiene que funcionar. Con
  // APKC_WASM se crea la plantilla «Menú de opciones» para compilarla y probar su Toast sobre el
  // teléfono; sin binario la prueba sigue siendo solo de DOM y se queda en «Hola mundo».
  if (HAY_WASM) {
    const plantilla = document.getElementById("plantilla");
    if (plantilla) {
      plantilla.value = "menu";
      plantilla.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  document.getElementById("crear-proyecto").click();
  await new Promise((ok) => setTimeout(ok, 1200));
  r.avisoCrear = document.getElementById("estado-crear").textContent;

  // La plantilla real «Menú de opciones»: compilar en wasm, abrir ⋮ Menú, pulsar «Opciones» y exigir
  // que «Menu pulsado» se vea como capa sobre el emulador, no solo en la consola. Se hace en las dos
  // superficies porque las dos comparten el modelo y el resumen.
  if (HAY_WASM) {
    document.querySelector('.pestana-vista[data-vista="pestana"]').click();
    document.getElementById("compilar-debug").click();
    for (let i = 0; i < 240; i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      const c = (document.getElementById("ultimo-codigo").textContent || "").trim();
      if (c && c !== "—" && c !== "…") break;
    }
    r.codigoMenu = (document.getElementById("ultimo-codigo").textContent || "").trim();
    r.salidaMenu = (document.getElementById("consola-pestana").textContent || "").slice(-800);
    r.estadoPestana = (document.getElementById("estado-pestana").textContent || "").slice(-300);
    await new Promise((ok) => setTimeout(ok, 1500));
    // Pantalla → Emulador
    document.querySelector('.pestana-vista[data-vista="vista"]').click();
    document.getElementById("vista-modo-emulador").click();
    await new Promise((ok) => setTimeout(ok, 900));
    const canvasVista = document.getElementById("vista-previa");
    r.canvasToastAntes = canvasVista ? [canvasVista.width, canvasVista.height] : null;
    r.menuItems = await abrirMenuYEsperar("vista-menu-opciones", "vista-menu-lista");
    const listaMenu = document.getElementById("vista-menu-lista");
    if (listaMenu && listaMenu.children.length) {
      listaMenu.children[0].click();
      await new Promise((ok) => setTimeout(ok, 700));
    }
    const toast = document.getElementById("vista-toast");
    r.toast = {
      texto: toast ? toast.textContent : "",
      oculto: toast ? toast.hidden : null,
      rol: toast ? toast.getAttribute("role") : "",
      vivo: toast ? toast.getAttribute("aria-live") : "",
      posicion: toast ? getComputedStyle(toast).position : "",
      puntero: toast ? getComputedStyle(toast).pointerEvents : "",
      consola: (document.getElementById("vista-consola-lista").textContent || "").slice(-200),
      estado: (document.getElementById("vista-previa-estado").textContent || "").slice(0, 200),
    };
    r.canvasToastDespues = canvasVista ? [canvasVista.width, canvasVista.height] : null;
    // el emulador del panel dividido
    document.querySelector('.pestana-vista[data-vista="pestana"]').click();
    document.getElementById("previa-modo-render").click();
    await new Promise((ok) => setTimeout(ok, 700));
    const canvasPanel = document.getElementById("previa-lateral-canvas");
    r.canvasPanelAntes = canvasPanel ? [canvasPanel.width, canvasPanel.height] : null;
    r.menuItemsPanel = await abrirMenuYEsperar("previa-menu-opciones", "previa-menu-lista");
    const listaPanel = document.getElementById("previa-menu-lista");
    if (listaPanel && listaPanel.children.length) {
      listaPanel.children[0].click();
      await new Promise((ok) => setTimeout(ok, 700));
    }
    const toastPanel = document.getElementById("previa-toast");
    r.toastPanel = {
      texto: toastPanel ? toastPanel.textContent : "",
      oculto: toastPanel ? toastPanel.hidden : null,
    };
    r.canvasPanelDespues = canvasPanel ? [canvasPanel.width, canvasPanel.height] : null;
    // efímero: pasados unos segundos, las dos capas se retiran solas sin repintar el canvas
    await new Promise((ok) => setTimeout(ok, 3200));
    r.toastTarde = {
      pantalla: (document.getElementById("vista-toast") || {}).hidden,
      panel: (document.getElementById("previa-toast") || {}).hidden,
    };
    // y un repintado del MISMO modelo no lo resucita: cambiar de modo y volver no lo enseña otra vez
    document.getElementById("previa-modo-vivo").click();
    document.getElementById("previa-modo-render").click();
    await new Promise((ok) => setTimeout(ok, 500));
    r.toastTardeRepintado = {
      pantalla: (document.getElementById("vista-toast") || {}).hidden,
      panel: (document.getElementById("previa-toast") || {}).hidden,
    };
  }
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
    comprueba(v.punteroInspector === "none" && v.punteroDetalleModelo === "none",
      "el detalle del modelo no deja pasar el clic al canvas que hay debajo (debe ser transparente " +
      "al puntero, como la caja del inspector): " +
      JSON.stringify({ inspector: v.punteroInspector, detalle: v.punteroDetalleModelo }));
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
    comprueba(v.toastCapa && v.toastCapa.panel && v.toastCapa.vista &&
      v.toastCapa.oculto === true && v.toastCapa.texto === "" &&
      v.toastCapa.rol === "status" && v.toastCapa.vivo === "polite",
      "la capa del Toast no está montada y oculta en las dos superficies: " +
      JSON.stringify(v.toastCapa));
    // soltar un apk: las tres superficies lo aceptan, el de Pantalla llega a abrirApkSoltada y el
    // fichero roto se rechaza con nombre y motivo sin tocar OPFS
    const sl = v.soltar || {};
    for (const id of ["previa-vivo-canvas", "previa-lateral-canvas", "vista-previa"]) {
      const uno = sl[id];
      comprueba(uno && uno.sobre === true && uno.marca === true && uno.marcaTrasSalir === false,
        "soltar un fichero no se engancha en " + id + " (dragover sin preventDefault o sin marca): " +
        JSON.stringify(uno));
      comprueba(/Suelta un \.apk/.test(String(sl[id + "-pista"])),
        "el canvas " + id + " no avisa de que se puede soltar un apk: " + String(sl[id + "-pista"]));
    }
    // un fichero que no es apk no puede cambiar nada: se mide el efecto, no el flag
    comprueba(sl.imagenSoltada === true,
      "el drop de un fichero que no se usa no cancela el navegador: soltarlo abriría el documento y " +
      "sacaría al usuario del editor sin guardar");
    comprueba(sl.imagen && sl.imagen.estadoIgual === true && sl.imagen.registroIgual === true &&
      sl.imagen.progresoOculto === true,
      "soltar una imagen en Pantalla cambió la página o abrió el progreso: " +
      JSON.stringify(sl.imagen));
    // la carga del fichero roto se ve antes del rechazo, con su nombre
    comprueba(sl.rotoCarga && sl.rotoCarga.visible === true &&
      /^Abriendo roto\.apk/.test(String(sl.rotoCarga.texto)),
      "soltar un apk no muestra la barra con el nombre del fichero: " + JSON.stringify(sl.rotoCarga));
    comprueba(sl.rotoCarga120 && sl.rotoCarga120.visible === true &&
      /Abriendo roto\.apk/.test(String(sl.rotoCarga120.texto)),
      "la barra de carga desaparece antes de verse (mínimo de 250 ms): " +
      JSON.stringify(sl.rotoCarga120));
    comprueba(sl.roto && /no se carg[oó] roto\.apk/.test(String(sl.roto.progreso && sl.roto.progreso.texto)) &&
      /no es un zip/.test(String(sl.roto.progreso && sl.roto.progreso.texto)) &&
      /no se carg[oó] roto\.apk/.test(String(sl.roto.estado)) &&
      /soltar:/.test(String(sl.roto.registro)) && /roto\.apk/.test(String(sl.roto.registro)),
      "el rechazo no queda en el marco, en la línea de estado y en el registro: " +
      JSON.stringify(sl.roto));
    // el apk válido: barra con el nombre en las tres superficies y el resultado al terminar
    const carga = sl.apkCarga || {};
    const superficies = ["vista", "vivo", "lateral"];
    comprueba(superficies.every((k) => carga[k] && carga[k].visible === true &&
      /^Abriendo vista-previa\.apk/.test(String(carga[k].texto))),
      "la barra de carga no aparece en las tres superficies: " + JSON.stringify(carga));
    comprueba(carga.vivo && carga.lateral && carga.vivo.texto === carga.vista.texto &&
      carga.lateral.texto === carga.vista.texto,
      "las tres superficies no enseñan el mismo texto de carga: " + JSON.stringify(carga));
    comprueba(sl.apkCarga120 && sl.apkCarga120.visible === true &&
      /Abriendo vista-previa\.apk/.test(String(sl.apkCarga120.texto)),
      "la barra del apk válido se apaga antes de verse: " + JSON.stringify(sl.apkCarga120));
    const fin = sl.apkFin || {};
    const resultado = String(fin.progreso && fin.progreso.texto);
    comprueba(/APK soltado vista-previa\.apk|no se pudo abrir vista-previa\.apk/.test(resultado) &&
      String(fin.estado) === resultado &&
      /soltar:/.test(String(fin.registro)) && /vista-previa\.apk/.test(String(fin.registro)),
      "el resultado del apk no queda en el marco, en la línea de estado y en el registro: " +
      JSON.stringify(fin));
    console.log("  soltar:", JSON.stringify({ carga: sl.apkCarga, fin: sl.apkFin, roto: sl.roto,
      imagen: sl.imagen }).slice(0, 700));
    // Sin APKC_WASM esta prueba es solo de DOM: basta con que el SW haya aislado la página y el
    // create no culpe a OPFS. Con el binario presente (es lo que hace e2e.sh) tiene que crear.
    const creo = /proyecto creado/.test(String(v.avisoCrear));
    comprueba(v.aislada === true && v.recarga === "1" &&
      (WASM ? creo : !/OPFS/.test(String(v.avisoCrear))),
      "sin cabeceras, el SW no recuperó el aislamiento ni pudo crear: " +
        JSON.stringify({ aislada: v.aislada, recarga: v.recarga, aviso: v.avisoCrear }));
    // la plantilla Menú y su Toast sobre el teléfono, con el binario presente
    if (WASM) {
      comprueba(v.codigoMenu === "0",
        "la plantilla Menú no compiló: " + JSON.stringify({ codigo: v.codigoMenu,
          salida: String(v.salidaMenu).slice(-300) }));
      comprueba(v.menuItems && v.menuItems.join(",") === "Opciones",
        "la plantilla Menú no publicó «Opciones»: " + JSON.stringify(v.menuItems));
      comprueba(v.toast && v.toast.texto === "Menu pulsado" && v.toast.oculto === false &&
        v.toast.rol === "status" && v.toast.vivo === "polite" &&
        v.toast.posicion === "absolute" && v.toast.puntero === "none",
        "el Toast no se ve sobre el emulador de Pantalla o no es una capa: " + JSON.stringify(v.toast));
      comprueba(/Menu pulsado/.test(String(v.toast && v.toast.consola)),
        "la consola perdió el historial del Toast: " + JSON.stringify(v.toast));
      comprueba(v.toastPanel && v.toastPanel.texto === "Menu pulsado" &&
        v.toastPanel.oculto === false,
        "el Toast no se ve sobre el emulador del panel: " + JSON.stringify(v.toastPanel));
      comprueba(JSON.stringify(v.canvasToastAntes) === JSON.stringify(v.canvasToastDespues),
        "el Toast cambió el tamaño del canvas de Pantalla: " +
        JSON.stringify({ antes: v.canvasToastAntes, despues: v.canvasToastDespues }));
      comprueba(JSON.stringify(v.canvasPanelAntes) === JSON.stringify(v.canvasPanelDespues),
        "el Toast cambió el tamaño del canvas del panel: " +
        JSON.stringify({ antes: v.canvasPanelAntes, despues: v.canvasPanelDespues }));
      comprueba(v.toastTarde && v.toastTarde.pantalla === true && v.toastTarde.panel === true,
        "el Toast no desaparece solo pasados unos segundos: " + JSON.stringify(v.toastTarde));
      comprueba(v.toastTardeRepintado && v.toastTardeRepintado.pantalla === true &&
        v.toastTardeRepintado.panel === true,
        "un repintado del mismo modelo resucitó el Toast caducado: " +
        JSON.stringify(v.toastTardeRepintado));
      console.log("  toast:", JSON.stringify({ pantalla: v.toast, panel: v.toastPanel }).slice(0, 500));
    } else {
      console.log("  toast: sin APKC_WASM, se omite la compilación de la plantilla Menú");
    }
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
  borrarPerfil();
  console.log(fallos ? "navegador: " + fallos + " problemas" : "navegador: todo en orden");
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.log("  FALLO: " + e.message);
  navegador.kill("SIGKILL");
  servidor.close();
  borrarPerfil();
  process.exit(1);
});
