// Barrido de recursos del proyecto: los tipos y nombres de `R.` que salen de las rutas de OPFS
// (`res/layout`, `drawable`, `mipmap`…), de los XML de `res/values*`, de los `@+id/` de los
// layouts y de la `R.java` que dejó el build.
//
// Vive aparte de `autocompletado.js` porque lo usan dos consumidores: la lista del autocompletado
// (Java y XML) y el linter de XML, que necesita saber si un `@string/app_name` existe de verdad.
// La caché es de una sola copia: editar `res/` la invalida (con pausa, la decide quien teclea) y
// nadie recorre OPFS dos veces por la misma pulsación. Sin OPFS (por ejemplo http sin COOP/COEP)
// devuelve un mapa vacío en vez de reventar.
import { hospedador } from "./pestana.js";
import {
  recursosDeRutas, agregarValores, agregarIdsDeXml, recursosDeRJava,
} from "./autocompletado-datos.js";

const TEXTOS = new TextDecoder();
let cache = null;
let enCurso = null;

export function totalDeNombres(mapa) {
  let total = 0;
  for (const tipo of Object.keys(mapa || {})) total += (mapa[tipo] || new Set()).size;
  return total;
}

async function leer() {
  const mapa = {};
  let arbol = null;
  try {
    arbol = await hospedador.arbol();
  } catch (e) {
    return mapa; // sin OPFS no hay proyecto que barrer: los recursos quedan vacíos
  }
  const rutas = ((arbol && arbol.nodos) || [])
    .filter((n) => n && n.ruta && !n.dir)
    .map((n) => n.ruta);
  recursosDeRutas(rutas, mapa);
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
  return mapa;
}

// La caché solo se da por buena si tiene algo: un barrido vacío puede ser un proyecto que aún no
// se ha creado, y entonces hay que volver a mirar.
export async function cargarRecursosProyecto() {
  if (cache && Object.keys(cache).length) return cache;
  if (enCurso) return enCurso;
  enCurso = leer().then(
    (mapa) => { cache = mapa; enCurso = null; return mapa; },
    (e) => { enCurso = null; throw e; },
  );
  return enCurso;
}

export function recursosEnCache() {
  return cache || {};
}

export function invalidarRecursosProyecto() {
  cache = null;
}
