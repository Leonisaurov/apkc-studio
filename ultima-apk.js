// La última apk compilada, guardada aparte del build. `apkc build` escribe
// `/proyecto/build/app.apk` y la siguiente compilación lo pisa; esta copia estable en `/sdk`
// permite volver a ejecutar `apkc preview` cuando se quiera, sin compilar otra vez. No es un
// fichero del proyecto ni entra en el zip: es una preferencia de esta pestaña.
//
// El JSON que la acompaña lleva la fecha, el tamaño y el SHA-256. El botón del emulador lo lee
// para decir si hay copia y de cuándo es; si no hay copia no se inventa ninguna.
export const RUTA_ULTIMA_APK = "/sdk/ultimo.apk";
export const RUTA_ULTIMA_META = "/sdk/ultimo.json";
export const EVENTO_ULTIMA_APK = "apkc:ultima-apk";

function hexDe(buffer) {
  const bytes = new Uint8Array(buffer);
  let salida = "";
  for (const b of bytes) salida += b.toString(16).padStart(2, "0");
  return salida;
}

// SHA-256 de los bytes, en hexadecimal. Si el navegador no expone `crypto.subtle` (no debería
// pasar en un origen aislado), la copia se guarda igual y el hash queda vacío: el botón no
// finge un valor que no midió.
export async function hashSha256(bytes) {
  if (!bytes || !bytes.length) return "";
  try {
    if (typeof crypto === "undefined" || !crypto.subtle || !crypto.subtle.digest) return "";
    const copia = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    return hexDe(await crypto.subtle.digest("SHA-256", copia));
  } catch (e) {
    return "";
  }
}

// Copia el apk recién compilado a `/sdk/ultimo.apk` y escribe su ficha. Devuelve la ficha
// escrita o null si el origen no existe. Un fallo de OPFS se propaga para que el llamante lo
// cuente en la barra sin convertir un build correcto en un build fallido.
export async function guardarUltimaApk(hospedador, origen, datos = {}) {
  if (!hospedador || typeof hospedador.bytes !== "function") return null;
  const bytes = await hospedador.bytes(origen);
  if (!bytes || !bytes.length) return null;
  const escrito = await hospedador.escribir(RUTA_ULTIMA_APK, bytes);
  if (escrito && escrito.tipo === "error") throw new Error(escrito.error || "no se pudo escribir la copia");
  const meta = {
    ruta: RUTA_ULTIMA_APK,
    origen: String(origen || ""),
    tipo: String((datos && datos.tipo) || ""),
    bytes: bytes.length,
    sha256: await hashSha256(bytes),
    fecha: new Date().toISOString(),
  };
  const ficha = await hospedador.escribir(
    RUTA_ULTIMA_META, new TextEncoder().encode(JSON.stringify(meta)));
  if (ficha && ficha.tipo === "error") throw new Error(ficha.error || "no se pudo escribir la ficha");
  return meta;
}

// ¿Hay copia y qué dice su ficha? `hay` solo es true cuando los bytes del apk existen: una
// ficha huérfana (por ejemplo tras borrar la copia) no cuenta como «hay última apk».
export async function leerUltimaApk(hospedador) {
  const vacio = { hay: false, meta: null, bytes: 0 };
  if (!hospedador) return vacio;
  let meta = null;
  try {
    const ficha = await hospedador.leer(RUTA_ULTIMA_META);
    if (ficha && ficha.bytes && ficha.bytes.length) {
      meta = JSON.parse(new TextDecoder().decode(ficha.bytes));
    }
  } catch (e) {
    meta = null;
  }
  let bytes = null;
  try {
    bytes = await hospedador.bytes(RUTA_ULTIMA_APK);
  } catch (e) {
    bytes = null;
  }
  if (!bytes || !bytes.length) return vacio;
  return { hay: true, meta, bytes: bytes.length };
}

// La fecha de la ficha, corta y legible, sin fingir una zona horaria que no se guardó.
export function fechaDeMeta(meta) {
  const fecha = meta && typeof meta.fecha === "string" ? new Date(meta.fecha) : null;
  if (!fecha || Number.isNaN(fecha.getTime())) return "";
  const dos = (n) => String(n).padStart(2, "0");
  return dos(fecha.getDate()) + "/" + dos(fecha.getMonth() + 1) + " " +
    dos(fecha.getHours()) + ":" + dos(fecha.getMinutes());
}
