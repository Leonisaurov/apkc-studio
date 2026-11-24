// Parser puro de la coordenada que se escribe en la sección de dependencias. Sin DOM, sin red y
// sin OPFS: solo convierte texto en datos y explica lo que no puede hacer aquí.
//
// La forma es la misma que acepta `apkc-deps` de Python en `deps.json`:
//   grupo:artefacto:versión[:clasificador]
// Dos tramos (`grupo:artefacto`) solo son válidos si un BOM (lista de materiales) fija la versión;
// es el `allow_no_version` de `parse_coord`. Los rangos de un solo valor (`[1.0]`, `[1.0,1.0]`) se
// colapsan a ese valor, como `collapse_range`. Los rangos de un tramo se dejan literalmente
// (`[1.0,)`, `(,2.0]`) porque `apkc-deps` elige la versión listando `maven-metadata.xml`, algo que
// esta página no hace. Los multi-rango se rechazan con el mismo motivo que el Python.
//
// El núcleo WISP es más estrecho: exige exactamente tres tramos y caracteres de Maven en cada uno
// (`wisp.js:181-187` y `apkc/depswisp.go:517-532`). Se valida aparte para que un clasificador o un
// BOM no se recorten en silencio: la ficha dice por qué esa coordenada no puede ir por el relay.

const CAMPO = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const CAMPO_SIN_MAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_CAMPO = 128; // `maxLargoCampoMaven` del núcleo
const BOM_UNICODE = "\ufeff";

export const MOTIVO_MULTI_RANGO =
  "rango no soportado: apkc-deps elige la versión de un rango de un solo tramo " +
  "([a,b], (a,b), [a,), (,b]); los multi-rango de Maven ((,a],[b,)) hay que declararlos sueltos";
export const MOTIVO_WISP_TRES_PARTES = "el núcleo WISP acepta solo grupo:artefacto:versión (3 partes)";

function campoValido(valor, permiteMas) {
  if (typeof valor !== "string" || !valor || valor.length > MAX_CAMPO) return false;
  const re = permiteMas ? CAMPO : CAMPO_SIN_MAS;
  if (!re.test(valor) || valor === "." || valor === ".." || valor.includes("..")) return false;
  return permiteMas || valor.split(".").every((tramo) => tramo.length > 0);
}

// La versión puede ser un rango de un tramo literal (`[1.0,)`, `(,2.0]`): sus extremos tienen que
// ser campos válidos, pero el extremo abierto es cadena vacía. El clasificador nunca es un rango.
function versionValida(valor) {
  const limites = limitesDeRango(valor);
  if (!limites) return campoValido(valor, true);
  return limites.every((extremo) => !extremo || campoValido(extremo, true));
}

// Los extremos de un rango de un solo tramo, o null. Un corchete dentro del cuerpo delata un
// multi-rango: es la misma regla que `range_bounds` del Python.
function limitesDeRango(raw) {
  if (raw.length < 3 || !"[(".includes(raw[0]) || !"])".includes(raw[raw.length - 1])) return null;
  const cuerpo = raw.slice(1, -1);
  if (/[\[\]()]/.test(cuerpo)) return null;
  const partes = cuerpo.split(",").map((p) => p.trim());
  if (partes.length === 1) return partes[0] ? [partes[0], partes[0]] : null;
  if (partes.length !== 2) return null;
  if (!partes[0] && !partes[1]) return null;
  return partes;
}

export function colapsarRango(version) {
  const raw = String(version == null ? "" : version).trim();
  if (!raw) return { version: raw, aviso: "", error: "campo de versión vacío" };
  if (!"[(".includes(raw[0]) && !"])".includes(raw[raw.length - 1])) {
    return { version: raw, aviso: "", error: "" };
  }
  const limites = limitesDeRango(raw);
  if (!limites) return { version: "", aviso: "", error: MOTIVO_MULTI_RANGO };
  const [bajo, alto] = limites;
  if (bajo && alto && bajo === alto) {
    return {
      version: bajo,
      aviso: "rango de un solo valor «" + raw + "» fijado a «" + bajo + "», como en apkc-deps",
      error: "",
    };
  }
  return {
    version: raw,
    aviso: "rango de un tramo «" + raw + "»: esta página no lista maven-metadata.xml para elegir " +
      "la versión más alta; escribe una versión suelta o usa el índice local del propio origen",
    error: "",
  };
}

function fracaso(entrada, error) {
  return {
    ok: false, error, entrada, coord: "", grupo: "", artefacto: "", version: "",
    clasificador: "", sinVersion: false, avisos: [], wisp: { ok: false, motivo: error },
  };
}

// Devuelve `{ ok, error, coord, grupo, artefacto, version, clasificador, sinVersion, avisos,
// wisp: { ok, motivo } }`. `permitirBom` es el único camino para aceptar dos tramos.
export function parsearCoordenada(texto, { permitirBom = false } = {}) {
  const crudo = String(texto == null ? "" : texto);
  const avisos = [];
  let entrada = crudo;
  if (entrada.startsWith(BOM_UNICODE)) {
    entrada = entrada.replace(/^\ufeff+/, "");
    avisos.push("había un BOM Unicode al principio: se quitó para leer la coordenada");
  }
  const conEspacios = entrada !== entrada.trim();
  entrada = entrada.trim();
  if (conEspacios) avisos.push("se recortaron espacios alrededor de la coordenada");
  const partes = entrada.split(":");
  if (![2, 3, 4].includes(partes.length) || (partes.length === 2 && !permitirBom)) {
    return fracaso(crudo, "coordenada inválida: «" + entrada + "» (esperado " +
      "grupo:artefacto:versión[:clasificador], o grupo:artefacto si la fija un BOM" +
      (permitirBom ? "; aquí dos tramos se aceptan por el BOM" : "") + ")");
  }
  if (!partes[0] || !partes[1] || (partes.length > 2 && !partes[2]) ||
      (partes.length === 4 && !partes[3])) {
    return fracaso(crudo, "coordenada con campo vacío: «" + entrada + "»");
  }
  if (!campoValido(partes[0], false)) return fracaso(crudo, "el grupo «" + partes[0] + "» no es válido");
  if (!campoValido(partes[1], false)) return fracaso(crudo, "el artefacto «" + partes[1] + "» no es válido");

  const sinVersion = partes.length === 2;
  const versionCruda = sinVersion ? "" : partes[2];
  const rango = sinVersion ? { version: "", aviso: "", error: "" } : colapsarRango(versionCruda);
  if (rango.error) return fracaso(crudo, rango.error + " en «" + entrada + "»");
  if (rango.aviso) avisos.push(rango.aviso);
  if (!sinVersion && !versionValida(rango.version)) {
    return fracaso(crudo, "la versión «" + rango.version + "» no es válida");
  }
  const clasificador = partes.length === 4 ? partes[3] : "";
  if (clasificador && !campoValido(clasificador, true)) {
    return fracaso(crudo, "el clasificador «" + clasificador + "» no es válido");
  }
  if (sinVersion) {
    avisos.push("dos tramos: la versión la fija un BOM; el índice local debe traer la coordenada «" +
      entrada + "» sin versión");
  }

  const coord = [partes[0], partes[1], rango.version].concat(clasificador ? [clasificador] : []).join(":");
  const resultado = {
    ok: true, error: "", entrada: crudo, coord,
    grupo: partes[0], artefacto: partes[1], version: rango.version, clasificador, sinVersion,
    avisos,
    wisp: { ok: false, motivo: "" },
  };
  resultado.wisp = validarParaWisp(resultado);
  return resultado;
}

// Validación separada para el relay. No recorta nada: un clasificador o una versión fijada por BOM
// se explican en la ficha, y la coordenada sigue sirviendo para el índice local.
export function validarParaWisp(resultado) {
  if (!resultado || !resultado.ok) {
    return { ok: false, motivo: (resultado && resultado.error) || "coordenada no válida" };
  }
  const partes = resultado.coord.split(":");
  if (partes.length !== 3) {
    const detalle = resultado.clasificador
      ? " el clasificador «" + resultado.clasificador + "» no se recorta: usa el índice local " +
        "del propio origen o quítalo"
      : " la versión la fija un BOM y el núcleo necesita una versión explícita";
    return { ok: false, motivo: MOTIVO_WISP_TRES_PARTES + ";" + detalle };
  }
  if (!campoValido(partes[0], false)) {
    return { ok: false, motivo: "el grupo «" + partes[0] + "» no es válido para el núcleo WISP" };
  }
  if (!campoValido(partes[1], false)) {
    return { ok: false, motivo: "el artefacto «" + partes[1] + "» no es válido para el núcleo WISP" };
  }
  if (!campoValido(partes[2], true)) {
    return { ok: false, motivo: "la versión «" + partes[2] + "» no es válida para el núcleo WISP" };
  }
  if (/[\[\]()]/.test(partes[2])) {
    return { ok: false, motivo: "el núcleo WISP no acepta rangos: escribe la versión suelta" };
  }
  return { ok: true, motivo: "" };
}
