// La vista dividida del editor: a la derecha del código, un marco de teléfono con dos lecturas del
// mismo layout, sin compilar dos veces y sin tocar el documento que se está editando.
//
//   - «En vivo»: el `res/layout/*.xml` tal como está en el editor, convertido a modelo con
//     `vista-xml.js` y pintado en el canvas. Es un dibujo del layout —jerarquía, textos, tamaños,
//     gravedad y márgenes—, nunca el código XML: no hay `<pre>` ni resaltado de etiquetas. Se
//     refresca al teclear con un debounce corto, no lanza ningún comando de apkc y, si el XML está
//     a medias, conserva el último render bueno y lo dice en la línea de estado.
//   - «Render (eventos)»: el canvas del modelo real de `apkc preview` (tras compilar, con
//     `textoDinamico`) y la consola de la ejecución: capturas, avisos, pasos y error.
//
// Reglas que no se relajan:
//   - **Nada muta el modelo.** El separador cambia un ancho CSS y los dos canvas solo leen; ningún
//     `pointerdown` de esta pieza escribe en OPFS ni cambia `estadoPestana`.
//   - **Todo el texto del intérprete es dato, no marcado.** Se pinta con `textContent`.
//   - **Sin red.** El layout y los `@string` se leen del OPFS del propio proyecto.
//
// Las funciones de cabecera —`anchoValido`, `esRutaDeLayout`, `candidatosDeLayout` y
// `resumenEjecucion`— son puras y se prueban en node (`prueba.js`); el modelo en vivo se prueba en
// `vista-xml.js`. La carpeta de OPFS y el documento activo llegan por el objeto de dependencias:
// este módulo no importa `pestana.js`.
import { pintarModelo, modeloActual, EVENTO_PREVIA, escalaPara } from "./vista-previa.js";
import { modeloDeLayout, decodificarEntidades, paddingDe, esLineal, atributoLocal } from "./vista-xml.js";
import { insertarElemento, moverEnMarco, reordenarHijo, borrarElemento } from "./layout-editor.js";

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
const MENSAJE_SIN_ABRIR = "Abre un res/layout/*.xml en el editor para ver aquí el layout dibujado, " +
  "sin compilar.";

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
// que dice el modelo de `apkc preview` y, si hay árbol, sus layouts (main.xml primero).
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
  let modo = "vivo";
  let arrastrando = false;
  let temporizadorVivo = 0;
  let turnoVivo = 0;
  let rutaViva = null;
  let modeloVivo = null;
  let arbol = null;
  let strings = null;
  let stringsEn = 0;
  let arbolEn = 0;
  let cuadro = 0;
  let iniciado = false;
  // El modo editar no es un tercer modo de lectura: es un interruptor sobre «En vivo». Guarda la
  // ruta del nodo seleccionado (índices desde la raíz, sin contar los nodos de texto) y el arrastre
  // en curso. Nada de esto se persiste: al recargar se vuelve a la vista de solo lectura.
  let editando = false;
  let seleccion = null;
  let arrastre = null;
  let notaEdicion = "";

  const conDocumento = () => typeof document !== "undefined" && !!document.getElementById;

  function fila() { return conDocumento() ? document.getElementById("editor-fila") : null; }

  // --- separador ---------------------------------------------------------------------------
  function topeAncho() {
    // con la vista Editor oculta la fila mide cero: no se puede recortar contra un ancho que no
    // existe, así que el techo es el máximo y el recorte real llega al mostrarse la vista
    const caja = fila();
    const disponible = caja ? caja.clientWidth : 0;
    if (!(disponible > 0)) return ANCHO_MAXIMO;
    return Math.min(ANCHO_MAXIMO, Math.max(ANCHO_MINIMO, disponible - EDITOR_MINIMO));
  }

  function anchoDesde(clientX) {
    const caja = fila();
    if (!caja) return ANCHO_POR_DEFECTO;
    const rect = caja.getBoundingClientRect();
    const tope = Math.max(ANCHO_MINIMO, rect.width - EDITOR_MINIMO);
    return anchoValido(Math.round(rect.right - clientX), ANCHO_MINIMO, Math.min(ANCHO_MAXIMO, tope));
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
    if (!visible && editando) aplicarEditable(false);
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
    else { pintarVivo(); programarVivo(0); }
  }

  // --- En vivo / Render ---------------------------------------------------------------------
  function aplicarModo(valor, persistir) {
    // una preferencia vieja (`xml`) era el nombre anterior del mismo panel dibujado
    modo = valor === "render" ? "render" : "vivo";
    // el modo editar no existe sobre el render con eventos: cambiar de lectura lo apaga
    if (modo === "render" && editando) aplicarEditable(false);
    const botonVivo = document.getElementById("previa-modo-vivo");
    const botonRender = document.getElementById("previa-modo-render");
    const seccionVivo = document.getElementById("previa-vivo");
    const seccionRender = document.getElementById("previa-render");
    for (const [boton, activo] of [[botonVivo, modo === "vivo"], [botonRender, modo === "render"]]) {
      if (!boton) continue;
      boton.classList.toggle("activo", activo);
      boton.setAttribute("aria-selected", String(activo));
      boton.tabIndex = activo ? 0 : -1;
    }
    if (seccionVivo) seccionVivo.hidden = modo !== "vivo";
    if (seccionRender) seccionRender.hidden = modo !== "render";
    if (persistir) guardarClave(CLAVE_MODO, modo);
    if (!visible) return;
    if (modo === "render") programarPintado();
    else { pintarVivo(); programarVivo(0); }
  }

  function conectarModos() {
    const botonVivo = document.getElementById("previa-modo-vivo");
    const botonRender = document.getElementById("previa-modo-render");
    if (botonVivo) {
      botonVivo.addEventListener("click", () => aplicarModo("vivo", true));
      botonVivo.addEventListener("keydown", (e) => moverFocoModo(e));
    }
    if (botonRender) {
      botonRender.addEventListener("click", () => aplicarModo("render", true));
      botonRender.addEventListener("keydown", (e) => moverFocoModo(e));
    }
  }

  // role="tab" sin flechas deja el teclado a medias: las dos pestañas del panel se recorren con
  // las flechas, Home y End, como en cualquier tablist.
  function moverFocoModo(e) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const destino = e.key === "ArrowLeft" || e.key === "Home" ? "vivo" : "render";
    aplicarModo(destino, true);
    const boton = document.getElementById("previa-modo-" + destino);
    if (boton) boton.focus();
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

  // --- pintura ------------------------------------------------------------------------------
  function limpiarCanvas(canvas) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function pintarVivo() {
    if (!conDocumento()) return null;
    const canvas = document.getElementById("previa-vivo-canvas");
    const estado = document.getElementById("previa-vivo-estado");
    if (!canvas || !estado) return null;
    if (!modeloVivo) {
      limpiarCanvas(canvas);
      estado.textContent = MENSAJE_SIN_ABRIR;
      actualizarPaleta();
      actualizarEstadoEdicion();
      return null;
    }
    const pintado = pintarModelo(canvas, modeloVivo);
    if (editando && seleccion) {
      const nodo = nodoPorRuta(modeloVivo.raiz, seleccion);
      if (nodo && nodo.rect) dibujarContorno(canvas, cajaDeCanvas(canvas, modeloVivo), nodo.rect, false);
    }
    if (pintado && pintado.valida === false) {
      estado.textContent = "El layout no cabe en la caja del panel; se dibuja a tamaño de respaldo.";
    }
    actualizarPaleta();
    actualizarEstadoEdicion();
    return pintado;
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
      ? "Render de " + layout + " con los eventos de la app, sin aproximar. Se actualiza al compilar."
      : "Render aproximado de " + layout + " con los eventos de la app. Se actualiza al compilar.";
    pintarLog(modelo);
    if (pintado && pintado.valida === false) {
      estado.textContent = "El modelo de vista previa no trae una pantalla medible (ancho o alto no " +
        "finitos); no se pinta nada.";
    }
    return pintado;
  }

  function programarPintado() {
    if (typeof requestAnimationFrame !== "function") {
      if (modo === "render") pintarRender(); else pintarVivo();
      return;
    }
    if (cuadro) return;
    cuadro = requestAnimationFrame(() => {
      cuadro = 0;
      if (!visible) return;
      if (modo === "render") pintarRender(); else pintarVivo();
    });
  }

  // --- el layout en vivo --------------------------------------------------------------------
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
    strings = null;
    return arbol;
  }

  // Los `@string` del proyecto, del `values` base y sus variantes. Es una lectura de OPFS por
  // refresco (con caché de 5 s); si un values está roto, los demás siguen valiendo.
  async function stringsDelProyecto() {
    const ahora = Date.now();
    if (strings && ahora - stringsEn < 5000) return strings;
    const nodos = await nodosDelProyecto();
    const mapa = Object.create(null);
    for (const ruta of nodos.filter((r) => /\/res\/values[^/]*\/strings\.xml$/.test(r))) {
      try {
        const texto = await hospedador.texto(ruta);
        for (const m of String(texto).matchAll(/<string\s+name="([^"]+)"[^>]*>([^<]*)<\/string>/g)) {
          if (!(m[1] in mapa)) mapa[m[1]] = decodificarEntidades(m[2]);
        }
      } catch (e) { /* un values ilegible no impide pintar los demás */ }
    }
    strings = mapa;
    stringsEn = ahora;
    return mapa;
  }

  async function leerLayout(ruta) {
    // el documento abierto manda: lo que se dibuja es lo que se está escribiendo, aunque no se guarde
    if (estadoPestana && estadoPestana.ruta === ruta && editor && typeof editor.texto === "function") {
      return String(editor.texto());
    }
    // `hospedador.texto` devuelve "" tanto para un fichero vacío como para uno que ya no está, y
    // aquí los dos casos no son lo mismo: un layout borrado no es un layout en blanco
    const bytes = await hospedador.bytes(ruta);
    if (!bytes) throw new Error("no existe " + ruta);
    return new TextDecoder().decode(bytes);
  }

  function relativa(ruta) {
    return ruta.startsWith(carpeta + "/") ? ruta.slice(carpeta.length + 1) : ruta;
  }

  function estadoVivo(modelo, ruta, nota) {
    const estado = document.getElementById("previa-vivo-estado");
    if (!estado) return;
    const marca = document.getElementById("marca-sucio");
    const sucio = !!(marca && !marca.hidden && estadoPestana && estadoPestana.ruta === ruta);
    const partes = [relativa(ruta), modelo.nodos + (modelo.nodos === 1 ? " vista" : " vistas"),
      "en vivo (sin compilar)"];
    if (sucio) partes.push("sin guardar");
    if (modelo.sinStrings) partes.push(modelo.sinStrings + " @string sin resolver");
    if (nota) partes.push(nota);
    estado.classList.remove("con-aviso");
    estado.textContent = partes.join(" · ");
  }

  async function refrescarVivo() {
    if (!conDocumento() || !visible) return;
    const estado = document.getElementById("previa-vivo-estado");
    const canvas = document.getElementById("previa-vivo-canvas");
    if (!estado || !canvas) return;
    const turno = ++turnoVivo;
    const base = { abierta: estadoPestana ? estadoPestana.ruta : null, layout: layoutDelModelo(), proyecto: carpeta };
    let ruta = null;
    let texto = null;
    let error = "";
    const intentar = async (rutas) => {
      for (const candidata of rutas) {
        try {
          const leido = await leerLayout(candidata);
          if (turno !== turnoVivo) return true;
          ruta = candidata;
          texto = leido;
          return true;
        } catch (e) {
          if (!error) error = String(e && e.message ? e.message : e);
        }
      }
      return false;
    };
    if (!(await intentar(candidatosDeLayout(base)))) {
      if (turno !== turnoVivo) return;
      const nodos = await nodosDelProyecto(true);
      if (turno !== turnoVivo) return;
      if (!(await intentar(candidatosDeLayout({ ...base, nodos })))) {
        rutaViva = null;
        modeloVivo = null;
        canvas.getContext && limpiarCanvas(canvas);
        estado.classList.remove("con-aviso");
        estado.textContent = nodos.length || error
          ? MENSAJE_SIN_LAYOUT + (error ? " (" + error + ")" : "")
          : MENSAJE_SIN_ABRIR;
        actualizarPaleta();
        actualizarEstadoEdicion();
        return;
      }
    }
    if (turno !== turnoVivo) return;
    const stringsMap = await stringsDelProyecto();
    if (turno !== turnoVivo) return;
    const resultado = modeloDeLayout(texto, { layout: ruta, strings: stringsMap });
    if (!resultado.ok) {
      // un XML a medias no borra la pantalla que ya estaba bien: se avisa y se conserva
      estado.classList.add("con-aviso");
      estado.textContent = "XML inválido" + (resultado.linea ? " (línea " + resultado.linea + ")" : "") +
        ": se conserva el último render" + (rutaViva ? " de " + relativa(rutaViva) : "") + ".";
      actualizarPaleta();
      actualizarEstadoEdicion();
      return;
    }
    rutaViva = ruta;
    modeloVivo = resultado.modelo;
    estadoVivo(modeloVivo, ruta);
    pintarVivo();
  }

  function programarVivo(espera) {
    clearTimeout(temporizadorVivo);
    temporizadorVivo = setTimeout(() => {
      temporizadorVivo = 0;
      refrescarVivo().catch(() => {});
    }, typeof espera === "number" ? espera : ESPERA_TECLEO);
  }

  function conectarEntrada() {
    const codigo = document.getElementById("codigo");
    if (codigo) {
      codigo.addEventListener("input", () => {
        if (!visible) return;
        // si el layout mostrado es el documento que se escribe, basta el buffer; si no, no hay nada
        // que releer por teclear en otro fichero
        if (rutaViva && estadoPestana && estadoPestana.ruta === rutaViva) programarVivo(ESPERA_TECLEO);
        else if (!modeloVivo) programarVivo(ESPERA_TECLEO);
      });
    }
    const titulo = document.getElementById("fichero-abierto");
    if (titulo && typeof MutationObserver === "function") {
      new MutationObserver(() => programarVivo(ESPERA_DOCUMENTO))
        .observe(titulo, { childList: true, characterData: true, subtree: true });
    }
    // crear, subir o borrar un layout no abre necesariamente un documento: el árbol repintado es la
    // señal de que la lista de ficheros cambió, y el layout mostrado puede ser otro (o ninguno)
    const arbolEl = document.getElementById("arbol-pestana");
    if (arbolEl && typeof MutationObserver === "function") {
      new MutationObserver(() => programarVivo(ESPERA_ARBOL))
        .observe(arbolEl, { childList: true, subtree: true });
    }
    document.addEventListener(EVENTO_PREVIA, (e) => {
      if (!visible) return;
      const detalle = e && e.detail ? e.detail : {};
      // el modelo cambió: el canvas y la consola se pintan ya. Un rAF dejaría la consola con las
      // capturas del build anterior justo cuando el preview falla, que es cuando más importa.
      pintarRender(detalle.mensaje);
      // el layout del modelo puede decir cuál es el layout del proyecto si aún no hay ninguno vivo
      if (modo === "vivo" && !modeloVivo) programarVivo(ESPERA_PREVIA);
    });
  }

  // --- modo editar: añadir, arrastrar y borrar ------------------------------------------------
  // El panel no escribe el modelo: cambia el TEXTO del layout con `layout-editor.js` (puro) y lo
  // aplica con `editor.cambiar()`, así el cambio entra en el undo tree y el documento queda sucio
  // una sola vez. El canvas dibuja lo que devuelve `vista-xml.js`; no hay estado de documento aquí.
  function colorTema(nombre, respaldo) {
    if (!conDocumento() || typeof getComputedStyle !== "function") return respaldo;
    const valor = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
    return valor || respaldo;
  }

  function nodoPorRuta(raiz, ruta) {
    let nodo = raiz;
    for (const i of Array.isArray(ruta) ? ruta : []) {
      if (!nodo || !Array.isArray(nodo.hijos) || !nodo.hijos[i]) return null;
      nodo = nodo.hijos[i];
    }
    return nodo || null;
  }

  function etiquetaDe(nodo) {
    if (!nodo) return "";
    return nodo.id ? nodo.id + " (" + nodo.tipo + ")" : String(nodo.tipo || "vista");
  }

  // El cambio mínimo entre dos textos: `editor.cambiar(ini, fin, medio)` sustituye solo lo que
  // cambió, que es lo que hace legible el undo tree.
  function diferencia(a, b) {
    const max = Math.min(a.length, b.length);
    let ini = 0;
    while (ini < max && a[ini] === b[ini]) ini++;
    let fa = a.length, fb = b.length;
    while (fa > ini && fb > ini && a[fa - 1] === b[fb - 1]) { fa--; fb--; }
    return { ini, fin: fa, medio: b.slice(ini, fb) };
  }

  function motivoNoEditable() {
    if (!editando) return "El modo editar está apagado.";
    if (!editor || typeof editor.texto !== "function") return "El editor no está disponible.";
    if (!modeloVivo) {
      return "El layout abierto no es un XML válido: corrígelo en el editor antes de editarlo aquí.";
    }
    if (!estadoPestana || estadoPestana.ruta !== rutaViva) {
      return "El layout que se dibuja no está abierto: ábrelo en el editor para editarlo aquí.";
    }
    return "";
  }

  function puedeEditar() {
    return motivoNoEditable() === "";
  }

  function textoEstadoEdicion() {
    if (!editando) return "";
    const motivo = motivoNoEditable();
    if (motivo) return motivo;
    const nodo = seleccion ? nodoPorRuta(modeloVivo.raiz, seleccion) : null;
    if (nodo) {
      return "Seleccionado " + etiquetaDe(nodo) +
        " · arrástralo para moverlo · Supr lo borra · Esc lo suelta.";
    }
    return "Clic en un elemento del dibujo para seleccionarlo; añade otros desde la paleta.";
  }

  function actualizarEstadoEdicion() {
    const estado = document.getElementById("previa-editar-estado");
    if (!estado) return;
    estado.hidden = !editando;
    estado.textContent = editando ? (notaEdicion || textoEstadoEdicion()) : "";
  }

  function avisarEdicion(texto) {
    notaEdicion = String(texto || "");
    actualizarEstadoEdicion();
  }

  function actualizarPaleta() {
    const paleta = document.getElementById("previa-paleta");
    if (paleta) paleta.hidden = !editando;
    if (!conDocumento()) return;
    const puede = puedeEditar();
    for (const boton of document.querySelectorAll("#previa-paleta button")) boton.disabled = !puede;
  }

  // Aplica el XML nuevo al buffer. `editor.cambiar` devuelve el foco al textarea: en modo editar
  // se lo devolvemos al canvas para que Supr y Esc sigan funcionando sin volver a pulsar el nodo.
  function aplicarXml(nuevo, mensaje) {
    if (!editor || typeof editor.texto !== "function") return false;
    const antes = String(editor.texto());
    if (nuevo === antes) {
      if (mensaje) avisarEdicion(mensaje);
      return false;
    }
    const d = diferencia(antes, nuevo);
    editor.cambiar(d.ini, d.fin, d.medio, [d.ini + d.medio.length, d.ini + d.medio.length]);
    const canvas = canvasVivo();
    if (canvas && typeof canvas.focus === "function") canvas.focus();
    refrescarVivo().catch(() => {});
    if (mensaje) avisarEdicion(mensaje);
    return true;
  }

  function seleccionar(ruta) {
    const limpia = Array.isArray(ruta) && ruta.length ? ruta.slice() : null;
    const igual = JSON.stringify(limpia) === JSON.stringify(seleccion);
    seleccion = limpia;
    if (!igual) notaEdicion = "";
    if (visible && modo === "vivo") pintarVivo();
    else { actualizarPaleta(); actualizarEstadoEdicion(); }
  }

  function anadir(tipo) {
    const motivo = motivoNoEditable();
    if (motivo) { avisarEdicion(motivo); return false; }
    const r = insertarElemento(String(editor.texto()), { tipo });
    if (!r.ok) { avisarEdicion("No se pudo añadir: " + r.error); return false; }
    seleccion = r.ruta;
    notaEdicion = "";
    return aplicarXml(r.xml, "Añadido " + tipo + (r.id ? " (id/" + r.id + ")" : "") + ".");
  }

  function borrarSeleccion() {
    if (!seleccion) return false;
    const motivo = motivoNoEditable();
    if (motivo) { avisarEdicion(motivo); return false; }
    const nodo = nodoPorRuta(modeloVivo.raiz, seleccion);
    const etiqueta = etiquetaDe(nodo);
    const r = borrarElemento(String(editor.texto()), seleccion);
    if (!r.ok) { avisarEdicion("No se pudo borrar: " + r.error); return false; }
    seleccion = null;
    notaEdicion = "";
    return aplicarXml(r.xml, "Borrado " + etiqueta + ".");
  }

  function canvasVivo() {
    return conDocumento() ? document.getElementById("previa-vivo-canvas") : null;
  }

  function cajaDeCanvas(canvas, modelo) {
    return escalaPara(modelo, canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
  }

  function puntoDePuntero(canvas, evento) {
    const r = canvas.getBoundingClientRect();
    // el canvas tiene borde de 1 px: `clientWidth` no lo cuenta y `rect.width` sí
    const factor = r.width > 0 && canvas.clientWidth ? canvas.clientWidth / r.width : 1;
    return { x: (evento.clientX - r.left) * factor, y: (evento.clientY - r.top) * factor };
  }

  function puntoModelo(canvas, modelo, evento) {
    const caja = cajaDeCanvas(canvas, modelo);
    if (!caja.valida) return null;
    const p = puntoDePuntero(canvas, evento);
    return { x: (p.x - caja.x) / caja.escala, y: (p.y - caja.y) / caja.escala, caja };
  }

  // El nodo más profundo cuyo `rect` contiene el punto. La raíz no entra: borrarla dejaría la
  // actividad sin `setContentView`.
  function golpeEn(modelo, x, y) {
    let mejor = null;
    const recorrer = (nodo, ruta, profundidad) => {
      const r = nodo && nodo.rect;
      if (profundidad > 0 && r && Number.isFinite(r.ancho) && Number.isFinite(r.alto) &&
          x >= r.x && x <= r.x + r.ancho && y >= r.y && y <= r.y + r.alto) {
        if (!mejor || profundidad >= mejor.profundidad) mejor = { ruta, profundidad, nodo };
      }
      const hijos = nodo && Array.isArray(nodo.hijos) ? nodo.hijos : [];
      hijos.forEach((hijo, i) => recorrer(hijo, ruta.concat(i), profundidad + 1));
    };
    if (modelo && modelo.raiz) recorrer(modelo.raiz, [], 0);
    return mejor;
  }

  function dibujarContorno(canvas, caja, rect, guiones) {
    if (!canvas || !canvas.getContext || !caja || !caja.valida || !rect) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = colorTema("--acento", "#007acc");
    ctx.lineWidth = 2;
    ctx.setLineDash(guiones ? [4, 3] : []);
    const x = caja.x + rect.x * caja.escala;
    const y = caja.y + rect.y * caja.escala;
    const ancho = Math.max(1, rect.ancho * caja.escala);
    const alto = Math.max(1, rect.alto * caja.escala);
    ctx.strokeRect(x + 1, y + 1, Math.max(1, ancho - 2), Math.max(1, alto - 2));
    ctx.restore();
  }

  // Durante el arrastre se dibuja el contorno del nodo desplazado: es la única realimentación que
  // necesita el dedo o el ratón, y no toca el documento hasta soltar.
  function dibujarFantasma(dx, dy) {
    const canvas = canvasVivo();
    if (!canvas || !modeloVivo || !arrastre) return;
    const nodo = nodoPorRuta(modeloVivo.raiz, arrastre.ruta);
    if (!nodo || !nodo.rect) return;
    pintarVivo();
    const caja = cajaDeCanvas(canvas, modeloVivo);
    dibujarContorno(canvas, caja, {
      x: nodo.rect.x + dx, y: nodo.rect.y + dy, ancho: nodo.rect.ancho, alto: nodo.rect.alto,
    }, true);
  }

  function moverNodo(ruta, dx, dy) {
    const motivo = motivoNoEditable();
    if (motivo) { avisarEdicion(motivo); return false; }
    const modelo = modeloVivo;
    const nodo = nodoPorRuta(modelo.raiz, ruta);
    const rutaPadre = ruta.slice(0, -1);
    const padre = nodoPorRuta(modelo.raiz, rutaPadre);
    if (!nodo || !nodo.rect || !padre || !padre.rect) return false;
    const texto = String(editor.texto());
    if (esLineal(padre.tipo)) {
      // Un layout lineal coloca en orden: mover es reordenar los hijos en el XML.
      const vertical = atributoLocal(padre.atributos, "orientation") !== "horizontal";
      const otros = (padre.hijos || [])
        .map((hijo, i) => ({ nodo: hijo, ruta: rutaPadre.concat(i) }))
        .filter((x) => x.ruta.join("/") !== ruta.join("/"));
      const centro = (x) => {
        const r = x.nodo.rect || { x: 0, y: 0, ancho: 0, alto: 0 };
        return vertical ? r.y + r.alto / 2 : r.x + r.ancho / 2;
      };
      const objetivo = vertical
        ? nodo.rect.y + nodo.rect.alto / 2 + dy
        : nodo.rect.x + nodo.rect.ancho / 2 + dx;
      let indice = 0;
      for (const x of otros) if (centro(x) < objetivo) indice++;
      const r = reordenarHijo(texto, ruta, indice);
      if (!r.ok) { avisarEdicion("No se pudo mover: " + r.error); return false; }
      if (!r.cambio) { avisarEdicion("El elemento ya está en esa posición."); return false; }
      seleccion = r.ruta;
      notaEdicion = "";
      return aplicarXml(r.xml, "Movido " + etiquetaDe(nodo) + " a la posición " +
        (r.ruta[r.ruta.length - 1] + 1) + ".");
    }
    // Un marco coloca por gravedad y márgenes: se fijan margen izquierdo y superior respecto al
    // contenido del padre (y se quita `layout_gravity`, que anularía el margen).
    const pad = paddingDe(padre);
    const izquierda = Math.max(0, nodo.rect.x - (padre.rect.x + pad.izq) + dx);
    const arriba = Math.max(0, nodo.rect.y - (padre.rect.y + pad.arriba) + dy);
    const r = moverEnMarco(texto, ruta, { izquierda, arriba });
    if (!r.ok) { avisarEdicion("No se pudo mover: " + r.error); return false; }
    if (!r.cambio) { avisarEdicion("El margen no cambia."); return false; }
    return aplicarXml(r.xml, "Movido " + etiquetaDe(nodo) + " a " + Math.round(izquierda) +
      "dp de margen izquierdo y " + Math.round(arriba) + "dp de superior.");
  }

  function soltarCanvas(e) {
    if (!arrastre) return;
    const a = arrastre;
    arrastre = null;
    if (!a.movido) return;
    const canvas = canvasVivo();
    const modelo = modeloVivo;
    if (!canvas || !modelo) return;
    const caja = cajaDeCanvas(canvas, modelo);
    if (!caja.valida) return;
    const r = canvas.getBoundingClientRect();
    const factor = r.width > 0 && canvas.clientWidth ? canvas.clientWidth / r.width : 1;
    moverNodo(a.ruta, ((e.clientX - a.x0) * factor) / caja.escala,
      ((e.clientY - a.y0) * factor) / caja.escala);
  }

  function conectarCanvasEditable() {
    const canvas = canvasVivo();
    if (!canvas) return;
    canvas.addEventListener("pointerdown", (e) => {
      if (!editando || (typeof e.button === "number" && e.button !== 0)) return;
      const modelo = modeloVivo;
      if (!modelo) { avisarEdicion(motivoNoEditable()); return; }
      const p = puntoModelo(canvas, modelo, e);
      if (!p) return;
      const golpe = golpeEn(modelo, p.x, p.y);
      seleccionar(golpe ? golpe.ruta : null);
      if (typeof canvas.focus === "function") canvas.focus();
      e.preventDefault();
      if (!golpe) return;
      arrastre = { ruta: golpe.ruta, x0: e.clientX, y0: e.clientY, movido: false };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
    });
    // el movimiento y el soltar se siguen en el documento: el puntero puede salir del canvas
    document.addEventListener("pointermove", (e) => {
      if (!arrastre) return;
      const dx = e.clientX - arrastre.x0;
      const dy = e.clientY - arrastre.y0;
      if (!arrastre.movido && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      arrastre.movido = true;
      if (!modeloVivo) return;
      const caja = cajaDeCanvas(canvas, modeloVivo);
      if (!caja.valida) return;
      const r = canvas.getBoundingClientRect();
      const factor = r.width > 0 && canvas.clientWidth ? canvas.clientWidth / r.width : 1;
      dibujarFantasma((dx * factor) / caja.escala, (dy * factor) / caja.escala);
      e.preventDefault();
    });
    document.addEventListener("pointerup", soltarCanvas);
    document.addEventListener("pointercancel", () => { arrastre = null; });
  }

  // Supr borra y Esc suelta, solo con el modo editar y una selección. Se ignoran los campos de
  // texto y cualquier combinación con Ctrl/Alt/Meta: el autocompletado, `Ctrl+Mayús+P`, `Ctrl+G` y
  // la búsqueda siguen siendo del editor.
  function conectarTecladoEditable() {
    document.addEventListener("keydown", (e) => {
      if (!editando || !seleccion) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const destino = e.target;
      const esCampo = destino && (destino.tagName === "TEXTAREA" || destino.tagName === "INPUT" ||
        destino.tagName === "SELECT" || destino.isContentEditable);
      if (esCampo) return;
      if (e.key === "Delete") {
        e.preventDefault();
        borrarSeleccion();
      } else if (e.key === "Escape") {
        e.preventDefault();
        seleccionar(null);
      }
    });
  }

  function aplicarEditable(valor) {
    const activo = !!valor && visible;
    if (activo && modo !== "vivo") aplicarModo("vivo", true);
    editando = activo;
    arrastre = null;
    if (!editando) { seleccion = null; notaEdicion = ""; }
    const boton = document.getElementById("previa-modo-editar");
    if (boton) {
      boton.classList.toggle("activo", editando);
      boton.setAttribute("aria-pressed", String(editando));
    }
    const canvas = canvasVivo();
    if (canvas) canvas.classList.toggle("editable", editando);
    actualizarPaleta();
    actualizarEstadoEdicion();
    if (visible && modo === "vivo") {
      pintarVivo();
      if (editando) programarVivo(0);
    }
  }

  function conectarEditable() {
    const boton = document.getElementById("previa-modo-editar");
    if (boton) boton.addEventListener("click", () => aplicarEditable(!editando));
    if (conDocumento()) {
      for (const b of document.querySelectorAll("#previa-paleta button")) {
        b.addEventListener("click", () => anadir(b.dataset.tipo));
      }
    }
    conectarCanvasEditable();
    conectarTecladoEditable();
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
    modo = leerClave(CLAVE_MODO, "vivo") === "render" ? "render" : "vivo";

    conectarSeparador(separador);
    conectarModos();
    conectarEntrada();
    conectarEditable();
    const alternar = document.getElementById("previa-alternar");
    if (alternar) alternar.addEventListener("click", () => aplicarVisible(!visible, true));
    const cerrar = document.getElementById("previa-cerrar");
    if (cerrar) cerrar.addEventListener("click", () => aplicarVisible(false, true));

    if (typeof ResizeObserver === "function") {
      // al entrar en la vista Editor la fila pasa de 0 al ancho real: el recorte se rehace con la
      // preferencia guardada, no con lo que cupo en una sección oculta
      new ResizeObserver(() => {
        aplicarAncho(preferido, false);
        if (!visible) return;
        programarPintado();
      }).observe(caja);
    }

    aplicarAncho(preferido, false);
    aplicarVisible(visible, false);
    aplicarModo(modo, false);
    pintarRender();
    pintarVivo();
    programarVivo(0);
    return true;
  }

  return {
    iniciar,
    aplicarModo,
    aplicarVisible,
    refrescarVivo,
    pintarVivo,
    pintarRender,
    // el modo editar, para las pruebas de chromium y la consola de desarrollo
    editar: aplicarEditable,
    anadir,
    borrarSeleccion,
    seleccionar,
    // lectura para las pruebas de chromium: el modelo dibujado en el modo en vivo (no el código)
    modeloVivo: () => modeloVivo,
    estado: () => ({
      ancho, visible, modo, ruta: rutaViva, editando,
      seleccion: seleccion ? seleccion.slice() : null,
    }),
  };
}
