// Punto de entrada del sitio. Las dependencias se resuelven con imports; el HTML ya no decide
// el orden de carga. `temas.js` se carga aparte en el <head> para aplicar el tema antes de pintar.
import { hospedador } from "./pestana.js";
import { instalarPuenteEnReposo } from "./wisp-puente.js";
import { CONTRATO_NUCLEO } from "./wisp.js";
import "./autocompletado.js";
import "./vistas.js";
import "./diagnostico.js";
// la paleta de comandos (Ctrl+Mayús+P) es de toda la página, no del panel de Inicio: vive aquí y
// no dentro de `diagnostico.js`, que solo pinta `analyze()`
import "./paleta.js";
import "./idioma.js";
import "./offline.js";
import "./reparar.js";

// El proxy de reposo usa la misma cola del hospedador que el núcleo vivo. Se instala en el punto
// de entrada de la página —no en las pruebas de node que importan los módulos sueltos— para que
// `resolverPorWisp` pueda pedir un artefacto con `wisp-get` cuando no haya núcleo vivo.
instalarPuenteEnReposo({
  global: globalThis,
  contrato: CONTRATO_NUCLEO,
  enviar: (mensaje) => hospedador.wispEnReposo(mensaje.payload),
});
