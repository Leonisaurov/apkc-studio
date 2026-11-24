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
// Sobre la lectura «Vista previa» hay un modo **editar** (lápiz): añade nodos, los reordena en un
// LinearLayout o les fija márgenes en un marco, los borra y edita sus propiedades, escribiendo el
// XML del editor con `layout-editor.js` (puro). La paleta, la ficha de propiedades y el visor de
// jerarquía son capas flotantes sobre el dibujo: no comprimen el canvas. Un tipo se puede arrastrar
// desde la paleta al punto donde se suelta (con indicador de destino) y un ImageView puede recibir
// un PNG del disco. El modo editar tiene su propio historial (Ctrl+Z/Ctrl+Mayús+Z) y el panel sigue
// sin tocar el documento: se lo pide a `EDITOR.cambiar`.
//
// Funciones puras, probadas en node (`prueba.js`): `medidaValida`, `anchoValido`,
// `cajaRedimensionada`, `esRutaDeLayout`, `candidatosDeLayout`, `resumenEjecucion`,
// `oyentesDeModelo` y `nodoEnPunto`. El modelo en vivo se prueba en `vista-xml.js`. La carpeta de
// OPFS y el documento activo llegan por el objeto de dependencias: no importa `pestana.js`.
import {
  pintarModelo, modeloActual, EVENTO_PREVIA, modeloDeSalida, pintarVistaPrevia, nodosAplanados,
  textoDeNodo, rectsEscalados, escalaPara, MENSAJE_SIN_MODELO, textoDelModelo,
} from "./vista-previa.js";
import { modeloDeLayout, decodificarEntidades, paddingDe, contenedorDe, atributoLocal } from "./vista-xml.js";
import {
  insertarElemento, moverEnMarco, reordenarHijo, borrarElemento,
  leerPropiedades, escribirPropiedad, tiposRaizDisponibles, cambiarTipoRaiz,
  iconosSistema, tamanoDeTipo,
} from "./layout-editor.js";
import { RUTA_ULTIMA_APK, leerUltimaApk, fechaDeMeta, EVENTO_ULTIMA_APK } from "./ultima-apk.js";

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
// el emulador guarda su energía, el tamaño de pantalla y si el inspector está abierto. Son
// preferencias de la ventana: apagar o cambiar de tamaño no toca la última apk ni el proyecto.
const CLAVE_ENERGIA = "apkc-studio/previa-energia";
const CLAVE_PANTALLA = "apkc-studio/previa-pantalla";
const CLAVE_INSPECTOR_PANEL = "apkc-studio/previa-inspector";
const CLAVE_INSPECTOR_VISTA = "apkc-studio/vista-inspector";
// la consola de la vista Pantalla es una capa desprendida: su modo, su borde y su posición son
// preferencias de la ventana, como el tamaño (que ya guardan CLAVE_LADO y CLAVE_LADO_ALTO)
const CLAVE_LADO_MODO = "apkc-studio/previa-lado-modo";
const CLAVE_LADO_BORDE = "apkc-studio/previa-lado-borde";
const CLAVE_LADO_X = "apkc-studio/previa-lado-x";
const CLAVE_LADO_Y = "apkc-studio/previa-lado-y";
// el registro y la consola del panel del editor son la otra capa desprendida: mismo modo, borde y
// posición, más su propio tamaño libre (el de Pantalla ya vive en CLAVE_LADO/CLAVE_LADO_ALTO)
const CLAVE_PANEL_MODO = "apkc-studio/previa-inspector-modo";
const CLAVE_PANEL_BORDE = "apkc-studio/previa-inspector-borde";
const CLAVE_PANEL_X = "apkc-studio/previa-inspector-x";
const CLAVE_PANEL_Y = "apkc-studio/previa-inspector-y";
const CLAVE_PANEL_ANCHO = "apkc-studio/previa-inspector-ancho";
const CLAVE_PANEL_ALTO = "apkc-studio/previa-inspector-alto";
const MODO_LIBRE = "libre";
const MODO_ACOPLADO = "acoplado";
const MODO_MINIMIZADO = "minimizado";
const BORDE_POR_DEFECTO = "derecha";
// la consola se puede acoplar a los cuatro bordes de la ventana; el borde elegido se guarda con el
// modo, así que una recarga devuelve la capa al mismo sitio y con el mismo tamaño
const BORDES = ["izquierda", "derecha", "arriba", "abajo"];
export function bordeValido(pedido) {
  return BORDES.includes(pedido) ? pedido : BORDE_POR_DEFECTO;
}
// Geometría de una capa acoplada, pura y probada en node: el ancho y el alto son los que eligió el
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
// el tecleo se reúne en una sola pasada del intérprete: escribir cada letra repetiría el guion
// completo en wasm, y lo que importa es el texto final que ve la app
const ESPERA_ESCRITURA = 220;
// los tipos que aceptan teclado del usuario, los mismos que `admiteTecleo` de apkc preview. Un toque
// sobre uno de ellos se consume en el campo, no se entrega al OnClickListener del contenedor.
const TIPOS_CON_TECLADO = new Set([
  "EditText", "AutoCompleteTextView", "MultiAutoCompleteTextView", "TextInputEditText",
]);

const MENSAJE_SIN_EJECUCION = "El modelo no trae ejecución: el apk se leyó con --sin-ejecutar o no " +
  "tiene classes.dex. Sin capturas ni avisos.";
const MENSAJE_SIN_LAYOUT = "El proyecto no tiene ningún res/layout/*.xml. Crea un layout en el " +
  "explorador o abre uno para verlo aquí.";
const MENSAJE_SIN_ABRIR = "Abre un res/layout/*.xml en el editor para ver aquí el layout dibujado, " +
  "sin compilar.";
const MENSAJE_SIN_PULSOS = "Compila el proyecto (Editor → Compilar → Compilar debug) para ver las " +
  "vistas que responden a un clic.";
const MENSAJE_APAGADO = "Emulador apagado. Enciéndelo para volver a ejecutar la última APK " +
  "guardada, sin compilar.";
const MENSAJE_SIN_ULTIMA = "No hay ninguna última APK guardada todavía: compila una vez y el build " +
  "dejará una copia estable para el emulador.";
const PANTALLAS = {
  "360x640": { ancho: 360, alto: 640 },
  "411x823": { ancho: 411, alto: 823 },
};
const PANTALLA_POR_DEFECTO = { ancho: 360, alto: 640 };

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
  // Sin recortes: el emulador conserva toda la ejecución, como un dispositivo. Lo que se muestra
  // es lo que ocurrió, desde el primer clic hasta el último.
  const capturas = (Array.isArray(ejecucion.capturas) ? ejecucion.capturas : [])
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ origen: comoTexto(c.origen), id: comoTexto(c.id), texto: comoTexto(c.texto) }))
    .filter((c) => c.origen || c.texto !== "");
  const avisos = (Array.isArray(ejecucion.avisos) ? ejecucion.avisos : [])
    .map(comoTexto)
    .filter((a) => a.trim() !== "");
  // la consola de la app es un canal aparte del registro: cada línea lleva su origen y el orden en
  // que se emitió, porque el reloj no existe en el intérprete y no se finge
  const consola = (Array.isArray(ejecucion.consola) ? ejecucion.consola : [])
    .filter((l) => l && typeof l === "object")
    .map((l) => ({ origen: comoTexto(l.origen), texto: comoTexto(l.texto), secuencia: comoCuenta(l.secuencia) }))
    .filter((l) => l.origen || l.texto !== "");
  const pulsaciones = (Array.isArray(ejecucion.pulsaciones) ? ejecucion.pulsaciones : [])
    .map(comoTexto)
    .filter((p) => p.trim() !== "");
  const oyentes = (Array.isArray(ejecucion.oyentes) ? ejecucion.oyentes : [])
    .filter((o) => o && typeof o === "object")
    .map((o) => ({ id: comoTexto(o.id), idRef: comoTexto(o.idRef) }))
    .filter((o) => o.id || o.idRef);
  // los hot swaps del guion: qué método se reemplazó o se añadió. `existia` es del JSON y se
  // normaliza a booleano para que el registro no tenga que adivinar; un objeto sin clase ni método
  // no es un intercambio y no se pinta.
  const intercambios = (Array.isArray(ejecucion.intercambios) ? ejecucion.intercambios : [])
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      clase: comoTexto(c.clase), metodo: comoTexto(c.metodo), proto: comoTexto(c.proto),
      existia: c.existia === true,
    }))
    .filter((c) => c.clase || c.metodo);
  // el Toast es efímero: el intérprete publica el último en `toast` y deja todas sus líneas en
  // `consola`. El panel lo enseña sobre el teléfono unos segundos; la consola conserva el historial.
  const toast = comoTexto(ejecucion.toast);
  // el menú de opciones es un dato aparte del árbol: el intérprete publica lo que la app añadió con
  // `menu.add`, con su id `menu/N` y su título. `abierto` dice si el último `--menu` lo dejó
  // desplegado y `seleccionado`, qué ítem se pulsó. Sin `ejecucion.menu` no hay nada que enseñar.
  const menu = (() => {
    const crudo = ejecucion.menu;
    if (!crudo || typeof crudo !== "object") return null;
    const items = (Array.isArray(crudo.items) ? crudo.items : [])
      .filter((i) => i && typeof i === "object")
      .map((i) => ({
        id: comoTexto(i.id),
        titulo: comoTexto(i.titulo),
        itemId: Number.isFinite(Number(i.itemId)) ? Number(i.itemId) : 0,
      }))
      .filter((i) => i.id);
    return { abierto: crudo.abierto === true, items, seleccionado: comoTexto(crudo.seleccionado) };
  })();
  return {
    actividad: comoTexto(ejecucion.actividad),
    metodo: comoTexto(ejecucion.metodo),
    pasos: comoCuenta(ejecucion.pasos),
    interacciones: comoCuenta(ejecucion.interacciones),
    capturas,
    consola,
    pulsaciones,
    oyentes,
    intercambios,
    menu,
    toast,
    avisos,
    error: comoTexto(ejecucion.error),
  };
}

// Los ítems del menú de opciones que publicó el intérprete, ya acotados y con tipos seguros.
// Devuelve null cuando el modelo no trae menú (no se abrió o la app no tiene
// `onCreateOptionsMenu`), que es distinto de un menú vacío.
export function menuDeModelo(modelo) {
  const resumen = resumenEjecucion(modelo);
  return resumen ? resumen.menu : null;
}

// La línea de comandos de `apkc preview` para el guion de la pestaña. Cada paso conserva su orden:
// un clic es `--pulsar`, desplegar el menú es `--menu` y elegir un ítem, `--menu-item menu/N`, y un
// hot swap es `--intercambiar clase/metodo(proto)=fichero.dex`. Se repite el guion entero en cada
// invocación porque el comando no guarda la máquina; el dex vive en OPFS y se relee en cada pasada.
export function argvDePrevia(guion, apk) {
  const argv = ["preview"];
  for (const paso of Array.isArray(guion) ? guion : []) {
    const tipo = paso && paso.tipo;
    if (tipo === "menu") argv.push("--menu");
    else if (tipo === "menu-item") argv.push("--menu-item", String(paso.valor));
    else if (tipo === "escribir") {
      // `--escribir id/texto` entrega el texto como si el usuario lo tecleara; el idRef numérico no
      // lleva barras, así que la primera separa el id del texto (que sí puede llevarlas y tildes)
      const texto = paso.valor == null ? "" : String(paso.valor);
      argv.push("--escribir", String(paso.idRef) + "/" + texto);
    }
    else if (tipo === "intercambiar") {
      argv.push("--intercambiar", String(paso.firma) + "=" + String(paso.ruta));
    } else argv.push("--pulsar", String(paso && paso.valor));
  }
  argv.push(String(apk));
  return argv;
}

// El modelo de `apkc preview` trae su pantalla declarada (360×640 dp si no dice otra). El
// selector de tamaño no vuelve a ejecutar la app: reescala el MISMO modelo al tamaño pedido para
// que el lienzo y el marco de la pantalla coincidan. Es una transformación de vista, no una
// medida nueva del layout; por eso conserva el modelo original sin tocarlo.
export function modeloConPantalla(modelo, ancho, alto) {
  if (!modelo || typeof modelo !== "object") return modelo;
  const destinoAncho = Number.isFinite(Number(ancho)) && Number(ancho) > 0
    ? Math.round(Number(ancho)) : PANTALLA_POR_DEFECTO.ancho;
  const destinoAlto = Number.isFinite(Number(alto)) && Number(alto) > 0
    ? Math.round(Number(alto)) : PANTALLA_POR_DEFECTO.alto;
  const pantalla = modelo.pantalla && typeof modelo.pantalla === "object" ? modelo.pantalla : {};
  const baseAncho = Number.isFinite(Number(pantalla.ancho)) && Number(pantalla.ancho) > 0
    ? Number(pantalla.ancho) : destinoAncho;
  const baseAlto = Number.isFinite(Number(pantalla.alto)) && Number(pantalla.alto) > 0
    ? Number(pantalla.alto) : destinoAlto;
  if (baseAncho === destinoAncho && baseAlto === destinoAlto) return modelo;
  const sx = destinoAncho / baseAncho;
  const sy = destinoAlto / baseAlto;
  const escalarRect = (rect) => {
    if (!rect || typeof rect !== "object") return rect;
    const copia = { ...rect };
    for (const clave of ["x", "ancho"]) {
      if (Number.isFinite(Number(rect[clave]))) copia[clave] = Number(rect[clave]) * sx;
    }
    for (const clave of ["y", "alto"]) {
      if (Number.isFinite(Number(rect[clave]))) copia[clave] = Number(rect[clave]) * sy;
    }
    return copia;
  };
  const copiarNodo = (nodo) => {
    if (!nodo || typeof nodo !== "object") return nodo;
    const copia = { ...nodo };
    if (nodo.rect) copia.rect = escalarRect(nodo.rect);
    if (Array.isArray(nodo.hijos)) copia.hijos = nodo.hijos.map(copiarNodo);
    return copia;
  };
  return {
    ...modelo,
    pantalla: {
      x: (Number.isFinite(Number(pantalla.x)) ? Number(pantalla.x) : 0) * sx,
      y: (Number.isFinite(Number(pantalla.y)) ? Number(pantalla.y) : 0) * sy,
      ancho: destinoAncho,
      alto: destinoAlto,
    },
    raiz: copiarNodo(modelo.raiz),
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

// ¿Esta vista admite texto del usuario? Es la misma lista que el intérprete rechaza con `--escribir`
// sobre cualquier otro tipo; mantenerla aquí evita abrir un campo donde el aparato no dejaría teclear.
export function esEditableTexto(tipo) {
  return TIPOS_CON_TECLADO.has(String(tipo || ""));
}

// La vista editable bajo un punto, en las mismas coordenadas lógicas que el pintor. Se elige la más
// profunda, como en `oyenteEnPunto`, para que un EditText dentro de un contenedor con listener se
// quede con el toque en vez de disparar el clic del padre.
export function editableEnPunto(modelo, ancho, alto, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let elegido = null;
  for (const r of rectsEscalados(modelo, ancho, alto)) {
    if (!r.idRef || !esEditableTexto(r.tipo)) continue;
    if (x < r.x || y < r.y || x > r.x + r.ancho || y > r.y + r.alto) continue;
    if (!elegido || r.profundidad >= elegido.profundidad) elegido = r;
  }
  return elegido;
}

// ¿Un modelo que llega por `EVENTO_PREVIA` empieza una ejecución nueva y por tanto borra la lista
// de clics? Solo si no lo pidió un clic (`pulsando`) y no es el MISMO modelo que devolvió el último
// `--pulsar`. La identidad es la clave: `repintarVistaPrevia` vuelve a avisar con el modelo que ya
// estaba en memoria, y ese repintado no puede tirar los clics entregados aunque el evento llegue
// después de que `pulsando` haya vuelto a false (era el «Pulsos: 1» de cada toque).
export function reiniciaPulsos({ pulsando, modelo, modeloDeClics } = {}) {
  if (pulsando) return false;
  return modelo == null || modelo !== modeloDeClics;
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

function borrarClave(clave) {
  try { localStorage.removeItem(clave); } catch (e) { /* preferencia, no dato */ }
}

// El tamaño elegido: un preset de `PANTALLAS` o un par ancho×alto en dp. Se guarda como JSON para
// que el personalizado sobreviva a recargar sin una segunda clave por eje.
function leerPantalla() {
  const crudo = leerClave(CLAVE_PANTALLA, "");
  if (!crudo) return { ...PANTALLA_POR_DEFECTO };
  try {
    const datos = JSON.parse(crudo);
    const ancho = Number(datos && datos.ancho);
    const alto = Number(datos && datos.alto);
    if (Number.isFinite(ancho) && Number.isFinite(alto) && ancho >= 200 && alto >= 240) {
      return { ancho: Math.round(ancho), alto: Math.round(alto) };
    }
  } catch (e) { /* una preferencia corrupta no puede romper el arranque */ }
  return { ...PANTALLA_POR_DEFECTO };
}

function guardarPantalla() {
  guardarClave(CLAVE_PANTALLA, JSON.stringify(pantalla));
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
    consola: { lista: "previa-consola-lista", cabecera: "previa-consola-cabecera", vacio: "previa-consola-vacio" },
    pulsos: { caja: "previa-oyentes", cuenta: "previa-pulsos-cuenta", nota: "previa-pulsos-nota" },
    controles: "previa-emulador-controles",
    menu: { control: "previa-menu-opciones", lista: "previa-menu-lista" },
    intercambio: { firma: "previa-intercambio-firma", boton: "previa-intercambiar", fichero: "previa-intercambio-fichero" },
    toast: "previa-toast",
  },
  {
    id: "vista",
    canvasVivo: "vista-layout-canvas", estadoVivo: "vista-layout-estado",
    // el estado del emulador lo escribe vista-previa.js al pintar el modelo de apkc, pero la
    // línea de esta superficie también recibe los «Ejecutando el clic…» y los fallos: es la
    // misma que la del panel, sin una segunda copia del estado
    canvasRender: "vista-previa", estadoRender: "vista-previa-estado",
    log: { lista: "vista-log-lista", cabecera: "vista-log-cabecera", vacio: "vista-log-vacio" },
    consola: { lista: "vista-consola-lista", cabecera: "vista-consola-cabecera", vacio: "vista-consola-vacio" },
    pulsos: { caja: "vista-oyentes", cuenta: "vista-pulsos-cuenta", nota: "vista-pulsos-nota" },
    controles: "vista-emulador-controles",
    menu: { control: "vista-menu-opciones", lista: "vista-menu-lista" },
    intercambio: { firma: "vista-intercambio-firma", boton: "vista-intercambiar", fichero: "vista-intercambio-fichero" },
    toast: "vista-toast",
  },
];

// Las dos tiras de secciones del emulador: la del panel de la vista dividida y la de la vista
// Pantalla. Cada una tiene sus pestañas, sus paneles y su preferencia; el patrón es el mismo que el
// del panel inferior de compilación (Consola | Diagnóstico | Historial | Compilar | Firmar).
const SECCIONES = [
  {
    clave: "apkc-studio/previa-seccion",
    botones: { pulsos: "previa-seccion-pulsos", registro: "previa-seccion-registro", consola: "previa-seccion-consola" },
    paneles: { pulsos: "previa-pulsos", registro: "previa-log", consola: "previa-consola" },
  },
  {
    clave: "apkc-studio/vista-seccion",
    botones: { pulsos: "vista-seccion-pulsos", registro: "vista-seccion-registro", consola: "vista-seccion-consola" },
    paneles: { pulsos: "vista-pulsos", registro: "vista-log", consola: "vista-consola" },
  },
];
const SECCION_POR_DEFECTO = "pulsos";

// La pieza de interfaz. Se construye sin tocar el DOM y solo se engancha en `iniciar()`, para que
// importar este módulo desde la prueba de node no necesite navegador.
// El apk que se suelta sobre el canvas no entra en el proyecto: se guarda en una zona propia de
// OPFS y `apkc preview` lo lee desde ahí. Así un arrastre no pisa `build/app.apk`, ni `res/`, ni
// el estado de la última APK, y el siguiente build vuelve a su sitio sin limpiar nada.
const RUTA_APK_SOLTADA = "/previa-soltada/apk-soltado.apk";
// El dex de un hot swap tampoco entra en el proyecto: va a la misma zona aislada y `apkc preview`
// lo lee con `--intercambiar`. Un fichero por swap para que el guion, que se repite entero en cada
// invocación, no acabe leyendo el dex nuevo en los pasos viejos.
const RUTA_DEX_SOLTADO = "/previa-soltada/intercambio-";

// Las tres superficies que aceptan un fichero soltado: el canvas editable (junto al código), el del
// emulador en el panel de la vista dividida y el de la vista Pantalla. Un `.apk` se abre igual desde
// cualquiera —misma ruta aislada, mismo mensaje, mismo modelo—; la rama de la imagen sigue siendo
// solo del canvas editable y del modo editar.
const CANVAS_SOLTABLES = ["previa-vivo-canvas", "previa-lateral-canvas", "vista-previa"];
// El aviso de que se puede soltar un apk: va en el `title` del canvas, que no ocupa sitio y sirve
// también de tooltip. `detalleEmulador` lo conserva al reescribir el título con el modelo.
const PISTA_SOLTAR_APK = "Suelta un .apk (o un .dex para intercambiar un método) aquí";

// El progreso de un apk soltado: una barra indeterminada dentro del marco del teléfono, con el
// texto de la carga, en las tres superficies. Los ids están en index.html y se documentan en
// EDITOR.md.
const PROGRESOS = ["previa-vivo-progreso", "previa-lateral-progreso", "vista-previa-progreso"];
// Una carga instantánea no puede pasar sin que el usuario vea que pasó algo: la barra se queda al
// menos este tiempo antes de enseñar el resultado.
const MINIMO_PROGRESO = 250;

// esArchivoApk decide si un fichero soltado se trata como apk. No se fía solo del tipo MIME: en
// Linux un `.apk` suele llegar como `application/octet-stream` o vacío.
export function esArchivoApk(archivo) {
  if (!archivo) return false;
  if (String(archivo.type || "").toLowerCase() === "application/vnd.android.package-archive") return true;
  return /\.apk$/i.test(String(archivo.name || ""));
}

// motivoApkInvalido es la puerta previa a `apkc preview`: un fichero vacío o que no empiece por la
// cabecera local de un zip no es un apk y se rechaza con su motivo, sin escribir nada en OPFS. Un
// zip sin manifiesto o sin layout lo rechaza después el propio `preview`, que nombra lo que falta.
export function motivoApkInvalido(bytes) {
  if (!bytes || !bytes.length) return "el apk está vacío";
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return "no es un zip: un apk empieza por la cabecera PK\\x03\\x04";
  }
  return "";
}

// mensajeApkRechazado une el nombre que el usuario soltó con el motivo, que es lo que se enseña en
// la línea del emulador. Vacío significa «la puerta pasa»; el contenido del apk lo juzga `preview`.
export function mensajeApkRechazado(nombre, bytes) {
  const motivo = motivoApkInvalido(bytes);
  if (!motivo) return "";
  return "no se cargó " + String(nombre || "el apk") + ": " + motivo;
}

// Un `.dex` que se suelta para el hot swap: se reconoce por la extensión o por el tipo, porque en
// Linux llega como `application/octet-stream`. El contenido lo valida después `motivoDexInvalido`.
export function esArchivoDex(archivo) {
  if (!archivo) return false;
  const tipo = String(archivo.type || "").toLowerCase();
  if (tipo === "application/x-dex" || tipo === "application/dex") return true;
  return /\.dex$/i.test(String(archivo.name || ""));
}

// motivoDexInvalido es la puerta previa a `apkc preview --intercambiar`: un fichero vacío, que no
// empieza por el mágico `dex\n`, que no llega a la cabecera o cuya cabecera declara más bytes que
// el fichero no puede llegar al intérprete. El dex que pasa el mágico pero está roto por dentro lo
// rechaza el propio `preview`, que nombra el defecto concreto.
export function motivoDexInvalido(bytes) {
  if (!bytes || !bytes.length) return "el dex está vacío";
  if (bytes.length < 4 || bytes[0] !== 0x64 || bytes[1] !== 0x65 || bytes[2] !== 0x78 || bytes[3] !== 0x0a) {
    return "no es un dex: empieza por el mágico dex\\n";
  }
  if (bytes.length < 0x70) return "el dex está truncado: no llega a la cabecera de 112 bytes";
  const version = String.fromCharCode(bytes[4], bytes[5], bytes[6]);
  if (!/^0\d\d$/.test(version)) return "la versión del dex no tiene la forma 035, y llegó «" + version + "»";
  const declarado = bytes[0x20] | (bytes[0x21] << 8) | (bytes[0x22] << 16) | (bytes[0x23] << 24);
  if (!(declarado > 0) || declarado > bytes.length) {
    return "la cabecera declara " + (declarado >>> 0) + " bytes y el fichero tiene " + bytes.length;
  }
  return "";
}

// mensajeDexRechazado une el nombre del fichero con el motivo, como el del apk: es la frase que se
// queda en el registro y en la línea del emulador cuando el fichero no puede ser un dex.
export function mensajeDexRechazado(nombre, bytes) {
  const motivo = motivoDexInvalido(bytes);
  if (!motivo) return "";
  return "no se intercambió " + String(nombre || "el dex") + ": " + motivo;
}

// motivoFirmaInvalida es la puerta de la firma que acompaña al dex. La forma que acepta el
// intérprete es `Lcom/hola/Saludo;/metodo(proto)`; sin `/metodo` se cambia la clase entera, que es
// una forma legítima y por eso el método es opcional. Lo que no puede faltar es el descriptor.
export function motivoFirmaInvalida(firma) {
  const texto = String(firma || "").trim();
  if (!texto) {
    return "indica la firma clase/metodo en el campo «swap» antes de soltar el dex " +
      "(Lcom/hola/Saludo;/metodo()I)";
  }
  if (texto.indexOf(";") < 0) {
    return "la firma necesita el descriptor de la clase, como Lcom/hola/Saludo;, y después, si es " +
      "un método, /metodo(proto): llegó «" + texto + "»";
  }
  return "";
}

// textoDeIntercambio es la línea del registro para un hot swap ya aplicado. Lleva los cuatro datos
// que publica `ejecucion.intercambios` —clase, método, proto y si el método ya existía— porque son
// los que distinguen «reemplacé el cuerpo» de «añadí un método».
export function textoDeIntercambio(cambio) {
  if (!cambio || typeof cambio !== "object") return "";
  const clase = typeof cambio.clase === "string" ? cambio.clase : "";
  const metodo = typeof cambio.metodo === "string" ? cambio.metodo : "";
  const proto = typeof cambio.proto === "string" ? cambio.proto : "";
  if (!clase && !metodo) return "";
  return clase + (metodo ? "/" + metodo : "") + proto +
    " · existía: " + (cambio.existia === true ? "sí" : "no");
}

export function crearPreviaPanel({ hospedador, proyecto, estadoPestana, editor, conBloqueo } = {}) {
  const carpeta = typeof proyecto === "string" && proyecto ? proyecto : "/proyecto";
  // El bloqueo entre ventanas lo pone `pestana.js`; sin él (la prueba de node) la tarea corre
  // igual, como el resto del módulo.
  const bloquear = typeof conBloqueo === "function" ? conBloqueo : (tarea) => tarea();
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
  let colores = null;
  let coloresEn = 0;
  let arbolEn = 0;
  let cuadro = 0;
  // Medidas del lienzo que ya se aplicaron: la misma caja y el mismo tamaño de pantalla dan el
  // mismo canvas, así que repetir el ajuste por un aviso de tamaño que no cambió nada no lo toca.
  const medidasCanvasAplicadas = new Map();
  // Un gesto de la consola (moverla, acoplarla, minimizarla, abrirla o cerrarla) no puede
  // reescalar el lienzo: el `ResizeObserver` de la fila se despierta con el cambio de la capa y
  // `ajustarCanvas` encogería el dibujo. Mientras dura el gesto se ignora ese aviso; el ajuste
  // legítimo (tamaño de la ventana o preset de pantalla) sigue pasando.
  let pausaCanvas = false;
  let turnoPausa = 0;
  let iniciado = false;
  // la lista de clics entregados desde la última compilación: se repite entera en cada `--pulsar`,
  // que es lo que hace reproducible la pantalla (el comando no guarda estado entre invocaciones)
  let pulsos = [];
  // El guion completo, en orden: clics (`pulsar`), aperturas del menú (`menu`) y su selección
  // (`menu-item`). Se repite entero en cada invocación, igual que `pulsos`, porque `apkc preview` no
  // guarda la máquina; conservar el orden es lo que hace que un clic posterior al menú vea el mismo
  // estado que en el aparato.
  let guion = [];
  // Lo tecleado en los EditText es estado de la EJECUCIÓN, no del documento: nunca se escribe en el
  // XML. Se guarda por idRef y viaja en el guion como `--escribir id/texto`, en el orden del tecleo.
  const textosEscritos = new Map();
  // El campo real que recibe el teclado del dispositivo. Oculto salvo cuando un EditText tiene foco.
  let campoTexto = null;
  let focoTexto = null;
  let temporizadorEscritura = 0;
  // el pointerdown que abrió el campo: el mismo evento sube al documento y no puede cerrarlo
  let ignorarCierreTexto = null;
  // el número del dex soltado: cada swap escribe su propio fichero en la zona de prueba para que
  // repetir el guion no cambie los bytes de los pasos anteriores
  let secuenciaIntercambio = 0;
  let pulsando = false;
  // si el desplegable del menú de opciones está abierto en la interfaz. No se persiste: la app que
  // lo pinta es la que decide si hay ítems; al reiniciar o compilar vuelve a cerrarse.
  let menuDesplegado = false;
  // lo que ya está pintado en el desplegable, para no reconstruirlo en cada repintado y no robar el
  // foco al botón que se acaba de pulsar
  let claveMenu = "";
  // El último Toast que se enseña sobre el teléfono: su firma (para no reabrirlo en cada repintado)
  // y el temporizador que lo retira. El historial completo sigue en la consola de la app.
  let toastFirma = "";
  let toastTemporizador = 0;
  // Qué modelo produjo el Toast visible y cuántas emisiones se han visto. Un repintado repite el
  // mismo objeto y no reinicia la cuenta; una emisión nueva trae otro y sí, aunque el texto sea igual.
  let toastModelo = null;
  let toastFecha = 0;
  // Identidad de la ejecución que produjo el Toast: un WeakMap da un número a cada objeto
  // `ejecucion`. Un repintado o un cambio de tamaño conservan la misma referencia (el modelo
  // escalado comparte `ejecucion`), y un build nuevo trae otra, así que su Toast vuelve a salir.
  const ejecucionesDeToast = new WeakMap();
  let ejecucionToast = 0;
  // el modelo que produjo el último clic, por identidad. Un repintado del MISMO modelo —entrar en
  // Pantalla, cambiar el tamaño, mover la consola— llega con `pulsando` ya en false y antes se
  // confundía con un build nuevo: borraba `pulsos` y el primer toque volvía a «Pulsos: 1».
  let modeloDeClics = null;
  // Energía del emulador y tamaño de su lienzo. Apagar no borra nada: solo deja la pantalla en
  // negro y evita ejecutar; encender vuelve a pedir `apkc preview` sobre la copia estable.
  let apagado = leerClave(CLAVE_ENERGIA, "encendido") === "apagado";
  let pantalla = leerPantalla();
  let inspectorAbierto = {
    panel: leerClave(CLAVE_INSPECTOR_PANEL, "1") !== "0",
    vista: leerClave(CLAVE_INSPECTOR_VISTA, "1") !== "0",
  };
  // La consola de la vista Pantalla, desprendida de la página. `modo` es libre, acoplado o
  // minimizado; `x`/`y` son la posición libre en coordenadas de la ventana; `anterior` recuerda a
  // qué modo volver al restaurar una pastilla. El tamaño sigue en `queridaLado`/`cajaLado`.
  const lado = {
    modo: MODO_LIBRE,
    borde: BORDE_POR_DEFECTO,
    x: null,
    y: null,
    anterior: MODO_LIBRE,
  };
  // El registro y la consola del panel del editor: el mismo estado y su propio tamaño libre, que
  // ahora se ajusta con sus ocho tiradores y se guarda en sus propias claves.
  const inspector = {
    modo: MODO_LIBRE,
    borde: BORDE_POR_DEFECTO,
    x: null,
    y: null,
    anterior: MODO_LIBRE,
    ancho: null,
    alto: null,
  };
  // Las dos capas desprendidas, con lo que cambia de una a otra: su contenedor, sus claves y sus
  // botones. El resto del comportamiento es el mismo y vive en `aplicarModoFlotante`.
  const FLOTANTES = {
    panel: {
      estado: inspector,
      contenedor: () => el("previa-inspector"),
      claves: { modo: CLAVE_PANEL_MODO, borde: CLAVE_PANEL_BORDE, x: CLAVE_PANEL_X, y: CLAVE_PANEL_Y,
        ancho: CLAVE_PANEL_ANCHO, alto: CLAVE_PANEL_ALTO },
      ids: { asidero: "previa-inspector-asidero", minimizar: "previa-inspector-minimizar",
        izquierda: "previa-inspector-acoplar-izquierda", derecha: "previa-inspector-acoplar-derecha",
        arriba: "previa-inspector-acoplar-arriba", abajo: "previa-inspector-acoplar-abajo",
        soltar: "previa-inspector-soltar", tiradores: "previa-inspector-tirador-" },
      ancho: () => (Number.isFinite(inspector.ancho) ? inspector.ancho : ANCHO_POR_DEFECTO),
      alto: () => inspector.alto,
      anchoPropio: true,
      altoPropio: true,
      // oculta en el modo Vista previa: su caja mide cero hasta que se enseña el emulador
      esperarCaja: true,
    },
    vista: {
      estado: lado,
      contenedor: () => marcoLado(),
      claves: { modo: CLAVE_LADO_MODO, borde: CLAVE_LADO_BORDE, x: CLAVE_LADO_X, y: CLAVE_LADO_Y,
        ancho: null, alto: null },
      ids: { asidero: "vista-lado-asidero", minimizar: "vista-lado-minimizar",
        izquierda: "vista-lado-acoplar-izquierda", derecha: "vista-lado-acoplar-derecha",
        arriba: "vista-lado-acoplar-arriba", abajo: "vista-lado-acoplar-abajo",
        soltar: "vista-lado-soltar", tiradores: "vista-tirador-" },
      ancho: () => cajaLado.ancho,
      alto: () => cajaLado.alto,
      anchoPropio: false,
      altoPropio: false,
      esperarCaja: false,
    },
  };
  const completa = { panel: false, vista: false };
  let ultimaMeta = null;
  // el apk que respalda el modelo en pantalla: el del build o la copia estable. Los clics repiten
  // `apkc preview` sobre el mismo fichero, así no dependen de que `build/app.apk` siga ahí.
  let apkActual = "build/app.apk";
  // el apk que llegó por arrastre y respalda el modelo en pantalla; se conserva para que los clics
  // sigan pidiendo `apkc preview` sobre el mismo fichero hasta que un build o otra APK lo sustituya
  let rutaApkSoltada = RUTA_APK_SOLTADA;
  // distingue el modelo que llega de la última apk del que llega de un build, para no perder la
  // fuente al repintar desde el evento de `vista-previa.js`
  let origenPrevia = "build";
  // El modo editar no es un tercer modo de lectura: es un interruptor sobre «Vista previa». Guarda
  // la ruta del nodo seleccionado (índices desde la raíz, sin contar los nodos de texto) y el
  // arrastre de un nodo en curso. Nada de esto se persiste: al recargar se vuelve a la lectura.
  // El arrastre del nodo se llama `arrastreNodo`: `arrastre` es el de los tiradores del marco.
  let editando = false;
  let seleccion = null;
  let arrastreNodo = null;
  // el arrastre de un tipo DESDE la paleta es otro gesto: no mueve un nodo, crea uno donde se
  // suelta. `suprimirClicPaleta` evita que el clic que sigue al soltar añada además al final.
  let arrastrePaleta = null;
  // marca de tiempo del último arrastre soltado: si llega su clic en 600 ms, no añade otro nodo
  let suprimirClicPaleta = 0;
  let notaEdicion = "";
  // La ficha de propiedades se reconstruye solo cuando cambia el nodo; mientras se teclea se
  // actualizan los valores de los campos que no tienen el foco.
  let clavePropiedades = "";
  // Historial PROPIO del diseñador: una pila de operaciones del modo editar (añadir, mover, borrar,
  // propiedades). Es independiente del undo tree de texto; se aplica con `EDITOR.cambiar` solo como
  // mecanismo de escritura, así que deshacer aquí no depende de lo que hiciera el editor de código.
  let pilaDeshacer = [];
  let pilaRehacer = [];
  // el XML que dejó la última operación del diseñador: un `input` con este texto es nuestro y no
  // invalida el historial; cualquier otro es una edición manual y lo tira
  let textoDiseno = null;
  let rutaHistorial = null;
  // el visor de jerarquía es otra capa plegable; se recuerda qué ramas están cerradas
  let jerarquiaVisible = false;
  let jerarquiaPlegada = new Set();
  let claveJerarquia = "";
  // Los PNG importados, ya decodificados: la clave es `@drawable/nombre`. `null` = no se pudo leer
  // (se pinta el marcador con el nombre) y se reintenta al volver a importar.
  const imagenes = new Map();

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

  // Las medidas de la ventana: la consola flotante se acota a ellas, no al marco del emulador.
  function ventana() {
    return {
      ancho: (typeof window !== "undefined" && window.innerWidth) || 1024,
      alto: (typeof window !== "undefined" && window.innerHeight) || 768,
    };
  }

  // Un valor dentro de [minimo, maximo]; si la ventana es más pequeña que el mínimo, manda el
  // mínimo (la capa se sale por abajo antes que quedarse en cero píxeles).
  function acotar(valor, minimo, maximo) {
    const tope = Math.max(minimo, maximo);
    return Math.max(minimo, Math.min(tope, valor));
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
    // la consola de la vista Pantalla es una capa `fixed`: su espacio es la ventana, no el marco
    // del emulador. Así se puede mover por toda la página sin salirse de los bordes.
    const medidas = ventana();
    return {
      anchoMin: LADO_MINIMO,
      anchoMax: Math.max(LADO_MINIMO, Math.min(LADO_MAXIMO, medidas.ancho - 16)),
      altoMin: LADO_ALTO_MINIMO,
      altoMax: Math.max(LADO_ALTO_MINIMO, medidas.alto - 16),
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
    aplicarModoLado(persistir);
    actualizarAria();
  }

  // --- las dos capas desprendidas: libre, acoplada o minimizada -------------------------------
  // La consola de la vista Pantalla y el registro del panel del editor son el mismo sistema. Las
  // dos son `fixed`: no ocupan sitio en el reparto del emulador, se arrastran por toda la ventana
  // desde su asa y se recortan a los bordes. Su modo, borde, posición y tamaño son preferencias de
  // la ventana. Las medidas del canvas no dependen de ninguna de ellas.
  function leerFlotante(nombre) {
    const f = FLOTANTES[nombre];
    const estado = f.estado;
    const modo = leerClave(f.claves.modo, MODO_LIBRE);
    estado.modo = modo === MODO_ACOPLADO || modo === MODO_MINIMIZADO ? modo : MODO_LIBRE;
    estado.borde = bordeValido(leerClave(f.claves.borde, BORDE_POR_DEFECTO));
    const x = numeroOpcional(leerClave(f.claves.x, ""), 0, 100000);
    const y = numeroOpcional(leerClave(f.claves.y, ""), 0, 100000);
    estado.x = Number.isFinite(x) ? x : null;
    estado.y = Number.isFinite(y) ? y : null;
    if (f.claves.ancho) {
      const limites = limitesFlotante();
      const ancho = numeroOpcional(leerClave(f.claves.ancho, ""), limites.anchoMin, limites.anchoMax);
      if (f.anchoPropio) estado.ancho = Number.isFinite(ancho) ? ancho : null;
    }
    if (f.claves.alto) {
      const limites = limitesFlotante();
      const alto = numeroOpcional(leerClave(f.claves.alto, ""), limites.altoMin, limites.altoMax);
      if (f.altoPropio) estado.alto = Number.isFinite(alto) ? alto : null;
    }
    estado.anterior = estado.modo === MODO_MINIMIZADO ? MODO_LIBRE : estado.modo;
  }

  function leerFlotantes() {
    leerFlotante("panel");
    leerFlotante("vista");
  }

  function guardarFlotante(nombre) {
    const f = FLOTANTES[nombre];
    const estado = f.estado;
    guardarClave(f.claves.modo, estado.modo);
    guardarClave(f.claves.borde, estado.borde);
    if (Number.isFinite(estado.x)) guardarClave(f.claves.x, estado.x);
    if (Number.isFinite(estado.y)) guardarClave(f.claves.y, estado.y);
    if (f.claves.ancho) {
      if (Number.isFinite(estado.ancho)) guardarClave(f.claves.ancho, estado.ancho);
      else borrarClave(f.claves.ancho);
    }
    if (f.claves.alto) {
      if (Number.isFinite(estado.alto)) guardarClave(f.claves.alto, estado.alto);
      else borrarClave(f.claves.alto);
    }
  }

  // El alto de la capa libre: el que eligió el usuario o uno razonable para la ventana. En modo
  // acoplado manda la ventana (arriba y abajo a 8 px) y en la pastilla manda el contenido.
  function altoLibreFlotante(nombre) {
    const alto = FLOTANTES[nombre].alto();
    if (Number.isFinite(alto)) return Math.round(alto);
    return Math.max(LADO_ALTO_MINIMO, Math.min(560, ventana().alto - 96));
  }

  function actualizarBotonesFlotante(nombre) {
    const f = FLOTANTES[nombre];
    const estado = f.estado;
    const minimizar = el(f.ids.minimizar);
    if (minimizar) {
      const plegado = estado.modo === MODO_MINIMIZADO;
      minimizar.setAttribute("aria-pressed", String(plegado));
      const titulo = plegado
        ? "Restaurar el registro y la consola"
        : "Minimizar el registro y la consola";
      minimizar.title = titulo;
      minimizar.setAttribute("aria-label", titulo);
    }
    for (const borde of BORDES) {
      const boton = el(f.ids[borde]);
      if (boton) {
        const puesto = estado.modo === MODO_ACOPLADO && estado.borde === borde;
        boton.setAttribute("aria-pressed", String(puesto));
        const titulo = puesto ? "Soltar la consola y dejarla flotante"
          : "Acoplar la consola al borde " + borde;
        boton.title = titulo;
        boton.setAttribute("aria-label", titulo);
      }
    }
    const soltar = el(f.ids.soltar);
    if (soltar) {
      soltar.setAttribute("aria-pressed", String(estado.modo === MODO_LIBRE));
      soltar.hidden = estado.modo !== MODO_ACOPLADO;
    }
  }

  // Coloca la capa según su modo. Todo va en línea y con `position: fixed`: cambiar de modo no
  // toca el reparto del emulador, así que el canvas conserva sus medidas y su posición.
  function aplicarModoFlotante(nombre, persistir) {
    const f = FLOTANTES[nombre];
    const estado = f.estado;
    const contenedor = f.contenedor();
    if (!contenedor) return;
    const medidas = ventana();
    const faltaPosicion = !Number.isFinite(estado.x) || !Number.isFinite(estado.y);
    const faltaTamano = (f.anchoPropio && !Number.isFinite(estado.ancho)) ||
      (f.altoPropio && !Number.isFinite(estado.alto));
    if (estado.modo === MODO_LIBRE && (faltaPosicion || faltaTamano)) {
      // sin posición guardada se toma la caja que ya tiene (así el panel del editor conserva su
      // sitio y su tamaño al pasar a capa) o, si todavía mide cero porque está oculto, se espera
      const caja = typeof contenedor.getBoundingClientRect === "function"
        ? contenedor.getBoundingClientRect() : null;
      if (caja && caja.width > 0 && caja.height > 0) {
        if (f.anchoPropio && !Number.isFinite(estado.ancho)) estado.ancho = Math.round(caja.width);
        if (f.altoPropio && !Number.isFinite(estado.alto)) estado.alto = Math.round(caja.height);
        if (faltaPosicion) {
          estado.x = Math.round(caja.left);
          estado.y = Math.round(caja.top);
        }
      } else if (f.esperarCaja && faltaPosicion) {
        return;
      }
    }
    contenedor.dataset.modo = estado.modo;
    contenedor.dataset.borde = estado.borde;
    contenedor.classList.toggle("minimizado", estado.modo === MODO_MINIMIZADO);
    contenedor.style.position = "fixed";
    if (estado.modo === MODO_ACOPLADO) {
      // El tamaño es el mismo que en la capa libre: sus ocho tiradores lo cambian también aquí y
      // el resultado se guarda en las claves propias de cada superficie. El borde solo decide qué
      // arista se pega; el alto deja de ser `auto` para que el tirador sur tenga efecto.
      const caja = cajaAcoplada(estado.borde, f.ancho(), altoLibreFlotante(nombre), medidas);
      contenedor.style.width = caja.ancho + "px";
      contenedor.style.height = caja.alto + "px";
      contenedor.style.top = caja.arriba;
      contenedor.style.bottom = caja.abajo;
      contenedor.style.left = caja.izquierda;
      contenedor.style.right = caja.derecha;
    } else if (estado.modo === MODO_MINIMIZADO) {
      // la pastilla va abajo a la derecha: el título sigue a la vista y el emulador queda libre
      contenedor.style.width = "auto";
      contenedor.style.height = "auto";
      contenedor.style.top = "auto";
      contenedor.style.left = "auto";
      contenedor.style.bottom = "8px";
      contenedor.style.right = "8px";
    } else {
      const ancho = Math.round(f.ancho()) || LADO_POR_DEFECTO;
      const alto = altoLibreFlotante(nombre);
      const x = acotar(Number.isFinite(estado.x) ? estado.x : medidas.ancho - ancho - 16, 0,
        Math.max(0, medidas.ancho - ancho));
      const y = acotar(Number.isFinite(estado.y) ? estado.y : 96, 0, Math.max(0, medidas.alto - alto));
      estado.x = Math.round(x);
      estado.y = Math.round(y);
      contenedor.style.width = ancho + "px";
      contenedor.style.height = alto + "px";
      contenedor.style.left = estado.x + "px";
      contenedor.style.top = estado.y + "px";
      contenedor.style.right = "auto";
      contenedor.style.bottom = "auto";
    }
    actualizarBotonesFlotante(nombre);
    if (persistir) guardarFlotante(nombre);
  }

  function aplicarModoFlotantePorModo(nombre, modo, borde) {
    const estado = FLOTANTES[nombre].estado;
    if (borde) estado.borde = borde;
    if (modo !== MODO_MINIMIZADO && estado.modo !== MODO_MINIMIZADO) estado.anterior = modo;
    estado.modo = modo;
    // acoplar o cambiar de modo es un gesto de la consola: no puede reescalar el lienzo
    pausarAjusteCanvas();
    aplicarModoFlotante(nombre, true);
  }

  // compatibilidad con los llamadores que ya hablaban de la consola de Pantalla
  function aplicarModoLado(persistir) { aplicarModoFlotante("vista", persistir); }

  // Límites de una capa desprendida: la ventana es su espacio, tanto flotando como acoplada. Sirven
  // a los tiradores de las dos superficies, que antes solo tenía la de Pantalla.
  function limitesFlotante() {
    const medidas = ventana();
    return {
      anchoMin: LADO_MINIMO,
      anchoMax: Math.max(LADO_MINIMO, medidas.ancho - 16),
      altoMin: LADO_ALTO_MINIMO,
      altoMax: Math.max(LADO_ALTO_MINIMO, medidas.alto - 16),
    };
  }

  // Caja que se entrega al tirador: el ancho y el alto que se ve, nunca indefinidos.
  function cajaFlotante(nombre) {
    const f = FLOTANTES[nombre];
    return {
      ancho: f.ancho(),
      alto: altoLibreFlotante(nombre),
      arriba: 0,
    };
  }

  // Un tirador de la capa flotante del panel escribe en su propio estado; los de Pantalla siguen
  // pasando por `fijarLado`, que ya guarda `CLAVE_LADO`/`CLAVE_LADO_ALTO`. En los dos casos se
  // reaplica el modo con `persistir=false` y se guarda una sola vez al soltar.
  function fijarFlotante(nombre, caja, altura) {
    if (nombre === "panel") {
      inspector.ancho = caja.ancho;
      if (altura) inspector.alto = caja.alto;
      aplicarModoFlotante("panel", false);
    } else {
      fijarLado(caja, altura);
    }
  }

  function montarTiradoresFlotantes(nombre) {
    const f = FLOTANTES[nombre];
    const contenedor = f.contenedor();
    if (!contenedor) return;
    const tiradores = [...contenedor.querySelectorAll(".tirador-previa")];
    if (!tiradores.length) return;
    montarMarco(contenedor, {
      caja: () => cajaFlotante(nombre),
      limites: limitesFlotante,
      fijar: (caja, altura) => fijarFlotante(nombre, caja, altura),
      aplicar: (persistir) => {
        aplicarModoFlotante(nombre, persistir);
        if (nombre === "panel" && persistir) guardarFlotante("panel");
      },
      reiniciar: () => {
        if (nombre === "panel") { inspector.ancho = ANCHO_POR_DEFECTO; inspector.alto = null; }
        else { queridaLado.ancho = LADO_POR_DEFECTO; queridaLado.alto = null; queridaLado.arriba = 0; }
      },
    });
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
    const medidasLado = limitesLado();
    const oesteLado = el("vista-tirador-oeste");
    if (oesteLado) {
      oesteLado.setAttribute("aria-valuenow", String(cajaLado.ancho));
      oesteLado.setAttribute("aria-valuemin", String(medidasLado.anchoMin));
      oesteLado.setAttribute("aria-valuemax", String(medidasLado.anchoMax));
      oesteLado.setAttribute("aria-valuetext", cajaLado.ancho + " píxeles de ancho");
    }
    const surLado = el("vista-tirador-sur");
    if (surLado) {
      const alto = altoEfectivo(marcoLado(), cajaLado);
      surLado.setAttribute("aria-valuenow", String(alto));
      surLado.setAttribute("aria-valuemin", String(medidasLado.altoMin));
      surLado.setAttribute("aria-valuemax", String(medidasLado.altoMax));
      surLado.setAttribute("aria-valuetext", alto + " píxeles de alto");
    }
  }

  function soltar() {
    if (!arrastre) return;
    const { tirador, aplicar } = arrastre;
    arrastre = null;
    if (tirador) tirador.classList.remove("arrastrando");
    document.body.classList.remove("separando-previa");
    delete document.body.dataset.eje;
    // el guardado se hace una vez al soltar, no en cada movimiento del puntero. `aplicar` solo lo
    // trae el marco de una capa flotante: persiste su tamaño en sus propias claves.
    aplicarPanel(true);
    aplicarLado(true);
    if (aplicar) aplicar(true);
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
          aplicar: config.aplicar,
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
    if (!visible && editando) aplicarEditable(false);
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
    // la capa del registro vuelve con el panel: si estaba oculta, su caja era cero y se coloca ahora
    if (visible && modo === "render") aplicarModoFlotante("panel", false);
    if (!visible && !vistaActiva()) return;
    if (modo === "render") pintarRender();
    else { pintarVivo(); programarVivo(0); }
  }

  // --- Vista previa / Emulador --------------------------------------------------------------
  function aplicarModo(valor, persistir) {
    // una preferencia vieja (`xml`) era el nombre anterior del mismo panel dibujado
    modo = valor === "render" ? "render" : "vivo";
    // salir del emulador no puede dejar su superficie fija tapando la vista previa del layout
    if (modo !== "render") {
      if (completa.panel) aplicarCompleta("panel", false);
      if (completa.vista) aplicarCompleta("vista", false);
    }
    // el modo editar no existe sobre el emulador con eventos: cambiar de lectura lo apaga
    if (modo === "render" && editando) aplicarEditable(false);
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
    // el registro del panel es una capa: si estaba oculto en Vista previa y aún no tenía caja, se
    // coloca ahora que el emulador se ve; si ya tenía posición, solo se reacota a la ventana
    if (modo === "render") aplicarModoFlotante("panel", false);
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
  // secuencia que trae el intérprete, que es el orden real de emisión. Las dos superficies (panel y
  // Pantalla) tienen su propia lista: el modelo es uno y la consola no puede quedarse atrás.
  function limpiarConsola(texto) {
    for (const superficie of SUPERFICIES) {
      const lista = el(superficie.consola.lista);
      const cabecera = el(superficie.consola.cabecera);
      const vacio = el(superficie.consola.vacio);
      if (lista) lista.textContent = "";
      if (cabecera) cabecera.textContent = "sin salida";
      if (vacio) {
        vacio.hidden = false;
        if (texto) vacio.textContent = texto;
      }
    }
  }

  function pintarConsola(modelo) {
    const resumen = resumenEjecucion(modelo);
    for (const superficie of SUPERFICIES) {
      const lista = el(superficie.consola.lista);
      const cabecera = el(superficie.consola.cabecera);
      const vacio = el(superficie.consola.vacio);
      if (!lista || !cabecera || !vacio) continue;
      lista.textContent = "";
      if (!resumen) {
        cabecera.textContent = "sin salida";
        vacio.hidden = false;
        vacio.textContent = "Compila el proyecto para ver lo que la app imprime.";
        continue;
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
      const clics = resumen.pulsaciones.length;
      cabecera.textContent = (resumen.consola.length === 1 ? "1 línea" : resumen.consola.length + " líneas") +
        " · " + clics + (clics === 1 ? " clic" : " clics");
      const hay = lista.children.length > 0;
      vacio.hidden = hay;
      if (!hay) vacio.textContent = "La app no imprimió nada en esta ejecución.";
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
        // la misma palabra que el contador de pulsos: el registro y la cuenta hablan de lo mismo
        partes.push(resumen.interacciones + (resumen.interacciones === 1 ? " clic" : " clics"));
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
      // el hot swap se pinta desde el modelo, no desde el último mensaje: un repintado o un cambio
      // de superficie conserva lo que el intérprete cambió en la sesión
      for (const cambio of resumen.intercambios) {
        lista.appendChild(lineaLog("intercambio", "swap:", textoDeIntercambio(cambio)));
      }
      if (resumen.error) lista.appendChild(lineaLog("peligro", "error:", resumen.error));
      const hay = lista.children.length > 0;
      vacio.hidden = hay;
      if (!hay) vacio.textContent = "La ejecución no capturó escrituras ni dejó avisos.";
    }

  }

  // --- clics del emulador -------------------------------------------------------------------
  function limpiarOyentes(texto) {
    for (const superficie of SUPERFICIES) {
      const caja = el(superficie.pulsos.caja);
      const cuenta = el(superficie.pulsos.cuenta);
      const nota = el(superficie.pulsos.nota);
      if (caja) caja.textContent = "";
      if (cuenta) cuenta.textContent = "sin clics";
      if (nota) {
        nota.hidden = false;
        if (texto) nota.textContent = texto;
      }
    }
  }

  // Las vistas que responden a un clic, en las dos superficies. El botón de cada una pide el mismo
  // `--pulsar` que un toque sobre el canvas. Cuando no hay ejecución no se puede decir que la app
  // «no registró ningún OnClickListener»: eso solo se sabe después de ejecutar `onCreate`, así que
  // el aviso distingue los dos casos.
  function pintarOyentes(modelo) {
    const oyentes = oyentesDeModelo(modelo);
    const resumen = resumenEjecucion(modelo);
    // los clics que la pantalla declara haber ejecutado: el modelo los trae (`pulsaciones`) y, si
    // esta instancia acaba de pedir uno, la lista local ya los incluye; manda el mayor de los dos
    const entregados = Math.max(pulsos.length, resumen ? resumen.pulsaciones.length : 0);
    for (const superficie of SUPERFICIES) {
      const caja = el(superficie.pulsos.caja);
      const cuenta = el(superficie.pulsos.cuenta);
      const nota = el(superficie.pulsos.nota);
      if (!caja || !cuenta || !nota) continue;
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
      if (oyentes.length) continue;
      if (!resumen) nota.textContent = MENSAJE_SIN_PULSOS;
      else if (resumen.error) nota.textContent = "La ejecución se detuvo antes de registrar oyentes: " + resumen.error;
      else nota.textContent = "Esta ejecución no registró ningún OnClickListener sobre una vista con id.";
    }
  }

  // La línea de comandos del guion completo, en el orden en que se pidió. `apkc preview` no guarda
  // la máquina entre invocaciones: repetir el guion entero es lo que hace reproducible la pantalla.
  function argvDelGuion() {
    return argvDePrevia(guion, apkActual);
  }

  // Corre el guion entero y pinta el modelo que devuelva. Si la orden no se pudo entregar, deshace
  // el último paso para que la lista siga siendo válida y escribe el motivo en la línea del
  // emulador. Es el mismo camino para un clic, para abrir el menú, para elegir un ítem y para el
  // hot swap, que además necesita dejar su rechazo en el registro (`alFallar`).
  async function ejecutaGuion(desde, mensaje, { alFallar } = {}) {
    pulsando = true;
    mensajeVistaPreviaRender(mensaje);
    try {
      await hospedador.cwd(carpeta);
      const r = await hospedador.ejecutar(argvDelGuion());
      const modelo = modeloDeSalida(r && r.consola);
      if (!modelo) {
        guion.length = desde;
        const lineas = String((r && (r.error || r.consola)) || "").trim().split("\n").filter(Boolean);
        const motivo = lineas.length ? lineas[lineas.length - 1].trim()
          : "la orden no devolvió un modelo legible";
        mensajeVistaPreviaRender(motivo);
        if (typeof alFallar === "function") alFallar(motivo);
        return null;
      }
      // `pintarVistaPrevia` avisa por el evento; el panel se repinta con el modelo nuevo. La
      // identidad se guarda ANTES de avisar: el listener del evento ya puede reconocerlo como
      // «modelo de un clic» y no reiniciar `pulsos`, ni siquiera si el repintado llega más tarde.
      modeloDeClics = modelo;
      return pintarVistaPrevia(modelo);
    } catch (e) {
      guion.length = desde;
      const motivo = "no se pudo ejecutar la orden: " + (e && e.message ? e.message : e);
      mensajeVistaPreviaRender(motivo);
      // el rechazo también va al registro: deshacer el paso no basta, el usuario necesita saber
      // qué fichero no entró y por qué
      if (typeof alFallar === "function") alFallar(motivo);
      return null;
    } finally {
      pulsando = false;
    }
  }

  // --- el hot swap de un método --------------------------------------------------------------
  // El dex que el usuario suelta (o elige con el botón) va a OPFS y entra en el guion como un paso
  // más: `apkc preview` repite el guion entero, así que el intercambio ocurre en el orden en que se
  // pidió, la sesión conserva la identidad de sus objetos y la pantalla no se reinicia. La firma la
  // escribe el usuario; el modelo devuelve el resultado en `ejecucion.intercambios`.
  function registrarSwap(texto, clase) {
    for (const superficie of SUPERFICIES) {
      const lista = el(superficie.log.lista);
      if (!lista) continue;
      lista.appendChild(lineaLog(clase || "aviso", "swap:", texto));
      const vacio = el(superficie.log.vacio);
      if (vacio) vacio.hidden = true;
    }
  }

  function superficieDe(idSuperficie) {
    return SUPERFICIES.find((s) => s.id === idSuperficie) || SUPERFICIES[0];
  }

  function firmaDeSuperficie(idSuperficie) {
    const superficie = superficieDe(idSuperficie);
    const campo = superficie && superficie.intercambio ? el(superficie.intercambio.firma) : null;
    return campo && typeof campo.value === "string" ? campo.value.trim() : "";
  }

  async function intercambiarDexSoltado(archivo, idSuperficie, firmaDada) {
    if (!archivo) return null;
    const nombre = String(archivo.name || "el dex");
    const rechazar = (texto) => {
      mensajeVistaPreviaRender(texto);
      registrarSwap(texto, "peligro");
      return null;
    };
    if (apagado) return rechazar(MENSAJE_APAGADO);
    // La guarda se toma AQUÍ y ahora, no en `ejecutaGuion`: entre este punto y la ejecución hay
    // dos `await` (leer el fichero y escribirlo en OPFS), y dos drop seguidos la pasaban los dos,
    // dejando dos pasos en el guion y dos swaps donde el usuario pidió uno.
    if (pulsando) {
      return rechazar("no se intercambió " + nombre + ": el emulador está ejecutando otra orden; " +
        "espera a que termine.");
    }
    pulsando = true;
    // `ejecutaGuion` gestiona su propio `pulsando`; este `finally` solo suelta la reserva si el
    // swap se rechazó antes de llegar a ejecutar el guion.
    let ejecutando = false;
    try {
      // El modo cómodo manda la firma derivada del fuente; el camino avanzado sigue leyendo el
      // campo «swap» de la superficie donde se soltó el dex.
      const firma = firmaDada ? String(firmaDada).trim() : firmaDeSuperficie(idSuperficie);
      const malaFirma = motivoFirmaInvalida(firma);
      if (malaFirma) return rechazar("no se intercambió " + nombre + ": " + malaFirma);
      if (!resumenEjecucion(modeloActual())) {
        return rechazar("no se intercambió " + nombre + ": el emulador no tiene una sesión viva. " +
          "Compila el proyecto y espera su primera pantalla.");
      }
      let bytes;
      try {
        bytes = new Uint8Array(await archivo.arrayBuffer());
      } catch (e) {
        return rechazar("no se pudo leer " + nombre + ": " + (e && e.message ? e.message : e));
      }
      const rechazo = mensajeDexRechazado(nombre, bytes);
      if (rechazo) return rechazar(rechazo);
      const ruta = RUTA_DEX_SOLTADO + (++secuenciaIntercambio) + ".dex";
      try {
        const escrito = await hospedador.escribir(ruta, bytes);
        if (escrito && escrito.tipo === "error") {
          return rechazar("no se pudo guardar " + nombre + " en la zona de prueba: " + escrito.error);
        }
      } catch (e) {
        return rechazar("no se pudo guardar " + nombre + " en la zona de prueba: " +
          (e && e.message ? e.message : e));
      }
      const antes = guion.length;
      guion.push({ tipo: "intercambiar", firma, ruta });
      ejecutando = true;
      const pintado = await ejecutaGuion(antes, "Intercambiando " + firma + " desde " + nombre + "…", {
        alFallar: (motivo) => registrarSwap("no se intercambió " + nombre + ": " + motivo, "peligro"),
      });
      if (!pintado) return null;
      // el modelo ya publicó el cambio y `pintarLog` lo pinta desde `ejecucion.intercambios`; esta
      // línea dice además de qué fichero vino, que el modelo no sabe
      const cambios = (resumenEjecucion(modeloActual()) || { intercambios: [] }).intercambios;
      const ultimo = cambios.length ? cambios[cambios.length - 1] : null;
      registrarSwap(ultimo
        ? "aplicado desde " + nombre + ": " + textoDeIntercambio(ultimo)
        : "aplicado desde " + nombre + ", pero el modelo no publicó el cambio", "aviso");
      return pintado;
    } finally {
      if (!ejecutando) pulsando = false;
    }
  }

  // El modo cómodo: el dex ya compilado por la pestaña entra en el guion vivo con la firma que
  // manda el build, sin selector de ficheros y sin tocar el campo avanzado. Reutiliza la misma
  // guarda, validación, escritura en OPFS y registro del camino del arrastre.
  async function intercambiarDelBuild(bytes, firma) {
    const nombre = "build/app.apk";
    registrarSwap("intercambio automático desde " + nombre + ": " + String(firma || ""), "aviso");
    const copia = new Uint8Array(bytes || []);
    const archivo = { name: nombre, arrayBuffer: async () => copia.buffer };
    const pintado = await intercambiarDexSoltado(archivo, SUPERFICIES[0].id, firma);
    if (!pintado) return null;
    const cambios = (resumenEjecucion(modeloActual()) || { intercambios: [] }).intercambios;
    const ultimo = cambios.length ? cambios[cambios.length - 1] : null;
    registrarSwap(ultimo
      ? "intercambio automático aplicado: " + textoDeIntercambio(ultimo)
      : "intercambio automático: el modelo no publicó el cambio", "aviso");
    return pintado;
  }

  // El camino avanzado del panel y de Pantalla: un campo con la firma y un botón que abre el
  // selector de ficheros. Queda plegado bajo «swap con .dex (avanzado)» para que el modo cómodo
  // —marcar la casilla al compilar— sea lo que se ve primero. Se monta aquí y no en el HTML para
  // no duplicar el marcado en las dos superficies y para que la prueba de node siga importando
  // el módulo sin DOM.
  function montarControlIntercambio() {
    if (!conDocumento()) return;
    for (const superficie of SUPERFICIES) {
      const barra = el(superficie.controles);
      if (!barra || el(superficie.intercambio.firma)) continue;
      const avanzado = document.createElement("details");
      avanzado.className = "previa-control-avanzado";
      const titulo = document.createElement("summary");
      titulo.textContent = "swap con .dex (avanzado)";
      titulo.title = "Intercambiar un método con un .dex elegido en el equipo";
      avanzado.appendChild(titulo);
      const caja = document.createElement("label");
      caja.className = "previa-control-campo";
      caja.title = "Descriptor de la clase y, si es un método, /metodo(proto). Sin /metodo se " +
        "cambian todos los métodos que el dex declare para esa clase.";
      const rotulo = document.createElement("span");
      rotulo.textContent = "swap";
      const campo = document.createElement("input");
      campo.id = superficie.intercambio.firma;
      campo.type = "text";
      campo.autocomplete = "off";
      campo.spellcheck = false;
      campo.placeholder = "Lcom/hola/Saludo;/metodo()I";
      // el ancho del CSS de `.previa-control-campo input` es para los números de pantalla: una
      // firma no cabe, y el ancho es de esta pieza, no del tema
      campo.style.width = "15em";
      campo.setAttribute("aria-label", "Clase y método a intercambiar (clase/metodo(proto))");
      caja.appendChild(rotulo);
      caja.appendChild(campo);
      avanzado.appendChild(caja);

      const boton = document.createElement("button");
      boton.id = superficie.intercambio.boton;
      boton.type = "button";
      boton.className = "previa-control";
      boton.textContent = "Intercambiar…";
      boton.title = "Elegir un .dex y sustituir ese método en la sesión viva, sin reiniciar el emulador";
      boton.setAttribute("aria-label", "Intercambiar un método con un fichero .dex");
      const fichero = document.createElement("input");
      fichero.id = superficie.intercambio.fichero;
      fichero.type = "file";
      fichero.accept = ".dex,application/x-dex,application/octet-stream";
      fichero.hidden = true;
      fichero.addEventListener("change", () => {
        const elegido = fichero.files && fichero.files[0];
        fichero.value = "";
        if (!elegido) return;
        intercambiarDexSoltado(elegido, superficie.id)
          .catch((e) => falloSilencioso("intercambiar el dex elegido", e));
      });
      boton.addEventListener("click", () => {
        if (typeof fichero.click === "function") fichero.click();
      });
      avanzado.appendChild(boton);
      avanzado.appendChild(fichero);
      barra.appendChild(avanzado);
    }
  }

  // --- el menú de opciones --------------------------------------------------------------------
  // El desplegable del menú: lo que la app añadió con `menu.add` en `onCreateOptionsMenu`. El botón
  // de tres puntos vive en la barra del emulador (se monta en `iniciar`, porque la página no lo
  // trae en su HTML) y la lista se pinta en una capa sobre el marco del teléfono. Es la única forma
  // de llegar a un menú que, en el aparato, abre la tecla Menú o el desbordamiento de la ActionBar.
  function montarMenuDeOpciones() {
    for (const superficie of SUPERFICIES) {
      const barra = el(superficie.controles);
      const canvas = el(superficie.canvasRender);
      if (!barra || !canvas || el(superficie.menu.control) || el(superficie.menu.lista)) continue;
      const boton = document.createElement("button");
      boton.id = superficie.menu.control;
      boton.type = "button";
      boton.className = "previa-control previa-menu-opciones";
      boton.title = "Abrir el menú de opciones de la app (onCreateOptionsMenu)";
      boton.setAttribute("aria-label", "Abrir el menú de opciones de la app");
      boton.setAttribute("aria-haspopup", "menu");
      boton.setAttribute("aria-expanded", "false");
      boton.setAttribute("aria-controls", superficie.menu.lista);
      boton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/>' +
        '<circle cx="12" cy="19" r="1.6"/></svg><span class="texto-boton">Menú</span>';
      boton.addEventListener("click", (e) => {
        e.preventDefault();
        alternarMenu(boton);
      });
      barra.appendChild(boton);

      const lista = document.createElement("div");
      lista.id = superficie.menu.lista;
      lista.className = "previa-menu-lista";
      lista.setAttribute("role", "menu");
      lista.setAttribute("aria-label", "Menú de opciones de la app");
      lista.hidden = true;
      (canvas.parentElement || canvas).appendChild(lista);
    }
  }

  // El Toast del aparato, como capa sobre el marco: `Toast.makeText(...).show()` no deja una vista
  // en el layout, así que el intérprete lo publica en `ejecucion.toast` y aquí se pinta unos
  // segundos sobre el teléfono. No cambia el tamaño del canvas ni intercepta clics.
  function montarToasts() {
    for (const superficie of SUPERFICIES) {
      const canvas = el(superficie.canvasRender);
      if (!canvas || el(superficie.toast)) continue;
      const capa = document.createElement("div");
      capa.id = superficie.toast;
      capa.className = "previa-toast";
      capa.setAttribute("role", "status");
      capa.setAttribute("aria-live", "polite");
      capa.setAttribute("aria-atomic", "true");
      capa.hidden = true;
      (canvas.parentElement || canvas).appendChild(capa);
    }
  }

  // El historial completo sigue en la consola: un fallo que se deja a propósito sin mensaje visible
  // (una imagen que no se puede importar, un refresco que no aplica) se registra aquí con contexto
  // en vez de desaparecer.
  function falloSilencioso(contexto, e) {
    console.warn("[apkc-previa] " + contexto + ": " + (e && e.message ? e.message : e));
  }

  // La firma distingue una ejecución nueva de un repintado del mismo modelo: si el usuario redimensiona
  // o entra en Pantalla, el Toast ya visible no vuelve a empezar su cuenta atrás; si vuelve a pulsar el
  // ítem o recompila, la identidad de `ejecucion` cambia y el aviso se muestra otra vez.
  function firmaDeToast(modelo, resumen) {
    if (!resumen || !resumen.toast) return "";
    const ejecucion = modelo && typeof modelo === "object" ? modelo.ejecucion : null;
    let id = 0;
    if (ejecucion && typeof ejecucion === "object") {
      id = ejecucionesDeToast.get(ejecucion) || 0;
      if (!id) {
        id = ++ejecucionToast;
        ejecucionesDeToast.set(ejecucion, id);
      }
    }
    // `toastFecha` cuenta las emisiones (modelos nuevos), no los repintados: dos avisos con el
    // mismo texto son firmas distintas y el segundo reinicia la cuenta atrás. Sin esto, repetir el
    // mismo Toast a los 2,9 s se ocultaba a los 3 s del primero.
    return JSON.stringify([id, toastFecha, resumen.toast, resumen.pulsaciones, resumen.interacciones,
      resumen.consola.length, resumen.error]);
  }

  function pintarToast(modelo) {
    // el modelo CRUDO distingue una emisión de un repintado: `modeloConPantalla` devuelve una copia
    // escalada del mismo modelo cuando el tamaño elegido no coincide con el suyo
    const fuente = modeloActual() || modelo;
    if (fuente !== toastModelo) {
      toastModelo = fuente;
      toastFecha++;
    }
    const resumen = apagado ? null : resumenEjecucion(modelo);
    const firma = firmaDeToast(modelo, resumen);
    if (!firma) {
      // sin Toast en el modelo: se oculta y se olvida la firma, para que una ejecución posterior con
      // el mismo texto pueda volver a enseñarlo
      toastFirma = "";
      ocultarToast();
      return;
    }
    if (firma === toastFirma) return;
    toastFirma = firma;
    for (const superficie of SUPERFICIES) {
      const capa = el(superficie.toast);
      if (!capa) continue;
      capa.textContent = resumen.toast;
      capa.hidden = false;
    }
    clearTimeout(toastTemporizador);
    toastTemporizador = setTimeout(() => { ocultarToast(); }, 3000);
  }

  function ocultarToast() {
    if (toastTemporizador) clearTimeout(toastTemporizador);
    toastTemporizador = 0;
    // `toastFirma` NO se borra aquí: un repintado del mismo modelo después de caducar no puede
    // resucitar el aviso; solo una ejecución con otra firma (u otro modelo sin Toast) lo cambia.
    for (const superficie of SUPERFICIES) {
      const capa = el(superficie.toast);
      if (!capa) continue;
      capa.hidden = true;
      capa.textContent = "";
    }
  }

  // Pinta el desplegable con lo que el modelo publicó. Solo se reconstruye cuando cambian el estado
  // o los ítems: un repintado del mismo modelo no puede robar el foco al botón recién pulsado.
  function pintarMenu(modelo) {
    const menu = menuDesplegado ? menuDeModelo(modelo) : null;
    const abierto = !!(menuDesplegado && menu && menu.abierto && menu.items.length);
    const clave = JSON.stringify({ abierto, items: abierto ? menu.items : null });
    if (clave === claveMenu) return;
    claveMenu = clave;
    for (const superficie of SUPERFICIES) {
      const boton = el(superficie.menu.control);
      const lista = el(superficie.menu.lista);
      if (boton) {
        boton.setAttribute("aria-expanded", abierto ? "true" : "false");
        boton.classList.toggle("activo", abierto);
      }
      if (!lista) continue;
      lista.textContent = "";
      lista.hidden = !abierto;
      if (!abierto) continue;
      for (const item of menu.items) {
        const opcion = document.createElement("button");
        opcion.type = "button";
        opcion.className = "previa-menu-item";
        opcion.dataset.idref = item.id;
        opcion.setAttribute("role", "menuitem");
        opcion.textContent = item.titulo || item.id;
        opcion.title = "Pulsar «" + (item.titulo || item.id) + "» del menú de opciones";
        opcion.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          pulsarItemMenu(item.id);
        });
        lista.appendChild(opcion);
      }
    }
  }

  // Pide la pantalla después de un clic. Se repite TODO el estado desde `onCreate` (más los clics
  // anteriores), así que la pantalla resultante es la misma siempre para la misma lista: el comando
  // no puede guardar la máquina entre invocaciones y no lo finge.
  async function pulsar(idRef) {
    if (apagado) { mensajeVistaPreviaRender(MENSAJE_APAGADO); return null; }
    if (pulsando || typeof idRef !== "string" || !idRef) return null;
    // el clic puede venir del panel o de la vista Pantalla: con que una superficie esté montada
    // ya hay dónde escribir el «Ejecutando el clic…» y el fallo
    if (!SUPERFICIES.some((s) => s.estadoRender && document.getElementById(s.estadoRender))) return null;
    const antesPulsos = pulsos.length;
    const antesGuion = guion.length;
    pulsos.push(idRef);
    guion.push({ tipo: "pulsar", valor: idRef });
    const pintado = await ejecutaGuion(antesGuion, "Ejecutando el clic " + pulsos.length + "…");
    if (!pintado) {
      pulsos.length = antesPulsos;
      guion.length = antesGuion;
    }
    return pintado;
  }

  // Despliega el menú de opciones: añade `--menu` al guion y pinta los ítems que la app construyó
  // con `menu.add` en su `onCreateOptionsMenu`. Sin ejecución no se inventa nada: se pide compilar.
  async function abrirMenu() {
    if (apagado) { mensajeVistaPreviaRender(MENSAJE_APAGADO); return null; }
    if (pulsando) return null;
    if (!SUPERFICIES.some((s) => s.estadoRender && document.getElementById(s.estadoRender))) return null;
    const resumen = resumenEjecucion(modeloActual());
    if (!resumen) { mensajeVistaPreviaRender(MENSAJE_SIN_PULSOS); return null; }
    const antesGuion = guion.length;
    guion.push({ tipo: "menu" });
    const pintado = await ejecutaGuion(antesGuion, "Abriendo el menú de opciones…");
    if (!pintado) { menuDesplegado = false; pintarMenu(modeloActual()); return null; }
    const menu = menuDeModelo(modeloDeClics);
    if (!menu || !menu.items.length) {
      menuDesplegado = false;
      mensajeVistaPreviaRender(menu && !menu.abierto
        ? "onCreateOptionsMenu devolvió false: el menú de opciones no se muestra."
        : "La app no añadió ningún ítem al menú de opciones (menu.add).");
      pintarMenu(modeloDeClics);
      return null;
    }
    if (!menu.abierto) {
      menuDesplegado = false;
      mensajeVistaPreviaRender("onCreateOptionsMenu devolvió false: el menú de opciones no se muestra.");
      pintarMenu(modeloDeClics);
      return null;
    }
    menuDesplegado = true;
    pintarMenu(modeloDeClics);
    return pintado;
  }

  // Pulsa un ítem del menú abierto: añade `--menu-item` al guion y deja que el intérprete corra su
  // `OnMenuItemClickListener` y, si no lo consume, el `onOptionsItemSelected` de la actividad.
  async function pulsarItemMenu(idRef) {
    if (apagado) { mensajeVistaPreviaRender(MENSAJE_APAGADO); return null; }
    if (pulsando || typeof idRef !== "string" || !idRef) return null;
    if (!SUPERFICIES.some((s) => s.estadoRender && document.getElementById(s.estadoRender))) return null;
    const antesGuion = guion.length;
    guion.push({ tipo: "menu-item", valor: idRef });
    menuDesplegado = false;
    const pintado = await ejecutaGuion(antesGuion, "Pulsando el ítem " + idRef + " del menú…");
    if (!pintado) { menuDesplegado = false; pintarMenu(modeloActual()); }
    return pintado;
  }

  // Abre o cierra el desplegable desde el botón de tres puntos. Cerrarlo no ejecuta nada: es estado
  // de la interfaz; los ítems solo se piden al intérprete al abrir y al pulsarlos.
  function alternarMenu(boton) {
    if (menuDesplegado) { cerrarMenu(); if (boton && boton.focus) boton.focus(); return; }
    const modelo = modeloActual();
    if (apagado) { mensajeVistaPreviaRender(MENSAJE_APAGADO); return; }
    if (!resumenEjecucion(modelo)) { mensajeVistaPreviaRender(MENSAJE_SIN_PULSOS); return; }
    abrirMenu();
  }

  function cerrarMenu() {
    if (!menuDesplegado) return;
    menuDesplegado = false;
    pintarMenu(modeloActual());
  }

  // Un modelo nuevo (compilación, apk soltada, reinicio) empieza otra ejecución: los clics y las
  // órdenes del menú anteriores dejan de valer y el desplegable se cierra.
  function reiniciarGuion() {
    cerrarCampoTexto(false);
    pulsos = [];
    guion = [];
    modeloDeClics = null;
    menuDesplegado = false;
    claveMenu = "";
    // el texto tecleado era estado de la ejecución anterior: una compilación o una apk nueva
    // arrancan desde `onCreate` y no heredan lo que el usuario escribió en la pantalla anterior
    textosEscritos.clear();
  }

  function mensajeVistaPreviaRender(texto) {
    for (const superficie of SUPERFICIES) {
      const estado = superficie.estadoRender ? el(superficie.estadoRender) : null;
      if (estado) estado.textContent = texto;
    }
    detalleEmulador(texto);
  }

  // El detalle del modelo se enseña en la capa flotante (que no empuja el canvas) y en el `title`
  // del canvas, para no perderlo cuando el panel está cerrado o minimizado. La línea `role=status`
  // sigue llevando el texto para `aria-live`, pero está fuera del flujo.
  function detalleEmulador(texto) {
    const limpio = String(texto || "");
    for (const id of ["previa-detalle-modelo", "vista-lado-detalle"]) {
      const caja = el(id);
      if (caja) caja.textContent = limpio;
    }
    for (const id of ["previa-lateral-canvas", "vista-previa"]) {
      const canvas = el(id);
      if (canvas) ponerPistaSoltar(canvas, limpio);
    }
  }

  // El título del canvas lleva el detalle del modelo y, detrás, la pista de que ahí se puede soltar
  // un apk: se pone y se conserva desde un solo sitio para que no se pisen.
  function ponerPistaSoltar(canvas, detalle) {
    if (!canvas) return;
    const limpio = String(detalle || "").replace(" · " + PISTA_SOLTAR_APK, "").trim();
    canvas.title = limpio ? limpio + " · " + PISTA_SOLTAR_APK : PISTA_SOLTAR_APK;
  }

  // --- progreso del apk soltado --------------------------------------------------------------
  // El usuario tiene que ver que el arrastre hizo algo: una barra indeterminada y el nombre del
  // fichero dentro del marco del teléfono, en las tres superficies, y el mismo texto en la línea de
  // estado y en el registro del emulador. El resultado sustituye a la barra en ese mismo sitio y se
  // queda ahí hasta que el usuario pulsa el emulador o suelta otro fichero.
  let progresoToken = 0;
  let progresoDesde = 0;
  function pintarProgresoApk(texto, estado) {
    for (const id of PROGRESOS) {
      const caja = el(id);
      if (!caja) continue;
      const rotulo = caja.querySelector(".previa-progreso-texto");
      if (rotulo) rotulo.textContent = String(texto || "");
      caja.hidden = !texto;
      caja.classList.toggle("listo", estado === "listo");
      caja.classList.toggle("error", estado === "error");
    }
  }
  function empezarProgresoApk(texto) {
    progresoToken += 1;
    progresoDesde = Date.now();
    pintarProgresoApk(texto, "cargando");
    return progresoToken;
  }
  // El token evita que dos cargas se pisen el mensaje: solo la última escribe su resultado.
  async function terminarProgresoApk(token, texto, estado) {
    if (token !== progresoToken) return;
    const falta = MINIMO_PROGRESO - (Date.now() - progresoDesde);
    if (falta > 0) await new Promise((ok) => setTimeout(ok, falta));
    if (token !== progresoToken) return;
    pintarProgresoApk(texto, estado);
  }
  function cerrarProgresoApk() {
    progresoToken += 1;
    pintarProgresoApk("", "");
  }
  // La línea del registro del emulador, en las dos superficies: lo que se soltó se lee también ahí
  // y no solo en la línea de estado.
  function registrarSoltada(texto, clase) {
    for (const superficie of SUPERFICIES) {
      const lista = el(superficie.log.lista);
      if (!lista) continue;
      lista.appendChild(lineaLog(clase || "aviso", "soltar:", texto));
      const vacio = el(superficie.log.vacio);
      if (vacio) vacio.hidden = true;
    }
  }

  // --- energía, tamaño y última apk ---------------------------------------------------------
  // La copia estable la escribe `pestana.js` después de un build correcto. Aquí solo se lee para
  // decir si hay, y se usa como fuente de `apkc preview` sin volver a compilar.
  function actualizarEnergiaBotones() {
    for (const id of ["previa-energia", "vista-energia"]) {
      const boton = el(id);
      if (!boton) continue;
      boton.setAttribute("aria-pressed", String(!apagado));
      const titulo = apagado ? "Encender el emulador con la última apk guardada" : "Apagar el emulador";
      boton.title = titulo;
      boton.setAttribute("aria-label", titulo);
      const texto = boton.querySelector(".texto-boton");
      if (texto) texto.textContent = apagado ? "Apagado" : "Encendido";
    }
  }

  async function actualizarUltima() {
    let hay = false;
    try {
      const ultima = await leerUltimaApk(hospedador);
      hay = ultima.hay;
      ultimaMeta = hay ? ultima.meta : null;
    } catch (e) {
      hay = false;
      ultimaMeta = null;
    }
    const fecha = fechaDeMeta(ultimaMeta);
    const hash = ultimaMeta && typeof ultimaMeta.sha256 === "string" && ultimaMeta.sha256
      ? ultimaMeta.sha256.slice(0, 12) : "";
    for (const id of ["previa-usar-ultima", "vista-usar-ultima"]) {
      const boton = el(id);
      if (!boton) continue;
      boton.textContent = hay ? "Usar última APK" : "Usar última APK · sin copia";
      boton.title = hay
        ? "Ejecutar el emulador con la apk guardada" + (fecha ? " el " + fecha : "") +
          (hash ? " (sha256 " + hash + "…)" : "") + ", sin compilar"
        : "Todavía no hay una copia: compila una vez y el build la guardará";
      boton.setAttribute("aria-label", boton.title);
    }
    return hay;
  }

  async function ejecutarPreviewDe(ruta) {
    const fuente = ruta === RUTA_ULTIMA_APK ? "ultima" : "build";
    // un build o la última apk reemplazan el modelo: el resultado del arrastre anterior ya no vale
    cerrarProgresoApk();
    origenPrevia = fuente;
    try {
      await hospedador.cwd(carpeta);
      const r = await hospedador.ejecutar(["preview", ruta]);
      const modelo = modeloDeSalida(r && r.consola);
      if (!modelo) {
        const lineas = String((r && (r.error || r.consola)) || "").trim().split("\n").filter(Boolean);
        const motivo = lineas.length ? lineas[lineas.length - 1].trim() : "";
        mensajeEmulador("apkc preview no devolvió un modelo legible" + (motivo ? ": " + motivo : "."));
        return null;
      }
      apkActual = fuente === "ultima" ? RUTA_ULTIMA_APK : "build/app.apk";
      return pintarVistaPrevia(modelo);
    } catch (e) {
      mensajeEmulador("no se pudo leer la última apk: " + (e && e.message ? e.message : e));
      return null;
    } finally {
      origenPrevia = "build";
    }
  }

  // Abre un `.apk` que el usuario soltó sobre el canvas del emulador. El fichero se guarda en la
  // zona aislada de OPFS y se le pasa a `apkc preview` tal cual: el mismo comando que lee
  // `build/app.apk`, sin descomprimir a mano ni ejecutar nada del sistema. Un apk válido pero de una
  // app que construye sus vistas en código (sin `res/layout`) se publica como frontera con el
  // motivo que da `preview`; no se finge una pantalla vacía. Todo el camino —carga, rechazo y
  // error— deja su rastro en el marco del teléfono, en la línea de estado y en el registro.
  async function abrirApkSoltada(archivo) {
    if (!archivo) return null;
    const nombre = String(archivo.name || "el apk");
    const token = empezarProgresoApk("Abriendo " + nombre + "…");
    mensajeEmulador("Abriendo " + nombre + "…");
    registrarSoltada("Abriendo " + nombre + "…", "aviso");
    // cierra una carga con su mensaje en los tres sitios: el marco del teléfono, la línea de estado
    // y el registro. `pintarLog` repinta la lista cuando llega un modelo, así que el resultado se
    // apunta siempre después de pintar.
    const fallar = async (texto) => {
      mensajeEmulador(texto);
      registrarSoltada(texto, "peligro");
      await terminarProgresoApk(token, texto, "error");
      return null;
    };
    let bytes;
    try {
      bytes = new Uint8Array(await archivo.arrayBuffer());
    } catch (e) {
      return fallar("no se pudo leer " + nombre + ": " + (e && e.message ? e.message : e));
    }
    const rechazo = mensajeApkRechazado(nombre, bytes);
    if (rechazo) return fallar(rechazo);
    let escrito;
    try {
      escrito = await hospedador.escribir(RUTA_APK_SOLTADA, bytes);
    } catch (e) {
      return fallar("no se pudo guardar " + nombre + " en la zona de prueba: " +
        (e && e.message ? e.message : e));
    }
    if (escrito && escrito.tipo === "error") {
      return fallar("no se pudo guardar " + nombre + ": " + escrito.error);
    }
    // cargar un apk es como encender el emulador con otra fuente: se apaga el negro, se empieza una
    // ejecución nueva y los clics anteriores dejan de valer
    apagado = false;
    guardarClave(CLAVE_ENERGIA, "encendido");
    actualizarEnergiaBotones();
    reiniciarGuion();
    rutaApkSoltada = RUTA_APK_SOLTADA;
    for (const superficie of SUPERFICIES) limpiarCanvas(el(superficie.canvasRender));
    mensajeEmulador("Abriendo " + nombre + "…");
    origenPrevia = "soltada";
    try {
      await hospedador.cwd(carpeta);
      const r = await hospedador.ejecutar(["preview", RUTA_APK_SOLTADA]);
      const modelo = modeloDeSalida(r && r.consola);
      if (!modelo) {
        const lineas = String((r && (r.error || r.consola)) || "").trim().split("\n").filter(Boolean);
        const porque = lineas.length ? lineas[lineas.length - 1].trim() : "no devolvió un modelo legible";
        return fallar("no se pudo abrir " + nombre + ": " + porque);
      }
      const pintado = pintarVistaPrevia(modelo);
      const ejecucion = modelo.ejecucion;
      const frontera = ejecucion && ejecucion.error ? " · código no ejecutado: " + ejecucion.error : "";
      const resultado = "APK soltado " + nombre + ": " + textoDelModelo(modelo) + frontera;
      mensajeVistaPreviaRender(resultado);
      registrarSoltada(resultado, "aviso");
      await terminarProgresoApk(token, resultado, "listo");
      return pintado;
    } catch (e) {
      return fallar("no se pudo abrir " + nombre + ": " + (e && e.message ? e.message : e));
    } finally {
      origenPrevia = "build";
    }
  }

  // Enciende desde la copia estable. Si no hay copia no compila por su cuenta: lo dice y se queda
  // apagado, que es más honesto que inventar una pantalla.
  async function encenderDesdeUltima({ apagarSiNoHay = false } = {}) {
    let ultima;
    try {
      ultima = await leerUltimaApk(hospedador);
    } catch (e) {
      ultima = { hay: false, meta: null, bytes: 0 };
    }
    ultimaMeta = ultima.hay ? ultima.meta : null;
    if (!ultima.hay) {
      if (apagarSiNoHay) {
        apagado = true;
        guardarClave(CLAVE_ENERGIA, "apagado");
        actualizarEnergiaBotones();
        pintarRender();
      }
      mensajeEmulador(MENSAJE_SIN_ULTIMA);
      return null;
    }
    apagado = false;
    guardarClave(CLAVE_ENERGIA, "encendido");
    actualizarEnergiaBotones();
    reiniciarGuion();
    limpiarLog("Encendiendo desde la última APK guardada…");
    mensajeEmulador("Encendiendo desde la última APK guardada…");
    return ejecutarPreviewDe(RUTA_ULTIMA_APK);
  }

  async function aplicarEnergia(encendido, persistir = true) {
    apagado = !encendido;
    if (persistir) guardarClave(CLAVE_ENERGIA, apagado ? "apagado" : "encendido");
    actualizarEnergiaBotones();
    if (apagado) {
      // apagar no ejecuta ni borra la última apk: solo deja el lienzo en negro. El campo de texto
      // se cierra y lo tecleado deja de valer, como el foco de un dispositivo que se apaga.
      cerrarCampoTexto(false);
      textosEscritos.clear();
      cerrarProgresoApk();
      mensajeEmulador(MENSAJE_APAGADO);
      pintarRender();
      return null;
    }
    return encenderDesdeUltima({ apagarSiNoHay: true });
  }

  // Reiniciar es el ciclo del DISPOSITIVO: se limpia la pantalla y el registro y se vuelve a
  // ejecutar desde `onCreate`. No es `--recrear`, que gira la actividad conservando su Bundle.
  async function reiniciarEmulador() {
    let ultima;
    try {
      ultima = await leerUltimaApk(hospedador);
    } catch (e) {
      ultima = { hay: false, meta: null, bytes: 0 };
    }
    ultimaMeta = ultima.hay ? ultima.meta : null;
    if (!ultima.hay) {
      mensajeEmulador(MENSAJE_SIN_ULTIMA);
      return null;
    }
    apagado = false;
    guardarClave(CLAVE_ENERGIA, "encendido");
    actualizarEnergiaBotones();
    reiniciarGuion();
    apkActual = RUTA_ULTIMA_APK;
    limpiarLog("Reiniciando el emulador desde onCreate…");
    for (const superficie of SUPERFICIES) limpiarCanvas(el(superficie.canvasRender));
    mensajeEmulador("Reiniciando el emulador desde onCreate…");
    return ejecutarPreviewDe(RUTA_ULTIMA_APK);
  }

  function presetDe(ancho, alto) {
    for (const [clave, valor] of Object.entries(PANTALLAS)) {
      if (valor.ancho === ancho && valor.alto === alto) return clave;
    }
    return "personalizado";
  }

  function aplicarPantalla(datos, persistir = true) {
    const ancho = Math.max(200, Math.min(1600, Math.round(Number(datos && datos.ancho) || PANTALLA_POR_DEFECTO.ancho)));
    const alto = Math.max(240, Math.min(2000, Math.round(Number(datos && datos.alto) || PANTALLA_POR_DEFECTO.alto)));
    pantalla = { ancho, alto };
    if (persistir) guardarPantalla();
    const preset = presetDe(ancho, alto);
    for (const [idSelect, idPersonalizada, idAncho, idAlto] of [
      ["previa-pantalla-tamano", "previa-pantalla-personalizada", "previa-pantalla-ancho", "previa-pantalla-alto"],
      ["vista-pantalla-tamano", "vista-pantalla-personalizada", "vista-pantalla-ancho", "vista-pantalla-alto"],
    ]) {
      const select = el(idSelect);
      if (select) select.value = preset;
      const personalizada = el(idPersonalizada);
      if (personalizada) personalizada.hidden = preset !== "personalizado";
      const campoAncho = el(idAncho);
      if (campoAncho && document.activeElement !== campoAncho) campoAncho.value = String(ancho);
      const campoAlto = el(idAlto);
      if (campoAlto && document.activeElement !== campoAlto) campoAlto.value = String(alto);
    }
    ajustarPantallas();
    // mismo modelo, otro lienzo: se repinta sin lanzar `apkc preview`
    pintarRender();
  }

  function aplicarCompleta(superficie, valor) {
    completa[superficie] = !!valor;
    const contenedor = superficie === "panel" ? el("previa-render") : el("vista-cuerpo");
    if (contenedor) contenedor.classList.toggle("pantalla-completa", completa[superficie]);
    const entrar = el(superficie === "panel" ? "previa-pantalla-completa" : "vista-pantalla-completa");
    const salir = el(superficie === "panel" ? "previa-salir-completa" : "vista-salir-completa");
    if (entrar) entrar.hidden = completa[superficie];
    if (salir) salir.hidden = !completa[superficie];
    const ajustar = () => { ajustarPantallas(); pintarRender(); };
    // se ajusta ya (leer clientWidth fuerza el layout con la clase puesta) y otra vez en el
    // siguiente cuadro por si el navegador termina de medir la superficie fija
    ajustar();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(ajustar);
  }

  function aplicarInspector(superficie, abierto, persistir = true) {
    inspectorAbierto[superficie] = !!abierto;
    // abrir o cerrar la capa es un gesto de la consola: no puede reescalar el lienzo
    if (persistir) pausarAjusteCanvas();
    const contenedor = superficie === "panel" ? el("previa-inspector") : el("marco-vista-lado");
    const abrir = el(superficie === "panel" ? "previa-inspector-abrir" : "vista-inspector-abrir");
    if (contenedor) contenedor.hidden = !abierto;
    if (abrir) abrir.hidden = !!abierto;
    // al reabrir una capa se reaplica su modo: pudo cambiar el tamaño de la ventana mientras estaba
    // cerrada, y su posición libre tiene que seguir dentro de los bordes. Si se cerró plegada,
    // reabrirla la despliega: el botón dice «Registro y consola», no «pastilla».
    if (abierto) {
      const estado = FLOTANTES[superficie].estado;
      if (estado.modo === MODO_MINIMIZADO) {
        estado.modo = estado.anterior === MODO_ACOPLADO ? MODO_ACOPLADO : MODO_LIBRE;
      }
      aplicarModoFlotante(superficie, false);
    }
    if (persistir) {
      guardarClave(superficie === "panel" ? CLAVE_INSPECTOR_PANEL : CLAVE_INSPECTOR_VISTA,
        abierto ? "1" : "0");
    }
  }

  // Arrastre de una capa desprendida. Se mueve por toda la ventana (coordenadas de viewport, no
  // del padre) y se acota a sus bordes; arrastrar una acoplada la desprende sin saltar. El gesto
  // empieza solo en el asa: el resto de la cabecera deja pasar el clic al canvas que hay debajo.
  // No reordena ni recrea nada: el modelo, la sección activa y el scroll se conservan.
  function conectarFlotante(nombre) {
    const f = FLOTANTES[nombre];
    const estado = f.estado;
    const contenedor = f.contenedor();
    if (!contenedor) return;
    const asa = el(f.ids.asidero);
    if (!asa) return;
    const cabecera = contenedor.querySelector(".previa-inspector-cab");
    let mover = null;

    const restaurar = () => {
      estado.modo = estado.anterior === MODO_ACOPLADO ? MODO_ACOPLADO : MODO_LIBRE;
      pausarAjusteCanvas();
      aplicarModoFlotante(nombre, true);
    };
    const minimizar = () => {
      if (estado.modo === MODO_MINIMIZADO) { restaurar(); return; }
      estado.anterior = estado.modo;
      estado.modo = MODO_MINIMIZADO;
      pausarAjusteCanvas();
      aplicarModoFlotante(nombre, true);
    };
    // El mismo botón es reversible: si la capa ya está en ese borde, vuelve a flotar. El botón
    // «Soltar» hace lo mismo sin necesidad de acordarse de dónde estaba acoplada.
    const acoplar = (borde) => {
      if (estado.modo === MODO_ACOPLADO && estado.borde === borde) {
        aplicarModoFlotantePorModo(nombre, MODO_LIBRE);
      } else {
        aplicarModoFlotantePorModo(nombre, MODO_ACOPLADO, borde);
      }
    };

    asa.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (estado.modo === MODO_MINIMIZADO) return;
      const caja = contenedor.getBoundingClientRect();
      if (estado.modo === MODO_ACOPLADO) {
        // se queda donde estaba y pasa a libre: el primer movimiento no da un salto
        estado.modo = MODO_LIBRE;
        estado.x = Math.round(caja.left);
        estado.y = Math.round(caja.top);
        aplicarModoFlotante(nombre, false);
      }
      mover = {
        x: e.clientX, y: e.clientY,
        left: caja.left, top: caja.top,
        ancho: caja.width, alto: caja.height,
      };
      try { asa.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
      e.preventDefault();
    });

    document.addEventListener("pointermove", (e) => {
      if (!mover) return;
      // mover la capa es un gesto: tampoco puede reescalar el lienzo mientras se arrastra
      pausarAjusteCanvas();
      const medidas = ventana();
      estado.x = Math.round(acotar(mover.left + e.clientX - mover.x, 0,
        Math.max(0, medidas.ancho - mover.ancho)));
      estado.y = Math.round(acotar(mover.top + e.clientY - mover.y, 0,
        Math.max(0, medidas.alto - mover.alto)));
      contenedor.style.left = estado.x + "px";
      contenedor.style.top = estado.y + "px";
      contenedor.style.right = "auto";
      contenedor.style.bottom = "auto";
      e.preventDefault();
    });

    const soltar = () => {
      if (!mover) return;
      mover = null;
      pausarAjusteCanvas();
      aplicarModoFlotante(nombre, true);
    };
    document.addEventListener("pointerup", soltar);
    document.addEventListener("pointercancel", soltar);

    // con la pastilla, un clic en la cabecera la despliega: el hueco, el título y el asa; los demás
    // botones conservan su acción
    if (cabecera) {
      cabecera.addEventListener("click", (e) => {
        if (estado.modo !== MODO_MINIMIZADO) return;
        const boton = e.target && typeof e.target.closest === "function" ? e.target.closest("button") : null;
        if (boton && boton !== asa) return;
        restaurar();
      });
    }

    const botonMinimizar = el(f.ids.minimizar);
    if (botonMinimizar) {
      botonMinimizar.addEventListener("click", () => {
        if (estado.modo === MODO_MINIMIZADO) restaurar(); else minimizar();
      });
    }
    for (const borde of BORDES) {
      const boton = el(f.ids[borde]);
      if (boton) boton.addEventListener("click", () => acoplar(borde));
    }
    const botonSoltar = el(f.ids.soltar);
    if (botonSoltar) {
      botonSoltar.addEventListener("click", () => aplicarModoFlotantePorModo(nombre, MODO_LIBRE));
    }

    // al cambiar el tamaño de la ventana, la capa libre se recorta a los bordes nuevos
    if (typeof window !== "undefined") {
      window.addEventListener("resize", () => aplicarModoFlotante(nombre, false));
    }
  }

  function conectarControles() {
    for (const superficie of ["panel", "vista"]) {
      const prefijo = superficie === "panel" ? "previa" : "vista";
      const energia = el(prefijo + "-energia");
      if (energia) energia.addEventListener("click", () => aplicarEnergia(apagado));
      const reiniciar = el(prefijo + "-reiniciar");
      if (reiniciar) reiniciar.addEventListener("click", () => reiniciarEmulador());
      const ultima = el(prefijo + "-usar-ultima");
      if (ultima) ultima.addEventListener("click", () => encenderDesdeUltima());
      const select = el(prefijo + "-pantalla-tamano");
      if (select) select.addEventListener("change", () => {
        if (select.value === "personalizado") {
          // mostrar los dos campos no cambia el lienzo ni el modelo; solo deja editar el tamaño
          for (const pref of ["previa", "vista"]) {
            const otro = el(pref + "-pantalla-tamano");
            if (otro) otro.value = "personalizado";
            const campos = el(pref + "-pantalla-personalizada");
            if (campos) campos.hidden = false;
          }
          return;
        }
        const preset = PANTALLAS[select.value];
        if (preset) aplicarPantalla(preset, true);
      });
      for (const eje of ["ancho", "alto"]) {
        const campo = el(prefijo + "-pantalla-" + eje);
        if (!campo) continue;
        campo.addEventListener("change", () => {
          const ancho = Number(el(prefijo + "-pantalla-ancho")?.value) || pantalla.ancho;
          const alto = Number(el(prefijo + "-pantalla-alto")?.value) || pantalla.alto;
          aplicarPantalla({ ancho, alto }, true);
        });
      }
      const entrar = el(prefijo + "-pantalla-completa");
      if (entrar) entrar.addEventListener("click", () => aplicarCompleta(superficie, true));
      const salir = el(prefijo + "-salir-completa");
      if (salir) salir.addEventListener("click", () => aplicarCompleta(superficie, false));
      const cerrar = el(prefijo + "-inspector-cerrar");
      if (cerrar) cerrar.addEventListener("click", () => aplicarInspector(superficie, false));
      const abrir = el(prefijo + "-inspector-abrir");
      if (abrir) abrir.addEventListener("click", () => aplicarInspector(superficie, true));
    }
    conectarFlotante("panel");
    conectarFlotante("vista");
    // una pantalla completa no puede sobrevivir a cambiar de vista: taparía la vista nueva
    if (typeof MutationObserver === "function" && document.body) {
      new MutationObserver(() => {
        const vista = document.body.dataset.vista;
        if (vista !== "pestana" && completa.panel) aplicarCompleta("panel", false);
        if (vista !== "vista" && completa.vista) aplicarCompleta("vista", false);
      }).observe(document.body, { attributes: true, attributeFilter: ["data-vista"] });
    }
    document.addEventListener(EVENTO_ULTIMA_APK, () => { actualizarUltima(); });
  }

  // --- la entrada de texto del emulador -----------------------------------------------------
  // El EditText del canvas no es un elemento editable: es un rectángulo dibujado. Para que el
  // teclado del dispositivo funcione se abre un `<input>` real, oculto el resto del tiempo, sobre
  // la caja del nodo. Lo que teclea el usuario NO toca el XML: es estado de la ejecución y se
  // entrega a `apkc preview` con `--escribir`, que también lo publica en `textoDinamico`.
  function rectDeIdRef(canvas, idRef) {
    if (!canvas || !idRef) return null;
    const espacio = canvas.__espacio || { ancho: 0, alto: 0 };
    if (!(espacio.ancho > 0) || !(espacio.alto > 0)) return null;
    const modelo = modeloParaEmulador();
    if (!modelo) return null;
    return rectsEscalados(modelo, espacio.ancho, espacio.alto).find((r) => r.idRef === idRef) || null;
  }

  // El texto con el que se abre el campo: lo ya tecleado en esta ejecución, o lo que el modelo
  // muestra (el dinámico si la app escribió algo, el del layout si no).
  function textoInicialDe(idRef) {
    if (textosEscritos.has(idRef)) return textosEscritos.get(idRef);
    for (const { nodo } of nodosAplanados(modeloActual())) {
      if (nodo && nodo.idRef === idRef) return textoDeNodo(nodo);
    }
    return "";
  }

  function colocarCampoTexto() {
    if (!campoTexto || !focoTexto || campoTexto.hidden) return;
    const { canvas, idRef } = focoTexto;
    const r = rectDeIdRef(canvas, idRef);
    if (!r) { cerrarCampoTexto(); return; }
    const espacio = canvas.__espacio || { ancho: 0, alto: 0 };
    const caja = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect() : null;
    if (!caja || !(caja.width > 0) || !(caja.height > 0)) return;
    const sx = caja.width / espacio.ancho;
    const sy = caja.height / espacio.alto;
    campoTexto.style.left = (caja.left + r.x * sx) + "px";
    campoTexto.style.top = (caja.top + r.y * sy) + "px";
    campoTexto.style.width = Math.max(24, r.ancho * sx) + "px";
    campoTexto.style.height = Math.max(18, r.alto * sy) + "px";
    campoTexto.style.fontSize = Math.max(12, Math.min(28, r.alto * sy * 0.7)) + "px";
  }

  // Cerrar es perder el foco, no descartar lo tecleado: si quedaba una escritura aplazada se entrega
  // antes. El campo se oculta y se le quita el foco; `focoTexto` se limpia ANTES del `blur` para que
  // el manejador no vuelva a entrar aquí.
  function cerrarCampoTexto(entregar = true) {
    if (!campoTexto || !focoTexto) return;
    if (temporizadorEscritura) {
      clearTimeout(temporizadorEscritura);
      temporizadorEscritura = 0;
      // un reinicio o un apagado descarta la escritura pendiente: entregarla ejecutaría `--escribir`
      // sobre una apk que ya no es la que hay en pantalla
      if (entregar) escribirAhora();
    }
    const activo = typeof document !== "undefined" && document.activeElement === campoTexto;
    campoTexto.hidden = true;
    focoTexto = null;
    if (activo) campoTexto.blur();
  }

  // Entrega el texto final al intérprete repitiendo el guion completo. Solo se fusiona con el último
  // paso si ese paso es un `--escribir` del MISMO EditText: así teclear después de un clic no mueve
  // la escritura por delante del clic, y dos EditText distintos conservan cada uno su texto.
  async function enviarEscritura(idRef, valor) {
    if (apagado || pulsando || typeof idRef !== "string" || !idRef) return null;
    textosEscritos.set(idRef, valor);
    const ultimo = guion[guion.length - 1];
    if (ultimo && ultimo.tipo === "escribir" && ultimo.idRef === idRef) ultimo.valor = valor;
    else guion.push({ tipo: "escribir", idRef, valor });
    const copia = guion.map((p) => ({ ...p }));
    const pintado = await ejecutaGuion(0, "Escribiendo en " + idRef + "…");
    if (!pintado) {
      // `ejecutaGuion` descarta el guion desde cero al fallar; aquí solo falló la escritura, así
      // que se devuelven los clics y los textos anteriores tal como estaban.
      guion.length = 0;
      guion.push(...copia);
      textosEscritos.delete(idRef);
    }
    return pintado;
  }

  function escribirAhora() {
    return focoTexto ? enviarEscritura(focoTexto.idRef, focoTexto.valor) : Promise.resolve(null);
  }

  function programarEscritura() {
    if (temporizadorEscritura) clearTimeout(temporizadorEscritura);
    temporizadorEscritura = setTimeout(() => {
      temporizadorEscritura = 0;
      escribirAhora();
    }, ESPERA_ESCRITURA);
  }

  function abrirCampoTexto(canvas, rect, evento) {
    if (!campoTexto || apagado || pulsando || !rect || !rect.idRef) return;
    if (focoTexto && focoTexto.idRef !== rect.idRef) cerrarCampoTexto();
    focoTexto = { canvas, idRef: rect.idRef, valor: textoInicialDe(rect.idRef) };
    campoTexto.value = focoTexto.valor;
    campoTexto.hidden = false;
    campoTexto.setAttribute("aria-label", "Texto del EditText " + rect.idRef + " del emulador");
    // el mismo `pointerdown` sube al documento: sin esta marca el cierre de «toca fuera» lo cerraría
    ignorarCierreTexto = evento || null;
    colocarCampoTexto();
    campoTexto.focus();
    if (typeof campoTexto.setSelectionRange === "function") {
      const fin = campoTexto.value.length;
      campoTexto.setSelectionRange(fin, fin);
    }
  }

  function montarCampoTexto() {
    if (!conDocumento() || campoTexto) return;
    const campo = document.createElement("input");
    campo.type = "text";
    campo.className = "previa-campo-texto";
    campo.autocomplete = "off";
    campo.spellcheck = false;
    campo.hidden = true;
    campo.setAttribute("aria-label", "Texto del EditText del emulador");
    document.body.appendChild(campo);
    campo.addEventListener("input", () => {
      if (!focoTexto) return;
      focoTexto.valor = campo.value;
      programarEscritura();
    });
    campo.addEventListener("keydown", (e) => {
      if (!focoTexto) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (temporizadorEscritura) { clearTimeout(temporizadorEscritura); temporizadorEscritura = 0; }
        escribirAhora();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cerrarCampoTexto();
      }
    });
    // el IME dispara `input` igual que el teclado físico; `compositionend` solo asegura que un
    // carácter pendiente quede contado si el navegador no emitió `input` al cerrar la composición
    campo.addEventListener("compositionend", () => {
      if (focoTexto) { focoTexto.valor = campo.value; programarEscritura(); }
    });
    campo.addEventListener("blur", () => { if (focoTexto) cerrarCampoTexto(); });
    campoTexto = campo;
  }

  // Un clic en el canvas se traduce a la vista que hay debajo, en las coordenadas lógicas del
  // panel. Si esa vista no tiene listener, el clic no hace nada (y no se inventa un aviso). Los dos
  // canvas —el del panel de la vista dividida y el de Pantalla— se conectan igual.
  function conectarCanvas(idCanvas) {
    const canvas = document.getElementById(idCanvas || "previa-lateral-canvas");
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
      // el mismo modelo reescalado que se pintó: con el tamaño de pantalla elegido, el modelo
      // original no comparte la caja y el clic caería en otro nodo
      if (apagado) return;
      const modelo = modeloParaEmulador();
      // Un EditText se queda con el toque: se abre el campo real y NO se entrega el clic al
      // contenedor que pueda tener listener, igual que en el framework.
      const editable = editableEnPunto(modelo, ancho, alto, x, y);
      if (editable) {
        e.preventDefault();
        abrirCampoTexto(canvas, editable, e);
        return;
      }
      cerrarCampoTexto();
      const nodo = oyenteEnPunto(modelo, ancho, alto, x, y);
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
      // el nodo seleccionado se marca en las dos superficies: el modelo es uno y el dibujo tiene
      // que contarlo igual en el panel del editor y en Pantalla
      if (editando && seleccion) {
        const nodo = nodoPorRuta(modeloVivo.raiz, seleccion);
        if (nodo && nodo.rect) dibujarContorno(canvas, cajaDeCanvas(canvas, modeloVivo), nodo.rect, false);
      }
      const estado = el(superficie.estadoVivo);
      if (estado && pintado && pintado.valida === false) {
        estado.textContent = "El layout no cabe en la caja del panel; se dibuja a tamaño de respaldo.";
      }
      if (!primero) primero = pintado;
    }
    actualizarPaleta();
    actualizarEstadoEdicion();
    actualizarPropiedades();
    actualizarJerarquia();
    return primero;
  }

  // La línea de estado del emulador en las dos superficies, sin depender de si hay modelo.
  function mensajeEmulador(texto) {
    for (const superficie of SUPERFICIES) {
      const estado = superficie.estadoRender ? el(superficie.estadoRender) : null;
      if (estado) estado.textContent = texto;
    }
    detalleEmulador(texto);
  }

  function cajaUtil(marco) {
    if (!marco || typeof getComputedStyle !== "function") return null;
    const cs = getComputedStyle(marco);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const ancho = marco.clientWidth - pl - pr;
    const alto = marco.clientHeight - pt - pb;
    return ancho > 0 && alto > 0 ? { ancho, alto } : null;
  }

  // Ajusta el canvas a la relación del tamaño elegido dentro de su marco. Se hace con píxeles
  // explícitos para que la relación no dependa de cómo negocie el navegador `aspect-ratio`; así el
  // modelo y el lienzo dicen lo mismo y el dibujo no se deforma.
  function ajustarCanvas(canvas, anchoDp, altoDp) {
    if (!canvas) return;
    const marco = canvas.parentElement;
    const caja = cajaUtil(marco);
    if (!caja) return;
    // la misma caja y el mismo tamaño de pantalla dan el mismo lienzo: repetir el ajuste por un
    // aviso de tamaño que no cambió nada movería el dibujo sin motivo (un cambio de capa lo provoca)
    const clave = caja.ancho + "x" + caja.alto + "|" + anchoDp + "x" + altoDp;
    if (medidasCanvasAplicadas.get(canvas) === clave) return;
    medidasCanvasAplicadas.set(canvas, clave);
    const relacion = anchoDp / altoDp;
    let ancho = caja.ancho;
    let alto = ancho / relacion;
    if (alto > caja.alto) { alto = caja.alto; ancho = alto * relacion; }
    ancho = Math.max(1, Math.floor(ancho));
    alto = Math.max(1, Math.floor(alto));
    if (canvas.style.width !== ancho + "px") canvas.style.width = ancho + "px";
    if (canvas.style.height !== alto + "px") canvas.style.height = alto + "px";
  }

  function ajustarPantallas() {
    ajustarCanvas(el("previa-lateral-canvas"), pantalla.ancho, pantalla.alto);
    ajustarCanvas(el("vista-previa"), pantalla.ancho, pantalla.alto);
  }

  // Pausa el ajuste del lienzo mientras dura un gesto de la consola. El aviso del observador llega
  // después de pintar, así que la pausa se levanta dos cuadros más tarde (y el turno invalida las
  // pausas viejas si el gesto se repite, como en un arrastre).
  function pausarAjusteCanvas() {
    const turno = ++turnoPausa;
    pausaCanvas = true;
    if (typeof requestAnimationFrame !== "function") { pausaCanvas = false; return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const soltar = () => { if (turno === turnoPausa) pausaCanvas = false; };
      if (typeof setTimeout === "function") setTimeout(soltar, 0); else soltar();
    }));
  }

  // La pantalla apagada: un lienzo negro con el rótulo, sin tocar la última apk ni el modelo que
  // quedó en memoria. Encender vuelve a pedir `apkc preview` y pinta lo que devuelva.
  function dibujarApagado(canvas) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ancho = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
    const alto = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
    const dpr = typeof window !== "undefined" && window.devicePixelRatio
      ? Math.min(2, Math.max(1, window.devicePixelRatio)) : 1;
    if (canvas.width !== Math.round(ancho * dpr) || canvas.height !== Math.round(alto * dpr)) {
      canvas.width = Math.round(ancho * dpr);
      canvas.height = Math.round(alto * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, ancho, alto);
    canvas.__espacio = { ancho, alto };
    if (canvas.dataset) canvas.dataset.nodos = "";
  }

  function modeloParaEmulador() {
    const modelo = modeloActual();
    if (!modelo) return null;
    return modeloConPantalla(modelo, pantalla.ancho, pantalla.alto);
  }

  function pintarRender(motivo) {
    if (!conDocumento()) return null;
    if (apagado) cerrarCampoTexto();
    if (!apagado) ajustarPantallas();
    const modelo = apagado ? null : modeloParaEmulador();
    let primero = null;
    for (const superficie of SUPERFICIES) {
      const canvas = el(superficie.canvasRender);
      if (!canvas) continue;
      const estado = superficie.estadoRender ? el(superficie.estadoRender) : null;
      if (apagado) {
        dibujarApagado(canvas);
        if (estado) estado.textContent = MENSAJE_APAGADO;
        detalleEmulador(MENSAJE_APAGADO);
        continue;
      }
      if (!modelo) {
        // el motivo del último fallo viene del evento: «no hay apk», «el preview falló» o el de arranque
        limpiarCanvas(canvas);
        if (estado) estado.textContent = motivo || MENSAJE_SIN_MODELO;
        detalleEmulador(motivo || MENSAJE_SIN_MODELO);
        continue;
      }
      const pintado = pintarModelo(canvas, modelo);
      // El clic mide en el espacio con el que se pintó, no en el clientWidth del momento: si el panel
      // cambió de tamaño entre pintar y pulsar, el punto se desalinearía con los píxeles visibles.
      if (pintado && pintado.ancho > 0 && pintado.alto > 0) {
        canvas.__espacio = { ancho: pintado.ancho, alto: pintado.alto };
      }
      if (estado) {
        // la misma línea que escribe `vista-previa.js` para Pantalla, más el recordatorio del clic:
        // las dos superficies dicen lo mismo del mismo modelo. Este párrafo está fuera del flujo
        // (`.previa-estado-oculto`); el texto visible va a la capa flotante y al `title`.
        estado.textContent = textoDelModelo(modelo) + " Arranca en onCreate: pulsa una vista para " +
          "ejecutar su OnClickListener; se actualiza al compilar.";
        if (pintado && pintado.valida === false) {
          estado.textContent = "El modelo de vista previa no trae una pantalla medible (ancho o alto no " +
            "finitos); no se pinta nada.";
        }
        detalleEmulador(estado.textContent);
      }
      if (!primero) primero = pintado;
    }
    if (modelo) {
      pintarLog(modelo);
      pintarConsola(modelo);
      pintarOyentes(modelo);
    } else if (!apagado) {
      limpiarLog(motivo || MENSAJE_SIN_MODELO);
      pintarConsola(modelo);
      pintarOyentes(modelo);
    }
    // el menú de opciones sale del modelo, no del árbol: sin ejecución se cierra en vez de quedarse
    // con los ítems de una pantalla anterior
    pintarMenu(modelo);
    // el Toast es una capa efímera: se enseña sobre el teléfono y se retira solo; la consola conserva
    // todas sus líneas
    pintarToast(modelo);
    // el rect del EditText puede moverse al cambiar el tamaño de pantalla o el del panel; el campo
    // sigue al nodo pintado mientras tenga el foco
    colocarCampoTexto();
    return primero;
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
    colores = null;
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

  // Los colores de `res/values*/colors.xml`, con la misma caché que los `@string`. Sirven para que
  // un `android:background="@color/azul"` se vea en el dibujo sin compilar.
  async function coloresDelProyecto() {
    const ahora = Date.now();
    if (colores && ahora - coloresEn < 5000) return colores;
    const nodos = await nodosDelProyecto();
    const mapa = Object.create(null);
    for (const ruta of nodos.filter((r) => /\/res\/values[^/]*\/colors\.xml$/.test(r))) {
      try {
        const texto = await hospedador.texto(ruta);
        for (const m of String(texto).matchAll(/<color\s+name="([^"]+)"[^>]*>([^<]*)<\/color>/g)) {
          if (!(m[1] in mapa)) mapa[m[1]] = decodificarEntidades(m[2]);
        }
      } catch (e) { /* un values ilegible no impide pintar los demás */ }
    }
    colores = mapa;
    coloresEn = ahora;
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
        actualizarPaleta();
        actualizarEstadoEdicion();
        actualizarPropiedades();
        return;
      }
    }
    if (turno !== turnoVivo) return;
    const stringsMap = await stringsDelProyecto();
    const coloresMap = await coloresDelProyecto();
    if (turno !== turnoVivo) return;
    const resultado = modeloDeLayout(texto, { layout: ruta, strings: stringsMap, colores: coloresMap });
    if (!resultado.ok) {
      // un XML a medias no borra la pantalla que ya estaba bien: se avisa y se conserva
      ponerEstadoVivo("XML inválido" + (resultado.linea ? " (línea " + resultado.linea + ")" : "") +
        ": se conserva el último render" + (rutaViva ? " de " + relativa(rutaViva) : "") + ".", true);
      actualizarPaleta();
      actualizarEstadoEdicion();
      actualizarPropiedades();
      return;
    }
    rutaViva = ruta;
    modeloVivo = resultado.modelo;
    estadoVivo(modeloVivo, ruta);
    await cargarImagenes(modeloVivo);
    pintarVivo();
  }

  function programarVivo(espera) {
    clearTimeout(temporizadorVivo);
    temporizadorVivo = setTimeout(() => {
      temporizadorVivo = 0;
      refrescarVivo().catch((e) => falloSilencioso("refrescar el modo vivo", e));
    }, typeof espera === "number" ? espera : ESPERA_TECLEO);
  }

  function conectarEntrada() {
    const codigo = el("codigo");
    if (codigo) {
      codigo.addEventListener("input", () => {
        // un `input` que no dejó el diseñador es una edición a mano del XML: su pila deja de valer
        // (el texto que esperaba ya no está). La comparación con el texto esperado no depende de
        // que el evento llegue antes o después de `EDITOR.cambiar`.
        if (editando && codigo.value !== textoDiseno) {
          pilaDeshacer = [];
          pilaRehacer = [];
          rutaHistorial = null;
          actualizarHistorialDiseno();
        }
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
      // un modelo que no viene de un clic es un build nuevo: la lista de clics vuelve a empezar.
      // Un repintado del mismo modelo que devolvió el clic (entrar en Pantalla, cambiar el tamaño,
      // mover la consola) llega con `pulsando` en false y NO puede borrar los clics ya entregados.
      if (reiniciaPulsos({ pulsando, modelo: detalle.modelo, modeloDeClics })) {
        reiniciarGuion();
        apkActual = origenPrevia === "ultima" ? RUTA_ULTIMA_APK
          : origenPrevia === "soltada" ? rutaApkSoltada : "build/app.apk";
      }
      // el modelo cambió: el canvas y los dos paneles se pintan ya. Un rAF dejaría la consola con
      // las capturas del build anterior justo cuando el preview falla, que es cuando más importa.
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
      const raiz = !seleccion.length;
      return "Seleccionado " + etiquetaDe(nodo) + (raiz ? " (layout raíz)" : "") +
        " · " + (raiz
          ? "cambia su tipo y sus propiedades en la ficha; no se borra."
          : "arrástralo para moverlo · Supr lo borra · Esc lo suelta.");
    }
    return "Clic en un elemento del dibujo para seleccionarlo; el hueco del layout selecciona la raíz. " +
      "Añade otros desde la paleta.";
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
    for (const boton of document.querySelectorAll("#previa-paleta button[data-tipo]")) boton.disabled = !puede;
  }

  // Aplica el XML nuevo al buffer. `editor.cambiar` devuelve el foco al textarea: en modo editar
  // se lo devolvemos al canvas para que Supr y Esc sigan funcionando sin volver a pulsar el nodo.
  // La ficha de propiedades pasa `enfocar: false`: el foco se queda en el campo que se está
  // editando y el canvas se repinta igual. Cada cambio del diseñador entra en su propia pila
  // (`pilaDeshacer`); `historial: false` lo usa el deshacer/rehacer para no apilar lo que revive.
  function aplicarXml(nuevo, mensaje, opciones) {
    if (!editor || typeof editor.texto !== "function") return false;
    const antes = String(editor.texto());
    if (nuevo === antes) {
      if (mensaje) avisarEdicion(mensaje);
      return false;
    }
    const d = diferencia(antes, nuevo);
    const registrar = !opciones || opciones.historial !== false;
    const seleccionAplicada = seleccion ? seleccion.slice() : null;
    // el texto esperado se pone ANTES de escribir: el `input` de `execCommand` llega de forma
    // sincrónica y, si el valor todavía fuera el viejo, la pila se limpiaría a sí misma
    const textoPrevio = textoDiseno;
    textoDiseno = nuevo;
    try {
      editor.cambiar(d.ini, d.fin, d.medio, [d.ini + d.medio.length, d.ini + d.medio.length]);
    } catch (e) {
      textoDiseno = textoPrevio;
      throw e;
    }
    if (registrar) {
      pilaDeshacer.push({ antes, despues: nuevo, seleccion: seleccionAplicada });
      pilaRehacer.length = 0;
      rutaHistorial = estadoPestana ? estadoPestana.ruta : null;
      actualizarHistorialDiseno();
    }
    if (!opciones || opciones.enfocar !== false) {
      const canvas = canvasVivo();
      if (canvas && typeof canvas.focus === "function") canvas.focus();
    }
    refrescarVivo().catch((e) => falloSilencioso("refrescar el modo vivo", e));
    if (mensaje) avisarEdicion(mensaje);
    return true;
  }

  function limpiarHistorialDiseno() {
    pilaDeshacer = [];
    pilaRehacer = [];
    textoDiseno = null;
    rutaHistorial = null;
    actualizarHistorialDiseno();
  }

  function actualizarHistorialDiseno() {
    if (!conDocumento()) return;
    const deshacerBoton = document.getElementById("previa-editar-deshacer");
    const rehacerBoton = document.getElementById("previa-editar-rehacer");
    if (deshacerBoton) deshacerBoton.disabled = !editando || !pilaDeshacer.length;
    if (rehacerBoton) rehacerBoton.disabled = !editando || !pilaRehacer.length;
    const eliminar = document.getElementById("previa-editar-eliminar");
    if (eliminar) eliminar.disabled = !editando;
  }

  // El historial solo vale mientras se edite el mismo fichero y nadie haya tocado el texto a mano;
  // si el fichero cambió, se avisa y se empieza de cero en vez de aplicar un XML de otro layout.
  function historialVigente() {
    if (!pilaDeshacer.length && !pilaRehacer.length) return true;
    if (!estadoPestana || !rutaHistorial || estadoPestana.ruta === rutaHistorial) return true;
    limpiarHistorialDiseno();
    avisarEdicion("El historial del diseño era de otro fichero: empieza de nuevo.");
    return false;
  }

  function focoDeDiseno() {
    const activo = document.activeElement;
    if (activo && activo !== document.body && document.contains(activo) &&
        typeof activo.focus === "function") return activo;
    return canvasVivo();
  }

  function deshacerDiseno() {
    if (!editando || !historialVigente()) return false;
    const paso = pilaDeshacer.pop();
    if (!paso) { avisarEdicion("No hay cambios del diseño que deshacer."); return false; }
    const foco = focoDeDiseno();
    pilaRehacer.push(paso);
    const previa = seleccion;
    seleccion = previa && (previa.length === 0 || leerPropiedades(paso.antes, previa).ok)
      ? previa.slice() : null;
    aplicarXml(paso.antes, "Deshecho el último cambio del diseño.",
      { enfocar: false, historial: false });
    actualizarHistorialDiseno();
    if (foco && document.contains(foco)) foco.focus();
    return true;
  }

  function rehacerDiseno() {
    if (!editando || !historialVigente()) return false;
    const paso = pilaRehacer.pop();
    if (!paso) { avisarEdicion("No hay cambios del diseño que rehacer."); return false; }
    const foco = focoDeDiseno();
    pilaDeshacer.push(paso);
    const objetivo = paso.seleccion;
    seleccion = objetivo && (objetivo.length === 0 || leerPropiedades(paso.despues, objetivo).ok)
      ? objetivo.slice() : null;
    aplicarXml(paso.despues, "Rehecho el último cambio del diseño.",
      { enfocar: false, historial: false });
    actualizarHistorialDiseno();
    if (foco && document.contains(foco)) foco.focus();
    return true;
  }

  function seleccionar(ruta) {
    // la raíz es la ruta vacía `[]`; `null` es «nada seleccionado»
    const limpia = Array.isArray(ruta) ? ruta.slice() : null;
    const igual = JSON.stringify(limpia) === JSON.stringify(seleccion);
    seleccion = limpia;
    if (!igual) { notaEdicion = ""; clavePropiedades = ""; }
    if (visible && modo === "vivo") pintarVivo();
    else { actualizarPaleta(); actualizarEstadoEdicion(); actualizarPropiedades(); actualizarJerarquia(); }
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

  // --- soltar un tipo de la paleta en el dibujo ----------------------------------------------
  // El clic añade al final (rápido y con teclado); arrastrar coloca donde se suelta: en un marco
  // con márgenes y en un lineal en la posición que marca el punto. Nada se escribe hasta soltar.
  const UMBRAL_PALETA = 5;

  function esContenedorNodo(nodo) {
    return contenedorDe(nodo) !== "";
  }

  function hijosDelModelo(nodo) {
    return (nodo && Array.isArray(nodo.hijos) ? nodo.hijos : []).filter((h) => h && h.tipo);
  }

  // El contenedor más profundo bajo el punto: si se suelta sobre una vista, su padre; si sobre un
  // marco o un lineal, ese mismo. La raíz siempre vale.
  function contenedorEn(modelo, x, y) {
    let ruta = [];
    const golpe = golpeEn(modelo, x, y);
    if (golpe) ruta = golpe.ruta.slice();
    while (ruta.length) {
      const nodo = nodoPorRuta(modelo.raiz, ruta);
      if (esContenedorNodo(nodo)) return { ruta, nodo };
      ruta = ruta.slice(0, -1);
    }
    return esContenedorNodo(modelo.raiz) ? { ruta: [], nodo: modelo.raiz } : null;
  }

  // Calcula el destino de un tipo soltado en (x, y) del modelo, con la MISMA lógica que usa el
  // soltar y la que pinta el indicador: contenedor, índice y márgenes. `forma` es "linea" para un
  // lineal o "marco" para el resto.
  function destinoDeSoltar(tipo, x, y) {
    const modelo = modeloVivo;
    if (!modelo) return { ok: false, motivo: "No hay un layout dibujado sobre el que soltar." };
    const destino = contenedorEn(modelo, x, y);
    if (!destino) return { ok: false, motivo: "La raíz no admite hijos: elige un contenedor." };
    const padre = destino.nodo;
    const opciones = { tipo, padre: destino.ruta };
    if (contenedorDe(padre) === "lineal") {
      // un lineal coloca en orden: el punto decide entre qué hermanos entra
      const vertical = atributoLocal(padre.atributos, "orientation") !== "horizontal";
      const pos = vertical ? y : x;
      let indice = 0;
      for (const hijo of hijosDelModelo(padre)) {
        const r = hijo.rect;
        if (!r || !Number.isFinite(r.x)) continue;
        const centro = vertical ? r.y + r.alto / 2 : r.x + r.ancho / 2;
        if (centro < pos) indice++;
      }
      opciones.indice = indice;
      return {
        ok: true, padre, padreRuta: destino.ruta, opciones, indice, forma: "linea", vertical,
        padding: paddingDe(padre), x, y,
      };
    }
    // un marco coloca con márgenes: el punto donde se suelta, respecto al contenido del padre
    const pad = paddingDe(padre);
    opciones.indice = hijosDelModelo(padre).length;
    opciones.margen = {
      izquierda: Math.max(0, x - (padre.rect.x + pad.izq)),
      arriba: Math.max(0, y - (padre.rect.y + pad.arriba)),
    };
    return {
      ok: true, padre, padreRuta: destino.ruta, opciones, indice: opciones.indice,
      forma: "marco", margen: opciones.margen, padding: pad, x, y,
    };
  }

  function anadirEn(tipo, x, y) {
    const motivo = motivoNoEditable();
    if (motivo) { avisarEdicion(motivo); return false; }
    const destino = destinoDeSoltar(tipo, x, y);
    if (!destino.ok) { avisarEdicion(destino.motivo); return false; }
    const r = insertarElemento(String(editor.texto()), destino.opciones);
    if (!r.ok) { avisarEdicion("No se pudo añadir: " + r.error); return false; }
    seleccion = r.ruta;
    notaEdicion = "";
    return aplicarXml(r.xml, "Añadido " + tipo + (r.id ? " (id/" + r.id + ")" : "") +
      (destino.padreRuta.length ? " dentro de " + etiquetaDe(destino.padre) : "") + ".");
  }

  // --- el indicador de destino mientras se arrastra ------------------------------------------
  // Es una capa DOM (no se pinta en el canvas): así no se mezcla con el modelo y se apaga sin
  // repintar. En un marco, un hueco del tamaño exacto con el que entrará el tipo (`tamanoDeTipo`,
  // el mismo que escribe `elementoDe`) recortado al canvas; en un lineal, una línea del ancho del
  // hermano de referencia, no de todo el contenedor. Se recalcula en cada `pointermove`.
  function ocultarDestino() {
    const linea = document.getElementById("previa-destino-linea");
    const hueco = document.getElementById("previa-destino-hueco");
    if (linea) linea.hidden = true;
    if (hueco) hueco.hidden = true;
  }

  function pintarDestino(tipo, x, y) {
    const canvas = canvasVivo();
    const modelo = modeloVivo;
    const linea = document.getElementById("previa-destino-linea");
    const hueco = document.getElementById("previa-destino-hueco");
    if (!canvas || !modelo || !linea || !hueco) { ocultarDestino(); return null; }
    const caja = cajaDeCanvas(canvas, modelo);
    if (!caja.valida) { ocultarDestino(); return null; }
    const destino = destinoDeSoltar(tipo, x, y);
    if (!destino.ok) { ocultarDestino(); return destino; }
    // el canvas puede tener borde: su caja de cliente empieza en `clientLeft/clientTop`
    const ox = canvas.offsetLeft + canvas.clientLeft;
    const oy = canvas.offsetTop + canvas.clientTop;
    const aPx = (mx, my) => ({
      x: ox + caja.x + mx * caja.escala,
      y: oy + caja.y + my * caja.escala,
    });
    const tamano = tamanoDeTipo(tipo) || { ancho: 48, alto: 24 };
    if (destino.forma === "linea") {
      const padre = destino.padre;
      const pad = destino.padding;
      const hijos = hijosDelModelo(padre);
      const r = padre.rect;
      // el hermano de referencia es el que se quedará detrás del nuevo; si no hay, el último. La
      // línea mide lo que mide ese hermano, no el contenedor entero.
      const ref = destino.indice < hijos.length ? hijos[destino.indice]
        : (hijos.length ? hijos[hijos.length - 1] : null);
      if (destino.vertical) {
        const yModelo = destino.indice < hijos.length && ref && ref.rect
          ? ref.rect.y
          : (ref && ref.rect ? ref.rect.y + ref.rect.alto : r.y + pad.arriba);
        const xIni = ref && ref.rect ? ref.rect.x : r.x + pad.izq;
        const ancho = ref && ref.rect ? ref.rect.ancho
          : Math.min(tamano.ancho, Math.max(8, r.ancho - pad.izq - pad.der));
        const desde = aPx(xIni, yModelo);
        const hasta = aPx(xIni + ancho, yModelo);
        linea.style.left = Math.round(desde.x) + "px";
        linea.style.top = Math.round(desde.y - 1) + "px";
        linea.style.width = Math.max(2, Math.round(hasta.x - desde.x)) + "px";
        linea.style.height = "3px";
      } else {
        const xModelo = destino.indice < hijos.length && ref && ref.rect
          ? ref.rect.x
          : (ref && ref.rect ? ref.rect.x + ref.rect.ancho : r.x + pad.izq);
        const yIni = ref && ref.rect ? ref.rect.y : r.y + pad.arriba;
        const alto = ref && ref.rect ? ref.rect.alto
          : Math.min(tamano.alto, Math.max(8, r.alto - pad.arriba - pad.abajo));
        const desde = aPx(xModelo, yIni);
        const hasta = aPx(xModelo, yIni + alto);
        linea.style.left = Math.round(desde.x - 1) + "px";
        linea.style.top = Math.round(desde.y) + "px";
        linea.style.width = "3px";
        linea.style.height = Math.max(2, Math.round(hasta.y - desde.y)) + "px";
      }
      linea.hidden = false;
      hueco.hidden = true;
      return destino;
    }
    const padre = destino.padre;
    const pad = destino.padding;
    const mx = padre.rect.x + pad.izq + destino.margen.izquierda;
    const my = padre.rect.y + pad.arriba + destino.margen.arriba;
    const p = aPx(mx, my);
    // recortado al canvas: el hueco no se sale por la derecha ni por abajo, así se ve dónde
    // termina el elemento y no parece un marco que llega hasta el final
    const anchoMax = Math.max(8, ox + canvas.clientWidth - p.x);
    const altoMax = Math.max(8, oy + canvas.clientHeight - p.y);
    const ancho = Math.max(8, Math.min(Math.round(tamano.ancho * caja.escala), Math.round(anchoMax)));
    const alto = Math.max(8, Math.min(Math.round(tamano.alto * caja.escala), Math.round(altoMax)));
    hueco.style.left = Math.round(p.x) + "px";
    hueco.style.top = Math.round(p.y) + "px";
    hueco.style.width = ancho + "px";
    hueco.style.height = alto + "px";
    hueco.hidden = false;
    linea.hidden = true;
    return destino;
  }

  function fantasmaDePaleta(tipo) {
    if (!conDocumento()) return null;
    const caja = document.createElement("div");
    caja.className = "previa-arrastre-fantasma";
    caja.textContent = String(tipo);
    caja.setAttribute("aria-hidden", "true");
    document.body.appendChild(caja);
    return caja;
  }

  function moverFantasma(fantasma, x, y) {
    if (!fantasma) return;
    fantasma.style.left = Math.round(x) + "px";
    fantasma.style.top = Math.round(y) + "px";
  }

  function estaSobreCanvas(clientX, clientY) {
    const canvas = canvasVivo();
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  function limpiarArrastrePaleta(a) {
    if (a && a.fantasma && a.fantasma.parentNode) a.fantasma.parentNode.removeChild(a.fantasma);
    if (a && a.boton) a.boton.classList.remove("arrastrando");
    if (conDocumento()) document.body.classList.remove("arrastrando-paleta");
    const canvas = canvasVivo();
    if (canvas) canvas.classList.remove("previa-canvas-recibiendo");
    ocultarDestino();
  }

  function soltarPaleta(tipo, clientX, clientY) {
    const canvas = canvasVivo();
    const modelo = modeloVivo;
    if (!canvas || !modelo) {
      avisarEdicion("No hay un layout dibujado sobre el que soltar.");
      return false;
    }
    if (!estaSobreCanvas(clientX, clientY)) {
      avisarEdicion("Suelta " + tipo + " sobre el dibujo del layout.");
      return false;
    }
    const p = puntoModelo(canvas, modelo, { clientX, clientY });
    if (!p) return false;
    return anadirEn(tipo, p.x, p.y);
  }

  // Un solo gesto con puntero: se distingue del clic por el umbral. El fantasma, la marca del
  // canvas y la clase del botón son la realimentación; el documento solo cambia al soltar.
  function conectarPaletaArrastre() {
    const paleta = document.getElementById("previa-paleta");
    if (!paleta) return;
    paleta.addEventListener("click", (e) => {
      // el clic que acompaña a un arrastre no añade además al final
      if (!suprimirClicPaleta || Date.now() - suprimirClicPaleta > 600) return;
      suprimirClicPaleta = 0;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    paleta.addEventListener("pointerdown", (e) => {
      if (!editando || (typeof e.button === "number" && e.button !== 0)) return;
      const boton = e.target && typeof e.target.closest === "function"
        ? e.target.closest("button[data-tipo]") : null;
      if (!boton || boton.disabled) return;
      const motivo = motivoNoEditable();
      if (motivo) { avisarEdicion(motivo); return; }
      arrastrePaleta = {
        tipo: boton.dataset.tipo, boton, x0: e.clientX, y0: e.clientY, activo: false, fantasma: null,
      };
    });
    document.addEventListener("pointermove", (e) => {
      if (!arrastrePaleta) return;
      if (!arrastrePaleta.activo) {
        if (Math.abs(e.clientX - arrastrePaleta.x0) < UMBRAL_PALETA &&
            Math.abs(e.clientY - arrastrePaleta.y0) < UMBRAL_PALETA) return;
        arrastrePaleta.activo = true;
        arrastrePaleta.fantasma = fantasmaDePaleta(arrastrePaleta.tipo);
        arrastrePaleta.boton.classList.add("arrastrando");
        document.body.classList.add("arrastrando-paleta");
        try { arrastrePaleta.boton.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
      }
      moverFantasma(arrastrePaleta.fantasma, e.clientX, e.clientY);
      const canvas = canvasVivo();
      const dentroCanvas = estaSobreCanvas(e.clientX, e.clientY);
      // el indicador usa las mismas coordenadas del modelo y la misma lógica que el soltar; no se
      // marca todo el canvas, que parecía un marco sin final: el hueco acotado es la señal
      if (dentroCanvas && canvas && modeloVivo) {
        const p = puntoModelo(canvas, modeloVivo, { clientX: e.clientX, clientY: e.clientY });
        if (p) pintarDestino(arrastrePaleta.tipo, p.x, p.y);
        else ocultarDestino();
      } else {
        ocultarDestino();
      }
      e.preventDefault();
    });
    document.addEventListener("pointerup", (e) => {
      if (!arrastrePaleta) return;
      const a = arrastrePaleta;
      arrastrePaleta = null;
      limpiarArrastrePaleta(a);
      if (!a.activo) return; // fue un clic: lo atiende el manejador del botón
      suprimirClicPaleta = Date.now();
      soltarPaleta(a.tipo, e.clientX, e.clientY);
    });
    document.addEventListener("pointercancel", () => {
      if (!arrastrePaleta) return;
      limpiarArrastrePaleta(arrastrePaleta);
      arrastrePaleta = null;
    });
  }

  function borrarSeleccion() {
    if (!seleccion) {
      avisarEdicion("Selecciona un elemento del dibujo para borrarlo.");
      return false;
    }
    const motivo = motivoNoEditable();
    if (motivo) { avisarEdicion(motivo); return false; }
    if (!seleccion.length) {
      avisarEdicion("La raíz no se borra: la actividad necesita una vista para setContentView.");
      return false;
    }
    const nodo = nodoPorRuta(modeloVivo.raiz, seleccion);
    const etiqueta = etiquetaDe(nodo);
    const r = borrarElemento(String(editor.texto()), seleccion);
    if (!r.ok) { avisarEdicion("No se pudo borrar: " + r.error); return false; }
    seleccion = null;
    notaEdicion = "";
    clavePropiedades = "";
    return aplicarXml(r.xml, "Borrado " + etiqueta + ".");
  }

  // --- la ficha de propiedades ---------------------------------------------------------------
  // Los campos se crean con `createElement` y se rellenan con `value`/`textContent`: el texto del
  // layout es dato, nunca marcado. Un cambio de propiedad se aplica con `escribirPropiedad` y el
  // mismo `aplicarXml` del resto del modo editar, así que entra en el undo tree y el canvas se
  // repinta sin compilar y sin tocar `#ultimo-codigo`.
  function campoDePropiedad(def, valor) {
    if (def.tipo === "imagen") return campoImagen(def, valor);
    const caja = document.createElement("label");
    caja.className = "previa-propiedad" +
      (def.tipo === "texto" || def.tipo === "gravedad" ? " previa-propiedad-ancha" : "");
    const etiqueta = document.createElement("span");
    etiqueta.className = "previa-propiedad-etiqueta";
    etiqueta.textContent = def.etiqueta;
    const campo = document.createElement("input");
    campo.type = "text";
    campo.className = "previa-propiedad-campo";
    campo.value = valor == null ? "" : String(valor);
    campo.setAttribute("data-propiedad", def.nombre);
    campo.setAttribute("aria-label", def.etiqueta + " (" + def.nombre + ")");
    campo.setAttribute("title", def.ayuda);
    campo.setAttribute("placeholder", def.ayuda);
    campo.setAttribute("autocomplete", "off");
    campo.setAttribute("spellcheck", "false");
    const listas = {
      dimension: "previa-valores-dimension",
      medida: "previa-valores-medida",
      color: "previa-valores-color",
      gravedad: "previa-valores-gravedad",
      booleano: "previa-valores-booleano",
      orientacion: "previa-valores-orientacion",
    };
    if (listas[def.tipo]) campo.setAttribute("list", listas[def.tipo]);
    // `change` se dispara al salir del campo o con Enter: un cambio por pulsación llenaría el undo
    // tree de pasos y robaría el foco en cada letra.
    campo.addEventListener("change", () => aplicarPropiedad(def.nombre, campo.value, campo));
    campo.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      campo.blur();
    });
    caja.appendChild(etiqueta);
    caja.appendChild(campo);
    return caja;
  }

  // El tipo del layout raíz. `RelativeLayout` se ofrece para poder rechazarlo con su nombre y su
  // motivo, no porque `cambiarTipoRaiz` lo acepte.
  function campoRaiz(tipoActual) {
    const caja = document.createElement("label");
    caja.className = "previa-propiedad previa-propiedad-ancha";
    const etiqueta = document.createElement("span");
    etiqueta.className = "previa-propiedad-etiqueta";
    etiqueta.textContent = "Tipo de layout raíz";
    const select = document.createElement("select");
    select.className = "previa-propiedad-campo";
    select.setAttribute("data-raiz-tipo", "1");
    select.setAttribute("aria-label", "Tipo de layout raíz");
    for (const opcion of tiposRaizDisponibles()) {
      const opt = document.createElement("option");
      opt.value = opcion.tipo;
      opt.textContent = opcion.tipo + (opcion.disponible ? "" : " (no disponible)");
      if (!opcion.disponible) opt.title = opcion.motivo;
      if (opcion.tipo === tipoActual) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => cambiarRaiz(select.value));
    caja.appendChild(etiqueta);
    caja.appendChild(select);
    return caja;
  }

  function aplicarPropiedad(nombre, valor, campo) {
    const motivo = motivoNoEditable();
    if (motivo) {
      avisarEdicion(motivo);
      actualizarPropiedades(true);
      return false;
    }
    const r = escribirPropiedad(String(editor.texto()), seleccion, nombre, valor);
    if (!r.ok) {
      avisarEdicion("No se pudo cambiar " + nombre + ": " + r.error);
      actualizarPropiedades(true);
      if (campo && typeof campo.focus === "function") campo.focus();
      return false;
    }
    if (!r.cambio) {
      actualizarPropiedades(false);
      return false;
    }
    const cambiado = aplicarXml(r.xml, "Cambiado " + nombre + " a «" + r.valor + "».",
      { enfocar: false });
    // el foco vuelve al campo (no al canvas): se sigue editando la misma ficha
    if (campo && typeof campo.focus === "function" && document.contains(campo)) {
      campo.focus();
      if (campo.type === "text" && typeof campo.setSelectionRange === "function") {
        try { campo.setSelectionRange(campo.value.length, campo.value.length); } catch (e) { /* sin foco */ }
      }
    }
    if (!cambiado) actualizarPropiedades(false);
    return cambiado;
  }

  function cambiarRaiz(tipo) {
    const motivo = motivoNoEditable();
    if (motivo) {
      avisarEdicion(motivo);
      actualizarPropiedades(true);
      return false;
    }
    const r = cambiarTipoRaiz(String(editor.texto()), tipo);
    if (!r.ok) {
      avisarEdicion("No se cambió el tipo de layout: " + r.error);
      actualizarPropiedades(true);
      return false;
    }
    if (!r.cambio) {
      actualizarPropiedades(false);
      return false;
    }
    const cambiado = aplicarXml(r.xml, "Layout raíz cambiado a " + r.tipo + ".", { enfocar: false });
    actualizarPropiedades(true);
    return cambiado;
  }

  // --- imágenes de un ImageView / ImageButton --------------------------------------------------
  // El fichero viaja del usuario al OPFS del propio proyecto: no hay red. Se guarda en
  // `res/drawable/<nombre>.<ext>` y el XML recibe `@drawable/<nombre>` con el mismo
  // `escribirPropiedad` que el resto de campos, así que el cambio es mínimo y entra en el historial
  // del diseñador.
  const EXTENSIONES_IMAGEN = [".png", ".jpg", ".jpeg", ".webp"];
  // La lista viaja en `layout-editor.js` (datos puros, probados en `prueba.js`); aquí solo se pinta.
  const ICONOS_SISTEMA = iconosSistema();
  let campoImagenActivo = null;

  function nodoImagen(nodo) {
    return !!nodo && /^Image/.test(String(nodo.tipo || ""));
  }

  // Los nodos con `android:src`. Para un `@drawable/…` del proyecto se lee el PNG del OPFS y se
  // decodifica con `createImageBitmap`; `@android:drawable/…` vive en el jar, no en el proyecto, y
  // se queda como marcador con su nombre (frontera escrita en la ficha).
  function nodosConRecurso(modelo) {
    const salida = [];
    const recorrer = (nodo) => {
      if (!nodo || typeof nodo !== "object") return;
      if (typeof nodo.recurso === "string" && nodo.recurso) salida.push(nodo);
      for (const hijo of Array.isArray(nodo.hijos) ? nodo.hijos : []) recorrer(hijo);
    };
    if (modelo && modelo.raiz) recorrer(modelo.raiz);
    return salida;
  }

  async function cargarImagenes(modelo) {
    if (!modelo || typeof createImageBitmap !== "function" || !hospedador || !hospedador.bytes) return;
    for (const nodo of nodosConRecurso(modelo)) {
      const m = /^@drawable\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(nodo.recurso || ""));
      if (!m) continue;
      const clave = "@drawable/" + m[1];
      if (!imagenes.has(clave)) {
        let bitmap = null;
        for (const ext of EXTENSIONES_IMAGEN) {
          try {
            const bytes = await hospedador.bytes(carpeta + "/res/drawable/" + m[1] + ext);
            if (bytes && bytes.length) {
              bitmap = await createImageBitmap(new Blob([bytes]));
              break;
            }
          } catch (e) { /* sin fichero o formato que el navegador no lee */ }
        }
        imagenes.set(clave, bitmap || null);
      }
      nodo.imagen = imagenes.get(clave);
    }
  }

  function extensionDeImagen(nombre, tipo) {
    const m = /\.(png|jpe?g|webp)$/i.exec(String(nombre || ""));
    if (m) return "." + m[1].toLowerCase().replace("jpeg", "jpg");
    const t = String(tipo || "");
    if (/jpeg/.test(t)) return ".jpg";
    if (/webp/.test(t)) return ".webp";
    return ".png";
  }

  function nombreDeDrawable(nombre) {
    let base = String(nombre || "imagen").replace(/\.[^.]+$/, "").toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!/^[a-z_]/.test(base)) base = "imagen_" + base;
    return base.slice(0, 48) || "imagen";
  }

  async function nombreDrawableLibre(base, extension) {
    for (let n = 0; n < 100; n++) {
      const nombre = n ? base + "_" + (n + 1) : base;
      let ocupado = false;
      // un `drawable/<nombre>.xml` (vector) ocupa el mismo nombre de recurso que el PNG nuevo
      for (const ext of EXTENSIONES_IMAGEN.concat([".xml"])) {
        try {
          const bytes = await hospedador.bytes(carpeta + "/res/drawable/" + nombre + ext);
          if (bytes && bytes.length) { ocupado = true; break; }
        } catch (e) { /* no existe */ }
      }
      if (!ocupado) return { nombre, ruta: carpeta + "/res/drawable/" + nombre + extension };
    }
    return { nombre: base, ruta: carpeta + "/res/drawable/" + base + extension };
  }

  async function importarImagen(archivo, campo) {
    const motivo = motivoNoEditable();
    if (motivo) { avisarEdicion(motivo); return false; }
    const nodo = modeloVivo && seleccion ? nodoPorRuta(modeloVivo.raiz, seleccion) : null;
    if (!nodoImagen(nodo)) {
      avisarEdicion("Selecciona un ImageView o un ImageButton para darle una imagen.");
      return false;
    }
    if (!archivo || !/^image\//.test(String(archivo.type || ""))) {
      avisarEdicion("El fichero tiene que ser una imagen (PNG, JPG o WebP).");
      return false;
    }
    let bytes;
    try {
      bytes = new Uint8Array(await archivo.arrayBuffer());
    } catch (e) {
      avisarEdicion("No se pudo leer la imagen.");
      return false;
    }
    if (!bytes.length) { avisarEdicion("La imagen está vacía."); return false; }
    const extension = extensionDeImagen(archivo.name, archivo.type);
    // Elegir un nombre libre y escribir la imagen van bajo el mismo bloqueo: dos ventanas que
    // importen a la vez no pueden escoger el mismo `res/drawable/<nombre>` y pisarse el PNG.
    const { libre, escrito } = await bloquear(async () => {
      const elegido = await nombreDrawableLibre(nombreDeDrawable(archivo.name), extension);
      const r = await hospedador.escribir(elegido.ruta, bytes);
      return { libre: elegido, escrito: r };
    });
    if (escrito && escrito.tipo === "error") {
      avisarEdicion("No se pudo guardar la imagen: " + escrito.error);
      return false;
    }
    const valor = "@drawable/" + libre.nombre;
    imagenes.delete(valor);
    try { await hospedador.refrescar(carpeta + "/res"); } catch (e) { /* el árbol se refresca al compilar */ }
    return aplicarPropiedad("android:src", valor, campo);
  }

  function abrirSelectorImagen(campo) {
    const archivo = document.getElementById("previa-imagen-archivo");
    if (!archivo) return;
    campoImagenActivo = campo;
    archivo.value = "";
    archivo.click();
  }

  // El campo de imagen: el texto con `android:src`, el botón de fichero, el selector de iconos del
  // sistema y una nota que dice qué se dibuja de verdad y qué es un marcador.
  function campoImagen(def, valor) {
    const caja = document.createElement("fieldset");
    caja.className = "previa-propiedad previa-propiedad-ancha previa-imagen";
    const leyenda = document.createElement("legend");
    leyenda.className = "previa-propiedad-etiqueta";
    leyenda.textContent = def.etiqueta;
    const fila = document.createElement("div");
    fila.className = "previa-imagen-fila";
    const campo = document.createElement("input");
    campo.type = "text";
    campo.className = "previa-propiedad-campo";
    campo.value = valor == null ? "" : String(valor);
    campo.setAttribute("data-propiedad", def.nombre);
    campo.setAttribute("aria-label", "Arrastra una imagen o pulsa Elegir fichero");
    campo.setAttribute("title", def.ayuda);
    campo.setAttribute("placeholder", "@drawable/foto o @android:drawable/ic_delete");
    campo.setAttribute("autocomplete", "off");
    campo.setAttribute("spellcheck", "false");
    campo.addEventListener("change", () => aplicarPropiedad(def.nombre, campo.value, campo));
    campo.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      campo.blur();
    });
    const elegir = document.createElement("button");
    elegir.type = "button";
    elegir.className = "previa-paleta-boton";
    elegir.textContent = "Elegir fichero";
    elegir.setAttribute("role", "button");
    elegir.setAttribute("aria-label", "Arrastra una imagen o pulsa Elegir fichero");
    elegir.setAttribute("title", "Importa una imagen al proyecto y la usa en este nodo");
    elegir.addEventListener("click", (e) => {
      e.preventDefault();
      abrirSelectorImagen(campo);
    });
    fila.appendChild(campo);
    fila.appendChild(elegir);
    const iconos = document.createElement("select");
    iconos.className = "previa-propiedad-campo";
    iconos.setAttribute("data-icono-sistema", "1");
    iconos.setAttribute("aria-label", "Iconos del sistema disponibles en API 34");
    const vacio = document.createElement("option");
    vacio.value = "";
    vacio.textContent = "Icono del sistema…";
    iconos.appendChild(vacio);
    for (const nombre of ICONOS_SISTEMA) {
      const opcion = document.createElement("option");
      opcion.value = "@android:drawable/" + nombre;
      opcion.textContent = nombre;
      iconos.appendChild(opcion);
    }
    iconos.value = ICONOS_SISTEMA.some((n) => campo.value === "@android:drawable/" + n)
      ? campo.value : "";
    iconos.addEventListener("change", () => {
      if (!iconos.value) return;
      campo.value = iconos.value;
      aplicarPropiedad(def.nombre, iconos.value, campo);
    });
    const nota = document.createElement("span");
    nota.className = "previa-imagen-nota";
    nota.textContent = "Los PNG importados se dibujan de verdad; los iconos del sistema, como " +
      "marcador con su nombre (las variantes blancas/negras/grises no existen como recurso " +
      "público en API 34).";
    caja.appendChild(leyenda);
    caja.appendChild(fila);
    caja.appendChild(iconos);
    caja.appendChild(nota);
    return caja;
  }

  // --- el visor de jerarquía ------------------------------------------------------------------
  function claveDeRuta(ruta) {
    return (Array.isArray(ruta) ? ruta : []).join("/");
  }

  function rutaDeClave(clave) {
    return String(clave) === "" ? [] : String(clave).split("/").map((n) => Number(n));
  }

  function actualizarJerarquia(force) {
    const caja = el("previa-jerarquia");
    if (!caja) return;
    const lista = el("previa-jerarquia-lista");
    if (!lista) return;
    const boton = el("previa-jerarquia-alternar");
    const abierta = !!editando && jerarquiaVisible;
    if (boton) {
      boton.setAttribute("aria-pressed", abierta ? "true" : "false");
      boton.classList.toggle("activa", abierta);
    }
    caja.hidden = !abierta || !modeloVivo;
    if (!abierta || !modeloVivo) {
      lista.replaceChildren();
      claveJerarquia = "";
      return;
    }
    const filas = [];
    const recorrer = (nodo, ruta, prof) => {
      const hijos = hijosDelModelo(nodo);
      filas.push({ ruta: ruta.slice(), prof, tipo: String(nodo.tipo || "vista"), id: nodo.id || "",
        hijos: hijos.length });
      if (jerarquiaPlegada.has(claveDeRuta(ruta))) return;
      hijos.forEach((hijo, i) => recorrer(hijo, ruta.concat(i), prof + 1));
    };
    recorrer(modeloVivo.raiz, [], 0);
    const clave = JSON.stringify([filas.map((f) => [f.ruta, f.tipo, f.id, f.hijos]),
      [...jerarquiaPlegada].sort()]);
    if (force || clave !== claveJerarquia) {
      claveJerarquia = clave;
      const fragmento = document.createDocumentFragment();
      for (const fila of filas) {
        const li = document.createElement("li");
        li.className = "previa-jerarquia-fila";
        li.style.paddingLeft = (6 + fila.prof * 10) + "px";
        const rotulo = fila.tipo + " · " + (fila.id || "(sin id)");
        if (fila.hijos) {
          const plegada = jerarquiaPlegada.has(claveDeRuta(fila.ruta));
          const flecha = document.createElement("button");
          flecha.type = "button";
          flecha.className = "previa-jerarquia-flecha";
          flecha.textContent = plegada ? "▸" : "▾";
          flecha.setAttribute("aria-expanded", plegada ? "false" : "true");
          flecha.setAttribute("aria-label", (plegada ? "Desplegar " : "Plegar ") + rotulo);
          flecha.addEventListener("click", (e) => {
            e.preventDefault();
            const k = claveDeRuta(fila.ruta);
            if (jerarquiaPlegada.has(k)) jerarquiaPlegada.delete(k);
            else jerarquiaPlegada.add(k);
            actualizarJerarquia(true);
          });
          li.appendChild(flecha);
        } else {
          const hueco = document.createElement("span");
          hueco.className = "previa-jerarquia-hueco";
          hueco.setAttribute("aria-hidden", "true");
          li.appendChild(hueco);
        }
        const nodoBoton = document.createElement("button");
        nodoBoton.type = "button";
        nodoBoton.className = "previa-jerarquia-nodo";
        nodoBoton.dataset.ruta = claveDeRuta(fila.ruta);
        nodoBoton.textContent = rotulo;
        nodoBoton.setAttribute("aria-label", "Seleccionar " + rotulo);
        nodoBoton.addEventListener("click", () => {
          seleccionar(rutaDeClave(nodoBoton.dataset.ruta));
          const canvas = canvasVivo();
          if (canvas && typeof canvas.focus === "function") canvas.focus();
        });
        li.appendChild(nodoBoton);
        fragmento.appendChild(li);
      }
      lista.replaceChildren(fragmento);
    }
    const activa = seleccion ? claveDeRuta(seleccion) : null;
    for (const nodoBoton of lista.querySelectorAll("button[data-ruta]")) {
      const esActiva = activa !== null && nodoBoton.dataset.ruta === activa;
      nodoBoton.classList.toggle("activa", esActiva);
      nodoBoton.setAttribute("aria-current", esActiva ? "true" : "false");
    }
  }

  function seleccionarPadre() {
    if (!seleccion) return false;
    if (!seleccion.length) { avisarEdicion("La raíz no tiene padre."); return false; }
    seleccionar(seleccion.slice(0, -1));
    const canvas = canvasVivo();
    if (canvas && typeof canvas.focus === "function") canvas.focus();
    return true;
  }

  function actualizarPropiedades(force) {
    const seccion = el("previa-propiedades");
    if (!seccion) return;
    const campos = el("previa-propiedades-campos");
    const titulo = el("previa-propiedades-titulo");
    const vacio = el("previa-propiedades-vacio");
    if (!campos) return;
    const nodo = editando && modeloVivo && seleccion ? nodoPorRuta(modeloVivo.raiz, seleccion) : null;
    // La ficha es del nodo seleccionado: aparece al seleccionarlo y desaparece al soltarlo (Esc, el
    // botón de cerrar o un clic en el hueco). No ocupa sitio: es una capa sobre el dibujo.
    seccion.hidden = !nodo;
    if (!nodo) {
      campos.replaceChildren();
      clavePropiedades = "";
      if (vacio) vacio.hidden = true;
      if (titulo) titulo.textContent = "Propiedades";
      const padreVacio = el("previa-propiedades-padre");
      if (padreVacio) padreVacio.disabled = true;
      const canvasSin = canvasVivo();
      if (canvasSin) {
        canvasSin.setAttribute("aria-label", "Dibujo del layout del editor, sin compilar");
        canvasSin.setAttribute("role", "img");
      }
      return;
    }
    const raiz = seleccion.length === 0;
    const botonPadre = el("previa-propiedades-padre");
    if (botonPadre) botonPadre.disabled = raiz;
    // el canvas se anuncia distinto cuando el nodo seleccionado admite una imagen: ahí también se
    // puede soltar un fichero, y un lector de pantalla tiene que saberlo
    const canvasVista = canvasVivo();
    if (canvasVista) {
      const imagen = nodoImagen(nodo);
      canvasVista.setAttribute("aria-label", imagen
        ? "Arrastra una imagen o pulsa Elegir fichero para el " + String(nodo.tipo)
        : "Dibujo del layout del editor, sin compilar");
      canvasVista.setAttribute("role", imagen ? "button" : "img");
    }
    if (titulo) {
      titulo.textContent = raiz
        ? "Propiedades del layout raíz (" + etiquetaDe(nodo) + ")"
        : "Propiedades de " + etiquetaDe(nodo);
    }
    if (vacio) vacio.hidden = true;
    const texto = editor && typeof editor.texto === "function" ? String(editor.texto()) : "";
    const leido = leerPropiedades(texto, seleccion);
    if (!leido.ok) {
      campos.replaceChildren();
      clavePropiedades = "";
      return;
    }
    const clave = JSON.stringify([seleccion, leido.tipo, leido.raiz]);
    if (force || clave !== clavePropiedades) {
      clavePropiedades = clave;
      campos.replaceChildren();
      if (raiz) campos.appendChild(campoRaiz(leido.tipo));
      for (const def of leido.propiedades) {
        campos.appendChild(campoDePropiedad(def, leido.valores[def.nombre] || ""));
      }
      return;
    }
    // sin cambiar de nodo: se refrescan los valores, menos el campo que tiene el foco
    for (const campo of campos.querySelectorAll("[data-propiedad]")) {
      if (document.activeElement === campo) continue;
      const v = leido.valores[campo.getAttribute("data-propiedad")];
      if (typeof v === "string" && campo.value !== v) campo.value = v;
    }
    const select = campos.querySelector("[data-raiz-tipo]");
    if (select && document.activeElement !== select) select.value = leido.tipo;
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

  // El nodo más profundo cuyo `rect` contiene el punto. Si no hay ningún hijo bajo el punto pero el
  // punto cae dentro de la raíz, se selecciona la raíz (`[]`): su tipo, orientación, padding y fondo
  // también se editan. La raíz no se borra ni se mueve.
  function golpeEn(modelo, x, y) {
    let mejor = null;
    const dentro = (r) => r && Number.isFinite(r.ancho) && Number.isFinite(r.alto) &&
      x >= r.x && x <= r.x + r.ancho && y >= r.y && y <= r.y + r.alto;
    const recorrer = (nodo, ruta, profundidad) => {
      const r = nodo && nodo.rect;
      if (profundidad > 0 && dentro(r)) {
        if (!mejor || profundidad >= mejor.profundidad) mejor = { ruta, profundidad, nodo };
      }
      const hijos = nodo && Array.isArray(nodo.hijos) ? nodo.hijos : [];
      hijos.forEach((hijo, i) => recorrer(hijo, ruta.concat(i), profundidad + 1));
    };
    if (modelo && modelo.raiz) recorrer(modelo.raiz, [], 0);
    if (mejor) return mejor;
    if (modelo && modelo.raiz && dentro(modelo.raiz.rect)) {
      return { ruta: [], profundidad: 0, nodo: modelo.raiz };
    }
    return null;
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
    if (!canvas || !modeloVivo || !arrastreNodo) return;
    const nodo = nodoPorRuta(modeloVivo.raiz, arrastreNodo.ruta);
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
    if (!Array.isArray(ruta) || !ruta.length) {
      avisarEdicion("La raíz no se mueve: no tiene padre en el layout.");
      return false;
    }
    const modelo = modeloVivo;
    const nodo = nodoPorRuta(modelo.raiz, ruta);
    const rutaPadre = ruta.slice(0, -1);
    const padre = nodoPorRuta(modelo.raiz, rutaPadre);
    if (!nodo || !nodo.rect || !padre || !padre.rect) return false;
    const texto = String(editor.texto());
    if (contenedorDe(padre) === "lineal") {
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
    if (!arrastreNodo) return;
    const a = arrastreNodo;
    arrastreNodo = null;
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
      // la raíz se selecciona, pero no se arrastra: no tiene padre
      if (!golpe || !golpe.ruta.length) return;
      arrastreNodo = { ruta: golpe.ruta, x0: e.clientX, y0: e.clientY, movido: false };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
    });
    // el movimiento y el soltar se siguen en el documento: el puntero puede salir del canvas
    document.addEventListener("pointermove", (e) => {
      if (!arrastreNodo) return;
      const dx = e.clientX - arrastreNodo.x0;
      const dy = e.clientY - arrastreNodo.y0;
      if (!arrastreNodo.movido && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      arrastreNodo.movido = true;
      if (!modeloVivo) return;
      const caja = cajaDeCanvas(canvas, modeloVivo);
      if (!caja.valida) return;
      const r = canvas.getBoundingClientRect();
      const factor = r.width > 0 && canvas.clientWidth ? canvas.clientWidth / r.width : 1;
      dibujarFantasma((dx * factor) / caja.escala, (dy * factor) / caja.escala);
      e.preventDefault();
    });
    document.addEventListener("pointerup", soltarCanvas);
    document.addEventListener("pointercancel", () => { arrastreNodo = null; });
  }

  // Soltar un fichero sobre una superficie del emulador. Un `.apk` abre esa app en el emulador desde
  // cualquiera de los tres canvas, por la misma ruta aislada y con el mismo mensaje. Durante
  // `dragover` el navegador no deja leer el nombre del fichero (solo los tipos), así que aquí se
  // acepta cualquier `Files` y el `drop` decide: una imagen solo va al ImageView seleccionado del
  // canvas editable, así que en las demás superficies se ignora.
  function conectarSoltarCanvas(canvas, { editable = false } = {}) {
    if (!canvas) return;
    ponerPistaSoltar(canvas, canvas.title);
    const archivosDeArrastre = (e) => (e.dataTransfer && e.dataTransfer.files
      ? Array.from(e.dataTransfer.files) : []);
    canvas.addEventListener("dragover", (e) => {
      if (!e.dataTransfer) return;
      const tipos = Array.from(e.dataTransfer.types || []);
      if (tipos.indexOf("Files") < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      canvas.classList.add("previa-canvas-recibiendo");
    });
    canvas.addEventListener("dragleave", () => canvas.classList.remove("previa-canvas-recibiendo"));
    canvas.addEventListener("drop", (e) => {
      canvas.classList.remove("previa-canvas-recibiendo");
      // el navegador no puede quedarse el fichero: sin esto, soltarlo fuera de su rama lo abre como
      // documento y saca al usuario del editor sin guardar (el convenio de deps.js)
      e.preventDefault();
      const archivos = archivosDeArrastre(e);
      const archivo = archivos[0];
      if (!archivo) return;
      const atenderPrimero = () => {
        if (esArchivoApk(archivo)) {
          abrirApkSoltada(archivo).catch((err) => {
            mensajeEmulador("no se pudo cargar el apk soltado: " +
              (err && err.message ? err.message : err));
          });
          return;
        }
        if (esArchivoDex(archivo)) {
          const superficie = SUPERFICIES.find((s) =>
            s.canvasRender === canvas.id || s.canvasVivo === canvas.id);
          intercambiarDexSoltado(archivo, superficie ? superficie.id : "panel").catch((err) => {
            mensajeEmulador("no se pudo intercambiar el dex soltado: " +
              (err && err.message ? err.message : err));
          });
          return;
        }
        if (!editable || !editando) return;
        const nodo = seleccion && modeloVivo ? nodoPorRuta(modeloVivo.raiz, seleccion) : null;
        if (!nodoImagen(nodo)) return;
        const campo = document.querySelector(
          '#previa-propiedades-campos [data-propiedad="android:src"]');
        importarImagen(archivo, campo)
          .catch((e) => falloSilencioso("importar la imagen soltada", e));
      };
      atenderPrimero();
      if (archivos.length > 1) {
        // Antes solo entraba `files[0]` y los demás desaparecían sin una palabra. El swap y la
        // apertura de un apk trabajan de uno en uno (el guion del preview se repite entero), así
        // que se dice qué se atiende y qué se ignora en vez de tragárselo. El aviso va DESPUÉS del
        // primer fichero: su rechazo repinta la línea de estado y la lista, y borraría este texto.
        const sobran = archivos.slice(1).map((f) => "«" + (f.name || "sin nombre") + "»");
        const texto = "uno por vez: se atiende «" + (archivo.name || "el primer fichero") + "» y se " +
          (sobran.length === 1 ? "ignora " + sobran[0] : "ignoran " + sobran.join(", "));
        mensajeEmulador(texto);
        registrarSwap(texto, "aviso");
      }
    });
    // el resultado de una carga se queda en el marco hasta que el usuario pulsa el emulador: el
    // overlay no captura el puntero, así que este `pointerdown` es el que lo retira
    canvas.addEventListener("pointerdown", () => cerrarProgresoApk());
  }

  // Engancha el soltar en las tres superficies una sola vez: si un id se repite o `iniciar()` se
  // vuelve a llamar, el mismo canvas no acumula manejadores duplicados.
  const soltablesConectados = new Set();
  const canvasesConSoltar = new WeakSet();
  function conectarSoltarApk() {
    if (!conDocumento()) return;
    for (const id of CANVAS_SOLTABLES) {
      if (soltablesConectados.has(id)) continue;
      const canvas = document.getElementById(id);
      if (!canvas || canvasesConSoltar.has(canvas)) continue;
      soltablesConectados.add(id);
      canvasesConSoltar.add(canvas);
      conectarSoltarCanvas(canvas, { editable: id === "previa-vivo-canvas" });
    }
  }

  // Supr borra y Esc suelta, solo con el modo editar y una selección. Esc también cierra la ficha
  // desde dentro de un campo (es un panel superpuesto, no una columna). Se ignoran las
  // combinaciones con Ctrl/Alt/Meta: el autocompletado, `Ctrl+Mayús+P`, `Ctrl+G` y la búsqueda
  // siguen siendo del editor.
  function conectarTecladoEditable() {
    document.addEventListener("keydown", (e) => {
      if (!editando || !seleccion) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const destino = e.target;
      const esCampo = destino && (destino.tagName === "TEXTAREA" || destino.tagName === "INPUT" ||
        destino.tagName === "SELECT" || destino.isContentEditable);
      const enFicha = destino && typeof destino.closest === "function" &&
        !!destino.closest("#previa-propiedades");
      if (e.key === "Escape") {
        // en la ficha sí cierra; en los demás campos, Esc es de su dueño (búsqueda, paleta de
        // comandos, autocompletado) y no se toca
        if (esCampo && !enFicha) return;
        e.preventDefault();
        seleccionar(null);
        if (esCampo) {
          const canvas = canvasVivo();
          if (canvas && typeof canvas.focus === "function") canvas.focus();
        }
        return;
      }
      if (esCampo) return;
      if (e.key === "Delete") {
        e.preventDefault();
        borrarSeleccion();
      }
    });
  }

  function aplicarEditable(valor) {
    const activo = !!valor && visible;
    if (activo && modo !== "vivo") aplicarModo("vivo", true);
    editando = activo;
    arrastreNodo = null;
    if (arrastrePaleta) { limpiarArrastrePaleta(arrastrePaleta); arrastrePaleta = null; }
    suprimirClicPaleta = 0;
    if (!editando) { seleccion = null; notaEdicion = ""; clavePropiedades = ""; }
    const boton = document.getElementById("previa-modo-editar");
    if (boton) {
      boton.classList.toggle("activo", editando);
      boton.setAttribute("aria-pressed", String(editando));
    }
    const canvas = canvasVivo();
    if (canvas) canvas.classList.toggle("editable", editando);
    ocultarDestino();
    actualizarPaleta();
    actualizarEstadoEdicion();
    actualizarPropiedades(true);
    actualizarHistorialDiseno();
    actualizarJerarquia(true);
    if (visible && modo === "vivo") {
      pintarVivo();
      if (editando) programarVivo(0);
    }
  }

  // Plegar la paleta o la ficha deja solo su cabecera: el dibujo recupera el espacio que tapaba la
  // capa, sin mover el canvas (la capa no participa en el reparto).
  function conectarPlegables() {
    const pares = [
      { contenedor: "previa-paleta", boton: "previa-paleta-plegar", que: "la paleta" },
      { contenedor: "previa-propiedades", boton: "previa-propiedades-plegar", que: "las propiedades" },
    ];
    for (const par of pares) {
      const contenedor = document.getElementById(par.contenedor);
      const boton = document.getElementById(par.boton);
      if (!contenedor || !boton) continue;
      boton.addEventListener("click", () => {
        const plegada = contenedor.dataset.plegada !== "1";
        contenedor.dataset.plegada = plegada ? "1" : "0";
        boton.setAttribute("aria-expanded", plegada ? "false" : "true");
        boton.title = (plegada ? "Desplegar " : "Plegar ") + par.que;
        boton.setAttribute("aria-label", boton.title);
      });
    }
  }

  // Atajos del DISEÑADOR. Solo con el lápiz encendido y con el foco dentro del panel de la vista
  // previa (canvas, ficha, paleta) o en el cuerpo: ahí Ctrl+Z no debe llegar al historial de texto
  // del editor de código (ni al undo nativo del navegador, que reescribía el XML a espaldas del
  // modelo). Con el foco en el editor de código o en la búsqueda, la combinación es suya.
  function conectarAtajosDiseno() {
    document.addEventListener("keydown", (e) => {
      if (!editando || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const tecla = String(e.key || "").toLowerCase();
      if (tecla !== "z" && tecla !== "y") return;
      const destino = e.target;
      const enPanel = destino && typeof destino.closest === "function" &&
        !!destino.closest("#previa-lateral");
      const enCuerpo = destino === document.body || destino === document.documentElement;
      const activo = document.activeElement;
      const focoEnPanel = activo && typeof activo.closest === "function" &&
        !!activo.closest("#previa-lateral");
      if (!enPanel && !enCuerpo && !focoEnPanel) return;
      e.preventDefault();
      e.stopPropagation();
      if (tecla === "y" || (tecla === "z" && e.shiftKey)) rehacerDiseno();
      else deshacerDiseno();
    }, true);
  }

  function conectarEditable() {
    const boton = document.getElementById("previa-modo-editar");
    if (boton) boton.addEventListener("click", () => aplicarEditable(!editando));
    if (conDocumento()) {
      for (const b of document.querySelectorAll("#previa-paleta button[data-tipo]")) {
        b.addEventListener("click", () => anadir(b.dataset.tipo));
      }
      const deshacerBoton = document.getElementById("previa-editar-deshacer");
      if (deshacerBoton) deshacerBoton.addEventListener("click", () => deshacerDiseno());
      const rehacerBoton = document.getElementById("previa-editar-rehacer");
      if (rehacerBoton) rehacerBoton.addEventListener("click", () => rehacerDiseno());
      for (const idBorrar of ["previa-editar-eliminar", "previa-propiedades-eliminar"]) {
        const borrar = document.getElementById(idBorrar);
        if (borrar) borrar.addEventListener("click", () => borrarSeleccion());
      }
      const padre = document.getElementById("previa-propiedades-padre");
      if (padre) padre.addEventListener("click", () => seleccionarPadre());
      const alternarJerarquia = document.getElementById("previa-jerarquia-alternar");
      if (alternarJerarquia) alternarJerarquia.addEventListener("click", () => {
        jerarquiaVisible = !jerarquiaVisible;
        actualizarJerarquia(true);
      });
      const cerrarJerarquia = document.getElementById("previa-jerarquia-cerrar");
      if (cerrarJerarquia) cerrarJerarquia.addEventListener("click", () => {
        jerarquiaVisible = false;
        actualizarJerarquia(true);
      });
      const archivoImagen = document.getElementById("previa-imagen-archivo");
      if (archivoImagen) archivoImagen.addEventListener("change", () => {
        const f = archivoImagen.files && archivoImagen.files[0];
        const campo = campoImagenActivo || document.querySelector(
          '#previa-propiedades-campos [data-propiedad="android:src"]');
        if (f) importarImagen(f, campo).catch((e) => falloSilencioso("importar la imagen elegida", e));
        archivoImagen.value = "";
      });
      const cerrarPropiedades = document.getElementById("previa-propiedades-cerrar");
      if (cerrarPropiedades) {
        cerrarPropiedades.addEventListener("click", () => {
          seleccionar(null);
          const canvas = canvasVivo();
          if (canvas && typeof canvas.focus === "function") canvas.focus();
        });
      }
      conectarPlegables();
      conectarPaletaArrastre();
      conectarAtajosDiseno();
    }
    conectarCanvasEditable();
    conectarSoltarApk();
    conectarTecladoEditable();
  }

  // --- arranque -----------------------------------------------------------------------------
  // --- secciones del emulador ---------------------------------------------------------------
  // Registro, consola de la app y controles de pulsar son tres pestañas en cada superficie, como
  // las del panel inferior de compilación. Alternar solo cambia `hidden`: el contenido y el scroll
  // de cada panel se conservan.
  const seccion = { panel: SECCION_POR_DEFECTO, vista: SECCION_POR_DEFECTO };

  function aplicarSeccion(indice, valor, persistir) {
    const grupo = SECCIONES[indice];
    if (!grupo) return;
    const elegida = Object.prototype.hasOwnProperty.call(grupo.paneles, valor) ? valor : SECCION_POR_DEFECTO;
    for (const [clave, idBoton] of Object.entries(grupo.botones)) {
      const boton = el(idBoton);
      if (!boton) continue;
      const activo = clave === elegida;
      boton.classList.toggle("activo", activo);
      boton.setAttribute("aria-selected", activo ? "true" : "false");
      boton.tabIndex = activo ? 0 : -1;
    }
    for (const [clave, idPanel] of Object.entries(grupo.paneles)) {
      const panel = el(idPanel);
      if (panel) panel.hidden = clave !== elegida;
    }
    if (indice === 0) seccion.panel = elegida; else seccion.vista = elegida;
    if (persistir) guardarClave(grupo.clave, elegida);
  }

  function conectarSecciones() {
    SECCIONES.forEach((grupo, indice) => {
      const claves = Object.keys(grupo.botones);
      for (const clave of claves) {
        const boton = el(grupo.botones[clave]);
        if (!boton) continue;
        boton.addEventListener("click", () => aplicarSeccion(indice, clave, true));
        // role="tab" obliga a recorrer las pestañas con las flechas, Home y End
        boton.addEventListener("keydown", (e) => {
          if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const actual = claves.indexOf(clave);
          const destino = e.key === "Home" ? 0
            : e.key === "End" ? claves.length - 1
              : e.key === "ArrowRight" ? (actual + 1) % claves.length
                : (actual - 1 + claves.length) % claves.length;
          aplicarSeccion(indice, claves[destino], true);
          const siguiente = el(grupo.botones[claves[destino]]);
          if (siguiente) siguiente.focus();
        });
      }
      aplicarSeccion(indice, leerClave(grupo.clave, SECCION_POR_DEFECTO), false);
    });
  }

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
    leerFlotantes();

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
    // la capa del panel comparte tiradores con los marcos: los suyos son nuevos y viven dentro de
    // `#previa-inspector`; los de Pantalla ya están montados arriba y no se duplican
    montarTiradoresFlotantes("panel");

    // el movimiento se sigue en el documento: el puntero puede salirse del tirador sin soltar
    document.addEventListener("pointermove", (e) => {
      if (!arrastre) return;
      aplicarArrastre(e.clientX - arrastre.x, e.clientY - arrastre.y);
      e.preventDefault();
    });
    document.addEventListener("pointerup", soltar);
    document.addEventListener("pointercancel", soltar);

    conectarModos();
    conectarSecciones();
    conectarEntrada();
    conectarCanvas("previa-lateral-canvas");
    conectarCanvas("vista-previa");
    montarCampoTexto();
    conectarEditable();
    conectarControles();
    montarMenuDeOpciones();
    montarControlIntercambio();
    montarToasts();
    // el desplegable del menú se cierra al tocar fuera o con Escape, como cualquier popup; no toca
    // OPFS ni el documento: es estado de la interfaz
    document.addEventListener("pointerdown", (e) => {
      // el pointerdown que abrió el campo es este mismo evento subiendo desde el canvas: no puede
      // cerrarlo. Cualquier otro toque fuera del campo le quita el foco, sin tocar el documento.
      if (e === ignorarCierreTexto) { ignorarCierreTexto = null; return; }
      if (campoTexto && e.target !== campoTexto) cerrarCampoTexto();
      if (!menuDesplegado) return;
      const dentro = SUPERFICIES.some((s) => {
        const lista = el(s.menu.lista), boton = el(s.menu.control);
        return (lista && lista.contains(e.target)) || (boton && boton.contains(e.target));
      });
      if (!dentro) cerrarMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !menuDesplegado) return;
      e.preventDefault();
      cerrarMenu();
      const boton = SUPERFICIES.map((s) => el(s.menu.control))
        .find((b) => b && b.offsetParent !== null);
      if (boton) boton.focus();
    });
    // el campo es `fixed`: al desplazarse o redimensionarse la ventana su caja de referencia cambia
    window.addEventListener("scroll", colocarCampoTexto, true);
    window.addEventListener("resize", colocarCampoTexto);
    actualizarEnergiaBotones();
    aplicarPantalla(pantalla, false);
    aplicarInspector("panel", inspectorAbierto.panel, false);
    aplicarInspector("vista", inspectorAbierto.vista, false);
    actualizarUltima();
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
        aplicarModoFlotante("panel", false);
        // El lienzo no se reescala por mover o cambiar de modo la consola: ese cambio despierta este
        // observador y el ajuste se salta mientras dura el gesto (la pausa la pone el propio gesto).
        // Con el emulador apagado manda la caja del lienzo (lo pinta `dibujarApagado`). El ajuste
        // por tamaño de ventana o por preset sigue pasando: cambia la caja o el par de dp.
        if (!apagado && !pausaCanvas) ajustarPantallas();
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
    ajustarPantallas();
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
    // teclear desde fuera (pruebas y consola): el mismo paso `--escribir` que el campo real
    escribir: enviarEscritura,
    // lectura para las pruebas: el campo real y el EditText con el foco en este momento
    campoTexto: () => ({
      montado: !!campoTexto,
      visible: !!(campoTexto && !campoTexto.hidden),
      valor: campoTexto ? campoTexto.value : "",
      idRef: focoTexto ? focoTexto.idRef : "",
      textos: Object.fromEntries(textosEscritos),
    }),
    // el modo editar, para las pruebas de chromium y la consola de desarrollo
    editar: aplicarEditable,
    anadir,
    // soltar un tipo de la paleta en un punto del layout (coordenadas del modelo)
    anadirEn,
    borrarSeleccion,
    seleccionar,
    // el historial propio del diseñador (los mismos caminos que Ctrl+Z/Ctrl+Mayús+Z)
    deshacerDiseno,
    rehacerDiseno,
    // el modo cómodo: el dex del build entra en el guion vivo con la firma que manda la pestaña
    intercambiarDelBuild,
    // lectura para las pruebas: el modelo dibujado en el modo Vista previa (no el código)
    modeloVivo: () => modeloVivo,
    // el intérprete solo intercambia sobre una sesión viva; la pestaña lo usa para decidir si
    // inicia el emulador o aplica el dex directamente
    tieneSesion: () => !!resumenEjecucion(modeloActual()),
    // lo que el modelo publicó en `ejecucion.intercambios`, no lo que el panel pidió
    intercambios: () => (resumenEjecucion(modeloActual()) || { intercambios: [] }).intercambios,
    estado: () => ({
      ancho: caja.ancho, alto: caja.alto, arriba: caja.arriba,
      lado: cajaLado.ancho, ladoAlto: cajaLado.alto,
      visible, modo, ruta: rutaViva, pulsos: [...pulsos], editando,
      guion: guion.map((p) => p.tipo + (p.valor ? ":" + p.valor : p.firma ? ":" + p.firma : "")),
      // las rutas de OPFS que usan los pasos de hot swap, para que una prueba pueda comprobar que
      // el dex quedó bajo /previa-soltada/ y no en el proyecto
      intercambios: guion.filter((p) => p.tipo === "intercambiar").map((p) => p.ruta),
      menuAbierto: menuDesplegado,
      seccionPanel: seccion.panel, seccionVista: seccion.vista,
      // estado acoplable de las dos capas, para las pruebas de navegador sin leer estilos
      flotantes: {
        panel: { modo: inspector.modo, borde: inspector.borde,
          ancho: inspector.ancho, alto: inspector.alto },
        vista: { modo: lado.modo, borde: lado.borde,
          ancho: cajaLado.ancho, alto: cajaLado.alto },
      },
      seleccion: seleccion ? seleccion.slice() : null,
    }),
  };
}
