// La vista previa del teléfono: el mismo layout y el mismo modelo en dos sitios, la vista dividida
// del editor y la vista Pantalla. Los dos modos se llaman como lo que hacen:
//
//   - «Vista previa»: el `res/layout/*.xml` tal como está en el editor, convertido a modelo con
//     `vista-xml.js` y pintado en el canvas. Es un dibujo del layout —jerarquía, textos, tamaños,
//     gravedad y márgenes—, nunca el código XML: no hay `<pre>` ni resaltado de etiquetas. Se
//     refresca al teclear con un debounce corto, no lanza ningún comando de apkc y, si el XML está
//     a medias, conserva el último render bueno y lo dice en la línea de estado.
//   - «Emulador»: el canvas del modelo real de `apkc preview` (tras compilar, con `textoDinamico`),
//     los botones de las vistas que responden a un clic, el registro del emulador (escrituras de
//     view, avisos, pasos y error) y la consola de la app (`System.out.println` y `Log.*`). Arranca
//     en el estado de `onCreate`: el texto cambia solo al pulsar de verdad, y cada clic se manda a
//     `apkc preview --pulsar` en orden. La consola de compilación es otra (#consola-pestana).
//
// Reglas que no se relajan:
//   - **Nada muta el modelo.** Los tiradores cambian variables CSS del marco; los canvas solo leen.
//     Un clic solo vuelve a pedir `apkc preview` sobre el apk ya compilado con la lista de clics.
//   - **Todo el texto del intérprete es dato, no marcado.** Se pinta con `textContent`.
//   - **Sin red.** El layout y los `@string` se leen del OPFS del propio proyecto.
//
// Cada marco (editor y Pantalla) tiene cuatro aristas y cuatro esquinas: un tirador horizontal
// cambia el ancho y uno vertical el alto; las esquinas cambian los dos. Es preferencia de ventana.
//
// Funciones puras, probadas en node (`prueba.js`): `medidaValida`, `anchoValido`,
// `cajaRedimensionada`, `esRutaDeLayout`, `candidatosDeLayout`, `resumenEjecucion`,
// `oyentesDeModelo` y `nodoEnPunto`. El modelo en vivo se prueba en `vista-xml.js`. La carpeta de
// OPFS y el documento activo llegan por el objeto de dependencias: no importa `pestana.js`.
import {
  pintarModelo, modeloActual, EVENTO_PREVIA, modeloDeSalida, pintarVistaPrevia, nodosAplanados,
  textoDeNodo, rectsEscalados,
} from "./vista-previa.js";
import { modeloDeLayout, decodificarEntidades } from "./vista-xml.js";

// Persistencia de la vista dividida. Son preferencias de esta ventana, no del proyecto.
const CLAVE_ANCHO = "apkc-studio/previa-ancho";
const CLAVE_ALTO = "apkc-studio/previa-alto";
const CLAVE_ARRIBA = "apkc-studio/previa-arriba";
const CLAVE_VISIBLE = "apkc-studio/previa-visible";
const CLAVE_MODO = "apkc-studio/previa-modo";
// la columna de estado y consola de la vista Pantalla se mide aparte
const CLAVE_LADO = "apkc-studio/previa-lado";
const CLAVE_LADO_ALTO = "apkc-studio/previa-lado-alto";
const CLAVE_LADO_ARRIBA = "apkc-studio/previa-lado-arriba";

const ANCHO_POR_DEFECTO = 340;
const ANCHO_MINIMO = 240;
const ANCHO_MAXIMO = 900;
const ALTO_MINIMO = 320;
// el editor nunca baja de 280 px: el tirador no puede dejarlo en una rendija
const EDITOR_MINIMO = 280;
const LADO_POR_DEFECTO = 380;
const LADO_MINIMO = 220;
const LADO_MAXIMO = 560;
const LADO_ALTO_MINIMO = 240;
// el teléfono de la vista Pantalla no se queda sin ancho aunque el panel crezca
const VISTA_MINIMO = 280;
const ESTRECHO = "(max-width: 760px)";
const PASO = 16;
const PASO_GRANDE = 48;
const ESPERA_TECLEO = 350;
const ESPERA_DOCUMENTO = 160;
const ESPERA_ARBOL = 400;
const ESPERA_PREVIA = 120;
const CAPTURAS_MAXIMAS = 64;
const AVISOS_MAXIMOS = 24;
const CONSOLA_MAXIMAS = 128;
const OYENTES_MAXIMOS = 32;

const MENSAJE_SIN_MODELO = "Compila el proyecto (Editor → Compilar → Compilar debug) para ver aquí " +
  "la pantalla del emulador y lo que ejecuta la app.";
const MENSAJE_SIN_EJECUCION = "El modelo no trae ejecución: el apk se leyó con --sin-ejecutar o no " +
  "tiene classes.dex. Sin capturas ni avisos.";
const MENSAJE_SIN_LAYOUT = "El proyecto no tiene ningún res/layout/*.xml. Crea un layout en el " +
  "explorador o abre uno para verlo aquí.";
const MENSAJE_SIN_ABRIR = "Abre un res/layout/*.xml en el editor para ver aquí el layout dibujado, " +
  "sin compilar.";

// Una medida utilizable: siempre entera, dentro de [minimo, maximo] y con un respaldo si lo pedido
// no es un número (una preferencia corrupta no puede dejar el panel en 0 px).
export function medidaValida(pedido, minimo, maximo, respaldo) {
  const min = Number.isFinite(minimo) ? Math.round(minimo) : ANCHO_MINIMO;
  let max = Number.isFinite(maximo) ? Math.round(maximo) : ANCHO_MAXIMO;
  if (max < min) max = min;
  const n = typeof pedido === "number" ? pedido : Number(pedido);
  const porDefecto = Number.isFinite(respaldo) ? respaldo : ANCHO_POR_DEFECTO;
  if (!Number.isFinite(n)) return Math.min(max, Math.max(min, porDefecto));
  return Math.round(Math.min(max, Math.max(min, n)));
}

export function anchoValido(pedido, minimo, maximo) {
  return medidaValida(pedido, minimo, maximo, ANCHO_POR_DEFECTO);
}

// Un número opcional: `null` cuando la preferencia no existe o no es un número, y si la hay, dentro
// de su rango. Es lo que distingue «sin alto propio» (la fila entera) de «640 px elegidos».
export function numeroOpcional(valor, minimo, maximo) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n)) return null;
  return medidaValida(n, minimo, maximo, minimo);
}

// El reparto de una caja al arrastrar un tirador. `eje` es «oeste», «este», «norte», «sur» o una
// esquina que combine dos («noroeste»…): la arista que se mueve sigue al puntero y la de enfrente
// se queda quieta. El alto nunca deja hueco fuera del marco (`arriba >= 0`, `arriba + alto <=
// altoMax`) y el ancho no cruza sus límites. Pura: la usan los dos marcos y se prueba en node.
export function cajaRedimensionada(caja, eje, dx, dy, limites) {
  const l = limites && typeof limites === "object" ? limites : {};
  const anchoMin = Number.isFinite(l.anchoMin) ? Math.round(l.anchoMin) : ANCHO_MINIMO;
  const anchoMax = Math.max(anchoMin, Number.isFinite(l.anchoMax) ? Math.round(l.anchoMax) : ANCHO_MAXIMO);
  const altoMin = Number.isFinite(l.altoMin) ? Math.round(l.altoMin) : ALTO_MINIMO;
  const altoMax = Math.max(altoMin, Number.isFinite(l.altoMax) ? Math.round(l.altoMax) : altoMin * 4);
  const base = caja && typeof caja === "object" ? caja : {};
  const actual = {
    ancho: medidaValida(base.ancho, anchoMin, anchoMax, ANCHO_POR_DEFECTO),
    alto: medidaValida(base.alto, altoMin, altoMax, altoMax),
    arriba: Number.isFinite(base.arriba) ? Math.max(0, Math.round(base.arriba)) : 0,
  };
  if (actual.arriba + actual.alto > altoMax) actual.alto = Math.max(altoMin, altoMax - actual.arriba);
  const rumbo = typeof eje === "string" ? eje : "";
  // las direcciones se comparan exactas: «oeste» termina en «este» y un `includes` movería el
  // ancho en los dos sentidos a la vez, dejándolo igual
  const alOeste = rumbo === "oeste" || rumbo === "noroeste" || rumbo === "suroeste";
  const alEste = rumbo === "este" || rumbo === "noreste" || rumbo === "sureste";
  const alNorte = rumbo === "norte" || rumbo === "noroeste" || rumbo === "noreste";
  const alSur = rumbo === "sur" || rumbo === "suroeste" || rumbo === "sureste";
  let ancho = actual.ancho;
  let alto = actual.alto;
  let arriba = actual.arriba;
  if (alOeste) ancho -= dx;
  if (alEste) ancho += dx;
  if (alNorte) {
    // la arista de abajo no se mueve: el alto se queda con lo que sobra
    const tope = Math.max(0, arriba + alto - altoMin);
    const nuevoArriba = Math.min(tope, Math.max(0, arriba + dy));
    alto += arriba - nuevoArriba;
    arriba = nuevoArriba;
  }
  if (alSur) alto += dy;
  return {
    ancho: Math.round(Math.min(anchoMax, Math.max(anchoMin, ancho))),
    alto: Math.round(Math.min(altoMax - arriba, Math.max(altoMin, alto))),
    arriba: Math.round(arriba),
  };
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

// Las dos superficies donde se pinta lo mismo: el panel de la vista dividida y la vista Pantalla.
// Cada una tiene su canvas, su línea de estado y su consola; el modelo y el modo son únicos, así
// que no hay una segunda copia del estado que se pueda quedar atrás.
const SUPERFICIES = [
  {
    id: "panel",
    canvasVivo: "previa-vivo-canvas", estadoVivo: "previa-vivo-estado",
    canvasRender: "previa-lateral-canvas", estadoRender: "previa-render-estado",
    log: { lista: "previa-log-lista", cabecera: "previa-log-cabecera", vacio: "previa-log-vacio" },
  },
  {
    id: "vista",
    canvasVivo: "vista-layout-canvas", estadoVivo: "vista-layout-estado",
    // el estado del emulador de Pantalla lo escribe vista-previa.js con el modelo de apkc
    canvasRender: "vista-previa", estadoRender: null,
    log: { lista: "vista-log-lista", cabecera: "vista-log-cabecera", vacio: "vista-log-vacio" },
  },
];

// La pieza de interfaz. Se construye sin tocar el DOM y solo se engancha en `iniciar()`, para que
// importar este módulo desde la prueba de node no necesite navegador.
export function crearPreviaPanel({ hospedador, proyecto, estadoPestana, editor } = {}) {
  const carpeta = typeof proyecto === "string" && proyecto ? proyecto : "/proyecto";
  // la caja efectiva y la que se guarda: la efectiva se recorta contra la fila, la guardada no
  const caja = { ancho: ANCHO_POR_DEFECTO, alto: null, arriba: 0 };
  const querida = { ancho: ANCHO_POR_DEFECTO, alto: null, arriba: 0 };
  const cajaLado = { ancho: LADO_POR_DEFECTO, alto: null, arriba: 0 };
  const queridaLado = { ancho: LADO_POR_DEFECTO, alto: null, arriba: 0 };
  let visible = true;
  let modo = "vivo";
  let arrastre = null;
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
  const el = (id) => (conDocumento() ? document.getElementById(id) : null);

  function fila() { return el("editor-fila"); }
  function marcoPanel() { return el("marco-previa"); }
  function marcoLado() { return el("marco-vista-lado"); }

  function vistaActiva() {
    return conDocumento() && document.body && document.body.dataset.vista === "vista";
  }

  function estrecho() {
    if (typeof matchMedia !== "function") return false;
    try { return matchMedia(ESTRECHO).matches; } catch (e) { return false; }
  }

  // --- tiradores y medidas -----------------------------------------------------------------
  function limitesPanel() {
    const cajaFila = fila();
    const anchoDisponible = cajaFila ? cajaFila.clientWidth : 0;
    const altoDisponible = cajaFila ? cajaFila.clientHeight : 0;
    return {
      anchoMin: ANCHO_MINIMO,
      anchoMax: anchoDisponible > 0
        ? Math.max(ANCHO_MINIMO, Math.min(ANCHO_MAXIMO, anchoDisponible - EDITOR_MINIMO))
        : ANCHO_MAXIMO,
      altoMin: ALTO_MINIMO,
      altoMax: altoDisponible > 0 ? Math.max(ALTO_MINIMO, altoDisponible) : ALTO_MINIMO * 4,
    };
  }

  function limitesLado() {
    const marco = marcoLado();
    const cuerpo = marco && marco.parentElement ? marco.parentElement : null;
    const anchoDisponible = cuerpo ? cuerpo.clientWidth : 0;
    const altoDisponible = cuerpo ? cuerpo.clientHeight : 0;
    return {
      anchoMin: LADO_MINIMO,
      anchoMax: anchoDisponible > 0
        ? Math.max(LADO_MINIMO, Math.min(LADO_MAXIMO, anchoDisponible - VISTA_MINIMO))
        : LADO_MAXIMO,
      altoMin: LADO_ALTO_MINIMO,
      altoMax: altoDisponible > 0 ? Math.max(LADO_ALTO_MINIMO, altoDisponible) : LADO_ALTO_MINIMO * 4,
    };
  }

  // El alto que se ve: el elegido o, sin alto propio, el de la fila (que es lo que mide el marco).
  function altoEfectivo(marco, deLaCaja) {
    if (Number.isFinite(deLaCaja.alto)) return Math.round(deLaCaja.alto);
    return marco && marco.clientHeight > 0 ? Math.round(marco.clientHeight) : ALTO_MINIMO;
  }

  // La caja que se le da al tirador al empezar: con el alto materializado, para que una arista
  // superior o inferior sepa desde dónde arrastra aunque el panel ocupe toda la fila.
  function cajaDelArrastre(marco, deLaCaja) {
    return {
      ancho: deLaCaja.ancho,
      alto: altoEfectivo(marco, deLaCaja),
      arriba: Number.isFinite(deLaCaja.alto) ? deLaCaja.arriba : 0,
    };
  }

  function pintarMedidas(marco, efectiva, persistir, claves) {
    if (!marco) return;
    marco.style.setProperty("--previa-ancho", efectiva.ancho + "px");
    if (Number.isFinite(efectiva.alto)) {
      marco.dataset.alto = "propio";
      marco.style.setProperty("--previa-alto", efectiva.alto + "px");
      marco.style.setProperty("--previa-arriba", efectiva.arriba + "px");
    } else {
      delete marco.dataset.alto;
      marco.style.removeProperty("--previa-alto");
      marco.style.removeProperty("--previa-arriba");
    }
    if (persistir && claves) {
      guardarClave(claves.ancho, efectiva.ancho);
      if (Number.isFinite(efectiva.alto)) guardarClave(claves.alto, efectiva.alto);
      guardarClave(claves.arriba, efectiva.arriba);
    }
  }

  function aplicarPanel(persistir) {
    const marco = marcoPanel();
    if (!marco) return;
    const limites = limitesPanel();
    const conAlto = Number.isFinite(querida.alto);
    const ajustada = cajaRedimensionada({
      ancho: querida.ancho,
      alto: conAlto ? querida.alto : limites.altoMax,
      arriba: conAlto ? querida.arriba : 0,
    }, "sur", 0, 0, limites);
    caja.ancho = ajustada.ancho;
    caja.alto = conAlto ? ajustada.alto : null;
    caja.arriba = conAlto ? ajustada.arriba : 0;
    pintarMedidas(marco, caja, persistir, { ancho: CLAVE_ANCHO, alto: CLAVE_ALTO, arriba: CLAVE_ARRIBA });
    actualizarAria();
  }

  function aplicarLado(persistir) {
    const marco = marcoLado();
    if (!marco) return;
    const limites = limitesLado();
    const conAlto = Number.isFinite(queridaLado.alto);
    const ajustada = cajaRedimensionada({
      ancho: queridaLado.ancho,
      alto: conAlto ? queridaLado.alto : limites.altoMax,
      arriba: conAlto ? queridaLado.arriba : 0,
    }, "sur", 0, 0, limites);
    cajaLado.ancho = ajustada.ancho;
    cajaLado.alto = conAlto ? ajustada.alto : null;
    cajaLado.arriba = conAlto ? ajustada.arriba : 0;
    pintarMedidas(marco, cajaLado, persistir,
      { ancho: CLAVE_LADO, alto: CLAVE_LADO_ALTO, arriba: CLAVE_LADO_ARRIBA });
    actualizarAria();
  }

  function actualizarAria() {
    const panel = limitesPanel();
    const oeste = el("separador-previa");
    if (oeste) {
      oeste.setAttribute("aria-valuenow", String(caja.ancho));
      oeste.setAttribute("aria-valuemin", String(panel.anchoMin));
      oeste.setAttribute("aria-valuemax", String(panel.anchoMax));
      oeste.setAttribute("aria-valuetext", caja.ancho + " píxeles de ancho");
    }
    const sur = el("tirador-previa-sur");
    if (sur) {
      const alto = altoEfectivo(marcoPanel(), caja);
      sur.setAttribute("aria-valuenow", String(alto));
      sur.setAttribute("aria-valuemin", String(panel.altoMin));
      sur.setAttribute("aria-valuemax", String(panel.altoMax));
      sur.setAttribute("aria-valuetext", alto + " píxeles de alto");
    }
    const lado = limitesLado();
    const oesteLado = el("vista-tirador-oeste");
    if (oesteLado) {
      oesteLado.setAttribute("aria-valuenow", String(cajaLado.ancho));
      oesteLado.setAttribute("aria-valuemin", String(lado.anchoMin));
      oesteLado.setAttribute("aria-valuemax", String(lado.anchoMax));
      oesteLado.setAttribute("aria-valuetext", cajaLado.ancho + " píxeles de ancho");
    }
    const surLado = el("vista-tirador-sur");
    if (surLado) {
      const alto = altoEfectivo(marcoLado(), cajaLado);
      surLado.setAttribute("aria-valuenow", String(alto));
      surLado.setAttribute("aria-valuemin", String(lado.altoMin));
      surLado.setAttribute("aria-valuemax", String(lado.altoMax));
      surLado.setAttribute("aria-valuetext", alto + " píxeles de alto");
    }
  }

  function soltar() {
    if (!arrastre) return;
    const { tirador } = arrastre;
    arrastre = null;
    if (tirador) tirador.classList.remove("arrastrando");
    document.body.classList.remove("separando-previa");
    delete document.body.dataset.eje;
    // el guardado se hace una vez al soltar, no en cada movimiento del puntero
    aplicarPanel(true);
    aplicarLado(true);
    programarPintado();
  }

  // Las esquinas se llaman «noroeste», «noreste», «suroeste» y «sureste»: ni «norte» ni «sur»
  // aparecen como subcadena en las dos primeras, así que las direcciones se comparan exactas.
  function tocaElAlto(eje) {
    return eje === "norte" || eje === "sur" ||
      eje === "noroeste" || eje === "noreste" || eje === "suroeste" || eje === "sureste";
  }

  function esHorizontal(eje) {
    return eje === "oeste" || eje === "este" ||
      eje === "noroeste" || eje === "noreste" || eje === "suroeste" || eje === "sureste";
  }

  function aplicarArrastre(dx, dy) {
    if (!arrastre) return;
    const { eje, base, limites, fijar } = arrastre;
    const nueva = cajaRedimensionada(base, eje, dx, dy, limites());
    fijar(nueva, tocaElAlto(eje));
  }

  // `altura` distingue un arrastre horizontal (que no debe fijar el alto) de uno vertical o de una
  // esquina; sin él, mover la arista izquierda convertiría el panel en una tarjeta de alto fijo.
  function fijarPanel(nueva, altura) {
    querida.ancho = nueva.ancho;
    if (altura) {
      querida.alto = Number.isFinite(nueva.alto) ? nueva.alto : null;
      querida.arriba = nueva.arriba;
    }
    aplicarPanel(false);
  }

  function fijarLado(nueva, altura) {
    queridaLado.ancho = nueva.ancho;
    if (altura) {
      queridaLado.alto = Number.isFinite(nueva.alto) ? nueva.alto : null;
      queridaLado.arriba = nueva.arriba;
    }
    aplicarLado(false);
  }

  // Teclado de un tirador enfocable. Las flechas del eje mueven `PASO` px (`Shift`, `PASO_GRANDE`),
  // `Home` y `End` van al mínimo y al máximo, y en la arista izquierda `Alt+↑/↓` cambia el alto.
  function conectarTeclado(tirador, config) {
    tirador.addEventListener("keydown", (e) => {
      const { eje, limites, fijar, esAncho } = config;
      const paso = e.shiftKey ? PASO_GRANDE : PASO;
      let dx = 0;
      let dy = 0;
      let destino = null;
      const base = config.base();
      if (esAncho) {
        if (e.key === "ArrowLeft") dx = -paso;
        else if (e.key === "ArrowRight") dx = paso;
        else if (e.key === "Home") destino = { ...base, ancho: limites().anchoMin };
        else if (e.key === "End") destino = { ...base, ancho: limites().anchoMax };
        else if (e.altKey && e.key === "ArrowUp") dy = -paso;
        else if (e.altKey && e.key === "ArrowDown") dy = paso;
        else return;
      } else {
        if (e.key === "ArrowUp") dy = -paso;
        else if (e.key === "ArrowDown") dy = paso;
        else if (e.key === "Home") destino = { ...base, alto: limites().altoMin, arriba: base.arriba + base.alto - limites().altoMin };
        else if (e.key === "End") destino = { ...base, alto: limites().altoMax, arriba: 0 };
        else return;
      }
      e.preventDefault();
      const tocaAlto = dy !== 0 || !esAncho;
      // el alto y el ancho se aplican por separado: componer el nombre del eje daría cadenas que
      // el reparto no reconoce
      let nueva = base;
      if (dy !== 0) nueva = cajaRedimensionada(nueva, dy < 0 ? "norte" : "sur", 0, dy, limites());
      if (destino) nueva = { ...nueva, ...destino };
      else if (dx !== 0) nueva = cajaRedimensionada(nueva, eje, dx, 0, limites());
      fijar(nueva, tocaAlto);
      // con el teclado no hay «soltar»: la preferencia se guarda en cada paso
      config.aplicar(true);
      programarPintado();
    });
  }

  function montarMarco(marco, config) {
    if (!marco) return;
    for (const tirador of marco.querySelectorAll(".tirador-previa")) {
      const eje = tirador.dataset.eje || "";
      const esAncho = esHorizontal(eje);
      tirador.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (estrecho()) return;
        arrastre = {
          tirador,
          eje,
          x: e.clientX,
          y: e.clientY,
          base: cajaDelArrastre(marco, config.caja()),
          limites: config.limites,
          fijar: config.fijar,
        };
        try { tirador.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
        tirador.classList.add("arrastrando");
        document.body.classList.add("separando-previa");
        document.body.dataset.eje = eje;
        e.preventDefault();
      });
      // doble clic: vuelve al tamaño de siempre, sin tocar el modelo ni perder el modo
      tirador.addEventListener("dblclick", () => {
        config.reiniciar();
        config.aplicar(true);
        programarPintado();
      });
      if (tirador.tabIndex >= 0) {
        conectarTeclado(tirador, {
          eje,
          esAncho,
          limites: config.limites,
          fijar: config.fijar,
          aplicar: config.aplicar,
          base: () => cajaDelArrastre(marco, config.caja()),
        });
      }
    }
  }

  // --- visibilidad -------------------------------------------------------------------------
  function aplicarVisible(valor, persistir) {
    visible = !!valor;
    const marco = marcoPanel();
    const panel = el("previa-lateral");
    const separador = el("separador-previa");
    const boton = el("previa-alternar");
    if (marco) marco.hidden = !visible;
    if (panel) panel.hidden = !visible;
    if (separador) separador.hidden = !visible;
    if (boton) {
      boton.setAttribute("aria-expanded", String(visible));
      boton.classList.toggle("activo", visible);
    }
    if (persistir) guardarClave(CLAVE_VISIBLE, visible ? "1" : "0");
    if (!visible && !vistaActiva()) return;
    if (modo === "render") pintarRender();
    else { pintarVivo(); programarVivo(0); }
  }

  // --- Vista previa / Emulador --------------------------------------------------------------
  function aplicarModo(valor, persistir) {
    // una preferencia vieja (`xml`) era el nombre anterior del mismo panel dibujado
    modo = valor === "render" ? "render" : "vivo";
    const grupos = [
      { botones: ["previa-modo-vivo", "previa-modo-render"], secciones: ["previa-vivo", "previa-render"] },
      { botones: ["vista-modo-previa", "vista-modo-emulador"], secciones: ["vista-layout", "vista-emulador"] },
    ];
    for (const grupo of grupos) {
      for (const [id, activo] of [[grupo.botones[0], modo === "vivo"], [grupo.botones[1], modo === "render"]]) {
        const boton = el(id);
        if (!boton) continue;
        boton.classList.toggle("activo", activo);
        boton.setAttribute("aria-selected", String(activo));
        boton.tabIndex = activo ? 0 : -1;
      }
      const seccionVivo = el(grupo.secciones[0]);
      const seccionRender = el(grupo.secciones[1]);
      if (seccionVivo) seccionVivo.hidden = modo !== "vivo";
      if (seccionRender) seccionRender.hidden = modo !== "render";
    }
    if (persistir) guardarClave(CLAVE_MODO, modo);
    if (!visible && !vistaActiva()) return;
    if (modo === "render") pintarRender();
    else { pintarVivo(); programarVivo(0); }
  }

  function conectarModos() {
    const grupos = [
      { botones: [["previa-modo-vivo", "vivo"], ["previa-modo-render", "render"]],
        destinos: { vivo: "previa-modo-vivo", render: "previa-modo-render" } },
      { botones: [["vista-modo-previa", "vivo"], ["vista-modo-emulador", "render"]],
        destinos: { vivo: "vista-modo-previa", render: "vista-modo-emulador" } },
    ];
    for (const grupo of grupos) {
      for (const [id, valor] of grupo.botones) {
        const boton = el(id);
        if (!boton) continue;
        boton.addEventListener("click", () => aplicarModo(valor, true));
        boton.addEventListener("keydown", (e) => moverFocoModo(e, grupo.destinos));
      }
    }
  }

  // role="tab" sin flechas deja el teclado a medias: las dos pestañas de cada grupo se recorren con
  // las flechas, Home y End, como en cualquier tablist.
  function moverFocoModo(e, destinos) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const destino = e.key === "ArrowLeft" || e.key === "Home" ? "vivo" : "render";
    aplicarModo(destino, true);
    const boton = el(destinos[destino]);
    if (boton) boton.focus();
  }

  // --- consola de la ejecución -------------------------------------------------------------
  function limpiarLog(texto) {
    for (const superficie of SUPERFICIES) {
      const lista = el(superficie.log.lista);
      const cabecera = el(superficie.log.cabecera);
      const vacio = el(superficie.log.vacio);
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
    const resumen = resumenEjecucion(modelo);
    for (const superficie of SUPERFICIES) {
      const lista = el(superficie.log.lista);
      const cabecera = el(superficie.log.cabecera);
      const vacio = el(superficie.log.vacio);
      if (!lista || !cabecera || !vacio) continue;
      lista.textContent = "";
      if (!resumen) {
        cabecera.textContent = "sin ejecución";
        cabecera.classList.remove("con-error");
        vacio.hidden = false;
        vacio.textContent = MENSAJE_SIN_EJECUCION;
        continue;
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

  function ponerEstadoVivo(texto, aviso) {
    for (const superficie of SUPERFICIES) {
      const estado = el(superficie.estadoVivo);
      if (!estado) continue;
      estado.textContent = texto;
      estado.classList.toggle("con-aviso", !!aviso);
    }
  }

  function pintarVivo() {
    if (!conDocumento()) return null;
    let primero = null;
    for (const superficie of SUPERFICIES) {
      const canvas = el(superficie.canvasVivo);
      if (!canvas) continue;
      if (!modeloVivo) {
        limpiarCanvas(canvas);
        const estado = el(superficie.estadoVivo);
        if (estado) {
          estado.textContent = MENSAJE_SIN_ABRIR;
          estado.classList.remove("con-aviso");
        }
        continue;
      }
      const pintado = pintarModelo(canvas, modeloVivo);
      const estado = el(superficie.estadoVivo);
      if (estado && pintado && pintado.valida === false) {
        estado.textContent = "El layout no cabe en la caja del panel; se dibuja a tamaño de respaldo.";
      }
      if (!primero) primero = pintado;
    }
    return primero;
  }

  function pintarRender(motivo) {
    if (!conDocumento()) return null;
    const modelo = modeloActual();
    let primero = null;
    for (const superficie of SUPERFICIES) {
      const canvas = el(superficie.canvasRender);
      if (!canvas) continue;
      const estado = superficie.estadoRender ? el(superficie.estadoRender) : null;
      if (!modelo) {
        // el motivo del último fallo viene del evento: «no hay apk», «el preview falló» o el de arranque
        limpiarCanvas(canvas);
        if (estado) estado.textContent = motivo || MENSAJE_SIN_MODELO;
        continue;
      }
      const pintado = pintarModelo(canvas, modelo);
      if (estado) {
        const layout = modelo.layout ? String(modelo.layout) : "el layout";
        estado.textContent = (modelo.aproximado === false ? "Emulador de " : "Emulador aproximado de ") +
          layout + " con los eventos de la app. Se actualiza al compilar.";
        if (pintado && pintado.valida === false) {
          estado.textContent = "El modelo de vista previa no trae una pantalla medible (ancho o alto no " +
            "finitos); no se pinta nada.";
        }
      }
      if (!primero) primero = pintado;
    }
    const pintado = pintarModelo(canvas, modelo);
    // El clic mide en el espacio con el que se pintó, no en el clientWidth del momento: si el panel
    // cambió de tamaño entre pintar y pulsar, el punto se desalinearía con los píxeles visibles.
    if (pintado && pintado.ancho > 0 && pintado.alto > 0) {
      canvas.__espacio = { ancho: pintado.ancho, alto: pintado.alto };
    }
    const layout = modelo.layout ? String(modelo.layout) : "el layout";
    estado.textContent = "Emulador de " + layout +
      (modelo.aproximado === false ? ", sin aproximar." : " aproximado.") +
      " Arranca en onCreate: pulsa una vista para ejecutar su OnClickListener.";
    if (modelo) {
      pintarLog(modelo);
      pintarConsola(modelo);
      pintarOyentes(modelo);
    } else {
      limpiarLog(motivo || MENSAJE_SIN_MODELO);
      pintarConsola(modelo);
      pintarOyentes(modelo);
    }
    if (pintado && pintado.valida === false) {
      estado.textContent = "El modelo de vista previa no trae una pantalla medible; no se pinta nada.";
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
      if (!visible && !vistaActiva()) return;
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
    if (!conDocumento()) return;
    const marca = el("marca-sucio");
    const sucio = !!(marca && !marca.hidden && estadoPestana && estadoPestana.ruta === ruta);
    const partes = [relativa(ruta), modelo.nodos + (modelo.nodos === 1 ? " vista" : " vistas"),
      "en vivo (sin compilar)"];
    if (sucio) partes.push("sin guardar");
    if (modelo.sinStrings) partes.push(modelo.sinStrings + " @string sin resolver");
    if (nota) partes.push(nota);
    ponerEstadoVivo(partes.join(" · "), false);
  }

  async function refrescarVivo() {
    if (!conDocumento()) return;
    if (!visible && !vistaActiva()) return;
    const canvas = el("previa-vivo-canvas") || el("vista-layout-canvas");
    if (!canvas) return;
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
        for (const superficie of SUPERFICIES) limpiarCanvas(el(superficie.canvasVivo));
        ponerEstadoVivo(nodos.length || error
          ? MENSAJE_SIN_LAYOUT + (error ? " (" + error + ")" : "")
          : MENSAJE_SIN_ABRIR, false);
        return;
      }
    }
    if (turno !== turnoVivo) return;
    const stringsMap = await stringsDelProyecto();
    if (turno !== turnoVivo) return;
    const resultado = modeloDeLayout(texto, { layout: ruta, strings: stringsMap });
    if (!resultado.ok) {
      // un XML a medias no borra la pantalla que ya estaba bien: se avisa y se conserva
      ponerEstadoVivo("XML inválido" + (resultado.linea ? " (línea " + resultado.linea + ")" : "") +
        ": se conserva el último render" + (rutaViva ? " de " + relativa(rutaViva) : "") + ".", true);
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
    const codigo = el("codigo");
    if (codigo) {
      codigo.addEventListener("input", () => {
        if (!visible && !vistaActiva()) return;
        // si el layout mostrado es el documento que se escribe, basta el buffer; si no, no hay nada
        // que releer por teclear en otro fichero
        if (rutaViva && estadoPestana && estadoPestana.ruta === rutaViva) programarVivo(ESPERA_TECLEO);
        else if (!modeloVivo) programarVivo(ESPERA_TECLEO);
      });
    }
    const titulo = el("fichero-abierto");
    if (titulo && typeof MutationObserver === "function") {
      new MutationObserver(() => programarVivo(ESPERA_DOCUMENTO))
        .observe(titulo, { childList: true, characterData: true, subtree: true });
    }
    // crear, subir o borrar un layout no abre necesariamente un documento: el árbol repintado es la
    // señal de que la lista de ficheros cambió, y el layout mostrado puede ser otro (o ninguno)
    const arbolEl = el("arbol-pestana");
    if (arbolEl && typeof MutationObserver === "function") {
      new MutationObserver(() => programarVivo(ESPERA_ARBOL))
        .observe(arbolEl, { childList: true, subtree: true });
    }
    document.addEventListener(EVENTO_PREVIA, (e) => {
      if (!visible && !vistaActiva()) return;
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
    const marco = marcoPanel();
    const separador = el("separador-previa");
    if (!marco || !separador) return false;
    iniciado = true;
    querida.ancho = anchoValido(leerClave(CLAVE_ANCHO, ANCHO_POR_DEFECTO), ANCHO_MINIMO, ANCHO_MAXIMO);
    querida.alto = numeroOpcional(leerClave(CLAVE_ALTO, ""), ALTO_MINIMO, ALTO_MINIMO * 8);
    querida.arriba = numeroOpcional(leerClave(CLAVE_ARRIBA, "0"), 0, ALTO_MINIMO * 8) || 0;
    queridaLado.ancho = anchoValido(leerClave(CLAVE_LADO, LADO_POR_DEFECTO), LADO_MINIMO, LADO_MAXIMO);
    queridaLado.alto = numeroOpcional(leerClave(CLAVE_LADO_ALTO, ""), LADO_ALTO_MINIMO, LADO_ALTO_MINIMO * 8);
    queridaLado.arriba = numeroOpcional(leerClave(CLAVE_LADO_ARRIBA, "0"), 0, LADO_ALTO_MINIMO * 8) || 0;
    visible = leerClave(CLAVE_VISIBLE, "1") !== "0";
    modo = leerClave(CLAVE_MODO, "vivo") === "render" ? "render" : "vivo";

    montarMarco(marco, {
      caja: () => caja,
      limites: limitesPanel,
      fijar: fijarPanel,
      aplicar: aplicarPanel,
      reiniciar: () => {
        querida.ancho = ANCHO_POR_DEFECTO;
        querida.alto = null;
        querida.arriba = 0;
      },
    });
    montarMarco(marcoLado(), {
      caja: () => cajaLado,
      limites: limitesLado,
      fijar: fijarLado,
      aplicar: aplicarLado,
      reiniciar: () => {
        queridaLado.ancho = LADO_POR_DEFECTO;
        queridaLado.alto = null;
        queridaLado.arriba = 0;
      },
    });

    // el movimiento se sigue en el documento: el puntero puede salirse del tirador sin soltar
    document.addEventListener("pointermove", (e) => {
      if (!arrastre) return;
      aplicarArrastre(e.clientX - arrastre.x, e.clientY - arrastre.y);
      e.preventDefault();
    });
    document.addEventListener("pointerup", soltar);
    document.addEventListener("pointercancel", soltar);

    conectarModos();
    conectarEntrada();
    conectarCanvas();
    const alternar = el("previa-alternar");
    if (alternar) alternar.addEventListener("click", () => aplicarVisible(!visible, true));
    const cerrar = el("previa-cerrar");
    if (cerrar) cerrar.addEventListener("click", () => aplicarVisible(false, true));

    if (typeof ResizeObserver === "function") {
      const observador = new ResizeObserver(() => {
        // al entrar en la vista Editor la fila pasa de 0 al ancho real, y al cambiar la ventana el
        // alto disponible también cambia: se recorta la preferencia guardada, no la de un rato
        aplicarPanel(false);
        aplicarLado(false);
        if (!visible && !vistaActiva()) return;
        programarPintado();
      });
      if (fila()) observador.observe(fila());
      if (marco) observador.observe(marco);
      if (marcoLado()) observador.observe(marcoLado());
    }

    aplicarPanel(false);
    aplicarLado(false);
    aplicarVisible(visible, false);
    aplicarModo(modo, false);
    pintarRender();
    pintarVivo();
    programarVivo(0);
    return true;
  }

  // Repinta lo que toque sin ejecutar nada: lo llama vistas.js al entrar en la vista Pantalla,
  // donde los canvas estaban ocultos y su caja medía cero.
  function repintar() {
    aplicarPanel(false);
    aplicarLado(false);
    if (modo === "render") pintarRender();
    else { pintarVivo(); programarVivo(0); }
  }

  return {
    iniciar,
    aplicarModo,
    aplicarVisible,
    refrescarVivo,
    pintarVivo,
    pintarRender,
    repintar,
    // un clic desde fuera (la prueba de chromium): la misma orden que el puntero del canvas
    pulsar,
    // lectura para las pruebas: el modelo dibujado en el modo Vista previa (no el código)
    modeloVivo: () => modeloVivo,
    estado: () => ({
      ancho: caja.ancho, alto: caja.alto, arriba: caja.arriba,
      lado: cajaLado.ancho, ladoAlto: cajaLado.alto,
      visible, modo, ruta: rutaViva, pulsos: [...pulsos],
    }),
  };
}
