// Geometría y ciclo de vida de los módulos flotantes. Módulo puro: no toca el DOM, no lee
// almacenamiento y no importa de `previa-panel.js`, así que no hay ciclo ESM y se prueba en node.
// Las cuatro funciones de geometría se movieron aquí desde `previa-panel.js` (§340); ese fichero
// las importa para seguir usándolas y `prueba.js` las prueba directamente desde este módulo.

// Anchos y altos compartidos por las dos superficies de la vista previa y por los módulos.
export const ANCHO_POR_DEFECTO = 340;
export const ANCHO_MINIMO = 240;
export const ANCHO_MAXIMO = 900;
export const ALTO_MINIMO = 320;
export const LADO_POR_DEFECTO = 380;
export const LADO_MINIMO = 220;
export const LADO_ALTO_MINIMO = 240;
export const BORDES = ["izquierda", "derecha", "arriba", "abajo"];
export const BORDE_POR_DEFECTO = "derecha";
// La consola del teléfono nace pequeña: el respaldo es 340 × 240, nunca el viejo `min(560, …)`.
export const TAMANO_POR_DEFECTO = { ancho: ANCHO_POR_DEFECTO, alto: LADO_ALTO_MINIMO };

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

// Un número opcional: `null` cuando la preferencia no existe o no es un número, y si la hay, dentro
// de su rango. Es lo que distingue «sin alto propio» (la fila entera) de «640 px elegidos».
export function numeroOpcional(valor, minimo, maximo) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n)) return null;
  return medidaValida(n, minimo, maximo, minimo);
}

// Geometría de una caja acoplada, pura y probada en node: el ancho y el alto son los que eligió el
// usuario (o los de siempre), recortados a la ventana, y solo el borde elegido se pega al margen.
export function cajaAcoplada(borde, ancho, alto, medidas, margen = 8) {
  const anchoVentana = Number.isFinite(medidas && medidas.ancho) ? medidas.ancho : 1024;
  const altoVentana = Number.isFinite(medidas && medidas.alto) ? medidas.alto : 768;
  const anchoUtil = Math.max(LADO_MINIMO, anchoVentana - margen * 2);
  const altoUtil = Math.max(LADO_ALTO_MINIMO, altoVentana - margen * 2);
  const caja = {
    ancho: Math.round(medidaValida(ancho, LADO_MINIMO, anchoUtil, LADO_POR_DEFECTO)),
    alto: Math.round(medidaValida(alto, LADO_ALTO_MINIMO, altoUtil, altoUtil)),
    arriba: "auto", abajo: "auto", izquierda: "auto", derecha: "auto",
  };
  if (borde === "arriba") caja.arriba = margen;
  else if (borde === "abajo") caja.abajo = margen;
  else if (borde === "izquierda") caja.izquierda = margen;
  else caja.derecha = margen;
  return caja;
}

// El reparto de una caja al arrastrar un tirador. `eje` es «oeste», «este», «norte», «sur» o una
// esquina que combine dos («noroeste»…): la arista que se mueve sigue al puntero y la de enfrente
// se queda quieta. El alto nunca deja hueco fuera del marco (`arriba >= 0`, `arriba + alto <=
// altoMax`) y el ancho no cruza sus límites. Pura: la usan los dos marcos y se prueba en node.
// `izquierda` se devuelve junto a `ancho`, `alto` y `arriba` para que el tirador oeste pueda dejar
// fija la arista derecha: antes solo había `arriba` y el borde izquierdo se reconstruía a cero.
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
    izquierda: Number.isFinite(base.izquierda) ? Math.round(base.izquierda) : 0,
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
  // la arista derecha de la caja de partida es la que se mantiene quieta al tirar del oeste
  const derechaFija = actual.izquierda + actual.ancho;
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
  const anchoFinal = Math.round(Math.min(anchoMax, Math.max(anchoMin, ancho)));
  // Recalcular `izquierda` desde la arista fija evita que el recorte a `anchoMin`/`anchoMax`
  // desplace el borde de enfrente: el ancho pedido y el aplicado pueden diferir.
  const izquierda = alOeste ? derechaFija - anchoFinal : actual.izquierda;
  return {
    ancho: anchoFinal,
    alto: Math.round(Math.min(altoMax - arriba, Math.max(altoMin, alto))),
    arriba: Math.round(arriba),
    izquierda: Math.round(izquierda),
  };
}

// El teléfono del emulador no se queda sin ancho cuando el panel crece.
const VISTA_MINIMO = 280;

// Registro de los cinco módulos del editor. Cada entrada describe el contenido existente (que se
// envuelve, no se clona ni se renombra) y su geometría preferida. No hay dependencias de DOM aquí:
// `raiz` es un selector guardado como dato, no un `querySelector` ejecutado al importar.
export const MODULOS = {
  explorador: {
    id: "explorador", titulo: "Archivos", raiz: ".lateral",
    anchoPref: 260, altoPref: 240, min: { ancho: 180, alto: 160 },
    claves: {}, esperarCaja: false,
  },
  editor: {
    id: "editor", titulo: "Editor", raiz: ".editor",
    anchoPref: 640, altoPref: 420, min: { ancho: 280, alto: 280 },
    claves: {}, esperarCaja: false,
  },
  previa: {
    id: "previa", titulo: "Teléfono", raiz: "#marco-previa",
    anchoPref: LADO_POR_DEFECTO, altoPref: 640, min: { ancho: VISTA_MINIMO, alto: 240 },
    claves: {}, esperarCaja: false,
  },
  "consola-telefono": {
    id: "consola-telefono", titulo: "Registro y consola del teléfono", raiz: "#previa-inspector",
    anchoPref: ANCHO_POR_DEFECTO, altoPref: LADO_ALTO_MINIMO,
    min: { ancho: LADO_MINIMO, alto: LADO_ALTO_MINIMO },
    claves: {}, esperarCaja: true,
  },
  compilacion: {
    id: "compilacion", titulo: "Consola de compilación", raiz: "#panel-inferior",
    anchoPref: 640, altoPref: LADO_ALTO_MINIMO * 2, min: { ancho: 280, alto: LADO_ALTO_MINIMO },
    claves: {}, esperarCaja: false,
  },
};

// Una instancia de un módulo del registro. `nombre` distingue las dos superficies del mismo tipo
// (panel del editor y vista Pantalla) y `extra` aporta lo que depende del DOM: contenedor, ids y
// claves de persistencia. El estado se puede pasar desde fuera para conservar el objeto existente.
export function instanciaModulo(tipo, nombre, extra = {}) {
  const def = MODULOS[tipo];
  if (!def) throw new Error("módulo desconocido: " + tipo);
  return {
    ...def,
    tipo,
    nombre,
    estado: extra.estado || estadoInicial(def.id + (nombre ? "/" + nombre : ""), def.z || 40),
    ...extra,
  };
}

// Estado inicial de un módulo. La geometría preferida es pequeña y el modo es flotante.
export function estadoInicial(id = "", z = 1) {
  return {
    id,
    modo: "libre",
    borde: BORDE_POR_DEFECTO,
    x: 0, y: 0,
    ancho: TAMANO_POR_DEFECTO.ancho,
    alto: TAMANO_POR_DEFECTO.alto,
    z: Number.isFinite(z) ? Math.round(z) : 1,
    visible: true,
  };
}

// Reducer puro del ciclo de vida de un módulo: mover, redimensionar, acoplar, desacoplar,
// minimizar, restaurar, cerrar, traer al frente y reiniciar. Nunca muta el estado de entrada.
// `redimensionar` recibe la caja completa y delega en `cajaRedimensionada`, así que la arista de
// enfrente sigue quieta; se prohíbe reconstruir `arriba` o `izquierda` a cero (§341).
export function reducirPanel(estado, accion) {
  const e = estado && typeof estado === "object" ? estado : estadoInicial();
  const a = accion && typeof accion === "object" ? accion : { tipo: "reiniciar" };
  switch (a.tipo) {
    case "mover":
      return {
        ...e,
        x: e.x + (Number.isFinite(a.dx) ? a.dx : 0),
        y: e.y + (Number.isFinite(a.dy) ? a.dy : 0),
      };
    case "redimensionar": {
      const caja = cajaRedimensionada(
        { ancho: e.ancho, alto: e.alto, arriba: e.y, izquierda: e.x },
        a.eje, Number.isFinite(a.dx) ? a.dx : 0, Number.isFinite(a.dy) ? a.dy : 0, a.limites);
      return { ...e, x: caja.izquierda, y: caja.arriba, ancho: caja.ancho, alto: caja.alto };
    }
    case "acoplar":
      return {
        ...e,
        modo: "acoplado",
        borde: BORDES.includes(a.borde) ? a.borde : BORDE_POR_DEFECTO,
      };
    case "desacoplar":
      return { ...e, modo: "libre" };
    case "minimizar":
      return {
        ...e,
        modoAnterior: e.modo === "minimizado" ? e.modoAnterior : e.modo,
        modo: "minimizado",
      };
    case "restaurar":
      return {
        ...e,
        modo: e.modoAnterior && e.modoAnterior !== "minimizado" ? e.modoAnterior : "libre",
        modoAnterior: undefined,
      };
    case "cerrar":
      return { ...e, modo: "cerrado", visible: false };
    case "traerAlFrente":
      return { ...e, z: Number.isFinite(a.z) ? a.z : (Number.isFinite(e.z) ? e.z + 1 : 1) };
    case "reiniciar":
      return estadoInicial(e.id, e.z);
    default:
      return e;
  }
}
