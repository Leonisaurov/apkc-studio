// La vista dividida del editor: a la derecha del código, un marco de teléfono con dos lecturas del
// mismo layout, sin compilar dos veces y sin tocar el documento que se está editando.
//
//   - «En vivo»: el `res/layout/*.xml` tal como está en el editor, convertido a modelo con
//     `vista-xml.js` y pintado en el canvas. Es un dibujo del layout —jerarquía, textos, tamaños,
//     gravedad y márgenes—, nunca el código XML: no hay `<pre>` ni resaltado de etiquetas. Se
//     refresca al teclear con un debounce corto, no lanza ningún comando de apkc y, si el XML está
//     a medias, conserva el último render bueno y lo dice en la línea de estado.
//   - «Render (eventos)»: el canvas del modelo real de `apkc preview` (tras compilar, con
//     `textoDinamico`), los botones de las vistas que responden a un clic, el registro del emulador
//     (escrituras de view, avisos, pasos y error) y la consola de la app (`System.out.println` y
//     `Log.*`). El emulador arranca en el estado que deja `onCreate`: el texto solo cambia cuando se
//     pulsa de verdad, y cada clic se manda a `apkc preview --pulsar` en orden, así que la pantalla
//     es reproducible. La consola de los comandos de compilación NO es esta: es la del panel
//     inferior (`#consola-pestana`).
//
// Reglas que no se relajan:
//   - **Nada muta el modelo.** El separador cambia un ancho CSS; ningún `pointerdown` de esta pieza
//     escribe en OPFS ni cambia `estadoPestana`. Un clic solo vuelve a pedir `apkc preview` sobre el
//     apk que ya está compilado, con la lista de clics acumulada.
//   - **Todo el texto del intérprete es dato, no marcado.** Se pinta con `textContent`.
//   - **Sin red.** El layout y los `@string` se leen del OPFS del propio proyecto.
//
// Las funciones de cabecera —`anchoValido`, `esRutaDeLayout`, `candidatosDeLayout`,
// `resumenEjecucion`, `oyentesDeModelo` y `nodoEnPunto`— son puras y se prueban en node
// (`prueba.js`); el modelo en vivo se prueba en `vista-xml.js`. La carpeta de OPFS y el documento
// activo llegan por el objeto de dependencias: este módulo no importa `pestana.js`.
import {
  pintarModelo, modeloActual, EVENTO_PREVIA, modeloDeSalida, pintarVistaPrevia, nodosAplanados,
  textoDeNodo, rectsEscalados,
} from "./vista-previa.js";
import { modeloDeLayout, decodificarEntidades } from "./vista-xml.js";

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
const CONSOLA_MAXIMAS = 128;
const OYENTES_MAXIMOS = 32;

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
  // la consola de la app es un canal aparte del registro: cada línea lleva su origen y el orden en
  // que se emitió, porque el reloj no existe en el intérprete y no se finge
  const consola = (Array.isArray(ejecucion.consola) ? ejecucion.consola : [])
    .slice(0, CONSOLA_MAXIMAS)
    .filter((l) => l && typeof l === "object")
    .map((l) => ({ origen: comoTexto(l.origen), texto: comoTexto(l.texto), secuencia: comoCuenta(l.secuencia) }))
    .filter((l) => l.origen || l.texto !== "");
  const pulsaciones = (Array.isArray(ejecucion.pulsaciones) ? ejecucion.pulsaciones : [])
    .slice(0, OYENTES_MAXIMOS)
    .map(comoTexto)
    .filter((p) => p.trim() !== "");
  const oyentes = (Array.isArray(ejecucion.oyentes) ? ejecucion.oyentes : [])
    .slice(0, OYENTES_MAXIMOS)
    .filter((o) => o && typeof o === "object")
    .map((o) => ({ id: comoTexto(o.id), idRef: comoTexto(o.idRef) }))
    .filter((o) => o.id || o.idRef);
  return {
    actividad: comoTexto(ejecucion.actividad),
    metodo: comoTexto(ejecucion.metodo),
    pasos: comoCuenta(ejecucion.pasos),
    interacciones: comoCuenta(ejecucion.interacciones),
    capturas,
    consola,
    pulsaciones,
    oyentes,
    avisos,
    error: comoTexto(ejecucion.error),
  };
}

// Las vistas que responden a un clic, con su aspecto en el modelo. `ejecucion.oyentes` es la fuente
// (lo que el intérprete registró); el árbol solo aporta el tipo y el texto para la etiqueta. El
// `idRef` es lo que se manda a `apkc preview --pulsar`, porque no depende del idioma ni del nombre.
export function oyentesDeModelo(modelo) {
  const resumen = resumenEjecucion(modelo);
  if (!resumen || !resumen.oyentes.length) return [];
  const porRef = new Map();
  for (const { nodo } of nodosAplanados(modelo)) {
    if (nodo && typeof nodo.idRef === "string" && nodo.idRef) porRef.set(nodo.idRef, nodo);
  }
  return resumen.oyentes.map((o) => {
    const nodo = o.idRef ? porRef.get(o.idRef) : null;
    return {
      id: o.id || o.idRef,
      idRef: o.idRef,
      tipo: nodo && typeof nodo.tipo === "string" ? nodo.tipo : "",
      texto: nodo ? textoDeNodo(nodo) : "",
    };
  });
}

// La vista bajo un punto del canvas, en coordenadas lógicas del panel (las mismas que usa el
// pintor). Gana la más profunda, que es la que un dedo tocaría. Devuelve null fuera del dibujo.
export function nodoEnPunto(modelo, ancho, alto, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let elegido = null;
  for (const r of rectsEscalados(modelo, ancho, alto)) {
    if (x < r.x || y < r.y || x > r.x + r.ancho || y > r.y + r.alto) continue;
    if (!elegido || r.profundidad >= elegido.profundidad) elegido = r;
  }
  return elegido;
}

// La vista que ATIENDE un clic en ese punto: la más profunda que además registró el listener. Un
// toque sobre el hijo de un contenedor con `OnClickListener` sube hasta el contenedor, como el
// reparto de eventos del framework; si ninguna de las que contienen el punto escucha, no hay clic.
export function oyenteEnPunto(modelo, ancho, alto, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let elegido = null;
  for (const r of rectsEscalados(modelo, ancho, alto)) {
    if (!r.oyente || !r.idRef) continue;
    if (x < r.x || y < r.y || x > r.x + r.ancho || y > r.y + r.alto) continue;
    if (!elegido || r.profundidad >= elegido.profundidad) elegido = r;
  }
  return elegido;
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
  // la lista de clics entregados desde la última compilación: se repite entera en cada `--pulsar`,
  // que es lo que hace reproducible la pantalla (el comando no guarda estado entre invocaciones)
  let pulsos = [];
  let pulsando = false;

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
    limpiarConsola();
    limpiarOyentes();
  }

  // La consola de la app: solo `print`/`println`/`Log.*`. Se pinta con `textContent` y el número de
  // secuencia que trae el intérprete, que es el orden real de emisión.
  function limpiarConsola(texto) {
    const lista = document.getElementById("previa-consola-lista");
    const cabecera = document.getElementById("previa-consola-cabecera");
    const vacio = document.getElementById("previa-consola-vacio");
    if (lista) lista.textContent = "";
    if (cabecera) cabecera.textContent = "sin salida";
    if (vacio) {
      vacio.hidden = false;
      if (texto) vacio.textContent = texto;
    }
  }

  function pintarConsola(modelo) {
    const lista = document.getElementById("previa-consola-lista");
    const cabecera = document.getElementById("previa-consola-cabecera");
    const vacio = document.getElementById("previa-consola-vacio");
    if (!lista || !cabecera || !vacio) return;
    const resumen = resumenEjecucion(modelo);
    lista.textContent = "";
    if (!resumen) {
      cabecera.textContent = "sin salida";
      vacio.hidden = false;
      vacio.textContent = "Compila el proyecto para ver lo que la app imprime.";
      return;
    }
    for (const linea of resumen.consola) {
      const li = document.createElement("li");
      li.className = "previa-consola-linea";
      const secuencia = document.createElement("span");
      secuencia.className = "previa-consola-secuencia";
      secuencia.textContent = String(linea.secuencia || lista.children.length + 1);
      const origen = document.createElement("span");
      origen.className = "previa-consola-origen";
      origen.textContent = linea.origen || "salida";
      const cuerpo = document.createElement("span");
      cuerpo.className = "previa-consola-texto";
      cuerpo.textContent = linea.texto;
      li.appendChild(secuencia);
      li.appendChild(origen);
      li.appendChild(cuerpo);
      lista.appendChild(li);
    }
    cabecera.textContent = resumen.consola.length === 1
      ? "1 línea · " + resumen.pulsaciones.length + (resumen.pulsaciones.length === 1 ? " clic" : " clics")
      : resumen.consola.length + " líneas · " + resumen.pulsaciones.length +
        (resumen.pulsaciones.length === 1 ? " clic" : " clics");
    const hay = lista.children.length > 0;
    vacio.hidden = hay;
    if (!hay) vacio.textContent = "La app no imprimió nada en esta ejecución.";
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
    partes.push(resumen.interacciones + (resumen.interacciones === 1 ? " clic" : " clics"));
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

  // --- clics del emulador -------------------------------------------------------------------
  function limpiarOyentes(texto) {
    const caja = document.getElementById("previa-oyentes");
    const cuenta = document.getElementById("previa-pulsos-cuenta");
    const nota = document.getElementById("previa-pulsos-nota");
    if (caja) caja.textContent = "";
    if (cuenta) cuenta.textContent = "sin clics";
    if (nota) {
      nota.hidden = false;
      if (texto) nota.textContent = texto;
    }
  }

  function pintarOyentes(modelo) {
    const caja = document.getElementById("previa-oyentes");
    const cuenta = document.getElementById("previa-pulsos-cuenta");
    const nota = document.getElementById("previa-pulsos-nota");
    if (!caja || !cuenta || !nota) return;
    const oyentes = oyentesDeModelo(modelo);
    const resumen = resumenEjecucion(modelo);
    // los clics que la pantalla declara haber ejecutado: el modelo los trae (`pulsaciones`) y, si
    // esta instancia acaba de pedir uno, la lista local ya los incluye; manda el mayor de los dos
    const entregados = Math.max(pulsos.length, resumen ? resumen.pulsaciones.length : 0);
    caja.textContent = "";
    cuenta.textContent = entregados === 0 ? "sin clics"
      : entregados + (entregados === 1 ? " clic" : " clics");
    for (const o of oyentes) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "previa-oyente";
      boton.dataset.idref = o.idRef;
      const etiqueta = o.texto ? o.id + " · " + o.texto : o.id;
      boton.textContent = etiqueta;
      boton.title = "Ejecutar el OnClickListener de " + o.id;
      boton.addEventListener("click", (e) => {
        e.preventDefault();
        pulsar(o.idRef);
      });
      caja.appendChild(boton);
    }
    nota.hidden = oyentes.length > 0;
    if (!oyentes.length) {
      nota.textContent = "Esta ejecución no registró ningún OnClickListener sobre una vista con id.";
    }
  }

  // Pide la pantalla después de un clic. Se repite TODO el estado desde `onCreate` (más los clics
  // anteriores), así que la pantalla resultante es la misma siempre para la misma lista: el comando
  // no puede guardar la máquina entre invocaciones y no lo finge.
  async function pulsar(idRef) {
    if (pulsando || typeof idRef !== "string" || !idRef) return null;
    if (!document.getElementById("previa-render-estado")) return null;
    const antes = pulsos.length;
    pulsos.push(idRef);
    pulsando = true;
    const estado = document.getElementById("previa-render-estado");
    if (estado) estado.textContent = "Ejecutando el clic " + pulsos.length + "…";
    try {
      await hospedador.cwd(carpeta);
      const argv = ["preview"];
      for (const p of pulsos) argv.push("--pulsar", p);
      argv.push("build/app.apk");
      const r = await hospedador.ejecutar(argv);
      const modelo = modeloDeSalida(r && r.consola);
      if (!modelo) {
        // el clic no se pudo entregar: se deshace para que la lista siga siendo válida y se dice por qué
        pulsos.length = antes;
        const lineas = String((r && (r.error || r.consola)) || "").trim().split("\n").filter(Boolean);
        mensajeVistaPreviaRender(lineas.length ? lineas[lineas.length - 1].trim() : "el clic no devolvió un modelo legible");
        return null;
      }
      // `pintarVistaPrevia` avisa por el evento; el panel se repinta con el modelo nuevo
      return pintarVistaPrevia(modelo);
    } catch (e) {
      pulsos.length = antes;
      mensajeVistaPreviaRender("no se pudo ejecutar el clic: " + (e && e.message ? e.message : e));
      return null;
    } finally {
      pulsando = false;
    }
  }

  function mensajeVistaPreviaRender(texto) {
    const estado = document.getElementById("previa-render-estado");
    if (estado) estado.textContent = texto;
  }

  // Un clic en el canvas se traduce a la vista que hay debajo, en las coordenadas lógicas del
  // panel. Si esa vista no tiene listener, el clic no hace nada (y no se inventa un aviso).
  function conectarCanvas() {
    const canvas = document.getElementById("previa-lateral-canvas");
    if (!canvas) return;
    const alPulsar = (e) => {
      // el espacio de la pintura manda: con él se midió el modelo y con él se pinta
      const espacio = canvas.__espacio || { ancho: 0, alto: 0 };
      const ancho = espacio.ancho;
      const alto = espacio.alto;
      const caja = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
      if (!(ancho > 0) || !(alto > 0) || !caja || !(caja.width > 0) || !(caja.height > 0)) return;
      const x = (e.clientX - caja.left) * (ancho / caja.width);
      const y = (e.clientY - caja.top) * (alto / caja.height);
      const nodo = oyenteEnPunto(modeloActual(), ancho, alto, x, y);
      if (!nodo) return;
      e.preventDefault();
      pulsar(nodo.idRef);
    };
    canvas.addEventListener("pointerdown", alPulsar);
    // el teclado también puede pulsar la primera vista que responde: es la misma orden, sin puntero
    canvas.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const primero = oyentesDeModelo(modeloActual())[0];
      if (!primero) return;
      e.preventDefault();
      pulsar(primero.idRef);
    });
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
      return null;
    }
    const pintado = pintarModelo(canvas, modeloVivo);
    if (pintado && pintado.valida === false) {
      estado.textContent = "El layout no cabe en la caja del panel; se dibuja a tamaño de respaldo.";
    }
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
    // el espacio con el que se pintó: el clic tiene que medir en ESE espacio, no en el que el
    // canvas tenga ahora. Si el panel cambió de tamaño entre pintar y pulsar, buscar con
    // clientWidth dejaría el punto desalineado con los píxeles que se ven.
    if (pintado && pintado.ancho > 0 && pintado.alto > 0) {
      canvas.__espacio = { ancho: pintado.ancho, alto: pintado.alto };
    }
    const layout = modelo.layout ? String(modelo.layout) : "el layout";
    estado.textContent = (modelo.aproximado === false
      ? "Render de " + layout + " con los eventos de la app, sin aproximar."
      : "Render aproximado de " + layout + " con los eventos de la app.") +
      " Arranca en el estado de onCreate: pulsa una vista para ejecutar su OnClickListener.";
    pintarLog(modelo);
    pintarConsola(modelo);
    pintarOyentes(modelo);
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
      // un modelo que no viene de un clic es un build nuevo: la lista de clics vuelve a empezar
      if (!pulsando) pulsos = [];
      // el modelo cambió: el canvas y los dos paneles se pintan ya. Un rAF dejaría la consola con
      // las capturas del build anterior justo cuando el preview falla, que es cuando más importa.
      pintarRender(detalle.mensaje);
      // el layout del modelo puede decir cuál es el layout del proyecto si aún no hay ninguno vivo
      if (modo === "vivo" && !modeloVivo) programarVivo(ESPERA_PREVIA);
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
    modo = leerClave(CLAVE_MODO, "vivo") === "render" ? "render" : "vivo";

    conectarSeparador(separador);
    conectarModos();
    conectarEntrada();
    conectarCanvas();
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
    // un clic desde fuera (la prueba de chromium): la misma orden que el puntero del canvas
    pulsar,
    // lectura para las pruebas de chromium: el modelo dibujado en el modo en vivo (no el código)
    modeloVivo: () => modeloVivo,
    estado: () => ({ ancho, visible, modo, ruta: rutaViva, pulsos: [...pulsos] }),
  };
}
