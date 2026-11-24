// Puente del contrato WISP entre el worker y la página. El núcleo (`apkcWisp`) se registra dentro
// del wasm de Go, en el worker, y `wisp.js` lo busca en `globalThis` de la página: sin este módulo
// la persona ve «núcleo WISP no disponible» aunque la compilación sí lo traiga.
//
// Es un módulo puro: no toca el DOM ni instala nada al importarse. `activar()` escribe los globales
// del núcleo vivo con el contrato que el worker anunció por mensaje; `instalarPuenteEnReposo()`
// instala `apkcWispEnReposo`, que dispara `wisp-get` cuando no hay núcleo vivo. `tipoGo` y
// `bytesWasm` del sondeo no activan nada (son del cargador, no del núcleo).
import { CONTRATO_NUCLEO } from "./wisp.js";

// La forma de respuesta es la misma para las dos vías. El worker transfiere un
// ArrayBuffer para no copiar el artefacto; el contrato de la página exige
// Uint8Array, que es lo que `wisp.js` contrasta antes de darlo por bueno.
function interpretarRespuesta(r) {
  if (!r || r.tipo === "error") {
    throw new Error((r && r.error) || "el núcleo WISP no respondió");
  }
  if (r.tipo !== "wisp") {
    throw new Error("respuesta WISP inesperada: " + String(r.tipo));
  }
  const respuesta = r.respuesta || {};
  const bytes = respuesta.bytes == null ? respuesta.bytes : new Uint8Array(respuesta.bytes);
  return { ...respuesta, bytes };
}

function comprobarContrato(global, enviar, contrato) {
  if (!global || typeof enviar !== "function") {
    throw new Error("el puente WISP necesita un global donde instalarse y una función enviar");
  }
  // El contrato no se negocia: otra versión obligaría a cambiar el núcleo y la página a la vez.
  if (contrato !== CONTRATO_NUCLEO) {
    throw new Error("contrato WISP desconocido: " + contrato + "; se esperaba " + CONTRATO_NUCLEO);
  }
}

// `apkcWispEnReposo` es el mismo contrato para cuando no hay núcleo vivo: en
// vez de hablar con el global de Go, dispara `apkc wisp-get` en el hospedador
// con la petición (incluidas las CAs) en go.env. Es un comando de un solo
// disparo, no un demonio; se instala aparte y sobrevive a `desactivar()`.
export function instalarPuenteEnReposo({ global, enviar, contrato } = {}) {
  comprobarContrato(global, enviar, contrato);
  if (global.apkcWispEnReposo) return global.apkcWispEnReposo;
  global.apkcWispEnReposo = {
    version: contrato,
    obtener: async (payload) => interpretarRespuesta(await enviar({ tipo: "wisp-get", payload })),
  };
  return global.apkcWispEnReposo;
}

export function instalarPuenteWisp({ global, enviar, contrato } = {}) {
  comprobarContrato(global, enviar, contrato);
  let activo = false;

  const llamar = async (metodo, payload) => interpretarRespuesta(await enviar({ tipo: "wisp", metodo, payload }));

  const activar = (mensaje) => {
    if (mensaje != null && (mensaje.contrato !== CONTRATO_NUCLEO || mensaje.activo === false)) {
      throw new Error("el worker no anunció el contrato WISP " + CONTRATO_NUCLEO);
    }
    if (activo) return;
    global.apkcWisp = {
      version: contrato,
      obtener: (payload) => llamar("obtener", payload),
    };
    global.apkcWispCargarCAs = (payload) => llamar("cargarCAs", payload);
    activo = true;
  };

  const desactivar = () => {
    if (!activo) return;
    try { delete global.apkcWisp; } catch (e) { /* global de solo lectura: no se puede retirar */ }
    try { delete global.apkcWispCargarCAs; } catch (e) { /* ídem */ }
    activo = false;
  };

  return { activar, desactivar, estaActivo: () => activo };
}
