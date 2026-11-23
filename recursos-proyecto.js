// Barrido de recursos del proyecto: los tipos y nombres de `R.` que salen de las rutas de OPFS
// (`res/layout`, `drawable`, `mipmap`…), de los XML de `res/values*`, de los `@+id/` de los
// layouts y de la `R.java` que dejó el build.
//
// Vive aparte de `autocompletado.js` porque lo usan dos consumidores: la lista del autocompletado
// (Java y XML) y el linter de XML, que necesita saber si un `@string/app_name` existe de verdad.
// La caché es de una sola copia: guardar, crear, importar, mover, borrar o recibir un cambio de
// otra ventana (`apkc:proyecto-cambio`) la invalida, y nadie recorre OPFS dos veces por la misma
// pulsación. Recursos y clases se tiran por separado: un `.java` no repite el barrido de `res/`.
// Sin OPFS (por ejemplo http sin COOP/COEP) devuelve un mapa vacío en vez de reventar.
import { hospedador } from "./pestana.js";
import {
  recursosDeRutas, agregarValores, agregarIdsDeXml, recursosDeRJava, clasesDeRutas,
} from "./autocompletado-datos.js";

const TEXTOS = new TextDecoder();
let cache = null;          // tipo -> Set de nombres (R.*)
let cacheClases = null;    // nombres de clase del proyecto (/src/…)
// Dos banderas, no una: guardar un `.java` no puede obligar a recorrer otra vez `res/`, y un
// `res/` nuevo no invalida la lista de clases. Las dos se llenan con el mismo barrido, pero se
// tiran por separado. `listo` incluye el barrido vacío para no repetirlo en cada pulsación.
let listoRecursos = false;
let listoClases = false;
let version = 0;           // invalida un barrido que llegue tarde, después de un cambio
let enCurso = null;

export function totalDeNombres(mapa) {
  let total = 0;
  for (const tipo of Object.keys(mapa || {})) total += (mapa[tipo] || new Set()).size;
  return total;
}

async function leer() {
  const mapa = {};
  const clases = new Set();
  let arbol = null;
  try {
    arbol = await hospedador.arbol();
  } catch (e) {
    return { mapa, clases }; // sin OPFS no hay proyecto que barrer: los recursos quedan vacíos
  }
  const rutas = ((arbol && arbol.nodos) || [])
    .filter((n) => n && n.ruta && !n.dir)
    .map((n) => n.ruta);
  recursosDeRutas(rutas, mapa);
  // los tipos del proyecto salen del mismo árbol, sin abrir ni parsear los `.java`
  for (const clase of clasesDeRutas(rutas)) clases.add(clase);
  for (const ruta of rutas) {
    const esValues = /\/res\/values[^/]*\/[^/]+\.xml$/.test(ruta);
    const esXml = /\/res\/(layout|menu|xml)[^/]*\/[^/]+\.xml$/.test(ruta);
    const esR = /\/src\/(?:.+\/)?R\.java$/.test(ruta);
    if (!esValues && !esXml && !esR) continue;
    let bytes = null;
    try {
      bytes = await hospedador.bytes(ruta); // el hospedador devuelve el Uint8Array
    } catch (e) {
      continue;
    }
    if (!bytes) continue;
    const texto = TEXTOS.decode(bytes);
    if (esValues) agregarValores(texto, mapa);
    else if (esR) recursosDeRJava(texto, mapa);
    else agregarIdsDeXml(texto, mapa);
  }
  return { mapa, clases };
}

// Un solo barrido para los dos consumidores. La caché se da por buena también cuando salió vacía
// (`listo*`): un proyecto aún sin `res/` o sin `src/` dejaría de barrer OPFS en cada pulsación.
// Los cambios que pueden llenarla llegan por `apkc:proyecto-cambio` (guardar, crear, importar,
// mover, borrar y las que publica otra ventana), que invalida; ya no hace falta pulsar
// `refrescar()` a mano.
function cargarDatos() {
  if (enCurso) return enCurso;
  const mio = version;
  const promesa = leer().then(
    (resultado) => {
      if (mio === version) {
        cache = resultado.mapa;
        cacheClases = resultado.clases;
        listoRecursos = true;
        listoClases = true;
      }
      // solo se suelta la marca si sigue siendo este barrido: una invalidación puede haber
      // arrancado otro y no se le puede pisar el `enCurso`
      if (enCurso === promesa) enCurso = null;
      return resultado;
    },
    (e) => {
      if (enCurso === promesa) enCurso = null;
      throw e;
    },
  );
  enCurso = promesa;
  return promesa;
}

export async function cargarRecursosProyecto() {
  if (listoRecursos) return cache || {};
  return (await cargarDatos()).mapa;
}

// Tipos del proyecto (`/src/…/Foo.java`) para el contexto de clases del autocompletado Java.
export async function cargarClasesProyecto() {
  if (listoClases) return cacheClases || new Set();
  return (await cargarDatos()).clases;
}

export function recursosEnCache() {
  return cache || {};
}

// Un proyecto nuevo o un `res/`/`R.java` cambiado invalida las dos cachés: el árbol entero pudo
// cambiar (importar, crear, borrar una carpeta, meter un `deps/`).
export function invalidarRecursosProyecto() {
  version++;
  cache = null;
  cacheClases = null;
  listoRecursos = false;
  listoClases = false;
  enCurso = null;
}

// Un `.java` creado, guardado, renombrado o borrado solo cambia la lista de clases. Se tira
// `cacheClases` y no `cache`: el siguiente `cargarClasesProyecto()` vuelve a barrer (una vez),
// mientras el autocompletado XML conserva su mapa de `res/`. Es la razón de separar las dos
// banderas en vez de ampliar `tocaRecursos`.
export function invalidarClasesProyecto() {
  version++;
  cacheClases = null;
  listoClases = false;
  enCurso = null;
}

// `pestana.js` avisa por el DOM (no por BroadcastChannel) para que la misma ventana se entere de
// sus propios guardados y creaciones. Un `@+id` que aún no se ha guardado lo aporta el propio
// buffer en `candidatosXml`.
function tocaRecursos(mensaje) {
  const d = mensaje || {};
  if (d.tipo === "proyecto") return true;
  const rutas = [d.ruta, d.origen, d.destino, ...(Array.isArray(d.rutas) ? d.rutas : [])]
    .filter(Boolean);
  return rutas.some((r) => /\/res\//.test(String(r)) || /(^|\/)R\.java$/.test(String(r)));
}

// Cualquier `.java` cambia los tipos del proyecto; también la creación, el renombrado o el
// borrado de una ruta bajo `/src/` (puede ser una carpeta o un fichero sin extensión `.java`).
function tocaClases(mensaje) {
  const d = mensaje || {};
  if (d.tipo === "proyecto") return true;
  const rutas = [d.ruta, d.origen, d.destino, ...(Array.isArray(d.rutas) ? d.rutas : [])]
    .filter(Boolean);
  return rutas.some((r) => /\.java$/i.test(String(r)) || /\/src\//.test(String(r)));
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("apkc:proyecto-cambio", (evento) => {
    const detalle = evento && evento.detail;
    // el orden importa: un `R.java` bajo `/src/` cae en las dos ramas y el proyecto entero manda
    if (tocaRecursos(detalle)) invalidarRecursosProyecto();
    else if (tocaClases(detalle)) invalidarClasesProyecto();
  });
}
