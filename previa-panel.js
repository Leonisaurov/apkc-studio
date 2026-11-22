// La vista dividida del editor: a la derecha del código, un marco de teléfono con dos lecturas del
// mismo proyecto, sin compilar dos veces y sin tocar el documento que se está editando.
//
//   - «XML en vivo»: el `res/layout/*.xml` tal como está en el editor (o en OPFS si está cerrado),
//     con el resaltado de `editor.js`. Se refresca al teclear con un debounce corto y no lanza
//     ningún comando de apkc. Es de solo lectura: no hay un segundo editor del XML.
//   - «Render (eventos)»: el canvas que pinta el modelo de `apkc preview` (el mismo que la pestaña
//     Vista) y, debajo, la consola de la ejecución: capturas, avisos, pasos, interacciones y error.
//
// Reglas que no se relajan:
//   - **Nada muta el modelo.** El separador cambia un ancho CSS y la consola pinta texto ya emitido;
//     ningún `pointerdown` de esta pieza escribe en OPFS ni cambia `estadoPestana`.
//   - **Todo el texto del intérprete es dato, no marcado.** Se pinta con `textContent`; un
//     `texto` con `<script>` sale escapado porque nunca pasa por `innerHTML`.
//   - **Sin red.** Los layouts se leen del OPFS del propio proyecto por el hospedador de siempre.
//
// Las funciones de cabecera —`anchoValido`, `esRutaDeLayout`, `candidatosDeLayout` y
// `resumenEjecucion`— son puras y se prueban en node (`prueba.js`). La carpeta de OPFS y el
// documento activo llegan por el objeto de dependencias: este módulo no importa `pestana.js`.
import { esXml, resaltar } from "./editor.js";
import { textoHtml } from "./consola.js";
import { htmlConfiable } from "./tt.js";
import { pintarModelo, modeloActual, EVENTO_PREVIA } from "./vista-previa.js";

// Persistencia de la vista dividida. Son preferencias de esta ventana, no del proyecto.
const CLAVE_ANCHO = "apkc-studio/previa-ancho";
const CLAVE_VISIBLE = "apkc-studio/previa-visible";
const CLAVE_MODO = "apkc-studio/previa-modo";

const ANCHO_POR_DEFECTO = 340;
const ANCHO_MINIMO = 240;
const ANCHO_MAXIMO = 900;
// el editor nunca baja de 280 px: el separador no puede dejarlo en una rendija
const EDITOR_MINIMO = 280;
const ESPERA_TECLEO = 350;
const ESPERA_DOCUMENTO = 160;
const ESPERA_ARBOL = 400;
const ESPERA_PREVIA = 120;
const CAPTURAS_MAXIMAS = 64;
const AVISOS_MAXIMOS = 24;

const MENSAJE_SIN_MODELO = "Compila el proyecto (Editor → Compilar → Compilar debug) para ver aquí " +
  "la pantalla y lo que ejecuta la app.";
const MENSAJE_SIN_EJECUCION = "El modelo no trae ejecución: el apk se leyó con --sin-ejecutar o no " +
  "tiene classes.dex. Sin capturas ni avisos.";
const MENSAJE_SIN_LAYOUT = "El proyecto no tiene ningún res/layout/*.xml. Crea un layout en el " +
  "explorador o abre uno para verlo aquí.";

// Un ancho utilizable: siempre entero, dentro de [minimo, maximo] y con un respaldo si lo guardado
// no es un número (una preferencia corrupta no puede dejar el panel en 0 px).
export function anchoValido(pedido, minimo, maximo) {
  const min = Number.isFinite(minimo) ? Math.round(minimo) : ANCHO_MINIMO;
  let max = Number.isFinite(maximo) ? Math.round(maximo) : ANCHO_MAXIMO;
  if (max < min) max = min;
  const n = typeof pedido === "number" ? pedido : Number(pedido);
  if (!Number.isFinite(n)) return Math.min(max, Math.max(min, ANCHO_POR_DEFECTO));
  return Math.round(Math.min(max, Math.max(min, n)));
}

export function esRutaDeLayout(ruta) {
  return typeof ruta === "string" && /\/res\/layout[^/]*\/[^/]+\.xml$/i.test(ruta);
}

// El layout del proyecto es `res/layout*` en su raíz. `build/res/layout/...` es la copia que deja
// una compilación: mostrarla sería enseñar un fichero generado como si fuera el que se edita.
function esDelProyecto(ruta, base) {
  return esRutaDeLayout(ruta) && ruta.startsWith(base + "/res/layout");
}

// Las rutas candidatas, en el orden en que se intentan: primero lo que se está editando, después lo
// que dice el modelo de `apkc preview` y, si hay árbol, sus layouts (main.xml primero). Sin el
// árbol, un candidato del modelo que no exista se descarta al no poder leerse; por eso el llamante
// reintenta con el árbol antes de darse por vencido.
export function candidatosDeLayout({ abierta, layout, nodos, proyecto } = {}) {
  const base = typeof proyecto === "string" && proyecto.trim()
    ? proyecto.trim().replace(/\/+$/, "") : "/proyecto";
  const lista = [];
  const mete = (ruta) => {
    if (typeof ruta !== "string") return;
    let r = ruta.trim().replace(/^\/+/, "");
    if (!r) return;
    if (!/^res\//.test(r)) r = "res/layout/" + r;
    if (!/\.xml$/i.test(r)) r += ".xml";
    const completa = base + "/" + r;
    if (!lista.includes(completa)) lista.push(completa);
  };
  if (esDelProyecto(abierta, base)) lista.push(abierta);
  if (typeof layout === "string" && layout.trim()) mete(layout);
  // el árbol puede traer ficheros de fuera del proyecto (un zip importado en otra carpeta, por
  // ejemplo) y la copia generada de build/: un layout de otro sitio no es el layout de esta app
  const conocidos = Array.isArray(nodos) ? nodos.filter((ruta) => esDelProyecto(ruta, base)) : [];
  if (!conocidos.length) return lista;
  const orden = [...conocidos].sort((a, b) => {
    const mainA = /\/layout\/main\.xml$/i.test(a) ? 0 : 1;
    const mainB = /\/layout\/main\.xml$/i.test(b) ? 0 : 1;
    return mainA - mainB || a.localeCompare(b);
  });
  for (const ruta of orden) if (!lista.includes(ruta)) lista.push(ruta);
  // con el árbol delante, un candidato que no existe no se intenta
  return lista.filter((ruta) => conocidos.includes(ruta));
}

// El bloque `ejecucion` del modelo, acotado y con tipos seguros. Devuelve null cuando no hay
// ejecución (modelo sin `ejecucion`), que es distinto de «ejecutó y no capturó nada».
export function resumenEjecucion(modelo) {
  const ejecucion = modelo && typeof modelo === "object" ? modelo.ejecucion : null;
  if (!ejecucion || typeof ejecucion !== "object") return null;
  const comoTexto = (v) => (typeof v === "string" ? v : "");
  const comoCuenta = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const capturas = (Array.isArray(ejecucion.capturas) ? ejecucion.capturas : [])
    .slice(0, CAPTURAS_MAXIMAS)
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ origen: comoTexto(c.origen), id: comoTexto(c.id), texto: comoTexto(c.texto) }))
    .filter((c) => c.origen || c.texto !== "");
  const avisos = (Array.isArray(ejecucion.avisos) ? ejecucion.avisos : [])
    .slice(0, AVISOS_MAXIMOS)
    .map(comoTexto)
    .filter((a) => a.trim() !== "");
  return {
    actividad: comoTexto(ejecucion.actividad),
    metodo: comoTexto(ejecucion.metodo),
    pasos: comoCuenta(ejecucion.pasos),
    interacciones: comoCuenta(ejecucion.interacciones),
    capturas,
    avisos,
    error: comoTexto(ejecucion.error),
  };
}

function leerClave(clave, respaldo) {
  try {
    const valor = localStorage.getItem(clave);
    return valor === null ? respaldo : valor;
  } catch (e) {
    return respaldo;
  }
}

function guardarClave(clave, valor) {
  try { localStorage.setItem(clave, String(valor)); } catch (e) { /* preferencia, no dato */ }
}

// La pieza de interfaz. Se construye sin tocar el DOM y solo se engancha en `iniciar()`, para que
// importar este módulo desde la prueba de node no necesite navegador.
export function crearPreviaPanel({ hospedador, proyecto, estadoPestana, editor } = {}) {
  const carpeta = typeof proyecto === "string" && proyecto ? proyecto : "/proyecto";
  let ancho = ANCHO_POR_DEFECTO;
  let preferido = ANCHO_POR_DEFECTO;
  let visible = true;
  let modo = "xml";
  let arrastrando = false;
  let temporizadorXml = 0;
  let turnoXml = 0;
  let rutaMostrada = null;
  let arbol = null;
  let arbolEn = 0;
  let cuadro = 0;
  let iniciado = false;

  const conDocumento = () => typeof document !== "undefined" && !!document.getElementById;

  function fila() { return conDocumento() ? document.getElementById("editor-fila") : null; }

  // --- separador ---------------------------------------------------------------------------
  function anchoDesde(clientX) {
    const caja = fila();
    if (!caja) return ANCHO_POR_DEFECTO;
    const rect = caja.getBoundingClientRect();
    const tope = Math.max(ANCHO_MINIMO, rect.width - EDITOR_MINIMO);
    return anchoValido(Math.round(rect.right - clientX), ANCHO_MINIMO, Math.min(ANCHO_MAXIMO, tope));
  }

  function topeAncho() {
    // con la vista Editor oculta la fila mide cero: no se puede recortar contra un ancho que no
    // existe, así que el techo es el máximo y el recorte real llega al mostrarse la vista
    const caja = fila();
    const disponible = caja ? caja.clientWidth : 0;
    if (!(disponible > 0)) return ANCHO_MAXIMO;
    return Math.min(ANCHO_MAXIMO, Math.max(ANCHO_MINIMO, disponible - EDITOR_MINIMO));
  }

  function aplicarAncho(pedido, persistir) {
    const caja = fila();
    const separador = document.getElementById("separador-previa");
    if (!caja) return;
    // `preferido` es lo que la persona eligió y lo que se guarda; `ancho` es lo que cabe ahora
    preferido = anchoValido(pedido, ANCHO_MINIMO, ANCHO_MAXIMO);
    ancho = anchoValido(preferido, ANCHO_MINIMO, topeAncho());
    caja.style.setProperty("--previa-ancho", ancho + "px");
    if (separador) {
      separador.setAttribute("aria-valuenow", String(ancho));
      separador.setAttribute("aria-valuemax", String(topeAncho()));
      separador.setAttribute("aria-valuetext", ancho + " píxeles de vista previa");
    }
    if (persistir) guardarClave(CLAVE_ANCHO, preferido);
  }

  function soltarSeparador() {
    if (!arrastrando) return;
    arrastrando = false;
    const separador = document.getElementById("separador-previa");
    if (separador) separador.classList.remove("arrastrando");
    document.body.classList.remove("separando-previa");
    guardarClave(CLAVE_ANCHO, preferido);
    programarPintado();
  }

  function conectarSeparador(separador) {
    separador.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      arrastrando = true;
      try { separador.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
      separador.classList.add("arrastrando");
      document.body.classList.add("separando-previa");
      e.preventDefault();
    });
    // el movimiento se sigue en el documento: el puntero puede salirse del separador sin soltar
    document.addEventListener("pointermove", (e) => {
      if (!arrastrando) return;
      aplicarAncho(anchoDesde(e.clientX));
      e.preventDefault();
    });
    document.addEventListener("pointerup", soltarSeparador);
    document.addEventListener("pointercancel", soltarSeparador);

    separador.addEventListener("keydown", (e) => {
      // el separador se mueve: a la izquierda, el panel de la previa crece
      const paso = e.shiftKey ? 48 : 16;
      let nuevo = null;
      if (e.key === "ArrowLeft") nuevo = ancho + paso;
      else if (e.key === "ArrowRight") nuevo = ancho - paso;
      else if (e.key === "Home") nuevo = ANCHO_MINIMO;
      else if (e.key === "End") nuevo = Math.min(ANCHO_MAXIMO, (fila() && fila().clientWidth - EDITOR_MINIMO) || ANCHO_MAXIMO);
      if (nuevo === null) return;
      e.preventDefault();
      aplicarAncho(nuevo, true);
      programarPintado();
    });
  }

  // --- visibilidad -------------------------------------------------------------------------
  function aplicarVisible(valor, persistir) {
    visible = !!valor;
    const panel = document.getElementById("previa-lateral");
    const separador = document.getElementById("separador-previa");
    const boton = document.getElementById("previa-alternar");
    if (panel) panel.hidden = !visible;
    if (separador) separador.hidden = !visible;
    if (boton) {
      boton.setAttribute("aria-expanded", String(visible));
      boton.classList.toggle("activo", visible);
    }
    if (persistir) guardarClave(CLAVE_VISIBLE, visible ? "1" : "0");
    if (!visible) return;
    if (modo === "render") programarPintado();
    else programarXml(0);
  }

  // --- XML / Render ------------------------------------------------------------------------
  function aplicarModo(valor, persistir) {
    modo = valor === "render" ? "render" : "xml";
    const botonXml = document.getElementById("previa-modo-xml");
    const botonRender = document.getElementById("previa-modo-render");
    const seccionXml = document.getElementById("previa-xml");
    const seccionRender = document.getElementById("previa-render");
    for (const [boton, activo] of [[botonXml, modo === "xml"], [botonRender, modo === "render"]]) {
      if (!boton) continue;
      boton.classList.toggle("activo", activo);
      boton.setAttribute("aria-selected", String(activo));
      boton.tabIndex = activo ? 0 : -1;
    }
    if (seccionXml) seccionXml.hidden = modo !== "xml";
    if (seccionRender) seccionRender.hidden = modo !== "render";
    if (persistir) guardarClave(CLAVE_MODO, modo);
    if (!visible) return;
    if (modo === "render") programarPintado();
    else programarXml(0);
  }

  function conectarModos() {
    const botonXml = document.getElementById("previa-modo-xml");
    const botonRender = document.getElementById("previa-modo-render");
    if (botonXml) {
      botonXml.addEventListener("click", () => aplicarModo("xml", true));
      botonXml.addEventListener("keydown", (e) => moverFocoModo(e, "render"));
    }
    if (botonRender) {
      botonRender.addEventListener("click", () => aplicarModo("render", true));
      botonRender.addEventListener("keydown", (e) => moverFocoModo(e, "xml"));
    }
  }

  // role="tab" sin flechas deja el teclado a medias: las dos pestañas del panel se recorren con
  // las flechas, Home y End, como en cualquier tablist.
  function moverFocoModo(e, elOtro) {
    const destino = e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End"
      ? (e.key === "ArrowLeft" || e.key === "Home" ? "xml" : "render")
      : null;
    if (!destino) return;
    e.preventDefault();
    aplicarModo(destino, true);
    const boton = document.getElementById("previa-modo-" + destino);
    if (boton) boton.focus();
    else if (elOtro) { /* sin el otro botón no hay a dónde ir */ }
  }

  // --- consola de la ejecución -------------------------------------------------------------
  function limpiarLog(texto) {
    const lista = document.getElementById("previa-log-lista");
    const cabecera = document.getElementById("previa-log-cabecera");
    const vacio = document.getElementById("previa-log-vacio");
    if (lista) lista.textContent = "";
    if (cabecera) {
      cabecera.textContent = "sin ejecución";
      cabecera.classList.remove("con-error");
    }
    if (vacio) {
      vacio.hidden = false;
      vacio.textContent = texto || MENSAJE_SIN_MODELO;
    }
  }

  function lineaLog(clase, origen, texto) {
    const li = document.createElement("li");
    li.className = "previa-log-linea " + clase;
    const etiqueta = document.createElement("span");
    etiqueta.className = "previa-log-origen";
    etiqueta.textContent = origen;
    const cuerpo = document.createElement("span");
    cuerpo.className = "previa-log-texto";
    cuerpo.textContent = texto;
    li.appendChild(etiqueta);
    li.appendChild(cuerpo);
    return li;
  }

  function pintarLog(modelo) {
    const lista = document.getElementById("previa-log-lista");
    const cabecera = document.getElementById("previa-log-cabecera");
    const vacio = document.getElementById("previa-log-vacio");
    if (!lista || !cabecera || !vacio) return;
    const resumen = resumenEjecucion(modelo);
    lista.textContent = "";
    if (!resumen) {
      cabecera.textContent = "sin ejecución";
      cabecera.classList.remove("con-error");
      vacio.hidden = false;
      vacio.textContent = MENSAJE_SIN_EJECUCION;
      return;
    }
    const partes = [];
    if (resumen.metodo) partes.push(resumen.metodo);
    if (resumen.actividad) partes.push(resumen.actividad);
    partes.push(resumen.pasos + (resumen.pasos === 1 ? " paso" : " pasos"));
    if (resumen.interacciones) {
      partes.push(resumen.interacciones + (resumen.interacciones === 1 ? " interacción" : " interacciones"));
    }
    cabecera.textContent = partes.join(" · ");
    cabecera.classList.toggle("con-error", !!resumen.error);
    // el orden del JSON es el de la ejecución: primero las capturas y después los avisos
    for (const captura of resumen.capturas) {
      const origen = captura.origen || "captura";
      const conId = captura.id ? origen + " " + captura.id : origen;
      lista.appendChild(lineaLog("captura", conId + ":", captura.texto === "" ? "(sin texto)" : captura.texto));
    }
    for (const aviso of resumen.avisos) lista.appendChild(lineaLog("aviso", "aviso:", aviso));
    if (resumen.error) lista.appendChild(lineaLog("peligro", "error:", resumen.error));
    const hay = lista.children.length > 0;
    vacio.hidden = hay;
    if (!hay) vacio.textContent = "La ejecución no capturó escrituras ni dejó avisos.";
  }

  // --- render -------------------------------------------------------------------------------
  function limpiarCanvas(canvas) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function pintarRender(motivo) {
    if (!conDocumento()) return null;
    const canvas = document.getElementById("previa-lateral-canvas");
    const estado = document.getElementById("previa-render-estado");
    if (!canvas || !estado) return null;
    const modelo = modeloActual();
    if (!modelo) {
      // el motivo del último fallo viene del evento: «no hay apk», «el preview falló» o el de arranque
      const texto = motivo || MENSAJE_SIN_MODELO;
      limpiarCanvas(canvas);
      estado.textContent = texto;
      limpiarLog(texto);
      return null;
    }
    const pintado = pintarModelo(canvas, modelo);
    const layout = modelo.layout ? String(modelo.layout) : "el layout";
    estado.textContent = modelo.aproximado === false
      ? "Render de " + layout + ", sin aproximar. Se actualiza al compilar; el XML en vivo se lee del editor."
      : "Render aproximado de " + layout + ". Se actualiza al compilar; el XML en vivo se lee del editor.";
    pintarLog(modelo);
    if (pintado && pintado.valida === false) {
      estado.textContent = "El modelo de vista previa no trae una pantalla medible (ancho o alto no " +
        "finitos); no se pinta nada.";
    }
    return pintado;
  }

  function programarPintado() {
    if (typeof requestAnimationFrame !== "function") { pintarRender(); return; }
    if (cuadro) return;
    cuadro = requestAnimationFrame(() => { cuadro = 0; pintarRender(); });
  }

  // --- XML en vivo --------------------------------------------------------------------------
  function layoutDelModelo() {
    const modelo = modeloActual();
    return modelo && typeof modelo.layout === "string" ? modelo.layout : "";
  }

  async function nodosDelProyecto(forzar) {
    const ahora = Date.now();
    if (!forzar && Array.isArray(arbol) && ahora - arbolEn < 5000) return arbol;
    try {
      const r = await hospedador.arbol();
      arbol = (r && Array.isArray(r.nodos) ? r.nodos : []).filter((n) => n && !n.dir).map((n) => n.ruta);
    } catch (e) {
      arbol = [];
    }
    arbolEn = ahora;
    return arbol;
  }

  async function leerLayout(ruta) {
    // el documento abierto manda: lo que se ve es lo que se está escribiendo, aunque no se guarde
    if (estadoPestana && estadoPestana.ruta === ruta && editor && typeof editor.texto === "function") {
      return String(editor.texto());
    }
    // `hospedador.texto` devuelve "" tanto para un fichero vacío como para uno que ya no está, y
    // aquí los dos casos no son lo mismo: un layout borrado no es un layout en blanco
    const bytes = await hospedador.bytes(ruta);
    if (!bytes) throw new Error("no existe " + ruta);
    return new TextDecoder().decode(bytes);
  }

  function pintarXml(ruta, texto) {
    const estado = document.getElementById("previa-xml-estado");
    const pre = document.getElementById("previa-xml-codigo");
    if (!estado || !pre) return;
    const relativa = ruta.startsWith(carpeta + "/") ? ruta.slice(carpeta.length + 1) : ruta;
    const xml = esXml(texto);
    const lineas = texto === "" ? 0 : texto.split("\n").length;
    const desplazamiento = pre.scrollTop;
    // el texto viene de un fichero del proyecto: primero se escapa y después se colorea; nunca se
    // inyecta el XML crudo
    pre.innerHTML = xml
      ? htmlConfiable(resaltar(texto, "xml") + "\n")
      : htmlConfiable(textoHtml(texto));
    pre.scrollTop = desplazamiento;
    const marca = document.getElementById("marca-sucio");
    const sucio = !!(marca && !marca.hidden && estadoPestana && estadoPestana.ruta === ruta);
    estado.textContent = relativa + " · " + lineas + (lineas === 1 ? " línea" : " líneas") +
      " · solo lectura" + (sucio ? " · sin guardar" : "") + (xml ? "" : " · no parece XML");
  }

  async function refrescarXml() {
    if (!conDocumento() || !visible) return;
    const estado = document.getElementById("previa-xml-estado");
    const pre = document.getElementById("previa-xml-codigo");
    if (!estado || !pre) return;
    const turno = ++turnoXml;
    const base = { abierta: estadoPestana ? estadoPestana.ruta : null, layout: layoutDelModelo(), proyecto: carpeta };
    let error = "";
    const intentar = async (rutas) => {
      for (const ruta of rutas) {
        try {
          const texto = await leerLayout(ruta);
          if (turno !== turnoXml) return true;
          rutaMostrada = ruta;
          pintarXml(ruta, texto);
          return true;
        } catch (e) {
          if (!error) error = String(e && e.message ? e.message : e);
        }
      }
      return false;
    };
    if (await intentar(candidatosDeLayout(base))) return;
    if (turno !== turnoXml) return;
    const nodos = await nodosDelProyecto(true);
    if (turno !== turnoXml) return;
    if (await intentar(candidatosDeLayout({ ...base, nodos }))) return;
    if (turno !== turnoXml) return;
    rutaMostrada = null;
    pre.textContent = "";
    estado.textContent = nodos.length || error
      ? "No se pudo leer el layout" + (error ? ": " + error : ".") + " "
      : MENSAJE_SIN_LAYOUT;
  }

  function programarXml(espera) {
    clearTimeout(temporizadorXml);
    temporizadorXml = setTimeout(() => {
      temporizadorXml = 0;
      refrescarXml().catch(() => {});
    }, typeof espera === "number" ? espera : ESPERA_TECLEO);
  }

  function conectarEntrada() {
    const codigo = document.getElementById("codigo");
    if (codigo) {
      codigo.addEventListener("input", () => {
        if (!visible) return;
        // si el layout mostrado es el documento que se escribe, basta el buffer; si no, no hay nada
        // que releer por teclear en otro fichero
        if (rutaMostrada && estadoPestana && estadoPestana.ruta === rutaMostrada) programarXml(ESPERA_TECLEO);
      });
    }
    const titulo = document.getElementById("fichero-abierto");
    if (titulo && typeof MutationObserver === "function") {
      new MutationObserver(() => programarXml(ESPERA_DOCUMENTO))
        .observe(titulo, { childList: true, characterData: true, subtree: true });
    }
    // crear, subir o borrar un layout no abre necesariamente un documento: el árbol repintado es la
    // señal de que la lista de ficheros cambió, y el layout mostrado puede ser otro (o ninguno)
    const arbolEl = document.getElementById("arbol-pestana");
    if (arbolEl && typeof MutationObserver === "function") {
      new MutationObserver(() => programarXml(ESPERA_ARBOL))
        .observe(arbolEl, { childList: true, subtree: true });
    }
    document.addEventListener(EVENTO_PREVIA, (e) => {
      if (!visible) return;
      const detalle = e && e.detail ? e.detail : {};
      // el modelo cambió: el canvas y la consola se pintan ya. Un rAF dejaría la consola con las
      // capturas del build anterior justo cuando el preview falla, que es cuando más importa.
      pintarRender(detalle.mensaje);
      if (modo === "xml") programarXml(ESPERA_PREVIA);
    });
  }

  // --- arranque -----------------------------------------------------------------------------
  function iniciar() {
    if (iniciado || !conDocumento()) return false;
    const caja = fila();
    const separador = document.getElementById("separador-previa");
    if (!caja || !separador) return false;
    iniciado = true;
    preferido = anchoValido(leerClave(CLAVE_ANCHO, ANCHO_POR_DEFECTO), ANCHO_MINIMO, ANCHO_MAXIMO);
    ancho = preferido;
    visible = leerClave(CLAVE_VISIBLE, "1") !== "0";
    modo = leerClave(CLAVE_MODO, "xml") === "render" ? "render" : "xml";

    conectarSeparador(separador);
    conectarModos();
    conectarEntrada();
    const alternar = document.getElementById("previa-alternar");
    if (alternar) alternar.addEventListener("click", () => aplicarVisible(!visible, true));
    const cerrar = document.getElementById("previa-cerrar");
    if (cerrar) cerrar.addEventListener("click", () => aplicarVisible(false, true));

    if (typeof ResizeObserver === "function") {
      // al entrar en la vista Editor la fila pasa de 0 al ancho real: el recorte se rehace con la
      // preferencia guardada, no con lo que cupo en una sección oculta
      new ResizeObserver(() => {
        aplicarAncho(preferido, false);
        if (!visible || modo !== "render") return;
        programarPintado();
      }).observe(caja);
    }

    aplicarAncho(preferido, false);
    aplicarVisible(visible, false);
    aplicarModo(modo, false);
    pintarRender();
    programarXml(0);
    return true;
  }

  return {
    iniciar,
    aplicarModo,
    aplicarVisible,
    refrescarXml,
    pintarRender,
    estado: () => ({ ancho, visible, modo, ruta: rutaMostrada }),
  };
}
