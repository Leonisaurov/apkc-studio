// El worker que hace correr apkc.wasm en la pestaña: da el fs con forma de Node que exige
// Go (fs-fragmento.js, respaldado en OPFS), carga el binario y ejecuta un comando cada vez.
//
// Por qué worker y no hilo principal: los access handles sincrónicos de OPFS solo existen en
// un DedicatedWorker, y es lo que permite escribir en una posición concreta como hacen las
// syscalls de Go. Sin esto la página tendría un fs de mentira en memoria y perdería el
// proyecto al recargar.
//
// wasm_exec.js viene del GOROOT de quien construyó el binario y lo sirve servidor.js desde
// /wasm_exec.js: no se copia ni se versiona (regla 2 del repo).
import { crearFs } from "./fs-fragmento.js";

// Cabecera de un módulo wasm: 00 61 73 6d. Un cuerpo truncado puede venir con 200 y pasar el
// `ok` del fetch, así que se comprueba antes de confiar en los bytes.
const magicoWasm = (b) => b && b.length > 7 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;

let sistema = null;            // { fs, montar, extraer, lista, ... } — se asigna AL FINAL del init
let arranque = null;           // la promesa del init en curso: ver iniciar()
let bytesModule = null;        // los bytes del wasm, una sola bajada; la instancia no se reutiliza
let recuperadoPorTrozos = false; // avisa a la página si la copia cacheada estaba incompleta
let errorWasmExec = null;      // el motivo por el que no se pudo cargar wasm_exec.js
// El contrato del núcleo WISP es el mismo que congeló la página (wisp.js): el worker solo anuncia
// el núcleo cuando el wasm que se está corriendo lo registró en globalThis.
const CONTRATO_WISP = "apkc-wisp/1";
// Marca de la única línea que `apkc wisp-get` escribe en stdout: el resto de la
// consola del comando (incluido el cierre) va a stderr y no debe llegar al DOM.
const MARCA_WISP_GET = "APKC_WISP_GET:";
let nucleoWispActivo = false;
let silenciarSalida = false;
// Una sola instancia de Go viva para la sesión del emulador. El contador SOLO se sube donde se
// crea la instancia (WebAssembly.instantiate): es la prueba de que un swap no levanta otra máquina.
let instanciasWasm = 0;
// Instancias creadas para el id de sesión actual. Se pone a cero solo cuando cambia el build/apk;
// cerrar a propósito (falsación) conserva la cuenta para que la segunda instancia se vea como 2.
let instanciasSesion = 0;
let cerradaAProposito = null; // id de la sesión cerrada por la falsación, no por cambio de build
let sesion = null;            // { id, go, corriendo, codigo }
let ordenes = [];             // órdenes nuevas para el bucle Go, una por invocación
const finOrdenes = new Map(); // id de orden → { resuelve }; lo llena `ejecutar`, lo vacía `fin-orden`
let siguienteOrden = 0;
let ultimoPreview = null;     // argv del `preview` que abrió la sesión: de aquí sale la apk
let localeArranque = "";      // idioma de ese arranque: viaja a la sesión por APKC_SESION_LOCALE
let ocupado = false;
let cola = [];
let entregarRaiz = null;
const raizPrometida = new Promise((resuelve) => { entregarRaiz = resuelve; });

// Un mutex de arranque, no un `if (sistema) return`: dos mensajes seguidos (por ejemplo el `leer` con
// que la página pregunta si ya hay un android.jar guardado y el `arbol` del arranque, o un `montar`
// y un `ejecutar`) pasaban ambos por el guard antes de que `sistema` estuviera asignado, creaban dos
// fs, y el comando quedaba enlazado al `globalThis.fs` de uno mientras la respuesta se leía de la
// consola del otro. El síntoma era un código de salida 1 con la consola vacía, y ficheros de cero
// bytes tras recargar: lo que docs/evidencia.md tenía anotado como intermitencia de OPFS (§39).
function iniciar() {
  if (sistema) return Promise.resolve();
  if (!arranque) {
    arranque = hacerIniciar().catch((e) => { arranque = null; throw e; });
  }
  return arranque;
}

async function hacerIniciar() {
  if (!crossOriginIsolated) {
    // sin COOP/COEP el handle sincrónico no está disponible; el síntoma es un TypeError dentro
    // del fs, que parece un fallo de apkc
    throw new Error("la página no es crossOriginIsolated: hay que abrirla por http con las cabeceras de servidor.js");
  }
  // navigator.storage vive en el hilo principal y en el worker es undefined (comprobado en este
  // chromium), mientras que createSyncAccessHandle solo existe en el worker: la página baja el
  // mango de OPFS y nos lo pasa por mensaje, que es lo que permite espejar los bytes
  const raiz = await raizPrometida;
  const nuevo = crearFs(raiz);
  // Go escribe en el fd 1 del fs, no en process.stdout: la consola del fs es el único punto por
  // el que pasa toda la salida. Se envuelve aquí para que la página la pinte mientras corre.
  const escribirConsola = nuevo.consola.escribir;
  nuevo.consola.escribir = (trozo) => {
    escribirConsola(trozo);
    // `wisp-get` devuelve el artefacto en base64 dentro de una línea; ese trozo
    // se lee de `consola.volcar()` al terminar, no se pinta en la consola de la
    // página. El buffer sigue llenándose para que el parseo funcione igual.
    if (!silenciarSalida) postMessage({ tipo: "salida", texto: String(trozo) });
  };

  // el fs y el process que Go consulta: hay que sustituirlos antes de ejecutar nada
  globalThis.fs = nuevo.fs;
  globalThis.path = {
    resolve: (...partes) => {
      const uno = partes.length ? partes.join("/") : nuevo.cwd();
      return uno.startsWith("/") ? uno : "/" + uno.replace(/^\/+/, "");
    },
    isAbsolute: (p) => String(p).startsWith("/"),
    dirname: (p) => { const a = String(p), i = a.lastIndexOf("/"); return i <= 0 ? "/" : a.slice(0, i); },
    basename: (p) => String(p).slice(String(p).lastIndexOf("/") + 1),
    sep: "/",
    join: (...p) => "/" + p.join("/").replace(/\/+/g, "/").replace(/^\/+/, ""),
  };
  globalThis.process = {
    cwd: () => nuevo.cwd(),
    chdir: (p) => nuevo.chdir(p),
    argv: [], env: {}, exitCode: 0,
    getuid: () => 1000, getgid: () => 1000, geteuid: () => 1000, getegid: () => 1000,
    getgroups: () => [], umask: () => 0o22,
    platform: "browser", arch: "wasm",
    on: () => {}, exit: () => {},
    stdout: { write: (b) => nuevo.consola.escribir(String(b)) },
    stderr: { write: (b) => nuevo.consola.escribir(String(b)) },
  };
  // performance y crypto NO se reasignan: en un worker de módulo ya son globales del
  // WorkerGlobalScope y son de solo lectura (asignarlos lanza "has only a getter", y ese error
  // tapaba por completo el arranque). El shim de node sí necesita ponerlos, porque allí no hay
  // entorno de navegador.
  await nuevo.sincronizar();          // el árbol que ya estaba en OPFS, dentro de la memoria
  await cargarWasmExec();

  // se asigna aqui y no al principio: mientras el arranque esté a medias, un mensaje que llegue
  // tiene que volver a pasar por iniciar(). Asignar antes del import dejaba `sistema` puesto sin
  // Go cargado, y el fallo aparecía veinte mensajes tarde como "Go is not defined"
  sistema = nuevo;
}

// wasm_exec.js es un script (asigna globalThis.Go dentro de un IIFE), no un módulo: se importa
// igual porque no exporta nada y su efecto es esa asignación; importScripts() no existe en un
// worker de tipo module. El motivo de un fallo se guarda para que el sondeo lo pueda decir.
async function cargarWasmExec() {
  if (typeof globalThis.Go === "function") return;
  try {
    await import("/wasm_exec.js");
  } catch (e) {
    errorWasmExec = "el import de /wasm_exec.js falló: " + String((e && e.message) || e);
    throw e;
  }
  if (typeof globalThis.Go !== "function") {
    errorWasmExec = "/wasm_exec.js se importó pero no definió globalThis.Go";
    throw new Error(errorWasmExec);
  }
  errorWasmExec = null;
}

// un comando por vez: el binario de Go en wasm no es reentrante, así que lo que llegue mientras
// corre espera su turno en lugar de pisar el fs compartido
function enCola(tarea) {
  // la cola se despierta al encolar, no solo al terminar: la primera tarea de la página se
  // quedaba dentro para siempre si nadie la empujaba (la prueba colgaba sin decir nada)
  return new Promise((resuelve) => { cola.push({ tarea, resuelve }); descolocar(); });
}

function descolocar() {
  if (ocupado || !cola.length) return;
  ocupado = true;
  const { tarea, resuelve } = cola.shift();
  tarea()
    .then(resuelve, (e) => resuelve({ ok: false, error: String((e && e.message) || e) }))
    .then(() => { ocupado = false; descolocar(); });
}

// --- la sesión viva del emulador --------------------------------------------------------------
// Contrato con el bucle Go de `apkc preview --sesion <apk>`:
//   · recibe la apk y el id en `go.argv` al crear la instancia (una sola vez);
//   · pregunta por trabajo con `js.Global().Get("apkcSesion").Call("siguiente")`, que devuelve un
//     JSON `{id, argv}` con la orden NUEVA, o "" si no hay ninguna;
//   · al terminar esa orden publica, desde este mismo worker,
//     `js.Global().Call("postMessage", map[string]any{"tipo":"apkc:fin-orden","id":id,"codigo":code})`.
// Un `postMessage` del worker llega a la página, no al worker: `pestana.js` lo reenvía aquí como
// `{tipo:"fin-orden",...}`. Así `consola.volcar()` entrega el modelo sin que `go.run` retorne.

function argumentoDe(argv, bandera) {
  if (!Array.isArray(argv)) return null;
  const i = argv.indexOf(bandera);
  return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : null;
}

// El contador de la sesión se pone a cero SOLO cuando cambia el id (otro build u otra apk). Un
// cierre a propósito del MISMO id es la falsación: debe conservar la cuenta para que la próxima
// instancia se vea como 2. Pura para poder falsarla en node sin levantar el worker.
export function reiniciarContadorDeSesion({ mismoId, cerradaAProposito, id } = {}) {
  return !mismoId && cerradaAProposito !== id;
}

function limpiarTimeouts(go) {
  if (go && go._scheduledTimeouts) {
    for (const id of go._scheduledTimeouts.values()) clearTimeout(id);
    go._scheduledTimeouts.clear();
  }
}

function anunciarNucleo(activo) {
  nucleoWispActivo = activo;
  postMessage({ tipo: "wisp-nucleo", activo, contrato: CONTRATO_WISP });
}

function fallarOrdenes(motivo) {
  for (const [id, pendiente] of finOrdenes) {
    pendiente.resuelve({ ok: false, error: motivo, codigo: -1,
      consola: sistema ? sistema.consola.volcar() : "", instanciasWasm });
  }
  finOrdenes.clear();
}

// Arranca la sesión si no hay una con este id, encola la orden nueva y espera su `fin-orden`.
// El apk NO viaja en la orden: sale del `preview` anterior que guardó `ultimoPreview`.
async function usarSesion(id, argv) {
  const i = argv.indexOf("--sesion");
  const orden = { id: ++siguienteOrden, argv: argv.slice(i + 2) };
  ordenes.push(orden);
  if (!sesion || sesion.id !== id) {
    const mismoId = !!sesion && sesion.id === id;
    if (sesion) await cerrarSesion();
    if (reiniciarContadorDeSesion({ mismoId, cerradaAProposito, id })) instanciasSesion = 0;
    cerradaAProposito = null;
    if (!ultimoPreview || ultimoPreview[0] !== "preview") {
      ordenes.length = 0;
      throw new Error("la sesión necesita un preview anterior con la apk: abre una apk o compila primero");
    }
    const go = new Go();
    // El locale viaja en el entorno, no como bandera: `preview --sesion` solo registra `-sesion` y
    // un `--locale` repetido en el argv de arranque haría fallar su FlagSet. La sesión lo lee una
    // sola vez y lo conserva en las órdenes vivas, que no llevan esa bandera (§326).
    const arranque = ultimoPreview.slice(1);
    const sinLocale = [];
    for (let i = 0; i < arranque.length; i++) {
      if (arranque[i] === "--locale") { i += 1; continue; }
      sinLocale.push(arranque[i]);
    }
    go.argv = ["apkc", "preview", "--sesion", id, ...sinLocale];
    go.env = {
      HOME: "/home/usuario", ANDROID_HOME: "/android", JAVA_HOME: "/jvm",
      APKC_SESION_ID: id,
      APKC_SESION_LOCALE: localeArranque,
    };
    go.exit = (c) => {
      // Resolver _exitPromise aquí mataría la máquina en la primera orden: la sesión vive hasta
      // cerrarSesion(). Se guarda el código y se limpian temporizadores, como hace el shim.
      if (sesion && sesion.go === go) sesion.codigo = c;
      limpiarTimeouts(go);
    };
    // `bytesModule` ya está cargado: `ejecutar` lo baja antes de llamar aquí.
    const { instance } = await WebAssembly.instantiate(bytesModule.slice(0), go.importObject);
    instanciasWasm += 1;
    instanciasSesion += 1;
    globalThis.apkcSesion = {
      id,
      // El bucle Go pregunta por trabajo; "" significa «sigue esperando».
      siguiente: () => (ordenes.length ? JSON.stringify(ordenes.shift()) : ""),
    };
    anunciarNucleo(true);
    const viva = { id, go, corriendo: null, codigo: null };
    sesion = viva;
    viva.corriendo = go.run(instance).then(
      () => {
        if (sesion === viva) { sesion = null; fallarOrdenes("la sesión wasm terminó sin cerrarse"); }
      },
      (e) => {
        if (sesion === viva) {
          sesion = null;
          fallarOrdenes("la sesión wasm falló: " + String((e && e.message) || e));
        }
      },
    );
  }
  return new Promise((resuelve) => { finOrdenes.set(orden.id, { resuelve }); });
}

// Cierre explícito: es el ÚNICO sitio que resuelve `_exitPromise` de la sesión. Devuelve si había
// una sesión viva; `forzarNuevaInstancia` se apoya en él para falsar el contador.
async function cerrarSesion({ forzar = false } = {}) {
  const viva = sesion;
  if (!viva) return false;
  // La falsación cierra la sesión sin cambiar de build: se recuerda el id para NO reiniciar el
  // contador en `usarSesion`. Un cierre normal sí lo reinicia en la próxima orden.
  if (forzar) cerradaAProposito = viva.id;
  sesion = null;
  ordenes.length = 0;
  try { delete globalThis.apkcSesion; } catch (e) { globalThis.apkcSesion = undefined; }
  fallarOrdenes("la sesión se cerró antes de terminar la orden");
  limpiarTimeouts(viva.go);
  try { viva.go._resolveExitPromise(); } catch (e) { /* ya estaba resuelta */ }
  try { await viva.corriendo; } catch (e) { /* la sesión ya estaba rota */ }
  anunciarNucleo(false);
  return true;
}

async function ejecutar(argv, env, idSesion) {
  // Un `preview` clásico (sin `--sesion`) abre o sustituye la máquina: cierra la sesión anterior y
  // recuerda su argv para que la primera orden viva sepa qué apk tiene que interpretar.
  if (Array.isArray(argv) && argv[0] === "preview" && !idSesion) {
    // Solo un preview clásico sustituye la máquina. Una orden con `--sesion` DEBE conservarla:
    // cerrar aquí convertiría cada clic en un arranque nuevo y el timeline volvería a empezar.
    if (sesion) await cerrarSesion();
    ultimoPreview = argv.slice();
    localeArranque = argumentoDe(argv, "--locale") || "";
  }

  if (!bytesModule) {
    // El manifiesto fija tamaño y SHA-256. Se intenta la copia normal (healthy), después la red
    // con `?directo=` (el SW la deja pasar sin tocarla) y, si el host trunca respuestas grandes,
    // se reconstruye el fichero con peticiones Range de 256 KB, medida que sí llega entera.
    let manifest = null;
    try {
      const r = await fetch("/wasm-manifest.json");
      if (r.ok) manifest = await r.json();
    } catch (e) { /* sin manifiesto: solo se comprueba la cabecera wasm */ }
    const huella = async (bytes) => {
      if (typeof crypto === "undefined" || !crypto.subtle) return null;
      const h = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const íntegro = async (c) => {
      if (!magicoWasm(c) || c.length < 1024) return false;
      if (manifest && manifest.bytes && c.length !== manifest.bytes) return false;
      if (manifest && manifest.sha256) {
        const h = await huella(c);
        if (h && h !== manifest.sha256) return false;
      }
      return true;
    };
    const descomprime = async (gz) => {
      if (typeof DecompressionStream !== "function") return null;
      const llano = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(llano).arrayBuffer());
    };
    const pruebaGz = async (gz) => {
      const c = await descomprime(gz);
      if (!c || !(await íntegro(c))) return false;
      bytesModule = c;
      return true;
    };
    const entero = async (ruta, comprimido) => {
      try {
        const r = await fetch(ruta);
        if (!r.ok) return false;
        const b = new Uint8Array(await r.arrayBuffer());
        const cl = Number(r.headers.get("content-length") || 0);
        if (cl && b.length !== cl) return false;
        return comprimido ? pruebaGz(b) : (await íntegro(b) ? (bytesModule = b, true) : false);
      } catch (e) {
        console.warn("no se pudo cargar", ruta + ":", e && e.message ? e.message : e);
        return false;
      }
    };
    const porRangos = async (ruta, total, comprimido) => {
      const TROZO = 262144;
      const bytes = new Uint8Array(total);
      let pos = 0;
      for (let ini = 0; ini < total; ini += TROZO) {
        const fin = Math.min(ini + TROZO, total) - 1;
        try {
          const r = await fetch(ruta + (ruta.indexOf("?") < 0 ? "?" : "&") +
            "directo=" + Date.now() + "-" + ini, { headers: { Range: "bytes=" + ini + "-" + fin } });
          if (r.status !== 206 && !r.ok) return false;
          const b = new Uint8Array(await r.arrayBuffer());
          if (b.length !== fin - ini + 1) return false;
          bytes.set(b, pos); pos += b.length;
        } catch (e) { return false; }
      }
      if (comprimido) {
        if (manifest && manifest.gzSha256) {
          const h = await huella(bytes);
          if (h && h !== manifest.gzSha256) return false;
        }
        const bien = await pruebaGz(bytes);
        if (bien) recuperadoPorTrozos = true;
        return bien;
      }
      if (!(await íntegro(bytes))) return false;
      bytesModule = bytes;
      recuperadoPorTrozos = true;
      return true;
    };

    if (!await entero("/apkc.wasm.gz", true)) {
      if (!manifest || !manifest.gzBytes || !await porRangos("/apkc.wasm.gz", manifest.gzBytes, true)) {
        if (!await entero("/apkc.wasm", false)) {
          if (!manifest || !manifest.bytes || !await porRangos("/apkc.wasm", manifest.bytes, false)) {
            throw new Error("no se pudo bajar un apkc.wasm íntegro: usa Reparar caché en Ajustes o recarga con Ctrl+Mayús+R");
          }
        }
      }
    }
    if (recuperadoPorTrozos) {
      postMessage({ tipo: "aviso", texto: "apkc.wasm se reconstruyó por trozos: la copia guardada estaba incompleta." });
    }
  }
  // Con id de sesión NO se crea una instancia nueva por orden: se reutiliza la viva y solo se
  // entrega el paso nuevo. Los bytes ya están cargados aquí arriba.
  if (idSesion) return usarSesion(idSesion, argv);

  // Sin sesión, la instancia se crea CADA VEZ: un binario de Go en wasm no puede volver a correrse
  // sobre la misma instancia después de salir, así que lo que se guarda son los bytes.
  const go = new Go();
  go.argv = ["apkc", ...argv];
  go.env = { HOME: "/home/usuario", ANDROID_HOME: "/android", JAVA_HOME: "/jvm", ...(env || {}) };
  let codigo = null;
  // run() espera _exitPromise y quien lo resuelve es la implementación POR DEFECTO de this.exit:
  // sustituir go.exit sin resolverla deja la promesa sin terminar (el mismo error que en el shim)
  go.exit = (c) => {
    codigo = c;
    // descartar los temporizadores pendientes, como en el shim: reanidar un programa que ya
    // salio lanza "Go program has already exited" dentro del worker
    if (go._scheduledTimeouts) {
      for (const id of go._scheduledTimeouts.values()) clearTimeout(id);
      go._scheduledTimeouts.clear();
    }
    go._resolveExitPromise();
  };
  const { instance } = await WebAssembly.instantiate(bytesModule.slice(0), go.importObject);
  instanciasWasm += 1;
  // El binario del fork registra apkcWisp en globalThis de este worker. La página no puede verlo:
  // se lo anuncia por mensaje para que instale el puente, y se lo retira cuando el wasm termina.
  // `wisp-get` es un disparo único que lee la petición de go.env: no debe anunciarse como núcleo
  // vivo, así que se conserva `nucleoWispActivo=false` y no se manda el mensaje de activación.
  const anunciaNucleo = argv[0] !== "wisp-get";
  if (anunciaNucleo) {
    nucleoWispActivo = true;
    postMessage({ tipo: "wisp-nucleo", activo: true, contrato: CONTRATO_WISP });
  }
  try {
    await go.run(instance);
  } finally {
    // un build mientras la sesión del emulador está viva no puede apagar su núcleo WISP: el
    // js.Func de la sesión sigue vivo aunque este comando clásico ya haya terminado.
    if (anunciaNucleo && !sesion) {
      nucleoWispActivo = false;
      postMessage({ tipo: "wisp-nucleo", activo: false, contrato: CONTRATO_WISP });
    }
  }
  return { ok: true, codigo: codigo === null ? 1 : codigo,
    consola: sistema.consola.volcar(), instanciasWasm };
}

self.onmessage = async (evento) => {
  const m = evento.data || {};
  try {
    // antes de cualquier init: iniciar() espera precisamente este mensaje, y procesarlo después
    // del await sería un bloqueo mutuo (la página no recibiría nunca respuesta)
    if (m.tipo === "raiz") {
      entregarRaiz(m.raiz);
      return void postMessage({ id: m.id, tipo: "raiz-recibida" });
    }
    await iniciar();
    if (m.tipo === "montar") {
      const r = await enCola(() => sistema.montar(m.ruta, new Uint8Array(m.datos)));
      // un fallo de la cola NO son bytes: entregarlo como si lo fuera convierte un error del
      // fs en un TypeError de TextDecoder tres pasos más lejos, que es imposible de leer
      if (r && r.ok === false) return void postMessage({ id: m.id, tipo: "error", error: r.error });
      return void postMessage({ id: m.id, tipo: "montado", ruta: m.ruta, bytes: r });
    }
    if (m.tipo === "leer") {
      const r = await enCola(() => sistema.extraer(m.ruta));
      if (r && r.ok === false) return void postMessage({ id: m.id, tipo: "error", error: r.error });
      // la tarea devuelve LOS BYTES, no un envoltorio: pedir r.bytes aquí era devolver siempre
      // null y que la página viera ficheros vacíos
      return void postMessage({ id: m.id, tipo: "contenido", ruta: m.ruta, bytes: r || null });
    }
    if (m.tipo === "rango") {
      const r = await enCola(() => sistema.rango(m.ruta, m.desde, m.largo));
      if (!r || r.ok === false) {
        return void postMessage({ id: m.id, tipo: "error", error: (r && r.error) || "no se pudo leer el rango" });
      }
      // solo el trozo pedido, más el tamaño total: el autocompletado del android.jar no copia 50 MB
      return void postMessage({ id: m.id, tipo: "rango", ruta: m.ruta, bytes: r.bytes, tamano: r.tamano });
    }
    if (m.tipo === "cwd") {               // apkc build no recibe ruta: trabaja donde esté el proceso
      try { sistema.chdir(m.ruta); } catch (e) { return void postMessage({ id: m.id, tipo: "error", error: String(e && e.message || e) }); }
      return void postMessage({ id: m.id, tipo: "cwd", ruta: sistema.cwd() });
    }
    if (m.tipo === "limpiar") {
      const r = await enCola(() => sistema.limpiar(m.ruta));
      return void postMessage({ id: m.id, tipo: "limpiado", ruta: m.ruta, ...r });
    }
    if (m.tipo === "refrescar") {
      const r = await enCola(() => sistema.recargar(m.ruta));
      if (r && r.ok === false) return void postMessage({ id: m.id, tipo: "error", error: r.error });
      return void postMessage({ id: m.id, tipo: "refrescado", ruta: m.ruta, ...r });
    }
    if (m.tipo === "renombrar") {
      const r = await enCola(() => sistema.renombrar(m.de, m.a));
      if (r && r.ok === false) return void postMessage({ id: m.id, tipo: "error", error: r.error });
      return void postMessage({ id: m.id, tipo: "renombrado", de: m.de, a: m.a });
    }
    if (m.tipo === "arbol") {
      return void postMessage({ id: m.id, tipo: "arbol", nodos: sistema.lista(), aislada: crossOriginIsolated });
    }
    // El bucle Go publica `apkc:fin-orden` por postMessage; la página lo reenvía aquí. NO pasa por
    // la cola: solo despierta la promesa de la orden que ya estaba esperando su modelo.
    if (m.tipo === "fin-orden") {
      const clave = finOrdenes.has(m.id) ? m.id : finOrdenes.keys().next().value;
      const pendiente = clave === undefined ? null : finOrdenes.get(clave);
      if (pendiente) {
        finOrdenes.delete(clave);
        pendiente.resuelve({
          ok: true,
          codigo: Number.isFinite(Number(m.codigo)) ? Number(m.codigo) : 0,
          consola: sistema.consola.volcar(),
          instanciasWasm, instanciasSesion,
        });
      }
      return void postMessage({ id: m.id, tipo: "fin-orden-recibido" });
    }
    if (m.tipo === "cerrar-sesion") {
      const cerrada = await cerrarSesion();
      return void postMessage({ id: m.id, tipo: "sesion-cerrada", cerrada, instanciasWasm, instanciasSesion });
    }
    if (m.tipo === "forzar-nueva-instancia") {
      // disparador de la falsación: cerrar a propósito obliga a la próxima orden a crear otra
      // instancia SIN reiniciar el contador, así que pasa de 1 a 2 (el caso negativo a rechazar).
      const cerrada = await cerrarSesion({ forzar: true });
      return void postMessage({ id: m.id, tipo: "instancia-forzada", cerrada, instanciasWasm, instanciasSesion });
    }
    if (m.tipo === "ejecutar") {
      const idSesion = argumentoDe(m.argv, "--sesion");
      const r = await enCola(() => ejecutar(m.argv, m.env, idSesion));
      // el resultado de la cola puede ser {ok:false,error}: eso es terminación con fallo, no
      // un fallo del hospedador; codigo=-1 lo deja claro para quien lea la consola
      const conCodigo = r && r.ok === false ? { ...r, codigo: -1 } : r;
      return void postMessage({ id: m.id, tipo: "terminado", ...conCodigo });
    }
    if (m.tipo === "wisp-get") {
      // La página en reposo pide un artefacto con un comando de un solo disparo.
      // No hay mutex propio: la cola de un comando por vez es la misma que usan
      // `ejecutar`, `montar` y el resto. La salida se silencia solo mientras corre
      // esta tarea para que el base64 no se pinte en la consola del editor.
      try {
        const r = await enCola(async () => {
          silenciarSalida = true;
          try {
            return await ejecutar(["wisp-get"], { APKC_WISP_REQ: JSON.stringify(m.payload || {}) });
          } finally {
            silenciarSalida = false;
          }
        });
        if (!r || r.ok === false || r.codigo !== 0) {
          const motivo = (r && typeof r.consola === "string" && r.consola.trim()) ||
            (r && r.error) || "wisp-get terminó sin éxito";
          return void postMessage({ id: m.id, tipo: "error", error: motivo });
        }
        const linea = String(r.consola || "").split("\n").find((l) => l.startsWith(MARCA_WISP_GET));
        if (!linea) {
          return void postMessage({ id: m.id, tipo: "error", error: "wisp-get no devolvió la línea con marca" });
        }
        const datos = JSON.parse(linea.slice(MARCA_WISP_GET.length));
        const binario = atob(datos.bytes);
        const bytes = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
        const buffer = bytes.buffer;
        return void postMessage({
          id: m.id, tipo: "wisp",
          respuesta: { bytes: buffer, sha256: datos.sha256, ruta: datos.ruta },
        }, [buffer]);
      } catch (e) {
        return void postMessage({ id: m.id, tipo: "error", error: String((e && e.message) || e) });
      }
    }
    if (m.tipo === "wisp") {
      if (m.metodo !== "obtener" && m.metodo !== "cargarCAs") {
        return void postMessage({ id: m.id, tipo: "error", error: "método WISP desconocido: " + m.metodo });
      }
      const nucleo = globalThis.apkcWisp;
      const funcion = nucleo && typeof nucleo[m.metodo] === "function" ? nucleo[m.metodo] :
        (m.metodo === "cargarCAs" ? globalThis.apkcWispCargarCAs : null);
      if (!nucleoWispActivo || typeof funcion !== "function") {
        // go.run terminó y con él el js.Func que el wasm registró: aunque la página haya dejado
        // el puente pegado, aquí no queda instancia viva a la que llamar. Falla cerrado con el
        // motivo, sin abrir socket desde un núcleo ya muerto.
        const motivo = nucleoWispActivo
          ? "núcleo WISP no activo en el hospedador"
          : "núcleo WISP sin instancia viva: el último comando terminó";
        return void postMessage({ id: m.id, tipo: "error", error: motivo });
      }
      try {
        const r = await funcion(m.payload);
        // El núcleo entrega un Uint8Array. Cambiar el dueño del buffer y transferirlo evita copiar
        // un artefacto de decenas de megabytes al cruzar al hilo principal.
        let respuesta = { ...r };
        if (r && r.bytes instanceof Uint8Array) {
          const u8 = r.bytes;
          const buffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          respuesta = { ...respuesta, bytes: buffer };
        }
        const transferencia = respuesta.bytes instanceof ArrayBuffer ? [respuesta.bytes] : [];
        return void postMessage({ id: m.id, tipo: "wisp", respuesta }, transferencia);
      } catch (e) {
        return void postMessage({ id: m.id, tipo: "error", error: String((e && e.message) || e) });
      }
    }
    if (m.tipo === "sondeo") {
      const nucleo = globalThis.apkcWisp;
      return void postMessage({
        id: m.id, tipo: "sondeo",
        haySistema: !!sistema, tipoGo: typeof globalThis.Go, aislada: crossOriginIsolated,
        errorWasmExec, bytesWasm: bytesModule ? bytesModule.length : 0,
        instanciasWasm, instanciasSesion,
        sesionActiva: !!sesion, idSesion: sesion ? sesion.id : null,
        // El puente de la página se activa SOLO por el contrato anunciado por el wasm, nunca por
        // `tipoGo` ni por `bytesWasm`: esos dos solo dicen que el cargador está vivo.
        contrato: nucleo && nucleo.version ? String(nucleo.version) : null,
        hayCAs: typeof globalThis.apkcWispCargarCAs === "function",
        nucleoActivo: nucleoWispActivo,
      });
    }
    postMessage({ id: m.id, tipo: "error", error: "mensaje sin tipo: " + m.tipo });
  } catch (e) {
    postMessage({ id: m.id, tipo: "error", error: String((e && e.message) || e) });
  }
};

postMessage({ tipo: "listo" });
