import { Historial } from "./historial.js";
import { fusionar } from "./fusion.js";
import { esXml, resaltar } from "./editor.js";
import { htmlConfiable, urlConfiable, enlaceConfiable } from "./tt.js";
import { crearBusqueda } from "./busqueda.js";
import { crearAjustes } from "./ajustes.js";
import { CONSOLA, pintarConsola, consolaHtml, textoHtml, enlazarSalidas,
  mostrarCarga, ocultarCarga, conCarga } from "./consola.js";
import { leerZip, normalizarEntradas, zipDelArbol, paqueteDelManifiesto, nombreDeZip,
  ajustesDelManifiesto, conAjustes, inflarConTope } from "./proyecto.js";
import { modeloDeSalida, pintarVistaPrevia, mensajeVistaPrevia, modeloActual } from "./vista-previa.js";
import { crearPreviaPanel, claseOyenteDe } from "./previa-panel.js";
import { crearPanelDeps } from "./deps.js";
import { guardarUltimaApk, EVENTO_ULTIMA_APK } from "./ultima-apk.js";
import { CONTRATO_NUCLEO } from "./wisp.js";
import { instalarPuenteWisp } from "./wisp-puente.js";
import { MODULOS, instanciaModulo } from "./paneles.js";

// La pestaña que hace: editor de fuente + un arbol en OPFS + los comandos de apkc.wasm.
//
// Todo lo que se escribe aquí se queda en el almacenamiento del propio navegador: no hay
// server al que subir el fuente ni el keystore. Lo que sí es nuevo respecto al generador de
// la sección 1 es que el que escribe ficheros ahora es apkc (en wasm), no esta página: la
// página solo edita lo que hay en el árbol y le pasa los comandos al worker.

const PROYECTO = "/proyecto";

// Comandos que la interfaz lanzó con `correr` y aún no terminaron. La cancelación del diagnóstico
// mataría el worker, así que se protege cualquier build, firma o compilación del usuario que esté
// en la misma cola: lo que se cancela es el check, no su trabajo.
let comandosDelUsuario = 0;

// Un fallo que se deja a propósito sin mensaje visible no puede ser invisible del todo: el `.catch`
// de las cáscaras de refresco y de historial lo deja por aquí con su contexto, en vez de tragárselo.
function falloSilencioso(contexto, e) {
  console.warn("[apkc] " + contexto + ": " + (e && e.message ? e.message : e));
}

const hospedador = (() => {
  // el worker se crea al primer uso, no al cargar el fichero: la prueba de node exige estas
  // funciones puras (el resaltador) y no tiene Worker ni document
  let worker = null, próximo = 1, alSalir = null;
  // id → { resuelve, temporizador, tipo }. El temporizador es el vigilante de ESA petición: un
  // worker mudo no puede dejar la página esperando para siempre (el velo de `conCarga` se retira
  // cuando la promesa se resuelve, aunque sea con error).
  const pendientes = new Map();
  // Sin respuesta en este tiempo, la petición se da por perdida. Es generoso porque un build en
  // wasm tarda, y cada mensaje del worker (la salida va llegando por trozos) lo reinicia.
  const ESPERA_WORKER = 20000;
  // Último fallo del worker. Un import que no carga se repite en cada intento, así que se recuerda
  // y se responde con él sin esperar al temporizador; `detener` (el botón del usuario) lo olvida.
  let roto = null;
  const fallo = (texto) => ({ tipo: "error", error: texto, mensaje: texto, consola: "" });
  const resolverPendiente = (id, valor) => {
    const pendiente = pendientes.get(id);
    if (!pendiente) return false;
    pendientes.delete(id);
    clearTimeout(pendiente.temporizador);
    pendiente.resuelve(valor);
    return true;
  };
  const vigilar = (id) => {
    const pendiente = pendientes.get(id);
    if (!pendiente) return;
    clearTimeout(pendiente.temporizador);
    pendiente.temporizador = setTimeout(() => {
      const texto = "el hospedador no respondió en " + Math.round(ESPERA_WORKER / 1000) + " s (" +
        (pendiente.tipo || "comando") + "): se ha reiniciado. Lo escrito en el proyecto sigue " +
        "guardado en el navegador.";
      roto = texto;
      for (const otro of [...pendientes.keys()]) resolverPendiente(otro, fallo(texto));
      try { if (worker) worker.terminate(); } catch (e) { /* ya estaba muerto */ }
      worker = null;
      puenteWisp.desactivar();
      raizPedida = null;
    }, ESPERA_WORKER);
  };
  // cualquier mensaje del worker es una señal de vida: reinicia el vigilante de lo que siga pendiente
  const senalDeVida = () => { for (const id of pendientes.keys()) vigilar(id); };
  const asegurar = () => {
    if (worker) return worker;
    worker = new Worker(urlConfiable("hospedador.js"), { type: "module" });   // module: el hospedador importa su fs con import
    // El módulo del worker puede no cargar (un 404, un import roto, COOP/COEP ausente). El
    // navegador lo avisa aquí y sin esto la promesa de `pedir` no se resolvería: el velo se queda
    // encima y el comando parece colgado.
    const morir = (detalle) => {
      const texto = "el hospedador no arrancó (" + (detalle || "el worker no cargó") +
        "): recarga la página y vuelve a intentarlo.";
      roto = texto;
      for (const id of [...pendientes.keys()]) resolverPendiente(id, fallo(texto));
      try { worker.terminate(); } catch (e) { /* ya estaba muerto */ }
      worker = null;
      puenteWisp.desactivar();
      raizPedida = null;
    };
    worker.addEventListener("error", (e) => {
      const evento = e && typeof e === "object" ? e : {};
      morir(String(evento.message || evento.filename || "").trim() || null);
    });
    // un mensaje que no se puede deserializar también deja el worker inservible para esa petición
    worker.addEventListener("messageerror", () => morir("mensaje ilegible del worker"));
    worker.onmessage = (e) => {
      senalDeVida();
      if (e.data && e.data.tipo === "salida") {
        if (alSalir) alSalir(String(e.data.texto || ""));
        return;
      }
      if (e.data && e.data.tipo === "aviso") {
        CONSOLA.escribir(String(e.data.texto || "") + "\n");
        return;
      }
      // El bucle Go publica el fin de cada orden con postMessage desde el worker. Un postMessage
      // del worker llega a la página, no al propio worker: se lo devolvemos como `fin-orden` para
      // que `consola.volcar()` entregue el modelo sin esperar a que `go.run` retorne.
      if (e.data && e.data.tipo === "apkc:fin-orden") {
        try {
          asegurar().postMessage({ tipo: "fin-orden", id: e.data.id, codigo: e.data.codigo });
        } catch (error) {
          falloSilencioso("apkc:fin-orden", error);
        }
        return;
      }
      // El núcleo WISP corre en el wasm del worker; la página solo lo ve cuando el binario lo
      // anuncia con su contrato. Un contrato distinto no instala nada: se queda sin núcleo.
      // El `activo:false` que el worker envía al terminar cada comando NO retira el puente: el
      // js.Func muere con go.run, pero la visibilidad del núcleo queda pegada tras el primer
      // contrato válido. Así `nucleoDisponible` sigue siendo verdadero en reposo, y un `obtener`
      // sin instancia viva falla cerrado en el hospedador con su motivo.
      if (e.data && e.data.tipo === "wisp-nucleo") {
        if (e.data.activo === false) return;
        try { puenteWisp.activar(e.data); }
        catch (error) {
          falloSilencioso("wisp-nucleo", error);
          puenteWisp.desactivar();
        }
        return;
      }
      resolverPendiente(e.data.id, e.data);
    };
    return worker;
  };
  const pedir = (mensaje) => new Promise((resuelve) => {
    if (roto) { resuelve(fallo(roto)); return; }
    const id = próximo++;
    pendientes.set(id, { resuelve, temporizador: 0, tipo: String(mensaje.tipo || "comando") });
    vigilar(id);
    try {
      asegurar().postMessage({ ...mensaje, id });
    } catch (e) {
      resolverPendiente(id, fallo("no se pudo hablar con el hospedador: " +
        (e && e.message ? e.message : e)));
    }
  });
  // El puente se crea aquí, después de `pedir`, porque necesita la función que pone el id y espera
  // la respuesta. No instala nada en globalThis hasta que llegue el mensaje `wisp-nucleo`.
  const puenteWisp = instalarPuenteWisp({
    global: globalThis,
    enviar: (mensaje) => pedir(mensaje),
    contrato: CONTRATO_NUCLEO,
  });
  // navigator.storage no existe dentro del worker, así que el mango raíz de OPFS lo baja la
  // página y se lo pasa al hospedador; sin esto el fs no tiene dónde escribir
  let raizPedida = null;
  const bajarRaiz = () => {
    if (raizPedida) return raizPedida;
    raizPedida = (async () => {
      if (!navigator.storage || !navigator.storage.getDirectory) {
        throw new Error("este navegador no expone OPFS (navigator.storage.getDirectory)");
      }
      const raiz = await navigator.storage.getDirectory();
      await pedir({ tipo: "raiz", raiz });
      return raiz;
    })();
    return raizPedida;
  };
  // matar el worker deja sin resolver lo que estuviera pendiente: el que pidió ese comando recibe
  // un error con nombre en vez de una promesa que nunca llega
  const detener = () => {
    if (!worker) { roto = null; return false; }
    try { worker.terminate(); } catch (e) { /* ya estaba muerto */ }
    worker = null;
    puenteWisp.desactivar();
    raizPedida = null;
    roto = null;
    for (const id of [...pendientes.keys()]) {
      resolverPendiente(id, fallo("comando detenido por el usuario"));
    }
    return true;
  };
  return {
    arbol: async () => { await bajarRaiz(); return pedir({ tipo: "arbol" }); },
    leer: async (ruta) => { await bajarRaiz(); return pedir({ tipo: "leer", ruta }); },
    // un trozo del fichero, sin copiarlo entero: el android.jar del autocompletado
    rango: async (ruta, desde, largo) => { await bajarRaiz(); return pedir({ tipo: "rango", ruta, desde, largo }); },
    escribir: async (ruta, datos) => { await bajarRaiz(); return pedir({ tipo: "montar", ruta, datos }); },
    ejecutar: async (argv) => { await bajarRaiz(); return pedir({ tipo: "ejecutar", argv }); },
    limpiar: async (ruta) => { await bajarRaiz(); return pedir({ tipo: "limpiar", ruta }); },
    refrescar: async (ruta) => { await bajarRaiz(); return pedir({ tipo: "refrescar", ruta }); },
    renombrar: async (de, a) => { await bajarRaiz(); return pedir({ tipo: "renombrar", de, a }); },
    cwd: async (ruta) => { await bajarRaiz(); return pedir({ tipo: "cwd", ruta }); },
    sondear: async () => { await bajarRaiz(); return pedir({ tipo: "sondeo" }); },
    // el puente de la página usa esta misma cola: el id y el vigilante los pone `pedir`
    wispLlamar: (metodo, payload) => pedir({ tipo: "wisp", metodo, payload }),
    // la vía de reposo: un solo disparo de `wisp-get` con la petición en go.env
    wispEnReposo: (payload) => pedir({ tipo: "wisp-get", payload }),
    // la salida llega por trozos mientras el comando corre; `correr` la pinta sin esperar al final
    escucharSalida(fn) { alSalir = fn; },
    // La sesión del emulador vive en el worker. Cerrarla es la única forma de resolver `_exitPromise`;
    // el siguiente `preview` con `--sesion` crea una instancia nueva (disparador del contador = 2).
    cerrarSesion: async () => { await bajarRaiz(); return pedir({ tipo: "cerrar-sesion" }); },
    forzarNuevaInstancia: async () => { await bajarRaiz(); return pedir({ tipo: "forzar-nueva-instancia" }); },
    instanciasWasm: async () => { await bajarRaiz(); const r = await pedir({ tipo: "sondeo" }); return r.instanciasWasm; },
    instanciasSesion: async () => { await bajarRaiz(); const r = await pedir({ tipo: "sondeo" }); return r.instanciasSesion; },
    // Go wasm no tiene kill: se termina el worker entero y se recrea en el siguiente comando. El
    // fs vive en OPFS, así que lo escrito hasta aquí no se pierde; el build puede quedar a medias.
    cancelar() { return detener(); },
    // la misma cancelación, pero solo si el worker no está haciendo nada que pidió el usuario.
    // La sonda de D5 (studio/sonda-check.js) la mide; el diagnóstico en vivo no la usa porque en la
    // pestaña no baja el tiempo (ver el comentario en diagnostico-vivo.js).
    cancelarSiNadieEspera() { return comandosDelUsuario > 0 ? false : detener(); },
    // leer con el error nombrado: si el fs falla, la página tiene que decir qué falló y no
    // dejar que un objeto de error se cuele como si fueran bytes
    async bytes(ruta) {
      const r = await this.leer(ruta);
      if (r.tipo === "error") throw new Error(ruta + ": " + r.error);
      return r.bytes ? (r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes)) : null;
    },
    async texto(ruta) {
      const b = await this.bytes(ruta);
      return b ? new TextDecoder().decode(b) : "";
    },
  };
})();

const estadoPestana = { ruta: null, nodo: null };

// Varias pestañas, como un editor de verdad: solo el documento activo vive en el textarea.
// Los limpios se descartan de memoria al cambiar y se releen de OPFS al volver; los sucios
// conservan su texto hasta que se guarden o se cierren.
const DOCUMENTOS = { lista: [], activa: null };
const CONFLICTO = { doc: null, datos: null };
const PERSISTENCIA = "apkc-studio/editor-v1";
// una activación lenta no puede pisar a la pestaña que se pulsó después
let activacion = 0;
// F1: la lectura de OPFS puede quedar en cola detrás de un build, y hasta que termina el
// textarea sigue con el buffer del documento anterior. Mientras este contador esté alto,
// `guardar` no escribe: la ruta activa ya es la nueva pero el contenido todavía no es suyo.
let cargandoDocumento = 0;

// F5: en esa misma ventana el documento nuevo todavía tiene `texto = null` y el textarea es del
// anterior. Aceptar una tecla ahí marcaba sucio el documento nuevo y la lectura posterior
// descartaba lo tecleado. La política es **rechazar la entrada** —ese texto pertenece al fichero
// anterior— con un aviso claro, y volver a admitir teclas al terminar la lectura. Las tres
// decisiones son puras para poder falsarlas en `prueba.js` sin DOM.
function rechazoTecleo(cargando) {
  return cargando ? "abriendo la pestaña: espera para escribir" : null;
}

// ¿Se acepta una entrada de teclado sobre `doc`? Con la pestaña cargando, no: el buffer no es suyo.
function aceptarEntrada(doc, cargando) {
  return !!doc && !cargando;
}

// Un documento sin texto en memoria no puede quedar sucio mientras dura la carga: `guardar`
// escribiría un buffer que no es suyo. Fuera de la carga sí se marca: un documento limpio también
// tiene `texto = null` hasta el siguiente `guardarEnMemoria`, y teclear debe ensuciarlo.
function puedeMarcarSucio(doc, cargando) {
  return !(cargando && doc && doc.texto === null);
}

// Identidad de esta ventana/pestaña del navegador. sessionStorage sobrevive a recargar y no se
// comparte entre ventanas nuevas; el árbol de deshacer se indexa por ella.
const VENTANA = (() => {
  try {
    let id = sessionStorage.getItem("apkc-studio/ventana");
    if (!id) {
      id = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      sessionStorage.setItem("apkc-studio/ventana", id);
    }
    return id;
  } catch (e) { return "v0"; }
})();

let temporizadorHistorial = null;

// Mientras una edición programática usa execCommand, el evento input que dispara no debe
// volver a pintar: la propia edición pinta una sola vez al terminar.
let silencioInput = 0;

// --- el editor, sin dependencias ---------------------------------------------------------
// Un textarea encima de un <pre> resaltado: es la única forma de tener color sin arrastrar
// un editor de terceros, y el precio es cuidar que las dos capas metricen igual (misma fuente,
// mismo whitespace, mismo scroll).
const EDITOR = {
  inicializar() {
    const area = document.getElementById("codigo");
    if (!area) return;
    area.addEventListener("input", () => {
      if (silencioInput) return;
      // F5: un input que llega con la pestaña cargando pertenece al buffer anterior; se rechaza
      // sin tocar el documento ni el historial
      if (!aceptarEntrada(documentoActivo(), cargandoDocumento)) return;
      EDITOR.pintar();
      EDITOR.sincronizar();
      actualizarCursor();
      marcarSucio(true);
      programarHistorial();
    });
    area.addEventListener("scroll", EDITOR.sincronizar);
    area.addEventListener("blur", volcarHistorial);
    area.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      // F5: con la pestaña a medio abrir se rechaza la tecla y se explica por qué; Ctrl+S sigue
      // llegando al atajo del documento, que a su vez avisa de que hay que esperar (F1)
      const rechazo = rechazoTecleo(cargandoDocumento);
      if (rechazo) { nota(rechazo); return; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const tecla = (e.key || "").toLowerCase();
        if (tecla === "z") {
          e.preventDefault();
          if (e.shiftKey) rehacer(); else deshacer();
          return;
        }
        if (tecla === "y") {
          e.preventDefault();
          rehacer();
          return;
        }
      }
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        EDITOR.indentar(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        EDITOR.entrar();
      }
    });
    area.addEventListener("keyup", actualizarCursor);
    area.addEventListener("click", actualizarCursor);
    area.addEventListener("focus", actualizarCursor);
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === area) actualizarCursor();
    });

    // la rueda sobre la columna de números no puede mover el textarea (es otro elemento):
    // se reenvía, y el clic en el margen devuelve el foco al código sin perder la posición
    const marco = document.querySelector(".editor");
    if (marco) {
      marco.addEventListener("wheel", (e) => {
        if (e.target === area || e.ctrlKey || e.metaKey) return;
        const escala = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? area.clientHeight : 1);
        area.scrollTop += e.deltaY * escala;
        area.scrollLeft += e.deltaX * escala;
        EDITOR.sincronizar();
        e.preventDefault();
      }, { passive: false });
      marco.addEventListener("mousedown", (e) => {
        if (e.target === area || e.button !== 0) return;
        e.preventDefault();
        area.focus();
      });
      // el panel inferior cambia el alto del editor: lo que estaba visible sigue siéndolo
      if (typeof ResizeObserver === "function") {
        new ResizeObserver(() => EDITOR.sincronizar()).observe(marco);
      }
    }
    EDITOR.pintar();
    actualizarCursor();
  },

  texto() { return document.getElementById("codigo").value; },

  poner(texto) {
    const area = document.getElementById("codigo");
    area.value = texto;
    area.setSelectionRange(0, 0);
    area.scrollTop = 0;
    area.scrollLeft = 0;
    EDITOR.pintar();
    EDITOR.sincronizar();
    actualizarCursor();
    marcarSucio(false);
  },

  pintar() {
    const area = document.getElementById("codigo");
    const resaltado = document.getElementById("resalto");
    if (!area || !resaltado) return;
    const valor = area.value;
    resaltado.innerHTML = htmlConfiable(resaltar(valor, esXml(valor) ? "xml" : "java") + "\n");
    EDITOR.numeros(valor);
  },

  numeros(valor) {
    const lineas = valor.split("\n").length;
    const ancho = Math.max(3, String(lineas).length);
    const cuadro = document.getElementById("numeros");
    if (!cuadro) return;
    let fuera = "";
    for (let i = 1; i <= lineas; i++) fuera += String(i).padStart(ancho, " ") + "\n";
    cuadro.textContent = fuera;
    cuadro.style.width = "calc(" + ancho + "ch + 18px)";
  },

  // Las dos capas de solo lectura tienen su propio scroll y se les copia el del textarea.
  // Antes se trasladaban con transform: el <pre> recortaba su contenido al alto visible y
  // al trasladarlo hacia arriba no quedaba nada pintado, así que a partir de la primera
  // pantalla el editor se veía vacío y parecía que no hacía scroll (§141).
  sincronizar() {
    const area = document.getElementById("codigo");
    const resaltado = document.getElementById("resalto");
    const numeros = document.getElementById("numeros");
    if (!area) return;
    if (resaltado) {
      if (resaltado.scrollTop !== area.scrollTop) resaltado.scrollTop = area.scrollTop;
      if (resaltado.scrollLeft !== area.scrollLeft) resaltado.scrollLeft = area.scrollLeft;
    }
    if (numeros && numeros.scrollTop !== area.scrollTop) numeros.scrollTop = area.scrollTop;
  },

  // Todo cambio programático pasa por aquí. Se usa execCommand("insertText") porque es la
  // única forma de que Tab, Shift+Tab y Enter entren en el historial nativo de deshacer;
  // setRangeText deja el textarea sin Ctrl+Z. Si el navegador no lo soporta, se cae a
  // setRangeText: el texto queda igual, solo se pierde el deshacer de esa edición.
  cambiar(desde, hasta, texto, seleccion) {
    const area = document.getElementById("codigo");
    let hecho = false;
    // execCommand actúa sobre el elemento con foco: si la barra de búsqueda lo tiene, el texto
    // se perdía sin error y el reemplazo decía «3 reemplazadas» sin cambiar nada.
    if (document.activeElement !== area) area.focus();
    if (typeof document.execCommand === "function") {
      if (area.selectionStart !== desde || area.selectionEnd !== hasta) {
        area.setSelectionRange(desde, hasta);
      }
      silencioInput++;
      try { hecho = document.execCommand("insertText", false, texto); }
      finally { silencioInput--; }
    }
    if (!hecho) area.setRangeText(texto, desde, hasta, "preserve");
    if (seleccion) area.setSelectionRange(seleccion[0], seleccion[1]);
    EDITOR.pintar();
    EDITOR.sincronizar();
    actualizarCursor();
    marcarSucio(true);
    programarHistorial();
  },

  // Tab y Shift+Tab: con selección indenta o desindenta las líneas; sin selección, Tab
  // inserta cuatro espacios en el cursor y Shift+Tab quita la sangría de su línea.
  indentar(delta) {
    const area = document.getElementById("codigo");
    const v = area.value;
    const a = area.selectionStart, b = area.selectionEnd;

    if (a === b) {
      if (delta > 0) {
        EDITOR.cambiar(a, b, "    ", [a + 4, a + 4]);
        return;
      }
      const ini = v.lastIndexOf("\n", a - 1) + 1;
      let finLinea = v.indexOf("\n", a);
      if (finLinea === -1) finLinea = v.length;
      const m = /^( {1,4}|\t)/.exec(v.slice(ini, finLinea));
      if (!m) return;
      const corte = m[0].length;
      const cursor = Math.max(ini, a - corte);
      EDITOR.cambiar(ini, ini + corte, "", [cursor, cursor]);
      return;
    }

    const ini = v.lastIndexOf("\n", a - 1) + 1;
    let fin = v.indexOf("\n", b);
    if (fin === -1) fin = v.length;
    // una selección que termina justo al empezar una línea no incluye esa línea
    if (b > a && v[b - 1] === "\n") fin = b - 1;
    let primera = 0, total = 0;
    const nuevas = v.slice(ini, fin).split("\n").map((linea, i) => {
      let cambio = 0;
      if (delta > 0) cambio = 4;
      else {
        const m = /^( {1,4}|\t)/.exec(linea);
        if (m) cambio = -m[0].length;
      }
      if (i === 0) primera = cambio;
      total += cambio;
      return delta > 0 ? "    " + linea : linea.slice(Math.max(0, -cambio));
    });
    if (!total) return;
    const nuevoA = Math.max(ini, a + primera);
    const nuevoB = Math.max(nuevoA, b + total);
    EDITOR.cambiar(ini, fin, nuevas.join("\n"), [nuevoA, nuevoB]);
  },

  // Enter conserva la sangría de la línea y añade un nivel si se acaba de abrir una llave.
  entrar() {
    const area = document.getElementById("codigo");
    const v = area.value;
    const a = area.selectionStart, b = area.selectionEnd;
    const ini = v.lastIndexOf("\n", a - 1) + 1;
    const linea = v.slice(ini, a);
    const sangria = (/^[ \t]*/.exec(linea) || [""])[0];
    const extra = /\{[ \t]*$/.test(linea) ? "    " : "";
    const insertar = "\n" + sangria + extra;
    EDITOR.cambiar(a, b, insertar, [a + insertar.length, a + insertar.length]);
  },
};

// La vista dividida (editor + teléfono) se monta desde aquí porque necesita el hospedador y el
// documento activo, pero su lógica vive en previa-panel.js: este fichero no gana otra copia del
// estado del editor ni del modelo de la vista previa.
const PREVIA_PANEL = crearPreviaPanel({
  hospedador, proyecto: PROYECTO, estadoPestana, editor: EDITOR, conBloqueo,
});

// Ln/Col del cursor, en la barra de estado. Se cuenta sobre el valor real, no sobre el HTML
// resaltado: el resaltado tiene spans y no sirve para medir posiciones.
function actualizarCursor() {  const area = document.getElementById("codigo");
  const salida = document.getElementById("estado-cursor");
  if (!area || !salida) return;
  const antes = area.value.slice(0, area.selectionStart);
  const lineas = antes.split("\n");
  salida.textContent = "Ln " + lineas.length + ", Col " + (lineas[lineas.length - 1].length + 1);
}

// El resaltado y esXml viven en editor.js.

// --- el árbol y los ficheros --------------------------------------------------------------
// El árbol empieza cerrado: solo se guardan las carpetas abiertas, no las plegadas. Antes el
// conjunto vacío significaba «todo abierto» y un proyecto con src/ y res/ se comía la pantalla.
const ARBOL = { abiertos: new Set() };

// En táctil el arrastre nativo compite con el menú de mantener pulsado; el arrastre se ofrece
// donde hay ratón o lápiz, y en el resto se mueve con «Mover a…».
const ARRASTRABLE = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(pointer: fine)").matches
  : false;

function relativa(ruta) {
  return ruta === PROYECTO ? "" : (ruta.startsWith(PROYECTO + "/") ? ruta.slice(PROYECTO.length + 1) : ruta);
}

// --- subir ficheros del dispositivo ---------------------------------------------------------
// El botón del explorador y el del menú Archivo usan la carpeta del fichero abierto; el menú de
// una carpeta del árbol permite elegir otra. Los bytes van directos a OPFS: no pasan por ningún
// servidor, igual que el resto del proyecto.
const SUBIDA = { destino: null };

function carpetaDe(ruta) {
  const i = String(ruta || "").lastIndexOf("/");
  return i <= 0 ? "/" : ruta.slice(0, i);
}

function carpetaActual() {
  return estadoPestana.ruta ? carpetaDe(estadoPestana.ruta) : PROYECTO;
}

// webkitRelativePath existe cuando se elige una carpeta: conserva los subdirectorios y descarta
// los tramos que intentarían salir del proyecto.
function nombreDeSubida(archivo) {
  const original = String(archivo.webkitRelativePath || archivo.name || "archivo").replace(/\\/g, "/");
  const partes = original.split("/").filter((p) => p && p !== "." && p !== "..");
  return partes.length ? partes.join("/") : "archivo";
}

function pedirSubida(destino, esCarpeta) {
  SUBIDA.destino = destino || carpetaActual();
  const entrada = document.getElementById(esCarpeta ? "subir-carpeta" : "subir-ficheros");
  if (!entrada) { nota("este navegador no expone el selector de archivos"); return; }
  entrada.value = "";
  entrada.click();
}

async function subirSeleccion(entrada) {
  const archivos = [...(entrada.files || [])];
  if (!archivos.length) return;
  const destino = SUBIDA.destino || carpetaActual();
  const rutas = archivos.map((archivo) => destino + "/" + nombreDeSubida(archivo));
  const choques = [];
  for (const ruta of rutas) {
    const r = await hospedador.leer(ruta);
    if (r && r.bytes) choques.push(ruta);
  }
  const donde = relativa(destino) || "la raíz del proyecto";
  if (choques.length && !window.confirm("Ya existen " + choques.length + " archivo(s) en " +
      donde + ". ¿Reemplazarlos?")) return;

  try {
    await conCarga("Subiendo " + archivos.length + " archivo(s)…", () => conBloqueo(async () => {
      for (let i = 0; i < archivos.length; i++) {
        const datos = new Uint8Array(await archivos[i].arrayBuffer());
        const escrito = await hospedador.escribir(rutas[i], datos);
        if (escrito && escrito.tipo === "error") throw new Error(escrito.error);
        try { localStorage.setItem(claveRevision(rutas[i]), nuevaRevision()); } catch (e) { /* sin revisión */ }
      }
    }));
  } finally {
    SUBIDA.destino = null;
  }
  publicar({ tipo: "mutacion", accion: "subir", rutas });
  await refrescarArbol();
  nota(archivos.length + (archivos.length === 1 ? " archivo subido a " : " archivos subidos a ") + donde);
  // con un solo fichero de texto, dejarlo abierto ahorra el paso de buscarlo en el árbol
  if (rutas.length === 1 && !estaSucio()) {
    if (await abrir(rutas[0])) {
      const vista = document.querySelector('[data-vista="pestana"]');
      if (vista && document.body.dataset.vista !== "pestana") vista.click();
    }
  }
}

// --- exportar e importar el proyecto ---------------------------------------------------------
// El zip conserva rutas y bytes tal cual. Al importar se reemplaza `/proyecto` entero, así que
// la confirmación dice cuántos ficheros entran y si hay cambios sin guardar.
function descargarBytes(nombre, bytes, tipo) {
  const enlace = document.createElement("a");
  const url = URL.createObjectURL(new Blob([bytes], { type: tipo || "application/octet-stream" }));
  enlace.href = enlaceConfiable(url);
  enlace.download = nombre;
  enlace.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportarProyecto() {
  return conCarga("Empaquetando el proyecto…", async () => {
    try {
      const arbol = await hospedador.arbol();
      const nodos = (arbol.nodos || []).filter(
        (n) => n.ruta === PROYECTO || n.ruta.startsWith(PROYECTO + "/"));
      const manifiesto = await hospedador.texto(PROYECTO + "/AndroidManifest.xml");
      if (!manifiesto) {
        nota("no hay proyecto que exportar: crea uno en Inicio");
        return;
      }
      const entradas = [];
      for (const n of nodos) {
        if (n.ruta === PROYECTO) continue;
        const rel = n.ruta.slice(PROYECTO.length + 1);
        if (n.dir) {
          entradas.push([rel + "/", new Uint8Array(0)]);
          continue;
        }
        const bytes = await hospedador.bytes(n.ruta);
        if (bytes) entradas.push([rel, bytes]);
      }
      const zip = zipDelArbol(entradas);
      descargarBytes(nombreDeZip(paqueteDelManifiesto(manifiesto)), zip, "application/zip");
      nota("proyecto exportado: " + entradas.filter((e) => !e[0].endsWith("/")).length +
        " ficheros, " + zip.length + " bytes");
    } catch (e) {
      nota("no se pudo exportar: " + (e && e.message ? e.message : e));
    }
  });
}

// --- importar con red ----------------------------------------------------------------------
// `limpiar` devuelve `borradoDelDisco` y `existia`: si `/proyecto` estaba en el disco y no se
// pudo borrar (otra pestaña con un handle abierto), escribir el zip encima deja una mezcla del
// árbol viejo y el nuevo que nada delata. La decisión es pura para poder falsarla en `prueba.js`.
export function decidirImportacion(limpieza) {
  if (limpieza && (limpieza.borradoDelDisco === true || limpieza.existia === false)) {
    return { puede: true, motivo: "" };
  }
  return {
    puede: false,
    motivo: "no se pudo borrar /proyecto del disco (¿otra pestaña tiene un fichero abierto?); " +
      "la importación se cancela para no mezclar el zip con el proyecto actual",
  };
}

async function escribirEntradas(entradas, prefijo, escribir) {
  for (const entrada of entradas) {
    if (entrada.dir) continue;
    const ruta = prefijo + "/" + entrada.ruta;
    const r = await escribir(ruta, entrada.datos);
    if (r && r.tipo === "error") throw new Error(r.error || "no se pudo escribir " + ruta);
  }
}

// Restaurar es dejar `/proyecto` como estaba: primero se borra lo que llegó a escribirse (si ese
// borrado falla, escribir encima sería otra mezcla) y después vuelven los ficheros de la copia.
// `false` = no se pudo, y quien llama lo avisa; nunca se devuelve éxito con la mezcla dentro.
async function restaurarProyecto(previo, prefijo, limpiar, escribir) {
  try {
    const limpieza = await limpiar(prefijo);
    if (!decidirImportacion(limpieza).puede) return false;
    await escribirEntradas(previo, prefijo, escribir);
    return true;
  } catch (e) {
    return false;
  }
}

// Reemplazo de `/proyecto` con red, sin DOM ni OPFS propios: todo entra por parámetro para que
// `prueba.js` pueda falsificar el disco. Si la escritura falla a mitad (cuota, handle, CRC) se
// restaura la copia previa; si tampoco se puede, `/proyecto` queda vacío y `restaurado: false`.
export async function reemplazarProyecto({ entradas, previo = [], prefijo, limpiar, escribir, refrescar }) {
  const limpieza = await limpiar(prefijo);
  const decision = decidirImportacion(limpieza);
  if (!decision.puede) {
    // el espejo del worker ya perdió el subárbol al intentar limpiar: se vuelve a descubrir del
    // disco para que el árbol de la página no mienta mientras se avisa del aborto
    if (refrescar) {
      try { await refrescar(prefijo); } catch (e) { /* la página se repinta igual */ }
    }
    return { ok: false, motivo: decision.motivo, restaurado: true };
  }
  try {
    await escribirEntradas(entradas, prefijo, escribir);
    return { ok: true, motivo: "", restaurado: false };
  } catch (e) {
    const motivo = "la escritura falló a mitad: " + (e && e.message ? e.message : e);
    return { ok: false, motivo, restaurado: await restaurarProyecto(previo, prefijo, limpiar, escribir) };
  }
}

// Copia del proyecto actual, antes de tocarlo: es a lo que se vuelve si la escritura falla a
// mitad. Los directorios no hacen falta porque `escribir` crea los padres de cada fichero.
async function copiaDelProyecto() {
  const arbol = await hospedador.arbol();
  const nodos = (arbol.nodos || []).filter(
    (n) => !n.dir && n.ruta.startsWith(PROYECTO + "/"));
  const copia = [];
  for (const n of nodos) {
    const bytes = await hospedador.bytes(n.ruta);
    if (bytes) copia.push({ ruta: n.ruta.slice(PROYECTO.length + 1), datos: bytes });
  }
  return copia;
}

async function importarProyecto(archivo) {
  if (!archivo) return;
  return conCarga("Leyendo " + archivo.name + "…", async () => {
    try {
      const entradas = normalizarEntradas(await leerZip(new Uint8Array(await archivo.arrayBuffer())));
      const manifiesto = entradas.find((e) => !e.dir && e.ruta === "AndroidManifest.xml");
      if (!manifiesto) throw new Error("el zip no trae AndroidManifest.xml en la raíz");
      const ficheros = entradas.filter((e) => !e.dir);
      const sucios = hayDocumentosSucios();
      if (!window.confirm("Importar «" + archivo.name + "» reemplaza el proyecto actual (" +
          ficheros.length + " ficheros)" + (sucios ? " y hay cambios sin guardar" : "") +
          ". Exporta antes si quieres conservarlo. ¿Seguir?")) return;
      // la copia se lee antes de limpiar: es la única versión del árbol viejo que quedará
      const previo = await copiaDelProyecto();
      let resultado = null;
      await conBloqueo(async () => {
        resultado = await reemplazarProyecto({
          entradas: ficheros, previo, prefijo: PROYECTO,
          limpiar: hospedador.limpiar, escribir: hospedador.escribir,
          refrescar: hospedador.refrescar,
        });
      });
      if (!resultado || !resultado.ok) {
        // con `restaurado: false` el disco no es de fiar: se suelta el editor para no seguir
        // editando sobre un árbol a medias, y el aviso dice qué pasó
        if (resultado && resultado.restaurado === false) limpiarEstadoEditor();
        await refrescarArbol();
        throw new Error((resultado && resultado.motivo) || "la importación no se completó");
      }
      for (const entrada of ficheros) {
        try { localStorage.setItem(claveRevision(PROYECTO + "/" + entrada.ruta), nuevaRevision()); }
        catch (e) { /* sin revisión */ }
      }
      limpiarEstadoEditor();
      await refrescarArbol();
      publicar({ tipo: "proyecto", accion: "importar" });
      nota("proyecto importado: " + ficheros.length + " ficheros");
      const primerJava = ficheros.find((e) => /\.java$/.test(e.ruta));
      if (primerJava && await abrir(PROYECTO + "/" + primerJava.ruta)) {
        const vista = document.querySelector('[data-vista="pestana"]');
        if (vista && document.body.dataset.vista !== "pestana") vista.click();
      }
    } catch (e) {
      nota("no se pudo importar: " + (e && e.message ? e.message : e));
    }
  });
}

// --- documentos abiertos -------------------------------------------------------------------
function documentoActivo() {
  return DOCUMENTOS.lista.find((doc) => doc.ruta === DOCUMENTOS.activa) || null;
}

function documentoDe(ruta) {
  return DOCUMENTOS.lista.find((doc) => doc.ruta === ruta) || null;
}

function hayDocumentosSucios() {
  return DOCUMENTOS.lista.some((doc) => doc.sucio) ||
    (!!estadoPestana.sucio && !documentoActivo());
}

function leerPersistencia() {
  try {
    let propio = sessionStorage.getItem(PERSISTENCIA);
    if (!propio) {
      // migración única desde la versión que guardaba la vista en localStorage
      const viejo = localStorage.getItem(PERSISTENCIA);
      if (viejo) {
        sessionStorage.setItem(PERSISTENCIA, viejo);
        localStorage.removeItem(PERSISTENCIA);
        propio = viejo;
      }
    }
    const dato = JSON.parse(propio || "{}");
    return dato && typeof dato === "object" ? dato : {};
  } catch (e) { return {}; }
}

// Estado de esta ventana, no compartido: pestañas, activa y carpetas abiertas. El proyecto y el
// árbol de deshacer viven aparte (OPFS e IndexedDB), así dos ventanas no se pisan la vista.
function guardarPersistencia() {
  try {
    sessionStorage.setItem(PERSISTENCIA, JSON.stringify({
      tabs: DOCUMENTOS.lista.map((doc) => doc.ruta),
      activa: DOCUMENTOS.activa,
      abiertos: [...ARBOL.abiertos],
    }));
  } catch (e) { /* sin persistencia, la página sigue */ }
}

// --- coordinación entre ventanas del mismo origen -----------------------------------------
const REV_PREF = "apkc-studio/rev/";
const canal = typeof window !== "undefined" && typeof BroadcastChannel === "function"
  ? new BroadcastChannel("apkc-studio")
  : null;

async function conBloqueo(tarea) {
  if (typeof navigator !== "undefined" && navigator.locks &&
      typeof navigator.locks.request === "function") {
    return navigator.locks.request("apkc-studio:/proyecto", { mode: "exclusive" }, tarea);
  }
  return tarea();
}

function claveRevision(ruta) {
  return REV_PREF + encodeURIComponent(ruta);
}
function revisionActual(ruta) {
  try { return localStorage.getItem(claveRevision(ruta)); } catch (e) { return null; }
}
function nuevaRevision() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
// Aviso local (misma ventana) de que el proyecto cambió: lo consume la caché de recursos del
// autocompletado y del linter de XML (`recursos-proyecto.js`). Va por el DOM porque
// BroadcastChannel no entrega a quien publica, y un `Ctrl+S` en `res/values` tiene que invalidar
// su propia caché igual que lo haría el guardado de otra ventana.
function avisarCambioDeProyecto(mensaje) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") return;
  try {
    document.dispatchEvent(new CustomEvent("apkc:proyecto-cambio", { detail: mensaje || {} }));
  } catch (e) { /* sin CustomEvent: la caché se refresca con `refrescar()` */ }
}

function publicar(mensaje) {
  avisarCambioDeProyecto(mensaje);
  if (!canal) return;
  try { canal.postMessage({ ...mensaje, origen: VENTANA }); } catch (e) { /* sin canal */ }
}

function ocultarConflicto() {
  CONFLICTO.doc = null;
  CONFLICTO.datos = null;
  const aviso = document.getElementById("conflicto-aviso");
  if (aviso) aviso.hidden = true;
}

function mostrarConflicto(doc, datos) {
  CONFLICTO.doc = doc;
  CONFLICTO.datos = datos;
  const texto = document.getElementById("conflicto-texto");
  const aviso = document.getElementById("conflicto-aviso");
  if (texto) {
    texto.textContent = "Otra ventana cambió " + relativa(doc.ruta) +
      "; las mismas líneas cambiaron en las dos.";
  }
  if (aviso) aviso.hidden = false;
}

function aplicarVersionRemota(doc, datos) {
  doc.texto = datos.suyo;
  doc.base = datos.suyo;
  doc.revision = datos.revision;
  doc.sucio = false;
  doc.conflicto = null;
  if (DOCUMENTOS.activa === doc.ruta) {
    EDITOR.poner(datos.suyo);
    marcarSucio(false);
    actualizarAccionesFichero();
  }
  ocultarConflicto();
  renderPestanas();
  renderHistorial();
  guardarPersistencia();
  nota("usada la versión de la otra ventana en " + relativa(doc.ruta));
}

function mantenerVersionPropia(doc) {
  const datos = doc && doc.conflicto ? doc.conflicto : CONFLICTO.datos;
  if (!doc || !datos) return;
  doc.base = datos.suyo;
  doc.revision = datos.revision;
  doc.sucio = true;
  doc.conflicto = null;
  ocultarConflicto();
  marcarSucio(true);
  renderPestanas();
  nota("mantienes tu versión; guarda para sobrescribir");
}

function insertarMarcasConflicto(doc) {
  const datos = doc && doc.conflicto ? doc.conflicto : CONFLICTO.datos;
  if (!doc || !datos) return;
  const nuestro = DOCUMENTOS.activa === doc.ruta ? EDITOR.texto() : datos.nuestro;
  const marcas = "<<<<<<< esta ventana\n" + nuestro +
    (nuestro.endsWith("\n") ? "" : "\n") + "=======\n" + datos.suyo +
    (datos.suyo.endsWith("\n") ? "" : "\n") + ">>>>>>> otra ventana\n";
  doc.texto = marcas;
  doc.base = datos.suyo;
  doc.revision = datos.revision;
  doc.sucio = true;
  doc.conflicto = null;
  if (DOCUMENTOS.activa === doc.ruta) {
    EDITOR.poner(marcas);
    marcarSucio(true);
  }
  ocultarConflicto();
  renderHistorial();
  nota("marcas de conflicto insertadas; edita y guarda");
}

async function recargarDocumentoRemoto(doc, revision) {
  try {
    await hospedador.refrescar(doc.ruta);
    const bytes = await hospedador.bytes(doc.ruta);
    if (!bytes) return;
    const suyo = new TextDecoder().decode(bytes);
    const rev = revision || revisionActual(doc.ruta);
    const activo = DOCUMENTOS.activa === doc.ruta;
    const nuestro = activo ? EDITOR.texto() : doc.texto;

    if (!doc.sucio || nuestro === suyo) {
      doc.texto = activo ? suyo : null;
      doc.base = suyo;
      doc.revision = rev;
      doc.sucio = false;
      doc.conflicto = null;
      if (activo) {
        EDITOR.poner(suyo);
        marcarSucio(false);
        await asegurarHistorial(doc, suyo);
        renderHistorial();
        actualizarAccionesFichero();
      }
      nota("otra ventana guardó " + relativa(doc.ruta) + "; recargado");
      return;
    }

    const base = doc.base === undefined || doc.base === null ? null : doc.base;
    if (base === null) {
      doc.conflicto = { base: suyo, suyo, nuestro, revision: rev };
      if (activo) mostrarConflicto(doc, doc.conflicto);
      else nota("otra ventana guardó " + relativa(doc.ruta) + "; hay conflicto");
      return;
    }

    const fusion = fusionar(base, nuestro, suyo);
    doc.revision = rev;
    if (fusion.estado === "suyo" || fusion.estado === "igual") {
      aplicarVersionRemota(doc, { suyo, revision: rev });
      return;
    }
    if (fusion.estado === "nuestro") {
      doc.base = suyo;
      nota("otra ventana guardó " + relativa(doc.ruta) + " sin cambios respecto a la base");
      return;
    }
    if (fusion.estado === "auto") {
      doc.texto = fusion.texto;
      doc.base = suyo;
      doc.sucio = true;
      doc.conflicto = null;
      if (activo) {
        EDITOR.poner(fusion.texto);
        marcarSucio(true);
        await asegurarHistorial(doc, fusion.texto);
        renderHistorial();
        actualizarAccionesFichero();
      }
      nota("cambios fusionados automáticamente en " + relativa(doc.ruta) + "; guarda para publicarlos");
      return;
    }

    doc.conflicto = { base, suyo, nuestro, revision: rev };
    if (activo) mostrarConflicto(doc, doc.conflicto);
    else nota("otra ventana guardó " + relativa(doc.ruta) + "; hay conflicto");
  } catch (e) {
    nota("no se pudo recargar " + relativa(doc.ruta) + ": " + (e && e.message ? e.message : e));
  }
}

async function aplicarBorradoRemoto(ruta) {
  const conservar = [];
  for (const doc of DOCUMENTOS.lista) {
    if (!(doc.ruta === ruta || doc.ruta.startsWith(ruta + "/"))) {
      conservar.push(doc);
      continue;
    }
    if (doc.sucio) {
      doc.remotoEliminado = true;
      conservar.push(doc);
    } else {
      Historial.borrar(VENTANA, doc.ruta)
        .catch((e) => falloSilencioso("borrar el historial de " + doc.ruta, e));
    }
  }
  DOCUMENTOS.lista = conservar;
  if (!DOCUMENTOS.lista.some((doc) => doc.ruta === DOCUMENTOS.activa)) {
    DOCUMENTOS.activa = null;
    estadoPestana.ruta = null;
    const vecino = DOCUMENTOS.lista[0];
    if (vecino) await activarDocumento(vecino.ruta);
    else limpiarSinDocumento();
  } else {
    renderPestanas();
    renderHistorial();
    actualizarAccionesFichero();
    guardarPersistencia();
  }
  nota("otra ventana borró " + relativa(ruta));
}

async function recibirRemoto(msg) {
  if (!msg || msg.origen === VENTANA) return;
  // lo que otra ventana cambió también invalida la caché de recursos de esta
  avisarCambioDeProyecto(msg);
  if (msg.tipo === "guardado") {
    const doc = documentoDe(msg.ruta);
    if (doc) await recargarDocumentoRemoto(doc, msg.revision);
    await hospedador.refrescar(PROYECTO)
      .catch((e) => falloSilencioso("refrescar el espejo tras un guardado de otra ventana", e));
    await refrescarArbol();
    return;
  }
  if (msg.tipo === "mutacion") {
    if (msg.accion === "renombrar" || msg.accion === "mover") {
      await hospedador.refrescar(msg.origen)
        .catch((e) => falloSilencioso("refrescar el origen de un renombrado remoto", e));
      await hospedador.refrescar(msg.destino)
        .catch((e) => falloSilencioso("refrescar el destino de un renombrado remoto", e));
      remapearDocumentos(msg.origen, msg.destino);
      remapearAbiertos(msg.origen, msg.destino);
      revelarRuta(estadoPestana.ruta);
    } else if (msg.accion === "borrar") {
      await aplicarBorradoRemoto(msg.ruta);
    } else if (msg.accion === "subir" || msg.accion === "crear" || msg.accion === "deps") {
      for (const ruta of msg.rutas || []) {
        await hospedador.refrescar(ruta)
          .catch((e) => falloSilencioso("refrescar " + ruta + " tras un cambio de otra ventana", e));
        const doc = documentoDe(ruta);
        if (!doc) continue;
        await recargarDocumentoRemoto(doc, revisionActual(ruta));
      }
    }
    await hospedador.refrescar(PROYECTO)
      .catch((e) => falloSilencioso("refrescar el espejo tras un cambio de otra ventana", e));
    await refrescarArbol();
    return;
  }
  if (msg.tipo === "proyecto") {
    await hospedador.refrescar(PROYECTO)
      .catch((e) => falloSilencioso("refrescar el espejo tras crear un proyecto en otra ventana", e));
    for (const doc of DOCUMENTOS.lista) {
      if (doc.sucio) doc.remotoEliminado = true;
      else doc.texto = null;
    }
    await refrescarArbol();
    nota("otra ventana creó un proyecto; el árbol se ha actualizado");
  }
}

function falloDocumento(e) {
  nota("fallo: " + (e && e.message ? e.message : e));
  console.error(e);
}

if (canal) {
  canal.addEventListener("message", (evento) => {
    if (evento.data && evento.data.origen !== VENTANA) {
      recibirRemoto(evento.data).catch(falloDocumento);
    }
  });
}

function renderPestanas() {
  const caja = document.getElementById("pestanas-archivo");
  if (!caja) return;
  caja.textContent = "";
  if (!DOCUMENTOS.lista.length) {
    const tab = document.createElement("div");
    tab.className = "editor-tab activa";
    const icono = document.createElement("span");
    icono.className = "editor-tab-icono";
    icono.setAttribute("aria-hidden", "true");
    const nombre = document.createElement("span");
    nombre.id = "fichero-abierto";
    nombre.textContent = "Sin fichero";
    const marca = document.createElement("span");
    marca.id = "marca-sucio";
    marca.className = "marca-sucio";
    marca.hidden = true;
    marca.setAttribute("aria-label", "cambios sin guardar");
    marca.textContent = "";
    tab.append(icono, nombre, marca);
    caja.appendChild(tab);
    return;
  }
  for (const doc of DOCUMENTOS.lista) {
    const activa = doc.ruta === DOCUMENTOS.activa;
    const tab = document.createElement("div");
    tab.className = "editor-tab" + (activa ? " activa" : "");
    tab.dataset.ruta = doc.ruta;
    tab.title = doc.ruta;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(activa));

    const icono = document.createElement("span");
    icono.className = "editor-tab-icono";
    icono.setAttribute("aria-hidden", "true");
    const nombre = document.createElement("span");
    if (activa) nombre.id = "fichero-abierto";
    else nombre.className = "editor-tab-nombre";
    nombre.textContent = relativa(doc.ruta);
    const marca = document.createElement("span");
    marca.className = "marca-sucio";
    if (activa) marca.id = "marca-sucio";
    marca.hidden = !doc.sucio;
    marca.setAttribute("aria-label", "cambios sin guardar");
    marca.textContent = "";
    const cerrar = document.createElement("button");
    cerrar.type = "button";
    cerrar.className = "editor-tab-cerrar";
    cerrar.title = "Cerrar " + relativa(doc.ruta);
    cerrar.setAttribute("aria-label", cerrar.title);
    cerrar.textContent = "×";
    cerrar.addEventListener("click", (e) => {
      e.stopPropagation();
      cerrarDocumento(doc.ruta).catch(falloDocumento);
    });

    tab.append(icono, nombre, marca, cerrar);
    tab.addEventListener("click", () => { abrir(doc.ruta).catch(falloDocumento); });
    tab.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      cerrarDocumento(doc.ruta).catch(falloDocumento);
    });
    caja.appendChild(tab);
  }
  const activa = caja.querySelector(".editor-tab.activa");
  if (activa && typeof activa.scrollIntoView === "function") {
    activa.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function pintarMarcaSucio() {
  const doc = documentoActivo();
  const marca = document.getElementById("marca-sucio");
  if (marca) marca.hidden = !(doc && doc.sucio);
}

function guardarEnMemoria() {
  const doc = documentoActivo();
  if (!doc) return;
  volcarHistorial();
  const area = document.getElementById("codigo");
  doc.texto = EDITOR.texto();
  if (area) {
    doc.cursor = [area.selectionStart, area.selectionEnd];
    doc.scroll = [area.scrollTop, area.scrollLeft];
  }
  // un documento limpio se puede releer de OPFS: no hace falta retener su texto
  if (!doc.sucio) doc.texto = null;
}

// --- historial de deshacer ---------------------------------------------------------------
function historialDe(doc) {
  return doc && doc.hist ? doc.hist : null;
}

async function asegurarHistorial(doc, texto) {
  if (!doc) return null;
  if (!doc.hist) {
    let arbol = await Historial.cargar(VENTANA, doc.ruta);
    if (!arbol) {
      arbol = Historial.crear(doc.ruta, texto);
    } else {
      arbol.cache = Historial.textoDe(arbol, arbol.actual);
      // el fichero cambió en otra ventana o en OPFS desde la última sesión
      if (arbol.cache !== texto) {
        doc.recuperable = arbol.actual;
        Historial.agregar(arbol, texto, { autor: "remoto" });
      }
    }
    doc.hist = arbol;
  } else {
    doc.hist.ruta = doc.ruta;
    const actual = Historial.textoDe(doc.hist, doc.hist.actual);
    if (actual !== texto) Historial.agregar(doc.hist, texto, { autor: "remoto" });
  }
  return doc.hist;
}

function volcarHistorial() {
  if (temporizadorHistorial) {
    clearTimeout(temporizadorHistorial);
    temporizadorHistorial = null;
  }
  const doc = documentoActivo();
  const arbol = historialDe(doc);
  if (!doc || !arbol) return;
  const area = document.getElementById("codigo");
  const id = Historial.agregar(arbol, EDITOR.texto(), {
    seleccion: area ? [area.selectionStart, area.selectionEnd] : [0, 0],
    scroll: area ? [area.scrollTop, area.scrollLeft] : [0, 0],
  });
  if (id) {
    Historial.guardar(VENTANA, arbol)
      .catch((e) => falloSilencioso("guardar el historial del árbol", e));
    renderHistorial();
  }
}

function programarHistorial() {
  if (temporizadorHistorial) clearTimeout(temporizadorHistorial);
  temporizadorHistorial = setTimeout(volcarHistorial, 500);
}

function aplicarNodoHistorial(nodo) {
  const doc = documentoActivo();
  if (!doc || !doc.hist || !nodo) return;
  const texto = Historial.textoDe(doc.hist, nodo.id);
  EDITOR.poner(texto);
  const area = document.getElementById("codigo");
  if (area && nodo.a) area.setSelectionRange(nodo.a[0], nodo.a[1]);
  if (area && nodo.s) {
    area.scrollTop = nodo.s[0];
    area.scrollLeft = nodo.s[1];
    EDITOR.sincronizar();
  }
  marcarSucio(true);
  doc.texto = texto;
  renderHistorial();
  Historial.guardar(VENTANA, doc.hist)
    .catch((e) => falloSilencioso("guardar el historial de " + doc.ruta, e));
}

function deshacer() {
  volcarHistorial();
  const doc = documentoActivo();
  if (!doc || !doc.hist) return false;
  const nodo = Historial.deshacer(doc.hist);
  if (!nodo) return false;
  aplicarNodoHistorial(nodo);
  return true;
}

function rehacer() {
  volcarHistorial();
  const doc = documentoActivo();
  if (!doc || !doc.hist) return false;
  const nodo = Historial.rehacer(doc.hist);
  if (!nodo) return false;
  aplicarNodoHistorial(nodo);
  return true;
}

function restaurarNodoHistorial(id) {
  volcarHistorial();
  const doc = documentoActivo();
  if (!doc || !doc.hist) return;
  const nodo = Historial.restaurar(doc.hist, id);
  if (nodo) aplicarNodoHistorial(nodo);
}

function limpiarHistorial() {
  const doc = documentoActivo();
  if (!doc || !doc.hist) return;
  if (!window.confirm("¿Borrar el historial de " + relativa(doc.ruta) + "?")) return;
  doc.hist = Historial.crear(doc.ruta, EDITOR.texto());
  Historial.guardar(VENTANA, doc.hist)
    .catch((e) => falloSilencioso("guardar el historial de " + doc.ruta, e));
  renderHistorial();
}

function renderHistorial() {
  const caja = document.getElementById("arbol-historial");
  const resumen = document.getElementById("historial-resumen");
  const botonDeshacer = document.getElementById("historial-deshacer");
  const botonRehacer = document.getElementById("historial-rehacer");
  if (!caja || !resumen) return;
  caja.textContent = "";
  const doc = documentoActivo();
  const arbol = historialDe(doc);
  if (!doc || !arbol) {
    resumen.textContent = "Sin historial";
    if (botonDeshacer) botonDeshacer.disabled = true;
    if (botonRehacer) botonRehacer.disabled = true;
    return;
  }
  const nodos = Historial.recorrer(arbol);
  const actual = arbol.nodos[arbol.actual];
  resumen.textContent = nodos.length + " versiones · " + relativa(doc.ruta);
  if (botonDeshacer) botonDeshacer.disabled = !actual || !actual.p;
  if (botonRehacer) botonRehacer.disabled = !actual || !actual.h.length;
  for (const nodo of nodos) {
    const fila = document.createElement("button");
    fila.type = "button";
    fila.className = "historial-nodo" + (nodo.id === arbol.actual ? " actual" : "");
    fila.style.paddingLeft = (8 + nodo.nivel * 16) + "px";
    fila.dataset.id = nodo.id;
    fila.setAttribute("role", "treeitem");
    fila.setAttribute("aria-level", String(nodo.nivel + 1));
    if (nodo.id === arbol.actual) fila.setAttribute("aria-current", "true");

    const hora = document.createElement("span");
    hora.className = "historial-hora";
    const fecha = new Date(nodo.ts);
    hora.textContent = fecha.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const autor = document.createElement("span");
    autor.className = "historial-autor";
    autor.textContent = nodo.au === "remoto" ? "remoto" : "local";
    const texto = document.createElement("span");
    texto.className = "historial-resumen";
    const delta = nodo.d ? " · +" + nodo.d.s.length + "/-" + nodo.d.b : (nodo.p ? " · checkpoint" : "");
    texto.textContent = (nodo.nivel ? "· " : "● ") + (nodo.p ? delta.replace(/^ · /, "") : "inicio");
    fila.append(hora, autor, texto);
    fila.addEventListener("click", () => restaurarNodoHistorial(nodo.id));
    caja.appendChild(fila);
  }
}

function limpiarSinDocumento() {
  DOCUMENTOS.activa = null;
  estadoPestana.ruta = null;
  estadoPestana.sucio = false;
  EDITOR.poner("");
  renderPestanas();
  renderHistorial();
  actualizarAccionesFichero();
  guardarPersistencia();
}

function quitarDocumento(doc) {
  const i = DOCUMENTOS.lista.indexOf(doc);
  if (i >= 0) DOCUMENTOS.lista.splice(i, 1);
  if (DOCUMENTOS.activa !== doc.ruta) {
    renderPestanas();
    guardarPersistencia();
    return false;
  }
  DOCUMENTOS.activa = null;
  estadoPestana.ruta = null;
  renderPestanas();
  const vecino = DOCUMENTOS.lista[Math.min(i, DOCUMENTOS.lista.length - 1)];
  if (vecino) return activarDocumento(vecino.ruta);
  limpiarSinDocumento();
  return false;
}

// F1: la activación fija la pestaña activa antes de leer OPFS para que la pestaña se marque al
// instante aunque la lectura quede en cola detrás de un build. El precio es que durante la carga
// el textarea todavía tiene el buffer anterior, así que `guardar` se bloquea con el contador
// `cargandoDocumento`; sin eso, un Ctrl+S en esa ventana escribía el buffer viejo en la ruta nueva.
// F5: por lo mismo el textarea se cierra a la escritura (`readOnly`) hasta que la lectura termina;
// las teclas no llegan al buffer ajeno y el aviso dice que hay que esperar.
function bloquearTecleo() {
  const area = document.getElementById("codigo");
  if (!area) return;
  const bloqueado = rechazoTecleo(cargandoDocumento) !== null;
  area.readOnly = bloqueado;
  if (bloqueado) area.setAttribute("aria-busy", "true");
  else area.removeAttribute("aria-busy");
}

async function activarDocumento(ruta) {
  const doc = documentoDe(ruta);
  if (!doc) return false;
  if (DOCUMENTOS.activa === ruta) { renderPestanas(); return true; }
  const turno = ++activacion;
  guardarEnMemoria();
  cargandoDocumento += 1;
  bloquearTecleo();
  try {
    return await cargarDocumentoEnEditor(doc, ruta, turno);
  } finally {
    cargandoDocumento -= 1;
    bloquearTecleo();
  }
}

async function cargarDocumentoEnEditor(doc, ruta, turno) {
  DOCUMENTOS.activa = ruta;
  estadoPestana.ruta = ruta;
  revelarRuta(ruta);

  if (doc.texto === null) {
    // una pestaña limpia inactiva puede tener una versión vieja en el espejo del worker; solo
    // se invalida si otra ventana publicó una revisión distinta (no en el flujo local de subida)
    const revisionDisco = revisionActual(ruta);
    if (doc.revision && revisionDisco && doc.revision !== revisionDisco) {
      await hospedador.refrescar(ruta)
        .catch((e) => falloSilencioso("refrescar " + ruta + " antes de releerlo", e));
    }
    let bytes;
    try {
      bytes = await conCarga("Abriendo " + relativa(ruta) + "…", () => hospedador.bytes(ruta));
    } catch (e) {
      if (turno !== activacion) return false;
      nota("no se pudo abrir " + ruta + ": " + (e && e.message ? e.message : e));
      return await quitarDocumento(doc);
    }
    if (turno !== activacion) return false;
    if (!bytes) {
      nota("no existe " + ruta);
      return await quitarDocumento(doc);
    }
    if (bytes.includes(0)) {
      nota(ruta + " parece un binario; el editor solo abre texto");
      return await quitarDocumento(doc);
    }
    doc.texto = new TextDecoder().decode(bytes);
    doc.base = doc.texto;
    doc.revision = revisionActual(ruta) || doc.revision || null;
  }

  await asegurarHistorial(doc, doc.texto);
  // EDITOR.poner marca limpio; el estado sucio de la pestaña hay que restaurarlo después
  const sucio = doc.sucio;
  EDITOR.poner(doc.texto);
  actualizarFirmaAutomatica();
  const area = document.getElementById("codigo");
  if (area && doc.cursor) area.setSelectionRange(doc.cursor[0], doc.cursor[1]);
  if (area && doc.scroll) {
    area.scrollTop = doc.scroll[0];
    area.scrollLeft = doc.scroll[1];
    EDITOR.sincronizar();
  }
  marcarSucio(sucio);
  renderPestanas();
  renderHistorial();
  if (doc.conflicto) mostrarConflicto(doc, doc.conflicto);
  else ocultarConflicto();
  if (doc.remotoEliminado) {
    nota("este fichero fue borrado en otra ventana; guardarlo lo recrea");
  }
  if (doc.recuperable) {
    nota("hay cambios sin guardar de la sesión anterior; ábrelos en Historial");
    doc.recuperable = null;
  }
  actualizarAccionesFichero();
  await refrescarArbol();
  guardarPersistencia();
  return true;
}

async function cerrarDocumento(ruta) {
  const doc = documentoDe(ruta);
  if (!doc) return;
  if (doc.ruta === DOCUMENTOS.activa) guardarEnMemoria();
  if (doc.sucio && !confirmarDescartes()) return;
  const i = DOCUMENTOS.lista.indexOf(doc);
  DOCUMENTOS.lista.splice(i, 1);
  if (DOCUMENTOS.activa === ruta) {
    DOCUMENTOS.activa = null;
    estadoPestana.ruta = null;
    const vecino = DOCUMENTOS.lista[Math.min(i, DOCUMENTOS.lista.length - 1)];
    if (vecino) await activarDocumento(vecino.ruta);
    else limpiarSinDocumento();
  } else {
    renderPestanas();
    guardarPersistencia();
  }
}

function remapearDocumentos(origen, destino) {
  for (const doc of DOCUMENTOS.lista) {
    const viejo = doc.ruta;
    if (doc.ruta === origen) doc.ruta = destino;
    else if (doc.ruta.startsWith(origen + "/")) doc.ruta = destino + doc.ruta.slice(origen.length);
    if (doc.ruta !== viejo && doc.hist) doc.hist.ruta = doc.ruta;
  }
  if (DOCUMENTOS.activa === origen) DOCUMENTOS.activa = destino;
  else if (DOCUMENTOS.activa && DOCUMENTOS.activa.startsWith(origen + "/")) {
    DOCUMENTOS.activa = destino + DOCUMENTOS.activa.slice(origen.length);
  }
  estadoPestana.ruta = DOCUMENTOS.activa;
  const historiasAbiertas = DOCUMENTOS.lista.filter((doc) => doc.hist).map((doc) => doc.hist);
  Historial.renombrarBajo(VENTANA, origen, destino)
    .then(() => Promise.all(historiasAbiertas.map((hist) => Historial.guardar(VENTANA, hist))))
    .catch((e) => falloSilencioso("renombrar el historial bajo " + origen, e));
  renderPestanas();
  renderHistorial();
  actualizarAccionesFichero();
  guardarPersistencia();
}

async function quitarDocumentosBajo(ruta) {
  const indiceActiva = DOCUMENTOS.lista.findIndex((doc) => doc.ruta === DOCUMENTOS.activa);
  for (const doc of DOCUMENTOS.lista) {
    if (doc.ruta === ruta || doc.ruta.startsWith(ruta + "/")) {
      Historial.borrar(VENTANA, doc.ruta)
        .catch((e) => falloSilencioso("borrar el historial de " + doc.ruta, e));
    }
  }
  DOCUMENTOS.lista = DOCUMENTOS.lista.filter((doc) =>
    !(doc.ruta === ruta || doc.ruta.startsWith(ruta + "/")));
  if (!DOCUMENTOS.lista.some((doc) => doc.ruta === DOCUMENTOS.activa)) {
    DOCUMENTOS.activa = null;
    estadoPestana.ruta = null;
    const vecino = DOCUMENTOS.lista[Math.min(indiceActiva, DOCUMENTOS.lista.length - 1)];
    if (vecino) await activarDocumento(vecino.ruta);
    else limpiarSinDocumento();
  } else {
    renderPestanas();
    guardarPersistencia();
  }
}

// crear un proyecto borra /proyecto: las pestañas viejas no pueden quedar apuntando a la nada
function limpiarEstadoEditor() {
  Historial.limpiar(VENTANA).catch((e) => falloSilencioso("limpiar el historial al crear proyecto", e));
  DOCUMENTOS.lista = [];
  DOCUMENTOS.activa = null;
  estadoPestana.ruta = null;
  estadoPestana.sucio = false;
  ARBOL.abiertos.clear();
  EDITOR.poner("");
  renderPestanas();
  renderHistorial();
  actualizarAccionesFichero();
  guardarPersistencia();
}

function cerrarMenuArchivo() {
  const menu = document.getElementById("menu-archivo");
  if (menu) menu.hidden = true;
}

function abrirMenuArchivo(x, y, nodo) {
  const menu = document.getElementById("menu-archivo");
  if (!menu) return;
  menu.textContent = "";
  const añadir = (texto, accion, peligro) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = texto;
    if (peligro) b.className = "peligro";
    b.onclick = () => { cerrarMenuArchivo(); accion(); };
    menu.appendChild(b);
  };
  if (!nodo.dir) {
    añadir("Abrir", async () => {
      if (await abrir(nodo.ruta)) {
        const vista = document.querySelector('[data-vista="pestana"]');
        if (vista && document.body.dataset.vista !== "pestana") vista.click();
      }
    });
    añadir("Descargar", () => descargarRuta(nodo.ruta));
  } else {
    añadir("Nuevo fichero aquí", () => nuevoFichero(nodo.ruta));
    añadir("Subir archivos aquí", () => pedirSubida(nodo.ruta, false));
    añadir("Subir carpeta aquí", () => pedirSubida(nodo.ruta, true));
  }
  añadir("Mover a…", async () => {
    const carpeta = await pedirCarpetaDestino();
    if (carpeta) await moverRuta(nodo.ruta, carpeta);
  });
  añadir("Renombrar", () => renombrarRuta(nodo.ruta));
  añadir("Borrar", () => borrarRuta(nodo.ruta), true);
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const caja = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - caja.width - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - caja.height - 6)) + "px";
}

function conectarMenu(fila, nodo) {
  fila.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    abrirMenuArchivo(e.clientX, e.clientY, nodo);
  });
  // Long press en táctil: el contexto nativo de Android no es fiable y aquí queremos un menú
  // propio con renombrar, borrar y descargar.
  let temporizador = null, inicio = null;
  const cancelar = () => {
    if (temporizador) clearTimeout(temporizador);
    temporizador = null;
    inicio = null;
  };
  fila.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    inicio = { x: e.clientX, y: e.clientY };
    temporizador = setTimeout(() => {
      temporizador = null;
      fila.dataset.menuLargo = "1";
      abrirMenuArchivo(inicio.x, inicio.y, nodo);
    }, 550);
  });
  fila.addEventListener("pointermove", (e) => {
    if (!inicio) return;
    if (Math.abs(e.clientX - inicio.x) > 8 || Math.abs(e.clientY - inicio.y) > 8) cancelar();
  });
  fila.addEventListener("pointerup", cancelar);
  fila.addEventListener("pointercancel", cancelar);

  if (ARRASTRABLE) {
    fila.draggable = true;
    fila.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("text/plain", nodo.ruta);
      e.dataTransfer.effectAllowed = "move";
      fila.classList.add("arrastrando");
    });
    fila.addEventListener("dragend", () => fila.classList.remove("arrastrando"));
    if (nodo.dir) {
      fila.addEventListener("dragover", (e) => {
        if (!Array.from(e.dataTransfer.types || []).includes("text/plain")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        fila.classList.add("soltar");
      });
      fila.addEventListener("dragleave", () => fila.classList.remove("soltar"));
      fila.addEventListener("drop", (e) => {
        e.preventDefault();
        fila.classList.remove("soltar");
        const origen = e.dataTransfer.getData("text/plain");
        if (origen) moverRuta(origen, nodo.ruta);
      });
    }
  }
}

async function renombrarRuta(ruta) {
  const nombre = ruta.split("/").pop();
  const nuevo = prompt("Nuevo nombre de " + nombre, nombre);
  if (!nuevo || nuevo === nombre) return;
  if (nuevo === "." || nuevo === ".." || nuevo.includes("/")) {
    nota("el nombre no puede llevar / ni ser . o ..");
    return;
  }
  const base = ruta.slice(0, ruta.lastIndexOf("/"));
  const destino = base + "/" + nuevo;
  const r = await conBloqueo(() => hospedador.renombrar(ruta, destino));
  if (r.tipo === "error") { nota("no se pudo renombrar: " + r.error); return; }
  publicar({ tipo: "mutacion", accion: "renombrar", origen: ruta, destino: destino });
  remapearDocumentos(ruta, destino);
  remapearAbiertos(ruta, destino);
  revelarRuta(estadoPestana.ruta);
  actualizarAccionesFichero();
  await refrescarArbol();
  nota("renombrado a " + relativa(destino));
}

async function borrarRuta(ruta) {
  if (!window.confirm("¿Borrar " + relativa(ruta) + "?")) return;
  const r = await conBloqueo(() => hospedador.limpiar(ruta));
  if (r.tipo === "error") { nota("no se pudo borrar: " + r.error); return; }
  publicar({ tipo: "mutacion", accion: "borrar", ruta: ruta });
  for (const abierta of [...ARBOL.abiertos]) {
    if (abierta === ruta || abierta.startsWith(ruta + "/")) ARBOL.abiertos.delete(abierta);
  }
  await quitarDocumentosBajo(ruta);
  await refrescarArbol();
  nota("borrado " + relativa(ruta));
}

// --- plegar, desplegar y mover ------------------------------------------------------------
function revelarRuta(ruta) {
  if (!ruta || !ruta.startsWith(PROYECTO + "/")) return;
  const partes = relativa(ruta).split("/");
  partes.pop();
  let actual = PROYECTO;
  for (const parte of partes) {
    actual += "/" + parte;
    ARBOL.abiertos.add(actual);
  }
}

function remapearAbiertos(origen, destino) {
  for (const ruta of [...ARBOL.abiertos]) {
    if (ruta === origen || ruta.startsWith(origen + "/")) {
      ARBOL.abiertos.delete(ruta);
      ARBOL.abiertos.add(destino + ruta.slice(origen.length));
    }
  }
}

function plegarTodo() {
  ARBOL.abiertos.clear();
  guardarPersistencia();
  refrescarArbol();
}

async function desplegarTodo() {
  let r;
  try { r = await hospedador.arbol(); } catch (e) { r = { nodos: [] }; }
  for (const nodo of r.nodos || []) {
    if (nodo.dir && nodo.ruta.startsWith(PROYECTO + "/")) ARBOL.abiertos.add(nodo.ruta);
  }
  guardarPersistencia();
  await refrescarArbol();
}

async function pedirCarpetaDestino() {
  const entrada = prompt("Carpeta destino dentro del proyecto", PROYECTO);
  if (entrada === null) return null;
  let carpeta = entrada.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!carpeta.startsWith("/")) carpeta = PROYECTO + "/" + carpeta;
  carpeta = normalizarRuta(carpeta);
  if (carpeta !== PROYECTO && !carpeta.startsWith(PROYECTO + "/")) {
    nota("la carpeta tiene que quedar dentro de /proyecto");
    return null;
  }
  const arbol = await hospedador.arbol();
  if (!(arbol.nodos || []).some((n) => n.dir && n.ruta === carpeta)) {
    nota("no existe la carpeta " + carpeta);
    return null;
  }
  return carpeta;
}

async function moverRuta(origen, carpeta) {
  if (!origen || !carpeta) return;
  carpeta = normalizarRuta(carpeta);
  // el arrastre no puede sacar nada del árbol que se ve
  if (!origen.startsWith(PROYECTO + "/")) return;
  if (carpeta !== PROYECTO && !carpeta.startsWith(PROYECTO + "/")) return;
  const destino = carpeta + "/" + origen.split("/").pop();
  if (destino === origen) return;
  if (destino.startsWith(origen + "/")) {
    nota("no se puede mover una carpeta dentro de sí misma");
    return;
  }
  const r = await conBloqueo(() => hospedador.renombrar(origen, destino));
  if (r.tipo === "error") { nota("no se pudo mover: " + r.error); return; }
  publicar({ tipo: "mutacion", accion: "mover", origen: origen, destino: destino });
  remapearDocumentos(origen, destino);
  remapearAbiertos(origen, destino);
  revelarRuta(estadoPestana.ruta);
  actualizarAccionesFichero();
  await refrescarArbol();
  nota("movido a " + relativa(destino));
}

async function refrescarArbol() {
  const fuera = document.getElementById("arbol-pestana");
  if (!fuera) return;
  let r;
  try {
    r = await hospedador.arbol();
  } catch (e) {
    r = { nodos: [] };
  }
  const nodos = (r.nodos || []).filter((n) => n.ruta.startsWith(PROYECTO + "/"));
  const entradaFiltro = document.getElementById("filtro-arbol");
  const filtro = entradaFiltro ? entradaFiltro.value.trim().toLowerCase() : "";
  let visibles = null;
  if (filtro) {
    // se queda lo que coincide y la cadena de padres, para que el árbol siga teniendo forma
    visibles = new Set();
    for (const n of nodos) {
      if (!relativa(n.ruta).toLowerCase().includes(filtro)) continue;
      visibles.add(n.ruta);
      let padre = n.ruta;
      while (padre.includes("/")) {
        padre = padre.slice(0, padre.lastIndexOf("/"));
        if (padre === PROYECTO || padre.length <= PROYECTO.length) break;
        visibles.add(padre);
      }
    }
  }
  const mostrados = filtro ? nodos.filter((n) => visibles.has(n.ruta)) : nodos;
  const scroll = fuera.scrollTop;
  fuera.textContent = "";
  if (!mostrados.length && filtro) {
    const vacio = document.createElement("div");
    vacio.className = "vacio";
    vacio.textContent = "Ningún fichero coincide con «" + entradaFiltro.value.trim() + "».";
    fuera.appendChild(vacio);
    return;
  }
  if (!nodos.length) {
    const vacio = document.createElement("div");
    vacio.className = "vacio";
    vacio.append("El proyecto está vacío. ");
    const ir = document.createElement("a");
    ir.href = enlaceConfiable("#crear");
    ir.textContent = "Crea uno en Inicio";
    ir.onclick = (e) => {
      e.preventDefault();
      const boton = document.querySelector('[data-vista="crear"]');
      if (boton) boton.click();
    };
    vacio.appendChild(ir);
    vacio.append(".");
    fuera.appendChild(vacio);
    fuera.scrollTop = 0;
    return;
  }

  // agrupa por carpeta: el explorador tiene que leerse como un árbol, no como una lista de rutas
  const hijos = new Map();
  for (const n of mostrados) {
    const partes = relativa(n.ruta).split("/");
    const padre = partes.length > 1 ? PROYECTO + "/" + partes.slice(0, -1).join("/") : PROYECTO;
    if (!hijos.has(padre)) hijos.set(padre, []);
    hijos.get(padre).push({ ...n, nombre: partes[partes.length - 1] });
  }
  for (const lista of hijos.values()) {
    lista.sort((x, y) => (Number(y.dir) - Number(x.dir)) || x.nombre.localeCompare(y.nombre));
  }

  const pintar = (padre, profundidad) => {
    for (const n of hijos.get(padre) || []) {
      const rel = relativa(n.ruta);
      const generado = rel === "build" || rel.startsWith("build/");
      const abierta = n.dir && (filtro ? true : ARBOL.abiertos.has(n.ruta));
      const fila = document.createElement("a");
      fila.href = enlaceConfiable("#");
      fila.dataset.ruta = n.ruta;
      fila.title = rel + (generado ? " · generado por apkc; se regenera en cada compilación" : "");
      fila.style.paddingLeft = (8 + profundidad * 12) + "px";
      fila.className = (n.dir ? "dir" : "archivo") + (generado ? " generado" : "");
      if (!n.dir) {
        const ext = (n.nombre.match(/\.([A-Za-z0-9]+)$/) || [])[1];
        if (ext) fila.classList.add("tipo-" + ext.toLowerCase());
      }
      fila.setAttribute("role", "treeitem");
      fila.setAttribute("aria-level", String(profundidad + 1));
      if (n.dir) fila.setAttribute("aria-expanded", String(abierta));
      if (n.ruta === estadoPestana.ruta) {
        fila.classList.add("activo");
        fila.setAttribute("aria-selected", "true");
      }

      const flecha = document.createElement("span");
      flecha.className = "arbol-flecha " +
        (n.dir ? (abierta ? "abierta" : "") : "hoja");
      fila.appendChild(flecha);

      const icono = document.createElement("span");
      icono.className = "arbol-icono " + (n.dir ? "dir" : "archivo");
      fila.appendChild(icono);

      const nombre = document.createElement("span");
      nombre.className = "nombre";
      nombre.textContent = n.nombre;
      fila.appendChild(nombre);
      if (generado && rel === "build") {
        const etiqueta = document.createElement("span");
        etiqueta.className = "arbol-generado";
        etiqueta.textContent = "generado";
        fila.appendChild(etiqueta);
      }

      if (!n.dir) {
        const bajar = document.createElement("span");
        bajar.className = "arbol-descargar";
        bajar.textContent = "↓";
        bajar.title = "Descargar " + relativa(n.ruta);
        bajar.setAttribute("role", "button");
        bajar.setAttribute("aria-label", "Descargar " + relativa(n.ruta));
        fila.appendChild(bajar);
      }

      if (n.dir) {
        fila.onclick = (e) => {
          e.preventDefault();
          if (fila.dataset.menuLargo) { delete fila.dataset.menuLargo; return; }
          if (ARBOL.abiertos.has(n.ruta)) ARBOL.abiertos.delete(n.ruta);
          else ARBOL.abiertos.add(n.ruta);
          guardarPersistencia();
          refrescarArbol();
        };
      } else {
        fila.onclick = async (e) => {
          e.preventDefault();
          if (fila.dataset.menuLargo) { delete fila.dataset.menuLargo; return; }
          if (e.target.closest(".arbol-descargar")) {
            await descargarRuta(n.ruta);
            return;
          }
          if (await abrir(n.ruta)) {
            const vista = document.querySelector('[data-vista="pestana"]');
            if (vista && document.body.dataset.vista !== "pestana") vista.click();
          }
        };
      }
      conectarMenu(fila, n);
      fuera.appendChild(fila);
      if (n.dir && abierta) pintar(n.ruta, profundidad + 1);
    }
  };
  pintar(PROYECTO, 0);
  fuera.scrollTop = scroll;

  // el fichero abierto puede quedar fuera de la parte visible del explorador: se acerca
  // solo lo justo, sin saltar al principio ni mover la página entera
  const activo = fuera.querySelector("a.activo");
  if (activo) {
    const r = activo.getBoundingClientRect(), c = fuera.getBoundingClientRect();
    if (r.top < c.top) fuera.scrollTop -= c.top - r.top;
    else if (r.bottom > c.bottom) fuera.scrollTop += r.bottom - c.bottom;
  }
}

// Abrir ya no descarta nada: cada fichero tiene su pestaña y su texto vive en ella. El contenido
// de una pestaña limpia no se lee hasta que se activa, así restaurar diez ficheros no lee diez.
async function abrir(ruta, yaConfirmado) {
  if (!ruta) return false;
  if (documentoDe(ruta)) return activarDocumento(ruta);
  DOCUMENTOS.lista.push({ ruta, texto: null, sucio: false, cursor: null, scroll: null });
  renderPestanas();
  return activarDocumento(ruta);
}

// Selecciona una línea del fichero abierto. El número viene de la consola (`ruta:línea`) y se
// limita al tamaño real: un enlace no puede dejar el cursor fuera del texto.
function irALinea(numero) {
  const area = document.getElementById("codigo");
  if (!area) return;
  const lineas = area.value.split("\n");
  const n = Math.max(1, Math.min(Number(numero) || 1, lineas.length));
  let desde = 0;
  for (let i = 0; i < n - 1; i++) desde += lineas[i].length + 1;
  area.focus();
  area.setSelectionRange(desde, desde + lineas[n - 1].length);
  const alto = parseFloat(getComputedStyle(area).lineHeight) || 18;
  area.scrollTop = Math.max(0, (n - 3) * alto);
  EDITOR.sincronizar();
  actualizarCursor();
}

async function saltarALinea(ruta, numero) {
  const limpia = String(ruta || "").replace(/^\.\//, "");
  if (!limpia) return;
  const absoluta = limpia.startsWith("/") ? limpia : PROYECTO + "/" + limpia;
  if (!(await abrir(absoluta))) return;
  irALinea(numero);
}

// La búsqueda del editor vive en busqueda.js.
const { abrirBusqueda, cerrarBusqueda, buscarSiguiente, reemplazarUno,
  reemplazarTodos, irALineaDesdeCuadro } =
  crearBusqueda({ EDITOR, actualizarCursor, irALinea });

function marcarSucio(v) {
  const doc = documentoActivo();
  // F5: con la pestaña cargando y el documento todavía sin texto, marcar sucio dejaba `texto=null`
  // en el documento nuevo y la lectura de OPFS pisaba después lo tecleado
  if (v && !puedeMarcarSucio(doc, cargandoDocumento)) return;
  if (doc) doc.sucio = !!v;
  estadoPestana.sucio = !!v;
  pintarMarcaSucio();
}
function estaSucio() {
  const doc = documentoActivo();
  return doc ? !!doc.sucio : !!estadoPestana.sucio;
}

// Las acciones del menú Archivo que necesitan un fichero abierto se deshabilitan en vez de
// contestar «abre uno primero» cuando no lo hay.
function actualizarAccionesFichero() {
  const hay = !!documentoActivo() || !!estadoPestana.ruta;
  for (const id of ["renombrar-fichero", "borrar-fichero"]) {
    const boton = document.getElementById(id);
    if (boton) boton.disabled = !hay;
  }
  const descargar = document.getElementById("descargar-fichero");
  if (descargar) descargar.hidden = !hay;
}
function confirmarDescartes() { return window.confirm("Hay cambios sin guardar. ¿Descartarlos?"); }

function rutaDeManifiesto(ruta) { return /(^|\/)AndroidManifest\.xml$/.test(String(ruta || "")); }

// Un AndroidManifest.xml siempre tiene `<manifest>` por raíz, pero delante caben prólogos que
// apkc acepta porque lo lee con `encoding/xml.Unmarshal`: BOM, espacios, la declaración
// `<?xml ...?>`, comentarios —también de varias líneas— y un DOCTYPE, con o sin subconjunto
// interno `[ ... ]` y con comillas en el identificador de sistema. El veto se salta esos prólogos
// y mira qué etiqueta queda: así no rechaza nada que el parser acepte, y sigue parando el XML de
// un layout pegado en esta pestaña, que dejaría el proyecto roto con el error lejos de la causa.
function pareceManifiesto(texto) {
  let resto = String(texto == null ? "" : texto).replace(/^\uFEFF/, "");
  for (;;) {
    resto = resto.trimStart();                       // espacios y saltos entre prólogos
    if (resto.startsWith("<?xml")) {
      const fin = resto.indexOf("?>");
      if (fin < 0) return false;
      resto = resto.slice(fin + 2);
      continue;
    }
    if (resto.startsWith("<!--")) {
      const fin = resto.indexOf("-->");
      if (fin < 0) return false;
      resto = resto.slice(fin + 3);
      continue;
    }
    // el nombre de la declaración no distingue mayúsculas: `<!doctype` y `<!DOCTYPE` son lo mismo
    if (resto.slice(0, 9).toUpperCase() === "<!DOCTYPE") {
      // termina en el primer `>` que no esté dentro del subconjunto interno `[ ... ]` ni entre
      // comillas: en `SYSTEM "a>b"` el `>` va dentro del literal y no cierra el DOCTYPE
      let i = 9, corchetes = 0, comilla = "";
      for (; i < resto.length; i++) {
        const c = resto[i];
        if (comilla) {
          if (c === comilla) comilla = "";
        } else if (c === '"' || c === "'") comilla = c;
        else if (c === "[") corchetes += 1;
        else if (c === "]") corchetes = Math.max(0, corchetes - 1);
        else if (c === ">" && corchetes === 0) break;
      }
      if (i >= resto.length) return false;
      resto = resto.slice(i + 1);
      continue;
    }
    break;
  }
  return /^<manifest(\s|\/?>)/.test(resto);
}

// El motivo va a la barra (lo que se mira al volver a la pestaña) y a la consola de desarrollo.
// Devuelve el texto para que las pruebas lo puedan exigir sin leer el DOM.
function avisarManifiestoInvalido(ruta) {
  const motivo = "no se guardó " + relativa(ruta) + ": su contenido no empieza por <manifest> " +
    "(¿está el XML de un layout en la pestaña del manifiesto?)";
  nota(motivo);
  console.error(motivo);
  return motivo;
}

async function guardar() {
  // F1: con una pestaña a medio abrir, el textarea todavía no es suyo. Escribir ahora guardaría
  // el buffer anterior en la ruta nueva; el motivo va a la barra, que es donde se mira.
  if (cargandoDocumento) {
    nota("espera a que termine de abrirse la pestaña antes de guardar");
    return false;
  }
  let doc = documentoActivo();
  let nuevo = false;
  if (!doc) {
    // compatibilidad con quien fija estadoPestana.ruta a mano (las pruebas lo hacen) y con el
    // primer guardado de un buffer sin nombre. La existencia del fichero se comprueba dentro del
    // mismo bloqueo que escribe (más abajo): fuera, otra ventana podía crearlo entre la
    // confirmación y el `escribir` y se pisaba sin avisar (TOCTOU).
    const ruta = estadoPestana.ruta || await nuevoNombre();
    if (!ruta) return false;
    doc = { ruta, texto: EDITOR.texto(), sucio: true, cursor: null, scroll: null,
      hist: Historial.crear(ruta, EDITOR.texto()) };
    nuevo = true;
  }
  if (!doc.hist) doc.hist = Historial.crear(doc.ruta, EDITOR.texto());
  volcarHistorial();
  const ruta = doc.ruta;
  const guardado = EDITOR.texto();
  const anterior = doc.revision;
  const revision = nuevaRevision();
  if (rutaDeManifiesto(ruta) && !pareceManifiesto(guardado)) {
    avisarManifiestoInvalido(ruta);
    return false;
  }
  // La revisión se lee y se confirma dentro del mismo bloqueo que la escritura: si se mirara
  // antes, otra ventana podía guardar entre la confirmación y el `escribir` y su cambio se
  // perdía sin avisar (TOCTOU). El diálogo corre con el bloqueo tomado, así que mientras está
  // abierto ninguna otra ventana puede escribir este proyecto; cancelar solo suelta el bloqueo.
  // Lo mismo vale para el «Ya existe» del buffer que todavía no tiene pestaña.
  let sobrescribir = true;
  try {
    await conBloqueo(async () => {
      if (nuevo) {
        const previo = await hospedador.leer(ruta);
        if (previo && previo.bytes &&
            !window.confirm("Ya existe " + relativa(ruta) + ". ¿Reemplazarlo?")) {
          sobrescribir = false;
          return;
        }
      }
      const revisionGuardada = revisionActual(ruta);
      if (anterior && revisionGuardada && anterior !== revisionGuardada &&
          !window.confirm("Otra ventana guardó " + relativa(ruta) + ". ¿Sobrescribir?")) {
        sobrescribir = false;
        return;
      }
      const escrito = await hospedador.escribir(ruta, new TextEncoder().encode(guardado));
      if (escrito && escrito.tipo === "error") throw new Error(escrito.error);
      try { localStorage.setItem(claveRevision(ruta), revision); } catch (e) { /* sin revisión */ }
    });
  } catch (e) {
    nota("no se pudo guardar " + ruta + ": " + (e && e.message ? e.message : e));
    return false;
  }
  if (!sobrescribir) return false;
  // el buffer sin pestaña se registra solo cuando el guardado procede: cancelar el «Ya existe»
  // no deja una pestaña a medio abrir de un fichero que no se escribió
  if (nuevo) {
    DOCUMENTOS.lista.push(doc);
    DOCUMENTOS.activa = ruta;
    estadoPestana.ruta = ruta;
    revelarRuta(ruta);
    renderPestanas();
    volcarHistorial();
  }
  doc.revision = revision;
  doc.base = guardado;
  // si se siguió escribiendo o se cambió de pestaña mientras el worker guardaba, el documento
  // solo queda limpio si el texto en memoria sigue siendo el que se escribió
  const actual = documentoDe(ruta);
  if (actual) {
    const texto = DOCUMENTOS.activa === ruta ? EDITOR.texto() : actual.texto;
    if (texto === guardado) {
      actual.sucio = false;
      if (DOCUMENTOS.activa === ruta) actual.texto = null;
    }
    if (DOCUMENTOS.activa === ruta) marcarSucio(!!actual.sucio);
  }
  renderPestanas();
  renderHistorial();
  actualizarAccionesFichero();
  Historial.guardar(VENTANA, doc.hist)
    .catch((e) => falloSilencioso("guardar el historial de " + doc.ruta, e));
  publicar({ tipo: "guardado", ruta, revision });
  nota("guardado en " + ruta);
  await refrescarArbol();
  guardarPersistencia();
  return true;
}

// Compilar lee OPFS, no el textarea: con un documento sucio, `apkc build` compilaba la versión
// guardada y el Emulador seguía enseñando la apk anterior aunque el comando saliera 0. Es el
// síntoma «compilo y el Emulador no recarga la última APK» con el cambio delante y sin guardar.
// Antes de compilar se guardan todos los documentos sucios —lo que hace un IDE al construir— y si
// uno no se puede guardar no se compila a medias: se devuelve -1 y el motivo ya está en la barra.
async function guardarParaCompilar() {
  const sucios = DOCUMENTOS.lista.filter((doc) => doc.sucio);
  if (!sucios.length) {
    // buffer sin pestaña: la compatibilidad con `estadoPestana.ruta` puesto a mano
    if (!(estadoPestana.sucio && !documentoActivo())) return 0;
    return (await guardar()) ? 1 : -1;
  }
  let guardados = 0;
  for (const doc of sucios) {
    if (DOCUMENTOS.activa === doc.ruta) {
      // el documento activo vive en el textarea, y `guardar` es la entrada única (revisiones,
      // historial y aviso a las otras ventanas)
      if (!await guardar()) return -1;
      guardados += 1;
      continue;
    }
    // el documento no activo conserva su texto en `doc.texto` mientras está sucio; si no lo
    // tuviera, guardarlo como vacío borraría el fichero: mejor no compilar y decirlo
    if (typeof doc.texto !== "string") {
      nota("no se pudo guardar " + relativa(doc.ruta) + " antes de compilar: el editor no tiene su texto");
      return -1;
    }
    const texto = doc.texto;
    // mismo veto que `guardar`: compilar con un manifiesto que no es manifiesto falla lejos
    // de la causa, y dejar el fichero a medias es peor que no compilar
    if (rutaDeManifiesto(doc.ruta) && !pareceManifiesto(texto)) {
      avisarManifiestoInvalido(doc.ruta);
      return -1;
    }
    const revision = nuevaRevision();
    try {
      await conBloqueo(async () => {
        const escrito = await hospedador.escribir(doc.ruta, new TextEncoder().encode(texto));
        if (escrito && escrito.tipo === "error") throw new Error(escrito.error);
        try { localStorage.setItem(claveRevision(doc.ruta), revision); } catch (e) { /* sin revisión */ }
      });
    } catch (e) {
      nota("no se pudo guardar " + relativa(doc.ruta) + " antes de compilar: " + (e && e.message ? e.message : e));
      return -1;
    }
    doc.revision = revision;
    doc.base = texto;
    doc.sucio = false;
    doc.texto = null;
    publicar({ tipo: "guardado", ruta: doc.ruta, revision });
    guardados += 1;
  }
  renderPestanas();
  renderHistorial();
  actualizarAccionesFichero();
  return guardados;
}

// El nombre por defecto sale del package que la persona escribió en Inicio, y cualquier ruta
// relativa se ancla a /proyecto: así "Nuevo" no puede escribir fuera del árbol que se ve.
function paqueteDelFormulario() {
  const campo = document.querySelector('#form [name="package"]');
  const paquete = campo ? String(campo.value || "").trim().toLowerCase() : "";
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(paquete) ? paquete : "com.mi.app";
}

function normalizarRuta(ruta) {
  const partes = [];
  for (const parte of ruta.split("/")) {
    if (!parte || parte === ".") continue;
    if (parte === "..") { partes.pop(); continue; }
    partes.push(parte);
  }
  return "/" + partes.join("/");
}

async function nuevoNombre(carpeta) {
  const base = carpeta || (PROYECTO + "/src/" + paqueteDelFormulario().replace(/\./g, "/"));
  const sugerida = base + "/" + (carpeta ? "nuevo.txt" : "MainActivity.java");
  const entrada = prompt("Ruta dentro del proyecto", sugerida);
  if (entrada === null) return null;
  let ruta = entrada.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!ruta.startsWith("/")) ruta = PROYECTO + "/" + ruta;
  ruta = normalizarRuta(ruta);
  if (!ruta.startsWith(PROYECTO + "/")) {
    nota("la ruta tiene que quedar dentro de /proyecto");
    return null;
  }
  return ruta;
}

// Crear un fichero desde el menú Archivo o desde el menú de una carpeta del árbol. La ruta se
// pide siempre, pero el valor por defecto cambia: MainActivity.java en el package del formulario,
// o nuevo.txt dentro de la carpeta sobre la que se pulsó.
async function nuevoFichero(carpeta) {
  const nombre = await nuevoNombre(carpeta);
  if (!nombre) return;
  const previo = await hospedador.leer(nombre);
  if (previo && previo.bytes && !window.confirm("Ya existe " + relativa(nombre) + ". ¿Reemplazarlo?")) return;
  // el fichero nace vacío en OPFS para que el explorador y el estado «sin cambios» digan
  // la verdad: un buffer suelto que no está en el árbol confunde más que ayuda
  try {
    await conBloqueo(async () => {
      const r = await hospedador.escribir(nombre, new Uint8Array(0));
      if (r && r.tipo === "error") throw new Error(r.error);
      try { localStorage.setItem(claveRevision(nombre), nuevaRevision()); } catch (e) { /* sin revisión */ }
    });
  } catch (e) {
    nota("no se pudo crear " + relativa(nombre) + ": " + (e && e.message ? e.message : e));
    return;
  }
  await abrir(nombre);
  const codigo = document.getElementById("codigo");
  if (codigo) codigo.focus();
  publicar({ tipo: "mutacion", accion: "crear", rutas: [nombre] });
  nota("creado " + relativa(nombre));
  guardarPersistencia();
}

// --- el panel inferior -------------------------------------------------------------------
// §343: es una instancia del módulo `compilacion`. Su altura la da la preferencia del módulo y
// el asa lo trae al frente dentro de la banda z 40-59. No se renombran ids ni se toca el botón
// «Compilar»: siguen siendo el contrato del editor y de las pruebas.
const moduloCompilacion = instanciaModulo("compilacion", "");
function aplicarModuloCompilacion(panel) {
  if (!panel) return;
  const def = MODULOS.compilacion;
  panel.dataset.modulo = def.id;
  panel.style.setProperty("--modulo-alto", def.altoPref + "px");
  panel.style.setProperty("--z", String(moduloCompilacion.estado.z));
  const asa = panel.querySelector(".modulo-asa");
  if (asa && !asa.dataset.conectado) {
    asa.dataset.conectado = "1";
    asa.addEventListener("pointerdown", () => {
      moduloCompilacion.estado.z += 1;
      panel.style.setProperty("--z", String(moduloCompilacion.estado.z));
    });
  }
}

function mostrarPanel(nombre) {
  const panel = document.getElementById("panel-inferior");
  if (!panel) return;
  aplicarModuloCompilacion(panel);
  panel.hidden = false;
  for (const b of document.querySelectorAll(".panel-tab")) {
    const activo = b.dataset.panel === nombre;
    b.classList.toggle("activo", activo);
    b.setAttribute("aria-selected", String(activo));
  }
  for (const v of document.querySelectorAll("#panel-inferior .panel-vista")) {
    v.classList.toggle("activa", v.id === "panel-" + nombre);
  }
  if (nombre === "historial") renderHistorial();
  const alternar = document.getElementById("alternar-panel");
  if (alternar) alternar.setAttribute("aria-expanded", "true");
}

function alternarPanel(nombre) {
  const panel = document.getElementById("panel-inferior");
  if (!panel) return;
  if (nombre) { mostrarPanel(nombre); return; }
  panel.hidden = !panel.hidden;
  const alternar = document.getElementById("alternar-panel");
  if (alternar) alternar.setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) {
    const activa = document.querySelector(".panel-tab.activo");
    if (activa) mostrarPanel(activa.dataset.panel);
  }
}

function cerrarPanel() {
  const panel = document.getElementById("panel-inferior");
  if (panel) panel.hidden = true;
  const alternar = document.getElementById("alternar-panel");
  if (alternar) alternar.setAttribute("aria-expanded", "false");
}

// --- los comandos ------------------------------------------------------------------------
// C4: `argv` guarda la copia redactada, nunca la contraseña. `build` se recuerda aparte porque
// una orden con `--storepass ***` no se puede relanzar tal cual.
const ULTIMO = { argv: ["create", PROYECTO], build: null, secreto: false };

// C3/C4: Ctrl+Enter repite la última orden, pero un `build` vuelve por su camino real: pide la
// clave otra vez y `compilarCon` guarda los documentos sucios antes de compilar. Una orden con
// contraseña no se repite desde aquí, porque lo guardado está redactado y fallaría con `***`.
async function ejecutarUltimo() {
  if (ULTIMO.build) {
    return ULTIMO.build === "debug" ? compilarDebug() : compilarDelTodo();
  }
  if (ULTIMO.secreto) {
    nota("no repito «" + ULTIMO.argv[0] + "» con Ctrl+Enter: lleva una contraseña que no se guarda");
    return null;
  }
  return correr(ULTIMO.argv);
}

// La línea que se pinta en la consola no puede repetir una contraseña: el buffer de CONSOLA
// guarda muchos caracteres y limpiar el campo del formulario no borra lo ya escrito. Se redacta
// solo la copia que se muestra; `argv` sigue intacto para hospedador.ejecutar. Cubre tanto
// `--storepass saludo` como `--storepass=saludo` y nombres como `--old-storepass`. El valor se
// redacta aunque empiece por `-`: una contraseña así también es una contraseña.
function redactarArgv(argv) {
  return argv.map((arg, i) => {
    const s = String(arg);
    const igual = s.indexOf("=");
    if (igual > 0 && /pass/i.test(s.slice(0, igual))) return s.slice(0, igual + 1) + "***";
    const anterior = String(argv[i - 1] || "");
    if (anterior.startsWith("-") && /pass/i.test(anterior)) return "***";
    return s;
  });
}

// El estado de `#ultimo-codigo` es de la compilación, no de cualquier orden: C1 dice «no compilé»
// cuando el build ni siquiera empezó y C2 evita que el `verify` posterior pise el código del
// build. Las órdenes internas se lanzan con `{ recordar: false }`.
function codigoUltimo(valor) {
  const codigo = document.getElementById("ultimo-codigo");
  if (codigo) codigo.textContent = String(valor);
}

function mensajeNoCompile(motivo) {
  return "no compilé" + (motivo ? ": " + motivo : "");
}

function noCompile(motivo) {
  codigoUltimo("no compilé");
  CONSOLA.escribir(mensajeNoCompile(motivo) + "\n");
}

async function correr(argv, opciones = {}) {
  const recordar = opciones.recordar !== false;
  if (recordar) {
    // C4: lo que se puede repetir va redactado; `argv` entero sigue yendo al hospedador
    ULTIMO.argv = redactarArgv(argv);
    ULTIMO.secreto = ULTIMO.argv.some((arg, i) => arg !== String(argv[i]));
    ULTIMO.build = opciones.build || null;
  }
  // la salida vive en el panel del editor: un atajo lanzado desde Inicio no puede dejarla oculta
  const vistaEditor = document.querySelector('[data-vista="pestana"]');
  if (vistaEditor && document.body.dataset.vista !== "pestana") vistaEditor.click();
  mostrarPanel("salida");
  CONSOLA.escribir("$ apkc " + redactarArgv(argv).join(" ") + "\n");
  const ocupado = document.getElementById("ocupado");
  const botonDetener = document.getElementById("detener-comando");
  if (ocupado) { ocupado.hidden = false; ocupado.textContent = "apkc trabajando…"; }
  if (botonDetener) botonDetener.hidden = false;
  let r;
  let recibido = 0;
  // la salida llega trozo a trozo: se pinta ya y la última línea hace de fase en la barra, sin
  // inventar porcentajes que apkc no imprime
  hospedador.escucharSalida((texto) => {
    recibido += texto.length;
    CONSOLA.escribir(texto);
    const lineas = texto.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n").filter((l) => l.trim());
    const ultima = lineas[lineas.length - 1];
    if (ocupado && ultima) ocupado.textContent = "apkc: " + ultima.trim().slice(0, 70);
  });
  try {
    comandosDelUsuario++;
    r = await hospedador.ejecutar(argv);
  } catch (e) {
    // si el worker no arranca, el aviso de «trabajando» no puede quedarse para siempre
    r = { tipo: "error", error: String((e && e.message) || e), consola: "" };
  } finally {
    comandosDelUsuario--;
    hospedador.escucharSalida(null);
    if (ocupado) ocupado.hidden = true;
    if (botonDetener) botonDetener.hidden = true;
  }
  const completa = String(r.consola || "");
  CONSOLA.escribir(completa.slice(recibido) + (r.error ? "FALLO DEL HOSPEDADOR: " + r.error + "\n" : ""));
  if (recordar && r.tipo === "terminado") codigoUltimo(r.codigo);
  await refrescarArbol();
  return r;
}

// Go wasm no se puede matar por dentro: se termina el worker y el siguiente comando arranca
// otro. Es honesto avisar de que el build puede quedar a medias.
function detener() {
  if (!hospedador.cancelar()) return;
  CONSOLA.escribir("\ncomando detenido; el build puede quedar a medias (apkc clean para empezar de cero).\n");
  const codigo = document.getElementById("ultimo-codigo");
  if (codigo) codigo.textContent = "(detenido)";
  const ocupado = document.getElementById("ocupado");
  if (ocupado) ocupado.hidden = true;
  const boton = document.getElementById("detener-comando");
  if (boton) boton.hidden = true;
}

function nota(texto) {
  // la página se puede recortar: sin el aviso, un fallo de OPFS no puede reventar el manejador
  const n = document.getElementById("estado-pestana");
  if (n) n.textContent = texto;
}

async function firmar() {
  const cfg = KEYSTORES.firmar;
  const k = await prepararKeystore(cfg);
  if (!k) return;
  const entrada = document.getElementById("apk-a-firmar");
  const origen = (entrada.value || PROYECTO + "/build/app.apk").trim();
  const esAab = /\.aab$/i.test(origen);
  const destino = PROYECTO + "/build/firmado." + (esAab ? "aab" : "apk");
  const v4 = document.getElementById("v4-firmar").checked;
  nota("firmando " + origen + " con " + k.alias + " (no sale de esta pestaña)");
  // `sign` escribe `firmado.*.tmp` junto al destino y no crea la carpeta. Si el proyecto no se
  // compiló nunca, build/ no existe: se crea con un fichero vacío (escribir crea los padres) y se
  // borra antes de firmar.
  await hospedador.escribir(PROYECTO + "/build/.carpeta", new Uint8Array(0));
  await hospedador.limpiar(PROYECTO + "/build/.carpeta");
  const argv = ["sign", "--keystore", k.ruta, "--storepass", k.pass,
    "--keyalias", k.alias, "--v4=" + (v4 ? "true" : "false")];
  if (document.getElementById("usar-rotacion").checked) {
    if (esAab) { nota("un .aab no lleva bloque v3/v3.1: la rotación es para apk"); return; }
    const passV = document.getElementById("storepass-viejo").value;
    const aliasV = (document.getElementById("keyalias-viejo").value || "androiddebugkey").trim();
    const rotMin = (document.getElementById("rotation-min-sdk").value || "33").trim();
    if (!passV) { nota("falta la contraseña del keystore viejo para la rotación"); return; }
    if (!(await hospedador.leer(RUTA_LINAJE)).bytes) {
      nota("crea el linaje antes de firmar con rotación");
      return;
    }
    argv.push("--lineage", RUTA_LINAJE, "--old-keystore", RUTA_VIEJO,
      "--old-storepass", passV, "--old-keyalias", aliasV, "--rotation-min-sdk", rotMin);
  }
  argv.push("--out", destino, origen);
  const r = await correr(argv);
  // la contraseña se limpia también cuando falla: un campo con la clave abierta en una pestaña
  // que se queda delante no es un detalle de estilo
  const campoPass = document.getElementById(cfg.pass);
  if (campoPass) campoPass.value = "";
  const campoViejo = document.getElementById("storepass-viejo");
  if (campoViejo) campoViejo.value = "";
  if (r && r.codigo === 0) {
    // el verify es un paso interno: no pisa `#ultimo-codigo` ni cambia lo que repite Ctrl+Enter
    const v = await correr(["verify", destino], { recordar: false });
    await descargar(destino);
    await ofrecerDescarga(destino + ".idsig", "descargar-idsig");
    if (v && v.codigo === 0) nota("firmado y verificado: " + destino.split("/").pop());
  }
}

// Descargar una entrada cualquiera del explorador sin abrirla en el editor: vale también
// para un PNG, un .apk o un .idsig que no son texto.
async function descargarRuta(ruta) {
  const nombre = ruta.split("/").pop();
  return conCarga("Preparando " + nombre + "…", async () => {
    try {
      const bytes = await hospedador.bytes(ruta);
      if (!bytes) { nota("no existe " + ruta); return; }
      const enlace = document.createElement("a");
      enlace.href = enlaceConfiable(URL.createObjectURL(new Blob([bytes])));
      enlace.download = nombre;
      enlace.click();
      setTimeout(() => URL.revokeObjectURL(enlace.href), 2000);
      nota("descarga lista: " + enlace.download + " (" + bytes.length + " bytes)");
    } catch (e) {
      nota("no se pudo descargar " + ruta + ": " + (e && e.message ? e.message : e));
    }
  });
}

// Los enlaces de descarga se reutilizan en cada compilación: guardar el blob anterior y
// revocarlo evita que una sesión larga acumule apks en memoria.
function ponerBlob(enlace, bytes, tipo) {
  if (!enlace) return null;
  if (enlace.dataset.blob) URL.revokeObjectURL(enlace.dataset.blob);
  const url = URL.createObjectURL(new Blob([bytes], { type: tipo }));
  enlace.dataset.blob = url;
  enlace.href = enlaceConfiable(url);
  return url;
}

async function descargar(ruta, ancla) {
  const nombre = ruta.split("/").pop();
  return conCarga("Preparando " + nombre + "…", async () => {
    const r = await hospedador.leer(ruta);
    if (!r.bytes) { nota("no hay nada en " + ruta); return; }
    const bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
    const enlace = document.getElementById(ancla || "descargar-apk");
    if (!enlace) return;
    const tipo = /\.aab$/i.test(ruta) ? "application/octet-stream" : "application/vnd.android.package-archive";
    ponerBlob(enlace, bytes, tipo);
    enlace.download = nombre;
    enlace.hidden = false;
    if (ancla === "descargar-fichero") {
      enlace.textContent = "Descargar";
    } else {
      enlace.textContent = enlace.download + " (" + bytes.length + " bytes)";
      const barra = document.getElementById("panel-descargas");
      if (barra) barra.hidden = false;
    }
    nota("descarga lista: " + enlace.download + " (" + bytes.length + " bytes)");
  });
}

// El .idsig viaja al lado del apk. Si no existe (un .aab, o --v4=false) el enlace se
// esconde, para que no quede un botón que no lleva a nada.
async function ofrecerDescarga(ruta, ancla) {
  const nombre = ruta.split("/").pop();
  return conCarga("Preparando " + nombre + "…", async () => {
    const enlace = document.getElementById(ancla);
    if (!enlace) return;
    const r = await hospedador.leer(ruta);
    if (!r.bytes) {
      enlace.hidden = true;
      if (enlace.dataset.blob) { URL.revokeObjectURL(enlace.dataset.blob); delete enlace.dataset.blob; }
      enlace.removeAttribute("href");
      return;
    }
    const bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
    ponerBlob(enlace, bytes, "application/octet-stream");
    enlace.download = nombre;
    enlace.textContent = enlace.download + " (" + bytes.length + " bytes)";
    enlace.hidden = false;
    const barra = document.getElementById("panel-descargas");
    if (barra) barra.hidden = false;
  });
}

// --- el build sin procesos: recursos, Java, dex y firma, en este mismo binario ------------
const RUTA_JAR = "/sdk/android.jar";
const RUTA_KEYSTORE = "/sdk/release.keystore";
const RUTA_VIEJO = "/keystore-viejo";
const RUTA_LINAJE = "/lineage.bin";

// API de compilación: el selector visible mantiene sincronizados los dos campos que ya usaba
// `apkc build` (y que las pruebas siguen fijando a mano).
const API_NOMBRES = {
  27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12L",
  33: "13", 34: "14", 35: "15",
};
const API_PREF = "apkc-studio/api";

function sincronizarApi(guardar) {
  const selector = document.getElementById("api-version");
  const version = document.getElementById("sdk-version");
  const codename = document.getElementById("codename");
  if (!selector) return;
  if (version) version.value = selector.value;
  if (codename) codename.value = API_NOMBRES[selector.value] || "";
  if (guardar) {
    try { localStorage.setItem(API_PREF, selector.value); } catch (e) { /* sin preferencia */ }
  }
}

// Lo que el servidor local sabe del SDK o del jar AOSP publicado en el propio origen. En una página
// servida de forma estática sin /android-stub.json ni /android-jar-info, el camino es el paquete
// oficial de Google, el .zip o el .jar. `url` y `sha256` solo se llenan en la ruta nueva del stub.
const JAR_SDK = {
  disponible: false, consultado: false, version: null, bytes: 0,
  sha256: "", url: "/android-jar", origen: "SDK", tag: "",
};

// Un keystore por flujo: el del build queda en OPFS (`/sdk/release.keystore`) y el de `sign` en
// `/keystore`, las rutas que ya usaban los botones. Lo nuevo es la contraseña, el alias que se
// elige entre los que el fichero declara, y el certificado que se enseña antes de firmar.
const KEYSTORES = {
  compilar: { fichero: "keystore-compilar", pass: "storepass-compilar", alias: "keyalias-compilar",
              estado: "estado-keystore-compilar", ruta: RUTA_KEYSTORE },
  firmar: { fichero: "keystore", pass: "storepass-firmar", alias: "keyalias-firmar",
            estado: "estado-keystore-firmar", ruta: "/keystore" },
};

function actualizarEstadoClave(tiene) {
  const detalle = document.getElementById("detalle-release");
  const badge = document.getElementById("clave-badge");
  const boton = document.getElementById("crear-clave-release");
  if (detalle) {
    detalle.classList.toggle("jar-listo", !!tiene);
    if (tiene) detalle.open = false;
  }
  if (badge) {
    badge.hidden = !tiene;
    badge.textContent = tiene ? "listo" : "";
  }
  if (boton) {
    boton.textContent = tiene ? "Cambiar clave de release" : "Crear clave de release";
    boton.classList.toggle("primario", !tiene);
  }
}

async function decirEstadoClave() {
  try {
    const r = await hospedador.leer(RUTA_KEYSTORE);
    actualizarEstadoClave(!!(r && r.bytes));
    return !!(r && r.bytes);
  } catch (e) {
    actualizarEstadoClave(false);
    return false;
  }
}

let claveDescargaUrl = null;

function cerrarDialogoClave() {
  const dialogo = document.getElementById("dialogo-clave");
  if (!dialogo) return;
  if (typeof dialogo.close === "function") dialogo.close();
  else dialogo.hidden = true;
}

function abrirDialogoClave() {
  const dialogo = document.getElementById("dialogo-clave");
  if (!dialogo) return;
  const form = document.getElementById("clave-paso-form");
  const listo = document.getElementById("clave-paso-listo");
  if (form) form.hidden = false;
  if (listo) listo.hidden = true;
  const aviso = document.getElementById("clave-aviso");
  const guardada = document.getElementById("clave-guardada");
  const generar = document.getElementById("clave-generar");
  const terminar = document.getElementById("clave-terminar");
  const estado = document.getElementById("clave-estado");
  if (aviso) aviso.checked = false;
  if (guardada) guardada.checked = false;
  if (generar) generar.disabled = true;
  if (terminar) terminar.disabled = true;
  if (estado) estado.textContent = "";
  for (const id of ["clave-pass", "clave-pass2"]) {
    const campo = document.getElementById(id);
    if (campo) campo.value = "";
  }
  if (typeof dialogo.showModal === "function") dialogo.showModal();
  else dialogo.hidden = false;
}

async function generarClaveRelease() {
  const valor = (id) => {
    const campo = document.getElementById(id);
    return campo ? campo.value.trim() : "";
  };
  const alias = valor("clave-alias") || "release";
  const pass = document.getElementById("clave-pass") ? document.getElementById("clave-pass").value : "";
  const pass2 = document.getElementById("clave-pass2") ? document.getElementById("clave-pass2").value : "";
  const cn = valor("clave-cn") || "Release";
  const org = valor("clave-org");
  const country = (valor("clave-pais") || "ES").toUpperCase();
  const estado = document.getElementById("clave-estado");
  const aviso = document.getElementById("clave-aviso");
  const decir = (texto) => { if (estado) estado.textContent = texto; };

  if (!aviso || !aviso.checked) { decir("marca el aviso antes de generar la clave"); return; }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias)) {
    decir("el alias solo puede llevar letras, números, punto, guion o guion bajo"); return;
  }
  if (pass.length < 8) { decir("la contraseña debe tener al menos 8 caracteres"); return; }
  if (pass !== pass2) { decir("las dos contraseñas no coinciden"); return; }
  if (!/^[A-Za-z]{2}$/.test(country)) { decir("el país tiene que ser dos letras, por ejemplo ES"); return; }
  const previo = await hospedador.leer(RUTA_KEYSTORE);
  if (previo && previo.bytes &&
      !window.confirm("Ya hay una clave de release en esta pestaña. ¿Reemplazarla? La anterior dejará de servir para actualizar la app.")) {
    return;
  }

  decir("generando la clave…");
  try {
    const r = await conBloqueo(() => correr([
      "create-keystore", "--out", RUTA_KEYSTORE,
      "--storepass", pass, "--keyalias", alias,
      "--common-name", cn, "--organization", org, "--country", country,
      "--force",
    ]));
    if (!r || r.codigo !== 0) {
      decir("no se pudo generar la clave; mira la consola");
      return;
    }
    const bytes = await hospedador.bytes(RUTA_KEYSTORE);
    if (!bytes || bytes.length < 1000) {
      decir("la clave no quedó en OPFS");
      return;
    }
    const campoPass = document.getElementById("storepass-compilar");
    if (campoPass) campoPass.value = pass;
    const select = document.getElementById("keyalias-compilar");
    if (select) {
      select.replaceChildren();
      select.add(new Option(alias, alias, true, true));
    }
    actualizarEstadoClave(true);

    if (claveDescargaUrl) URL.revokeObjectURL(claveDescargaUrl);
    claveDescargaUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const enlace = document.getElementById("clave-descargar");
    if (enlace) {
      enlace.href = enlaceConfiable(claveDescargaUrl);
      enlace.download = alias + ".jks";
      enlace.click();
    }
    const form = document.getElementById("clave-paso-form");
    const listo = document.getElementById("clave-paso-listo");
    if (form) form.hidden = true;
    if (listo) listo.hidden = false;
    for (const id of ["clave-pass", "clave-pass2"]) {
      const campo = document.getElementById(id);
      if (campo) campo.value = "";
    }
    decir("");
  } catch (e) {
    decir("no se pudo generar la clave: " + (e && e.message ? e.message : e));
  }
}

function estadoKeystore(cfg, texto) {
  document.getElementById(cfg.estado).textContent = texto;
}

// Escribe el fichero elegido en la ruta de la pestaña. Si no hay uno elegido, vale el que ya
// está guardado: así el botón funciona después de recargar y la prueba puede montarlo.
async function guardarKeystoreElegido(cfg) {
  const entrada = document.getElementById(cfg.fichero);
  if (entrada && entrada.files.length) {
    const datos = new Uint8Array(await entrada.files[0].arrayBuffer());
    await hospedador.escribir(cfg.ruta, datos);
    return true;
  }
  return !!(await hospedador.leer(cfg.ruta)).bytes;
}

// Inspecciona con el mismo binario que firma: alias, sujeto, huella y validez. Llena el
// <select> y, si el fichero tiene una sola clave, la deja elegida.
async function inspeccionarKeystore(cfg) {
  if (!(await guardarKeystoreElegido(cfg))) {
    estadoKeystore(cfg, "elige primero un keystore (.p12 o .jks)");
    return null;
  }
  const pass = document.getElementById(cfg.pass).value;
  if (!pass) { estadoKeystore(cfg, "escribe la contraseña del keystore"); return null; }
  const r = await correr(["keystore", "--keystore", cfg.ruta, "--storepass", pass]);
  const m = /keystore-json: (\{.*\})/.exec(r.consola || "");
  if (!m) {
    const ultima = (r.consola || "").trim().split("\n").pop() || "sin salida";
    estadoKeystore(cfg, "no se pudo leer el keystore: " + ultima);
    return null;
  }
  let info;
  try { info = JSON.parse(m[1]); } catch (e) {
    estadoKeystore(cfg, "el keystore no devolvió un JSON legible");
    return null;
  }
  const select = document.getElementById(cfg.alias);
  select.replaceChildren();
  if (info.keys === 1 && info.entries.length === 1) {
    const e = info.entries[0];
    select.add(new Option(e.alias, e.alias, true, true));
  } else {
    select.add(new Option("— elige el alias —", ""));
    for (const e of info.entries) select.add(new Option(e.alias, e.alias));
  }
  const e = info.entries.find((x) => x.alias === select.value) || info.entries[0];
  if (!e) { estadoKeystore(cfg, "el keystore no tiene ninguna clave con la que firmar"); return null; }
  const huella = e.sha256 ? " · SHA-256 " + e.sha256 : " · sin certificado";
  const validez = e.notAfter ? " · hasta " + e.notAfter : "";
  estadoKeystore(cfg, info.keys + " clave(s) · " + e.alias + " · " + e.subject + huella + validez);
  if (cfg === KEYSTORES.compilar) actualizarEstadoClave(true);
  return { info, elegida: e };
}

// Lo que firma: inspecciona siempre (para enseñar el certificado y exigir alias si hay varias
// claves) y devuelve las credenciales. La contraseña solo vive en el campo y en esta llamada.
async function prepararKeystore(cfg) {
  const v = await inspeccionarKeystore(cfg);
  if (!v) return null;
  const alias = document.getElementById(cfg.alias).value;
  if (!alias) { estadoKeystore(cfg, "elige el alias con el que firmar"); return null; }
  return { ruta: cfg.ruta, pass: document.getElementById(cfg.pass).value, alias: alias };
}

// «olvidar»: borra el fichero de OPFS y el estado de la página. La contraseña no se guardó.
async function olvidarKeystore(cfg) {
  await hospedador.limpiar(cfg.ruta);
  if (cfg === KEYSTORES.compilar) actualizarEstadoClave(false);
  document.getElementById(cfg.pass).value = "";
  if (document.getElementById(cfg.fichero)) document.getElementById(cfg.fichero).value = "";
  const select = document.getElementById(cfg.alias);
  select.replaceChildren();
  select.add(new Option("— pulsa «ver certificado» —", ""));
  estadoKeystore(cfg, "keystore olvidado: se borró de esta pestaña");
}

function estadoLinaje(texto) {
  const n = document.getElementById("estado-linaje");
  if (n) n.textContent = texto;
}

// Crea el linaje con la clave nueva ya inspeccionada (la de arriba) y la vieja de este bloque.
async function crearLinaje() {
  const cfg = KEYSTORES.firmar;
  const k = await prepararKeystore(cfg);
  if (!k) return;
  const entrada = document.getElementById("keystore-viejo");
  if (entrada.files.length) {
    const datos = new Uint8Array(await entrada.files[0].arrayBuffer());
    await hospedador.escribir(RUTA_VIEJO, datos);
  } else if (!(await hospedador.leer(RUTA_VIEJO)).bytes) {
    estadoLinaje("elige el keystore viejo (.p12 o .jks)");
    return;
  }
  const pass = document.getElementById("storepass-viejo").value;
  if (!pass) { estadoLinaje("escribe la contraseña del keystore viejo"); return; }
  const alias = (document.getElementById("keyalias-viejo").value || "androiddebugkey").trim();
  const r = await correr(["rotate", "--old-keystore", RUTA_VIEJO, "--old-storepass", pass,
    "--old-keyalias", alias, "--new-keystore", k.ruta, "--new-storepass", k.pass,
    "--new-keyalias", k.alias, "--out", RUTA_LINAJE]);
  if (r && r.codigo === 0) {
    estadoLinaje("linaje listo: la vieja firma v1/v2 y " + k.alias + " firma v3/v3.1");
  }
}

async function olvidarLinaje() {
  await hospedador.limpiar(RUTA_LINAJE);
  await hospedador.limpiar(RUTA_VIEJO);
  if (document.getElementById("keystore-viejo")) document.getElementById("keystore-viejo").value = "";
  document.getElementById("storepass-viejo").value = "";
  document.getElementById("usar-rotacion").checked = false;
  estadoLinaje("sin linaje");
}

// El paquete oficial de una plataforma es un .zip con `android-34/android.jar` dentro. Se lee
// el directorio central del zip, se toma esa entrada y se descomprime con DecompressionStream:
// así una página estática no obliga a descomprimir a mano. Si lo elegido ya es un .jar, no hay
// entrada anidada y se usa tal cual.
async function jarDeSeleccion(datos) {
  if (!datos || datos.length < 1000 || datos[0] !== 0x50 || datos[1] !== 0x4b) {
    throw new Error("el fichero no es un .jar ni un .zip");
  }
  const anidado = await extraerJarDeZip(datos);
  const jar = anidado || datos;
  if (jar.length < 1000 || jar[0] !== 0x50 || jar[1] !== 0x4b) {
    throw new Error("lo elegido no contiene un android.jar (ni es un .jar)");
  }
  return jar;
}

// El jar de una plataforma ronda los 26 MB y crecerá en las próximas APIs: 128 MiB deja sitio de
// sobra y sigue cortando una bomba. El tope se cuenta sobre los bytes que el flujo produce, no
// sobre el tamaño que declare el zip: uno hecho a mano puede decir 1024 B y expandirse a gigabytes.
const MAX_JAR = 128 * 1024 * 1024;

async function extraerJarDeZip(datos) {
  const dv = new DataView(datos.buffer, datos.byteOffset, datos.byteLength);
  const desde = Math.max(0, datos.length - 65557);
  let eocd = -1;
  for (let i = datos.length - 22; i >= desde; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("el zip no tiene fin de directorio (EOCD)");
  const entradas = dv.getUint16(eocd + 10, true);
  const inicioCentral = dv.getUint32(eocd + 16, true);
  if (entradas === 0xffff || inicioCentral === 0xffffffff) {
    throw new Error("zip64 no soportado: descomprime el paquete a mano y elige android.jar");
  }
  const dec = new TextDecoder();
  let p = inicioCentral;
  for (let i = 0; i < entradas; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip: entrada central " + i + " corrupta");
    const metodo = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nombre = dec.decode(datos.subarray(p + 46, p + 46 + nlen));
    if (/(^|\/)android\.jar$/i.test(nombre)) {
      if (dv.getUint32(local, true) !== 0x04034b50) throw new Error("zip: cabecera local de " + nombre + " corrupta");
      const inicioDatos = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const comprimido = datos.subarray(inicioDatos, inicioDatos + csize);
      let salida;
      if (metodo === 0) salida = comprimido.slice();
      else if (metodo === 8) {
        if (typeof DecompressionStream !== "function") {
          throw new Error("este navegador no descomprime deflate: descomprime el zip a mano");
        }
        // el mismo mecanismo que `leerZip`: se corta por bytes producidos, no por los declarados
        salida = await inflarConTope(comprimido, MAX_JAR, "android.jar");
      } else {
        throw new Error("zip: método de compresión " + metodo + " no soportado");
      }
      if (salida.length !== usize) {
        throw new Error("zip: android.jar descomprimido mide " + salida.length + ", se esperaban " + usize);
      }
      return salida;
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

async function ponerJarDeUrl(url, sha256Esperado) {
  // la ruta del servidor local, no de un CDN: la página solo habla con su propio origen, y eso es
  // lo que comprueba la prueba de la pestaña contando las peticiones
  return conCarga("Descargando android.jar…", async () => {
    const respuesta = await fetch(url);
    if (!respuesta.ok) throw new Error("el android.jar de " + url + " respondió " + respuesta.status);
    const datos = new Uint8Array(await respuesta.arrayBuffer());
    // un 200 con una página de error no puede acabar en OPFS como si fuera el jar
    if (datos.length < 1000 || datos[0] !== 0x50 || datos[1] !== 0x4b) {
      throw new Error("lo que devolvió " + url + " no es un jar (cabecera " +
        Array.from(datos.slice(0, 2)).join(",") + ")");
    }
    // El SHA-256 solo se exige en la ruta nueva del jar AOSP, cuyo JSON lo publica. El fallback al
    // SDK local (/android-jar) no trae hash y no debe romperse por esto.
    if (sha256Esperado) {
      const suma = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", datos)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      if (suma !== String(sha256Esperado).toLowerCase()) {
        throw new Error("el jar de " + url + " no coincide con el SHA-256 publicado (" +
          suma + " ≠ " + sha256Esperado + ")");
      }
    }
    await conBloqueo(() => hospedador.escribir(RUTA_JAR, datos));
    await decirEstadoJar();
    return datos.length;
  });
}

// El servidor sirve el jar AOSP publicado (/android-stub-34.jar) o, si no está, el android.jar del
// SDK local (/android-jar); la pestaña lo pide a su propio origen en los dos casos. La licencia de
// la SDK no permite versionarla, pero sí leerla de una instalación oficial ya presente.
async function traerJarDelSdk(silencioso) {
  try {
    const n = await ponerJarDeUrl(JAR_SDK.url || "/android-jar", JAR_SDK.sha256 || "");
    nota(JAR_SDK.origen === "AOSP"
      ? "android.jar AOSP " + JAR_SDK.tag + " guardado en OPFS (" + n + " bytes)"
      : "android.jar del SDK local guardado en OPFS (" + n + " bytes)");
    return true;
  } catch (e) {
    if (!silencioso) {
      const motivo = e && e.message ? e.message : String(e);
      nota("no se pudo traer el android.jar: " + motivo +
        ". Elige el fichero del SDK o ejecuta tools/entorno.sh jar");
    }
    return false;
  }
}

// Pinta si el servidor ve el jar AOSP publicado o un SDK local, sin bajar el jar entero: es un JSON
// pequeño y deja claro si el botón «Traer del SDK local» va a poder hacer algo.
async function consultarJarDelSdk() {
  const aviso = document.getElementById("estado-jar-sdk");
  const boton = document.getElementById("traer-android-jar");
  const sinSdk = "sin servidor local de SDK: descarga el paquete oficial o elige el .jar/.zip";
  if (!aviso) return;
  try {
    // F4: primero el jar AOSP del propio origen. Su JSON trae versión y SHA-256; si el sitio no lo
    // publica (404 en desarrollo), se cae al /android-jar-info de siempre, sin hash.
    let conStub = false;
    try {
      const respuesta = await fetch("/android-stub.json");
      if (respuesta.ok) {
        const info = await respuesta.json();
        JAR_SDK.disponible = true;
        JAR_SDK.version = info.version || null;
        JAR_SDK.bytes = info.bytes || 0;
        JAR_SDK.sha256 = info.sha256 || "";
        JAR_SDK.tag = info.tag || "";
        JAR_SDK.origen = info.origen || "AOSP";
        JAR_SDK.url = "/android-stub-34.jar";
        aviso.textContent = "el servidor sirve el android.jar " + JAR_SDK.origen + " (" +
          JAR_SDK.tag + "): API " + JAR_SDK.version + ", " + JAR_SDK.bytes + " bytes";
        conStub = true;
      }
    } catch (e) { /* sin stub publicado: se mira el SDK local como antes */ }
    if (!conStub) {
      JAR_SDK.sha256 = "";
      JAR_SDK.url = "/android-jar";
      JAR_SDK.origen = "SDK";
      JAR_SDK.tag = "";
      const respuesta = await fetch("/android-jar-info");
      if (!respuesta.ok) throw new Error("HTTP " + respuesta.status);
      const info = await respuesta.json();
      JAR_SDK.disponible = !!info.disponible;
      JAR_SDK.version = info.version || null;
      JAR_SDK.bytes = info.bytes || 0;
      aviso.textContent = JAR_SDK.disponible
        ? "el servidor ve el android.jar del SDK local: API " + info.version + ", " + info.bytes + " bytes"
        : sinSdk;
    }
  } catch (e) {
    JAR_SDK.disponible = false;
    JAR_SDK.sha256 = "";
    JAR_SDK.url = "/android-jar";
    aviso.textContent = sinSdk;
  } finally {
    JAR_SDK.consultado = true;
    if (boton) boton.hidden = !JAR_SDK.disponible;
    const usar = document.getElementById("sdk-usar-servidor");
    if (usar) usar.hidden = !JAR_SDK.disponible;
  }
}

async function usarJarElegido() {
  const entrada = document.getElementById("android-jar");
  if (!entrada.files.length) { nota("elige el android.jar o el .zip oficial primero"); return false; }
  const archivo = entrada.files[0];
  return conCarga("Leyendo " + archivo.name + "…", async () => {
    const datos = new Uint8Array(await archivo.arrayBuffer());
    const jar = await jarDeSeleccion(datos);
    await conBloqueo(() => hospedador.escribir(RUTA_JAR, jar));
    await decirEstadoJar();
    nota("android.jar guardado en esta pestaña (" + jar.length + " bytes); no sube a ningún sitio");
    return true;
  });
}

function actualizarEstadoSdk(tiene, bytes) {
  const detalle = document.getElementById("detalle-sdk");
  const badge = document.getElementById("sdk-badge");
  const boton = document.getElementById("abrir-dialogo-sdk");
  if (detalle) {
    detalle.classList.toggle("jar-listo", !!tiene);
    if (tiene) detalle.open = false;          // ya está: que no siga llamando la atención
  }
  if (badge) {
    badge.hidden = !tiene;
    badge.textContent = tiene ? "listo" : "";
  }
  if (boton) {
    boton.textContent = tiene ? "Cambiar android.jar" : "Obtener el android.jar";
    boton.classList.toggle("primario", !tiene);
  }
}

async function decirEstadoJar() {
  const aviso = document.getElementById("estado-jar");
  if (!aviso) return false;
  try {
    const r = await hospedador.leer(RUTA_JAR);
    if (r.bytes) {
      actualizarEstadoSdk(true, r.bytes.length);
      aviso.textContent = "android.jar listo en esta pestaña (" + r.bytes.length + " bytes)";
      return true;
    }
  } catch (e) {
    actualizarEstadoSdk(false);
    aviso.textContent = "no se puede leer OPFS en este contexto: " + (e && e.message ? e.message : e);
    return false;
  }
  actualizarEstadoSdk(false);
  aviso.textContent = "sin android.jar en esta pestaña todavía";
  return false;
}

async function asegurarJarDelProyecto() {
  if (await decirEstadoJar()) return true;
  const entrada = document.getElementById("android-jar");
  // si la persona ya eligió un fichero, ese manda; si no, solo se prueba el SDK local cuando
  // el servidor ha dicho que existe (en una página estática ese endpoint no está)
  if (entrada && entrada.files.length) {
    if (await usarJarElegido()) return true;
    nota("no se pudo leer el android.jar elegido");
    return false;
  }
  if (!JAR_SDK.consultado) await consultarJarDelSdk();
  if (JAR_SDK.disponible && await traerJarDelSdk(true)) return true;
  nota("hace falta el android.jar: acepta los términos, descarga el paquete oficial y elige el .zip o el .jar en Compilar");
  mostrarPanel("compilar");
  const detalle = document.getElementById("detalle-sdk");
  if (detalle) detalle.open = true;
  return false;
}

// La clave de depuración vive en OPFS y se crea una sola vez. No es una clave de release:
// alias androiddebugkey, contraseña android y CN=Android Debug, lo que espera cualquier
// instalación de desarrollo. Se conserva para que una apk debug se pueda actualizar encima
// de la anterior.
const DEBUG_KEY = { ruta: "/sdk/debug.keystore", pass: "android", alias: "androiddebugkey" };

async function asegurarDebugKeystore() {
  const existente = await hospedador.leer(DEBUG_KEY.ruta);
  if (existente.bytes) { decirEstadoDepuracion(); return DEBUG_KEY; }
  nota("creando la clave de depuración en esta pestaña…");
  const r = await correr(["debug-keystore", "--out", DEBUG_KEY.ruta,
    "--storepass", DEBUG_KEY.pass, "--keyalias", DEBUG_KEY.alias]);
  if (!r || r.codigo !== 0) {
    nota("no se pudo crear la clave de depuración; revisa la salida");
    return null;
  }
  if (!(await hospedador.leer(DEBUG_KEY.ruta)).bytes) {
    nota("la clave de depuración no quedó en OPFS");
    return null;
  }
  decirEstadoDepuracion();
  nota("clave de depuración creada: androiddebugkey · CN=Android Debug");
  return DEBUG_KEY;
}

// La clave de depuración también se puede sacar de la pestaña: es la misma que usa Android
// (`androiddebugkey` / `android`) y sirve para actualizar una instalación de prueba.
async function decirEstadoDepuracion() {
  const boton = document.getElementById("descargar-debug-keystore");
  if (!boton) return false;
  try {
    const r = await hospedador.leer(DEBUG_KEY.ruta);
    const hay = !!(r && r.bytes);
    boton.hidden = !hay;
    return hay;
  } catch (e) {
    boton.hidden = true;
    return false;
  }
}

// La firma por defecto del modo «compilar e intercambiar en caliente» sale del .java activo. La
// clase entera es el valor más útil cuando se acaba de editar un método: `apkc preview` cambia
// todos los que el dex declare para esa clase y conserva el estado de la sesión. El Contador, sin
// embargo, pone el `onClick` en una clase anónima: intercambiar solo la exterior deja el clic con
// el cuerpo viejo, así que la firma tiene que ser la del listener anónimo. Si el usuario escribe
// `clase/metodo(proto)` en el campo, esa firma gana y se intercambia solo ese método.

// El descriptor de una clase vive en la tabla de cadenas del dex como texto ASCII. Se busca byte
// a byte, sin parsear el dex: solo se pregunta si está o no está el nombre que ya se derivó.
function dexContieneTexto(dex, texto) {
  if (!dex || typeof dex.length !== "number") return true;
  const bytes = dex instanceof Uint8Array ? dex : new Uint8Array(dex);
  const aguja = new TextEncoder().encode(texto);
  for (let i = 0; i + aguja.length <= bytes.length; i++) {
    let iguales = true;
    for (let j = 0; j < aguja.length; j++) {
      if (bytes[i + j] !== aguja[j]) { iguales = false; break; }
    }
    if (iguales) return true;
  }
  return false;
}

function firmaPorDefectoDe(texto, ruta = "", dex = null) {
  const fuente = String(texto || "");
  const paquete = (/^\s*package\s+([\w.]+)\s*;/m.exec(fuente) || [])[1] || "";
  let clase = (/\b(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(fuente) || [])[1] || "";
  if (!clase && /\.java$/i.test(String(ruta || ""))) {
    clase = String(ruta).split(/[\\/]/).pop().replace(/\.java$/i, "");
  }
  if (!clase) return "";
  const prefijo = "L" + paquete.replace(/\./g, "/") + (paquete ? "/" : "");

  // javac numera las anónimas en orden de fuente: la primera es $1 aunque sea un Runnable. Por eso
  // se cuenta también la anónima que no es listener, pero solo se elige la que se pasa a
  // setOnClickListener( y cuyo tipo termina en OnClickListener.
  const anonimas = /new\s+([\w.]+)\s*\([^()]*\)\s*\{/g;
  let coincidencia;
  let ordinal = 0;
  while ((coincidencia = anonimas.exec(fuente))) {
    ordinal += 1;
    const tipo = coincidencia[1];
    if (!/(^|\.)OnClickListener$/.test(tipo)) continue;
    if (!/setOnClickListener\(\s*$/.test(fuente.slice(0, coincidencia.index))) continue;
    const anonima = prefijo + clase + "$" + ordinal + ";";
    if (dex && !dexContieneTexto(dex, anonima)) {
      nota("intercambio en caliente: el dex no trae " + anonima +
        "; se intercambia la clase anónima sin método");
      return anonima;
    }
    return anonima + "/onClick(Landroid/view/View;)V";
  }
  // las plantillas Lienzo y Notas implementan la interfaz en la propia actividad
  if (/\bimplements\b[^{]*\b(?:View\.)?OnClickListener\b/.test(fuente) &&
      /\bvoid\s+onClick\s*\(\s*View\b/.test(fuente)) {
    return prefijo + clase + ";/onClick(Landroid/view/View;)V";
  }
  return prefijo + clase + ";";
}

// El campo se rellena solo mientras siga mostrando el valor automático anterior; una firma
// escrita a mano no se pisa al cambiar de pestaña.
let firmaAutomaticaAnterior = "";
function actualizarFirmaAutomatica(dex = null, modeloDado = null) {
  const campo = document.getElementById("hotswap-firma");
  if (!campo) return;
  const doc = DOCUMENTOS.activa ? documentoDe(DOCUMENTOS.activa) : null;
  // guardar() deja `texto = null` en el documento activo (se relee de OPFS al volver a abrirlo),
  // pero el buffer del editor sí tiene el fuente que se acaba de compilar.
  let texto = doc && typeof doc.texto === "string" ? doc.texto : "";
  if (!texto && doc && DOCUMENTOS.activa === doc.ruta) {
    try { texto = EDITOR.texto(); } catch (e) { texto = ""; }
  }
  let firma = texto ? firmaPorDefectoDe(texto, doc.ruta, dex) : "";
  // Anclaje en producción: la clase REAL que la ejecución registró para el último id pulsado gana
  // sobre el ordinal `$N` derivado del fuente, porque javac renumera al borrar una anónima
  // intermedia. Sin clase publicada se conserva la derivación del fuente (límite declarado).
  if (firma) {
    const modelo = modeloDado || (typeof modeloActual === "function" ? modeloActual() : null);
    const ejecucion = modelo && typeof modelo === "object" ? modelo.ejecucion : null;
    const pulsos = ejecucion && Array.isArray(ejecucion.pulsaciones) ? ejecucion.pulsaciones : [];
    const idRef = pulsos.length ? String(pulsos[pulsos.length - 1]) : "";
    const clase = idRef ? claseOyenteDe(modelo, idRef) : "";
    if (clase) {
      const conL = clase.startsWith("L") ? clase : "L" + clase;
      firma = conL.replace(/;$/, "") + ";/onClick(Landroid/view/View;)V";
    }
  }
  if (!firma) return;
  const actual = campo.value.trim();
  if (actual && actual !== firmaAutomaticaAnterior) return;
  campo.value = firma;
  firmaAutomaticaAnterior = firma;
}

function firmaDeHotswap() {
  const campo = document.getElementById("hotswap-firma");
  const escrita = campo && typeof campo.value === "string" ? campo.value.trim() : "";
  if (escrita) return escrita;
  actualizarFirmaAutomatica();
  return campo ? campo.value.trim() : "";
}

// El dex que se intercambia es el del propio build: `classes.dex` dentro de build/app.apk, leído
// con el mismo leerZip que usa el editor para importar proyectos. No se genera con `apkc dex`
// aparte porque el build acaba de dejarlo firmado y igual al que ejecuta el emulador.
async function dexDelUltimoBuild() {
  const apk = await hospedador.bytes(PROYECTO + "/build/app.apk");
  if (!apk || !apk.length) return null;
  const entradas = await leerZip(apk);
  const claseDex = entradas.find((e) => !e.dir && e.ruta === "classes.dex");
  return claseDex ? claseDex.datos : null;
}

async function intercambiarTrasCompilar() {
  let dex;
  try {
    dex = await dexDelUltimoBuild();
  } catch (e) {
    dex = null;
    nota("intercambio en caliente: no se pudo leer el dex del build: " +
      (e && e.message ? e.message : e));
  }
  if (!dex) { nota("intercambio en caliente: build/app.apk no trae classes.dex"); return null; }
  // con el dex en la mano se comprueba que la anónima derivada existe antes de escribir la firma;
  // el campo escrito a mano sigue ganando porque actualizarFirmaAutomatica lo respeta.
  actualizarFirmaAutomatica(dex);
  const firma = firmaDeHotswap();
  if (!firma) {
    nota("intercambio en caliente: abre un .java o escribe la firma clase/metodo(proto)");
    return null;
  }
  if (!PREVIA_PANEL.tieneSesion()) {
    // el primer build no tiene sesión viva: se inicia el emulador como siempre y se dice por qué
    // no hubo intercambio. Repetir Compilar con la casilla marcada sí lo aplica.
    await previsualizarLoCompilado();
    nota("intercambio en caliente: no había sesión viva; se inició el emulador. La próxima " +
      "compilación intercambiará " + firma);
    return null;
  }
  const aplicado = await PREVIA_PANEL.intercambiarDelBuild(dex, firma);
  nota(aplicado
    ? "intercambio en caliente aplicado: " + firma
    : "intercambio en caliente rechazado: " + firma + "; el motivo está en el registro del emulador");
  return aplicado;
}

// Por defecto la página compila con `--inc`: saltarse el enlace de recursos cuando `res/` no
// cambió deja el apk igual entrada por entrada y es el 23 % de la pasada caliente en wasm
// (docs/plan-incremental-web.md). El checkbox `#inc-compilar` permite desactivarlo, y
// `opciones.incremental` manda siempre para que la prueba pueda pedir un build completo sin
// tener que tocar la casilla.
async function compilarCon(k, tipo, opciones = {}) {
  const v4 = document.getElementById("v4-compilar").checked;
  const version = (document.getElementById("sdk-version").value || "34").trim();
  const codename = (document.getElementById("codename").value || "14").trim();
  const casillaInc = document.getElementById("inc-compilar");
  const inc = opciones.incremental === undefined
    ? (casillaInc ? casillaInc.checked : true)
    : opciones.incremental !== false;
  // lo que se ve en el editor es lo que se compila: el build no lee el textarea (ver
  // guardarParaCompilar). El motivo de un fallo al guardar ya lo dejó en la barra.
  const guardados = await guardarParaCompilar();
  // C1: un build que no llega a empezar no puede dejar el `0` del anterior en la barra
  if (guardados < 0) { noCompile("no se pudieron guardar los cambios"); return null; }
  if (guardados > 0) CONSOLA.escribir("guardados " + guardados + " fichero(s) con cambios antes de compilar\n");
  await hospedador.cwd(PROYECTO);
  const argv = ["build"];
  if (inc) argv.push("--inc");
  argv.push("--linker", "go", "--compiler", "go",
    "--android-jar", RUTA_JAR, "--sdk-version", version, "--codename", codename,
    "--keystore", k.ruta, "--storepass", k.pass, "--keyalias", k.alias,
    "--v4=" + (v4 ? "true" : "false"));
  // `build: tipo` deja a Ctrl+Enter repetir por el camino real (C3) sin guardar la contraseña (C4)
  const r = await correr(argv, { build: tipo });
  // la contraseña de release no se queda escrita aunque el build falle
  if (tipo !== "debug") {
    const campoPass = document.getElementById(KEYSTORES.compilar.pass);
    if (campoPass) campoPass.value = "";
  }
  // el estado de la barra no se puede quedar en «compilando» para siempre: al terminar dice el
  // resultado, que es lo que la persona mira cuando vuelve a la pestaña
  if (!r || r.codigo !== 0) nota("la compilación falló; el motivo está en la consola");
  else nota("apk " + tipo + " en build/app.apk, firmado; consola con el detalle");
  if (r && r.codigo === 0) {
    await descargar(PROYECTO + "/build/app.apk", "descargar-apk-compilada");
    await ofrecerDescarga(PROYECTO + "/build/app.apk.idsig", "descargar-idsig-compilada");
    await verificarLoCompilado();
    // la copia estable es lo que permite encender el emulador después sin compilar; si OPFS
    // falla se dice en la barra, pero no se invalida un build que ya salió bien
    try {
      const meta = await guardarUltimaApk(hospedador, PROYECTO + "/build/app.apk", { tipo });
      if (meta && typeof document !== "undefined") {
        document.dispatchEvent(new CustomEvent(EVENTO_ULTIMA_APK, { detail: meta }));
      }
    } catch (e) {
      nota("el build salió bien, pero no se pudo guardar la última apk: " +
        (e && e.message ? e.message : e));
    }
    // el build ya está bien; la vista previa es un extra y su fallo no puede convertirlo en fallo.
    // Con el modo intercambio encendido no se reinicia la sesión: el dex recién compilado entra
    // en el guion vivo y el resultado se lee en `ejecucion.intercambios` y en el registro.
    const casillaHotswap = document.getElementById("hotswap-compilar");
    if (casillaHotswap && casillaHotswap.checked) await intercambiarTrasCompilar();
    else await previsualizarLoCompilado();
  }
  return r;
}

// La vista previa después de compilar: `apkc preview` lee el apk recién escrito y devuelve una
// línea de JSON con el modelo de su primera pantalla. Va por `hospedador.ejecutar` y no por
// `correr()` a propósito: no es una orden de la persona, así que no pisa `#ultimo-codigo` ni la
// consola, y si falla se queda en un mensaje del panel sin tocar el resultado del build.
async function previsualizarLoCompilado() {
  try {
    const apk = await hospedador.bytes(PROYECTO + "/build/app.apk");
    if (!apk || !apk.length) {
      mensajeVistaPrevia("No hay build/app.apk que previsualizar: compila el proyecto primero.");
      return null;
    }
    await hospedador.cwd(PROYECTO);
    const r = await hospedador.ejecutar(["preview", "build/app.apk"]);
    const modelo = modeloDeSalida(r && r.consola);
    if (!modelo) {
      const lineas = String((r && (r.error || r.consola)) || "").trim().split("\n").filter(Boolean);
      const motivo = lineas.length ? lineas[lineas.length - 1].trim() : "";
      mensajeVistaPrevia("apkc preview no devolvió un modelo legible" + (motivo ? ": " + motivo : "."));
      return null;
    }
    return pintarVistaPrevia(modelo);
  } catch (e) {
    mensajeVistaPrevia("no se pudo leer la vista previa: " + (e && e.message ? e.message : e));
    return null;
  }
}

async function compilarDebug() {
  // C1: jar o clave que faltan son «no compilé», no el código del build anterior
  if (!(await asegurarJarDelProyecto())) { noCompile("falta el android.jar"); return null; }
  const k = await asegurarDebugKeystore();
  if (!k) { noCompile("no hay clave de depuración"); return null; }
  nota("compilando debug con la clave de esta pestaña (no hace falta keystore)");
  return compilarCon(k, "debug");
}

async function compilarDelTodo() {
  if (!(await asegurarJarDelProyecto())) { noCompile("falta el android.jar"); return null; }
  const detalle = document.getElementById("detalle-release");
  if (detalle) detalle.open = true;
  const k = await prepararKeystore(KEYSTORES.compilar);
  if (!k) { noCompile("no hay keystore de release con el que firmar"); return null; }
  return compilarCon(k, "release");
}

// Verificar lo que se compiló aquí, con el lector de firmas del propio binario: la vuelta al apk se
// hace sobre el fs de la pestaña, sin apksigner y sin red. Si el verificador dice mal, su motivo es la
// única frase que le interesa a quien espera una apk utilizable. Es un paso interno: no pisa
// `#ultimo-codigo` (C2) ni lo que repite Ctrl+Enter.
async function verificarLoCompilado() {
  const aviso = document.getElementById("estado-verificacion");
  await hospedador.cwd(PROYECTO);
  const r = await correr(["verify", "build/app.apk"], { recordar: false });
  const lineas = String(r.consola || "")
    .replace(/\u001b\[[0-9]*m/g, "")
    .split("\n")
    .map((l) => l.replace("[verify] ", "").trim())
    .filter((l) => l.startsWith("v1 (JAR signing)") || l.startsWith("v2 (APK Signature Scheme v2)") ||
      l.startsWith("certificado") || l.startsWith("par desconocido"));
  if (aviso) aviso.textContent = lineas.length ? lineas.join(" · ") : "apkc no devolvió ningún veredicto";
  return r;
}

// --- ajustes del proyecto ------------------------------------------------------------------
// Los ajustes del proyecto viven en ajustes.js.
const { leerAjustes, guardarAjustes } = crearAjustes({
  hospedador, rutaManifiesto: PROYECTO + "/AndroidManifest.xml", conBloqueo,
  claveRevision, nuevaRevision, documentoDe, DOCUMENTOS, EDITOR, renderPestanas,
  refrescarArbol, publicar, nota, ajustesDelManifiesto, conAjustes,
});

// --- arranque ----------------------------------------------------------------------------
let listo = false;
async function iniciarPestana() {
  try {
    const r = await hospedador.arbol();
    listo = true;
    const nodos = r.nodos || [];
    const guardado = leerPersistencia();
    const aislacion = document.getElementById("aislacion");
    if (aislacion) aislacion.textContent = r.aislada ? "sí" : "no (hay que servir por http con COOP/COEP)";

    // restaurar árbol y pestañas antes de pintar; las pestañas se crean vacías y solo la activa
    // se lee de OPFS
    for (const ruta of guardado.abiertos || []) {
      if (nodos.some((n) => n.dir && n.ruta === ruta)) ARBOL.abiertos.add(ruta);
    }
    const rutas = [...new Set((guardado.tabs || []).filter((ruta) =>
      nodos.some((n) => !n.dir && n.ruta === ruta)))];
    DOCUMENTOS.lista = rutas.map((ruta) => ({ ruta, texto: null, sucio: false, cursor: null, scroll: null }));
    DOCUMENTOS.activa = null;
    renderPestanas();
    await refrescarArbol();

    const manifest = nodos.find((n) => n.ruta === PROYECTO + "/AndroidManifest.xml");
    const activa = rutas.includes(guardado.activa) ? guardado.activa : rutas[0];
    if (activa) {
      await activarDocumento(activa);
      const editor = document.querySelector('[data-vista="pestana"]');
      if (editor) editor.click();
    } else if (manifest) {
      await abrir(PROYECTO + "/AndroidManifest.xml");
      // si ya había proyecto en OPFS, se entra directamente al editor en vez de dejar a la
      // persona en Inicio mirando una pantalla que ya no le toca
      const editor = document.querySelector('[data-vista="pestana"]');
      if (editor) editor.click();
    } else {
      limpiarSinDocumento();
      const codigo = document.getElementById("codigo");
      if (codigo) codigo.placeholder = "Abre un fichero del explorador o crea un proyecto en Inicio.";
    }
  } catch (e) {
    const aislacion = document.getElementById("aislacion");
    if (aislacion) aislacion.textContent = "no disponible";
    // no borrar la persistencia por un fallo transitorio: el proyecto puede volver al recargar
    DOCUMENTOS.lista = [];
    DOCUMENTOS.activa = null;
    estadoPestana.ruta = null;
    estadoPestana.sucio = false;
    EDITOR.poner("");
    renderPestanas();
    actualizarAccionesFichero();
    const codigo = document.getElementById("codigo");
    if (codigo) codigo.placeholder = "Abre un fichero del explorador o crea un proyecto en Inicio.";
    nota("sin OPFS: " + (e && e.message ? e.message : e));
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("codigo")) return;
    // la página se puede recortar: cada botón se engancha solo si está en el DOM. El envoltorio
    // recoge las promesas rechazadas: un fallo de OPFS tiene que salir como aviso en la barra,
    // no como un unhandledrejection mudo con la página aparentemente viva.
    const mostrarFallo = (e) => {
      const texto = e && e.message ? e.message : String(e);
      nota("fallo: " + texto);
      console.error(e);
    };
    const en = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", (e) => {
        try {
          const r = fn(e);
          if (r && typeof r.catch === "function") r.catch(mostrarFallo);
        } catch (err) {
          mostrarFallo(err);
        }
      });
    };
    EDITOR.inicializar();
    actualizarAccionesFichero();
    // el panel lateral se engancha una vez; sus ids son contrato con las pruebas. Si el panel
    // revienta, el resto del editor no puede quedarse muerto: se avisa y se sigue enganchando
    // pestañas, explorador, subida y persistencia, que es lo que la página necesita para editar.
    try {
      PREVIA_PANEL.iniciar();
    } catch (err) {
      mostrarFallo(err);
    }

    // soltar en el hueco del explorador mueve a la raíz del proyecto
    const cajaArbol = document.getElementById("arbol-pestana");
    if (cajaArbol && ARRASTRABLE) {
      cajaArbol.addEventListener("dragover", (e) => {
        if (e.target !== cajaArbol) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        cajaArbol.classList.add("soltar-raiz");
      });
      cajaArbol.addEventListener("dragleave", (e) => {
        if (e.target === cajaArbol) cajaArbol.classList.remove("soltar-raiz");
      });
      cajaArbol.addEventListener("drop", (e) => {
        if (e.target !== cajaArbol) return;
        e.preventDefault();
        cajaArbol.classList.remove("soltar-raiz");
        const origen = e.dataTransfer.getData("text/plain");
        if (origen) moverRuta(origen, PROYECTO);
      });
    }

    const selectorApi = document.getElementById("api-version");
    if (selectorApi) {
      try {
        const pref = localStorage.getItem(API_PREF);
        if (pref && API_NOMBRES[pref]) selectorApi.value = pref;
      } catch (e) { /* sin preferencia */ }
      selectorApi.addEventListener("change", () => sincronizarApi(true));
      sincronizarApi(false);
    }

    const menuEditor = document.getElementById("menu-editor");
    if (menuEditor) {
      // cualquier acción del menú lo cierra; el <details> no guarda estado en JS
      menuEditor.addEventListener("click", (e) => {
        if (e.target.closest(".menu-editor-lista")) menuEditor.open = false;
      });
    }
    document.addEventListener("pointerdown", (e) => {
      const menu = document.getElementById("menu-archivo");
      if (menu && !menu.hidden && !menu.contains(e.target)) cerrarMenuArchivo();
      if (menuEditor && menuEditor.open && !menuEditor.contains(e.target)) menuEditor.open = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        cerrarMenuArchivo();
        if (menuEditor) menuEditor.open = false;
      }
    });
    window.addEventListener("scroll", cerrarMenuArchivo, true);
    window.addEventListener("resize", cerrarMenuArchivo);

    // El jar es de Google: no lo distribuimos ni lo descargamos por el usuario. El diálogo es un
    // acuse informado; los términos se aceptan en el sitio de Google al abrir sus enlaces.
    const dialogoSdk = document.getElementById("dialogo-sdk");
    const entiendo = document.getElementById("sdk-entiendo");
    const enlaceTerminos = document.getElementById("sdk-terminos");
    const enlaceDescarga = document.getElementById("sdk-descarga");
    const usarServidor = document.getElementById("sdk-usar-servidor");
    if (dialogoSdk && entiendo) {
      const reflejarAcuse = () => {
        const listo = !!entiendo.checked;
        for (const enlace of [enlaceTerminos, enlaceDescarga]) {
          if (!enlace) continue;
          enlace.setAttribute("aria-disabled", String(!listo));
          if (listo) enlace.removeAttribute("tabindex");
          else enlace.tabIndex = -1;
        }
      };
      const abrirDialogo = () => {
        entiendo.checked = false;
        reflejarAcuse();
        if (usarServidor) usarServidor.hidden = !JAR_SDK.disponible;
        if (typeof dialogoSdk.showModal === "function") dialogoSdk.showModal();
        else dialogoSdk.hidden = false;
        entiendo.focus();
      };
      const cerrarDialogo = () => {
        if (typeof dialogoSdk.close === "function") dialogoSdk.close();
        else dialogoSdk.hidden = true;
      };
      entiendo.addEventListener("change", reflejarAcuse);
      for (const enlace of [enlaceTerminos, enlaceDescarga]) {
        if (!enlace) continue;
        enlace.addEventListener("click", (e) => {
          if (!entiendo.checked) {
            e.preventDefault();
            nota("marca el acuse del SDK antes de abrir la página de Google");
            entiendo.focus();
          }
        });
      }
      en("abrir-dialogo-sdk", abrirDialogo);
      en("sdk-cerrar", cerrarDialogo);
      en("sdk-elegir-archivo", () => {
        cerrarDialogo();
        const entrada = document.getElementById("android-jar");
        if (entrada) entrada.click();
      });
      if (usarServidor) {
        en("sdk-usar-servidor", () => {
          cerrarDialogo();
          Promise.resolve(traerJarDelSdk(false)).catch((e) => nota(String(e && e.message || e)));
        });
      }
      reflejarAcuse();
    }

    en("crear-clave-release", abrirDialogoClave);
    en("clave-cancelar", cerrarDialogoClave);
    en("clave-generar", generarClaveRelease);
    en("clave-terminar", cerrarDialogoClave);
    const avisoClave = document.getElementById("clave-aviso");
    const generarClave = document.getElementById("clave-generar");
    if (avisoClave && generarClave) {
      avisoClave.addEventListener("change", () => {
        generarClave.disabled = !avisoClave.checked;
      });
    }
    const guardadaClave = document.getElementById("clave-guardada");
    const terminarClave = document.getElementById("clave-terminar");
    if (guardadaClave && terminarClave) {
      guardadaClave.addEventListener("change", () => {
        terminarClave.disabled = !guardadaClave.checked;
      });
    }

    for (const boton of document.querySelectorAll(".panel-tab")) {
      boton.addEventListener("click", () => mostrarPanel(boton.dataset.panel));
    }
    // La sección de dependencias solo engancha su botón: nada se pide al cargar. Si el índice no
    // está publicado (hoy, hasta que corra el workflow), el primer clic lo dice en #deps-estado.
    // La importación local escribe en OPFS; después hay que refrescar el árbol y avisar a las
    // demás ventanas, o la de al lado seguiría con el espejo viejo.
    try {
      crearPanelDeps({
        hospedador, conBloqueo,
        alImportar: async (rutas) => {
          for (const ruta of rutas) {
            try { localStorage.setItem(claveRevision(ruta), nuevaRevision()); } catch (e) { /* sin revisión */ }
          }
          publicar({ tipo: "mutacion", accion: "deps", rutas });
          await refrescarArbol();
        },
      });
    } catch (err) {
      mostrarFallo(err);
    }
    en("alternar-panel", () => {
      // Un clic desde la barra del fichero deja la acción de compilar lista: abrir el panel,
      // seleccionar la pestaña Compilar aunque el panel estuviera en otra y enfocar el botón
      // primario. El segundo clic de quien usa la página ya es el de «Compilar debug», no el de
      // buscar la pestaña. Para cerrar siguen sirviendo «×» del panel y Ctrl+`.
      const panel = document.getElementById("panel-inferior");
      if (!panel) return;
      mostrarPanel("compilar");
      const boton = document.getElementById("compilar-debug");
      if (boton) {
        boton.disabled = false;
        boton.focus();
        boton.scrollIntoView({ block: "nearest" });
      }
    });
    en("cerrar-panel", cerrarPanel);
    en("abrir-historial", () => mostrarPanel("historial"));
    en("conflicto-mio", () => mantenerVersionPropia(CONFLICTO.doc));
    en("conflicto-remoto", () => {
      const doc = CONFLICTO.doc;
      const datos = doc && doc.conflicto ? doc.conflicto : CONFLICTO.datos;
      if (doc && datos) aplicarVersionRemota(doc, datos);
    });
    en("conflicto-marcas", () => insertarMarcasConflicto(CONFLICTO.doc));
    en("historial-deshacer", deshacer);
    en("historial-rehacer", rehacer);
    en("historial-limpiar", limpiarHistorial);
    en("guardar-fichero", guardar);
    en("nuevo-fichero", () => nuevoFichero());
    en("subir-ficheros-boton", () => pedirSubida(carpetaActual(), false));
    en("exportar-proyecto", exportarProyecto);
    en("importar-proyecto", () => {
      const entrada = document.getElementById("importar-archivo");
      if (!entrada) { nota("este navegador no expone el selector de archivos"); return; }
      entrada.value = "";
      entrada.click();
    });
    const importarEntrada = document.getElementById("importar-archivo");
    if (importarEntrada) {
      importarEntrada.addEventListener("change", () => {
        importarProyecto(importarEntrada.files && importarEntrada.files[0]).catch(mostrarFallo);
      });
    }
    en("subir-arbol", () => pedirSubida(carpetaActual(), false));
    en("renombrar-fichero", () => estadoPestana.ruta
      ? renombrarRuta(estadoPestana.ruta)
      : nota("abre un fichero antes de renombrarlo"));
    en("borrar-fichero", () => estadoPestana.ruta
      ? borrarRuta(estadoPestana.ruta)
      : nota("abre un fichero antes de borrarlo"));

    // los dos selectores de archivo: uno normal y otro de carpeta (webkitdirectory conserva
    // los subdirectorios en webkitRelativePath)
    for (const id of ["subir-ficheros", "subir-carpeta"]) {
      const entrada = document.getElementById(id);
      if (entrada) entrada.addEventListener("change", () => {
        subirSeleccion(entrada).catch(mostrarFallo);
      });
    }
    en("firmar-aqui", firmar);
    en("crear-linaje", crearLinaje);
    en("olvidar-linaje", olvidarLinaje);
    en("ver-keystore-firmar", () => inspeccionarKeystore(KEYSTORES.firmar));
    en("olvidar-keystore-firmar", () => olvidarKeystore(KEYSTORES.firmar));
    en("ver-keystore-compilar", () => inspeccionarKeystore(KEYSTORES.compilar));
    en("olvidar-keystore-compilar", () => olvidarKeystore(KEYSTORES.compilar));
    en("usar-android-jar", async () => { await usarJarElegido(); });
    en("traer-android-jar", () => traerJarDelSdk(false));
    en("compilar-debug", compilarDebug);
    en("compilar-apk", compilarDelTodo);
    const casillaHotswap = document.getElementById("hotswap-compilar");
    if (casillaHotswap) casillaHotswap.addEventListener("change", () => {
      if (casillaHotswap.checked) actualizarFirmaAutomatica();
    });
    en("verificar-apk", verificarLoCompilado);
    en("descargar-debug-keystore", () => descargarRuta(DEBUG_KEY.ruta));
    en("leer-ajustes", () => leerAjustes());
    en("guardar-ajustes", guardarAjustes);
    en("detener-comando", detener);
    const consolaPestana = document.getElementById("consola-pestana");
    if (consolaPestana) {
      consolaPestana.addEventListener("click", (e) => {
        const enlace = e.target && e.target.closest ? e.target.closest("a.salto") : null;
        if (!enlace) return;
        e.preventDefault();
        saltarALinea(enlace.dataset.ruta, enlace.dataset.linea).catch(mostrarFallo);
      });
    }
    const filtroArbol = document.getElementById("filtro-arbol");
    if (filtroArbol) {
      filtroArbol.addEventListener("input", () => {
        refrescarArbol().catch((e) => falloSilencioso("refrescar el árbol al filtrar", e));
      });
    }
    en("buscar-siguiente", () => buscarSiguiente(false));
    en("buscar-anterior", () => buscarSiguiente(true));
    en("reemplazar-uno", reemplazarUno);
    en("reemplazar-todos", reemplazarTodos);
    en("buscar-cerrar", cerrarBusqueda);
    const campoBuscar = document.getElementById("buscar-texto");
    if (campoBuscar) {
      campoBuscar.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); buscarSiguiente(e.shiftKey); }
      });
    }
    const detalleAjustes = document.getElementById("detalle-ajustes");
    if (detalleAjustes) {
      detalleAjustes.addEventListener("toggle", () => {
        if (detalleAjustes.open) {
          leerAjustes(true).catch((e) => falloSilencioso("leer los ajustes del proyecto", e));
        }
      });
    }
    en("plegar-arbol", plegarTodo);
    en("desplegar-arbol", desplegarTodo);
    en("recargar-arbol", refrescarArbol);
    // Los enlaces de la barra ya llevan un href blob cuando están visibles: se deja que el
    // navegador siga el enlace. Interceptarlos y llamar a descargar() otra vez solo preparaba
    // el blob y no descargaba nada.
    en("descargar-fichero", (e) => {
      if (!estadoPestana.ruta) { e.preventDefault(); nota("no hay un fichero abierto"); return; }
      const enlace = e.currentTarget;
      // el buffer abierto, no lo último guardado: si hay cambios sin guardar, se descargan igual
      ponerBlob(enlace, EDITOR.texto(), "text/plain;charset=utf-8");
      enlace.download = estadoPestana.ruta.split("/").pop();
    });

    // Los atajos no dependen de que el foco esté en el textarea: Ctrl+S guarda también con el
    // cursor en el panel, y Ctrl+` cierra el panel desde cualquier sitio.
    document.addEventListener("keydown", (e) => {
      if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const tecla = (e.key || "").toLowerCase();
      if (tecla === "s") { e.preventDefault(); Promise.resolve(guardar()).catch(mostrarFallo); }
      else if (tecla === "p") {
        e.preventDefault();
        const filtro = document.getElementById("filtro-arbol");
        if (filtro) { filtro.focus(); filtro.select(); }
      }
      else if (tecla === "f") { e.preventDefault(); abrirBusqueda(false); }
      else if (tecla === "h") { e.preventDefault(); abrirBusqueda(true); }
      else if (tecla === "g") { e.preventDefault(); irALineaDesdeCuadro(); }
      else if (e.key === "Enter") { e.preventDefault(); Promise.resolve(ejecutarUltimo()).catch(mostrarFallo); }
      else if (e.key === "`" || e.code === "Backquote") { e.preventDefault(); alternarPanel(); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const barra = document.getElementById("buscar-barra");
      if (barra && !barra.hidden) { e.preventDefault(); cerrarBusqueda(); }
    });
    window.addEventListener("beforeunload", (e) => {
      volcarHistorial();
      if (!hayDocumentosSucios()) return;
      e.preventDefault();
      e.returnValue = "";
    });

    decirEstadoJar();
    decirEstadoClave();
    decirEstadoDepuracion();
    consultarJarDelSdk();
    iniciarPestana();
  });
}

export {
  PROYECTO, hospedador, estadoPestana, DOCUMENTOS, VENTANA, ARBOL,
  EDITOR, CONSOLA, abrir, guardar, guardarParaCompilar, pareceManifiesto, correr,
  compilarDelTodo, compilarDebug,
  mostrarPanel, alternarPanel, marcarSucio, deshacer, rehacer,
  rechazoTecleo, aceptarEntrada, puedeMarcarSucio, bloquearTecleo,
  refrescarArbol, estaSucio, hayDocumentosSucios, confirmarDescartes,
  limpiarEstadoEditor, ponerJarDeUrl, usarJarElegido, cerrarMenuArchivo,
  pedirSubida, subirSeleccion, renderHistorial, restaurarNodoHistorial,
  limpiarHistorial, resaltar, esXml, textoHtml, consolaHtml,
  jarDeSeleccion, extraerJarDeZip, sincronizarApi, moverRuta, revelarRuta,
  verificarLoCompilado, previsualizarLoCompilado, inspeccionarKeystore, crearLinaje, guardarPersistencia,
  documentoActivo, documentoDe, volcarHistorial, programarHistorial,
  aplicarNodoHistorial, historialDe, conCarga, mostrarCarga, ocultarCarga,
  pintarConsola, KEYSTORES, DEBUG_KEY, RUTA_JAR, RUTA_LINAJE, RUTA_VIEJO,
  PREVIA_PANEL,
  firmar, asegurarDebugKeystore, compilarCon, firmaPorDefectoDe, firmaDeHotswap,
  actualizarFirmaAutomatica, nuevoFichero,
  renombrarRuta, borrarRuta, abrirMenuArchivo, decirEstadoJar,
  consultarJarDelSdk, traerJarDelSdk, asegurarJarDelProyecto,
  conBloqueo, publicar, recibirRemoto, decirEstadoClave,
  actualizarEstadoClave, abrirDialogoClave, generarClaveRelease, redactarArgv,
  mensajeNoCompile,
  exportarProyecto, importarProyecto, descargarBytes,
  leerAjustes, guardarAjustes, irALinea, saltarALinea, detener, enlazarSalidas,
  decirEstadoDepuracion, abrirBusqueda, cerrarBusqueda, buscarSiguiente,
  reemplazarUno, reemplazarTodos, irALineaDesdeCuadro, leerZip,
};

// Puente de compatibilidad para las pruebas de navegador y la consola de desarrollo.
// El código de la página importa los símbolos; estos globales no son la fuente de verdad.
if (typeof window !== "undefined") {
  Object.assign(window, {
    PROYECTO, hospedador, estadoPestana, DOCUMENTOS, VENTANA, ARBOL,
    EDITOR, CONSOLA, abrir, guardar, guardarParaCompilar, pareceManifiesto, correr,
    compilarDelTodo, compilarDebug,
    mostrarPanel, alternarPanel, marcarSucio, deshacer, rehacer,
    rechazoTecleo, aceptarEntrada, puedeMarcarSucio, bloquearTecleo,
    refrescarArbol, estaSucio, hayDocumentosSucios, confirmarDescartes,
    limpiarEstadoEditor, ponerJarDeUrl, usarJarElegido, cerrarMenuArchivo,
    pedirSubida, subirSeleccion, renderHistorial, restaurarNodoHistorial,
    limpiarHistorial, resaltar, esXml, textoHtml, consolaHtml,
    jarDeSeleccion, extraerJarDeZip, sincronizarApi, Historial, moverRuta,
    revelarRuta, verificarLoCompilado, previsualizarLoCompilado, inspeccionarKeystore, crearLinaje,
    guardarPersistencia, documentoActivo, documentoDe, volcarHistorial,
    programarHistorial, aplicarNodoHistorial, historialDe, conCarga,
    mostrarCarga, ocultarCarga, pintarConsola, KEYSTORES, DEBUG_KEY,
    RUTA_JAR, RUTA_LINAJE, RUTA_VIEJO, firmar,
    asegurarDebugKeystore, compilarCon, firmaPorDefectoDe, firmaDeHotswap,
    actualizarFirmaAutomatica, nuevoFichero, renombrarRuta,
    borrarRuta, abrirMenuArchivo, decirEstadoJar, consultarJarDelSdk,
    traerJarDelSdk, asegurarJarDelProyecto, conBloqueo, publicar, recibirRemoto,
    decirEstadoClave, actualizarEstadoClave, abrirDialogoClave, generarClaveRelease,
    exportarProyecto, importarProyecto, descargarBytes,
    leerAjustes, guardarAjustes, irALinea, saltarALinea, detener, enlazarSalidas,
    decirEstadoDepuracion, abrirBusqueda, cerrarBusqueda, buscarSiguiente,
    reemplazarUno, reemplazarTodos, irALineaDesdeCuadro, leerZip,
  });
  // Superficie completa para las pruebas CDP, que evalúan los nombres antiguos. No se usa desde
  // el código de la página; los imports son la vía normal.
  Object.assign(window, {
    actualizarCursor, relativa, carpetaDe, carpetaActual, nombreDeSubida,
    pedirSubida, subirSeleccion, hayDocumentosSucios, leerPersistencia, PREVIA_PANEL,
    falloDocumento, renderPestanas, pintarMarcaSucio, guardarEnMemoria,
    historialDe, asegurarHistorial, volcarHistorial, programarHistorial,
    aplicarNodoHistorial, restaurarNodoHistorial, limpiarHistorial,
    renderHistorial, limpiarSinDocumento, quitarDocumento, activarDocumento,
    cerrarDocumento, remapearDocumentos, quitarDocumentosBajo,
    limpiarEstadoEditor, conectarMenu, remapearAbiertos, plegarTodo,
    desplegarTodo, pedirCarpetaDestino, actualizarAccionesFichero,
    paqueteDelFormulario, normalizarRuta, nuevoNombre, cerrarPanel,
    ejecutarUltimo, nota, descargarRuta, ponerBlob, descargar,
    ofrecerDescarga, estadoKeystore, guardarKeystoreElegido,
    inspeccionarKeystore, prepararKeystore, olvidarKeystore, estadoLinaje,
    olvidarLinaje, iniciarPestana, PERSISTENCIA, SUBIDA, API_NOMBRES,
    API_PREF, JAR_SDK, RUTA_KEYSTORE, ARRASTRABLE,
  });
}
