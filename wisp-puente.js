// Puente del contrato WISP entre el worker y la página. El núcleo (`apkcWisp`) se registra dentro
// del wasm de Go, en el worker, y `wisp.js` lo busca en `globalThis` de la página: sin este módulo
// la persona ve «núcleo WISP no disponible» aunque la compilación sí lo traiga.
//
// Es un módulo puro: no toca el DOM ni instala nada al importarse. Solo `activar()` escribe los
// globales, y lo hace con el contrato que el worker anunció por mensaje; `tipoGo` y `bytesWasm`
// del sondeo no activan nada (son del cargador, no del núcleo).
import { CONTRATO_NUCLEO } from "./wisp.js";

export function instalarPuenteWisp({ global, enviar, contrato } = {}) {
  if (!global || typeof enviar !== "function") {
    throw new Error("el puente WISP necesita un global donde instalarse y una función enviar");
  }
  // El contrato no se negocia: otra versión obligaría a cambiar el núcleo y la página a la vez.
  if (contrato !== CONTRATO_NUCLEO) {
    throw new Error("contrato WISP desconocido: " + contrato + "; se esperaba " + CONTRATO_NUCLEO);
  }
  let activo = false;

  const llamar = async (metodo, payload) => {
    const r = await enviar({ tipo: "wisp", metodo, payload });
    if (!r || r.tipo === "error") {
      throw new Error((r && r.error) || "el núcleo WISP no respondió");
    }
    if (r.tipo !== "wisp") {
      throw new Error("respuesta WISP inesperada: " + String(r.tipo));
    }
    const respuesta = r.respuesta || {};
    // El worker transfiere un ArrayBuffer para no copiar el artefacto; el contrato de la página
    // exige Uint8Array, que es lo que `wisp.js` contrasta antes de darlo por bueno.
    const bytes = respuesta.bytes == null ? respuesta.bytes : new Uint8Array(respuesta.bytes);
    return { ...respuesta, bytes };
  };

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
