// Módulo WISP de apkc-studio: la puerta, el aviso y la lista de relays.
//
// WISP es un proxy de sockets TCP sobre un WebSocket: un relay de terceros abre la conexión TCP
// desde su servidor, así que la respuesta de Maven llega como texto del WebSocket y el CORS deja
// de ser un muro. Eso rompe la regla 4 (nada fuera del origen) y por eso aquí no hay nada activo
// por defecto: la sección de dependencias sigue leyendo solo `./deps-index.json` del propio origen
// hasta que la persona acepta el aviso.
//
// Este fichero NO habla WISP ni TLS. El framing v1 y el `crypto/tls` viven en el núcleo de
// `apkc/`; aquí están el aviso, la elección de la persona, la lista de relays y el contrato con
// ese núcleo, que se documenta en DEPS.md.

export const RUTA_RELAYS = "./wisp-relays.json";
export const CLAVE_ELECCION = "apkc-studio/wisp";
export const VERSION_RELAYS = 1;
// Identificador del contrato con el núcleo. Cambiarlo obliga a cambiar el núcleo y esta página a
// la vez: no se negocia una forma a medias.
export const CONTRATO_NUCLEO = "apkc-wisp/1";

const ESQUEMA_RELAY = /^wss?:\/\//i;
const COORDENADA = /^[^:\s]+:[^:\s]+:[^:\s]+$/;

// La URL de un relay tiene que acabar en «/» (spec v1.2) y no puede llevar espacios. Se admiten
// `wss://` (lo normal) y `ws://` para un WISP local en esta misma máquina.
export function urlRelayValida(url) {
  const texto = String(url == null ? "" : url).trim();
  if (!texto) return "la URL del relay está vacía";
  if (!ESQUEMA_RELAY.test(texto)) return "la URL del relay tiene que empezar por wss:// (o ws:// para uno local)";
  if (/\s/.test(texto)) return "la URL del relay lleva espacios";
  if (texto.includes("?") || texto.includes("#")) {
    return "la URL del relay no admite «#» ni «?»; recibido " + JSON.stringify(texto);
  }
  let analizada;
  try { analizada = new URL(texto); }
  catch (e) { return "la URL del relay no se puede analizar: " + texto; }
  if (!analizada.host) return "la URL del relay no lleva servidor: " + texto;
  if (/^wss?:\/\/[^/?#]*@/i.test(texto)) {
    return "la URL del relay no admite credenciales de usuario; recibido " + JSON.stringify(texto);
  }
  if (analizada.protocol === "ws:" && !/^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(analizada.hostname)) {
    return "el relay debe usar wss:// (o ws:// en localhost); recibido " + JSON.stringify(texto);
  }
  if (!texto.endsWith("/")) return "la URL del relay tiene que acabar en «/» (spec v1.2), no en «" + texto.slice(-1) + "»";
  return "";
}

export function hostDeRelay(url) {
  try { return new URL(String(url || "")).host || ""; } catch (e) { return ""; }
}

// Una entrada de `wisp-relays.json` no se arregla: si falta la verificación por handshake, la
// latencia o el protocolo, se rechaza el fichero entero en vez de pintar un relay a ojo.
export function validarRelay(relay) {
  if (!relay || typeof relay !== "object" || Array.isArray(relay)) return "relay vacío";
  const problema = urlRelayValida(relay.url);
  if (problema) return problema;
  if (relay.verified !== true) return "el relay no consta verificado por handshake: " + relay.url;
  if (relay.protocol !== "v1") return "protocolo no admitido: " + JSON.stringify(relay.protocol);
  if (!Number.isInteger(relay.latencyMs) || relay.latencyMs < 0) {
    return "latencia no medida en " + relay.url + ": " + JSON.stringify(relay.latencyMs);
  }
  // `bufferPackets` puede ser null: el CONTINUE inicial varía de 128 a 2147483647 y solo se conoce
  // al abrir la conexión. Si viene medido, tiene que ser un entero positivo.
  if (relay.bufferPackets != null &&
      (!Number.isInteger(relay.bufferPackets) || relay.bufferPackets < 1)) {
    return "bufferPackets no válido en " + relay.url + ": " + JSON.stringify(relay.bufferPackets);
  }
  return "";
}

// Lee el JSON ya parseado. Las URLs repetidas se rechazan: dos filas iguales en el selector serían
// una elección ambigua.
export function leerRelays(datos) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw new Error("wisp-relays.json está vacío");
  if (datos.version !== VERSION_RELAYS) {
    throw new Error("wisp-relays.json no tiene version " + VERSION_RELAYS);
  }
  if (!Array.isArray(datos.relays) || !datos.relays.length) {
    throw new Error("wisp-relays.json no trae relays");
  }
  const relays = [];
  const vistas = new Set();
  for (const relay of datos.relays) {
    const problema = validarRelay(relay);
    if (problema) throw new Error("wisp-relays.json no válido: " + problema);
    if (vistas.has(relay.url)) throw new Error("wisp-relays.json repite el relay " + relay.url);
    vistas.add(relay.url);
    relays.push({
      url: relay.url, verified: relay.verified, latencyMs: relay.latencyMs,
      protocol: relay.protocol, bufferPackets: relay.bufferPackets == null ? null : relay.bufferPackets,
    });
  }
  return {
    version: datos.version, generado: String(datos.generado || ""), nota: String(datos.note || ""),
    spec: String(datos.spec || ""), relays,
  };
}

// La lista se pide al propio origen y solo cuando el módulo se activa: sin opt-in no hay ni una
// petición. `ruta` existe para la prueba; la página siempre usa `./wisp-relays.json`.
export async function cargarRelays({ fetchImpl, ruta } = {}) {
  const pedir = fetchImpl || globalThis.fetch;
  const destino = ruta || RUTA_RELAYS;
  const respuesta = await pedir(destino, { cache: "no-store", credentials: "same-origin" });
  if (!respuesta || !respuesta.ok) {
    throw new Error("no se pudo leer wisp-relays.json del propio origen" +
      (respuesta && respuesta.status ? " (" + respuesta.status + ")" : ""));
  }
  const tipo = String((respuesta.headers && respuesta.headers.get && respuesta.headers.get("content-type")) || "");
  if (/text\/html/i.test(tipo)) throw new Error("el origen devolvió HTML en vez de wisp-relays.json");
  let datos;
  try { datos = JSON.parse(await respuesta.text()); }
  catch (e) { throw new Error("wisp-relays.json no es JSON válido"); }
  return leerRelays(datos);
}

// --- la elección de la persona ----------------------------------------------------------------

// Solo hay dos valores guardados, y solo si la persona marcó «recordar»: por defecto no se escribe
// nada en localStorage.
export function leerEleccion(almacen) {
  if (!almacen || typeof almacen.getItem !== "function") return "";
  try {
    const valor = almacen.getItem(CLAVE_ELECCION);
    return valor === "activo" || valor === "inactivo" ? valor : "";
  } catch (e) { return ""; }
}

function guardarEleccion(almacen, valor) {
  if (!almacen || typeof almacen.setItem !== "function") return false;
  try { almacen.setItem(CLAVE_ELECCION, valor); return true; }
  catch (e) { return false; }
}

function borrarEleccion(almacen) {
  if (!almacen || typeof almacen.removeItem !== "function") return false;
  try { almacen.removeItem(CLAVE_ELECCION); return true; }
  catch (e) { return false; }
}

// El estado del módulo en esta pestaña. `decidir` fija la elección de la sesión y, solo si
// `recordar`, la deja escrita para la próxima visita.
export function crearEleccion({ almacen } = {}) {
  const guardada = leerEleccion(almacen);
  const estado = {
    decidido: !!guardada,
    activo: guardada === "activo",
    origen: guardada ? "recordada en este navegador" : "sin decisión",
  };
  return {
    estado,
    activo: () => estado.activo,
    decidido: () => estado.decidido,
    decidir(usar, { recordar = false } = {}) {
      estado.activo = !!usar;
      estado.decidido = true;
      estado.origen = recordar ? "recordada en este navegador" : "solo esta sesión";
      if (recordar) guardarEleccion(almacen, estado.activo ? "activo" : "inactivo");
      return estado.activo;
    },
    // «Desactivar» apaga el módulo y borra lo recordado: si la persona lo apagó a mano, la próxima
    // visita vuelve a preguntar en vez de resucitar la elección vieja.
    desactivar() {
      estado.activo = false;
      estado.decidido = true;
      estado.origen = "solo esta sesión";
      borrarEleccion(almacen);
      return false;
    },
    olvidar() {
      borrarEleccion(almacen);
      estado.decidido = false;
      estado.activo = false;
      estado.origen = "sin decisión";
    },
    guardada: () => leerEleccion(almacen),
  };
}

// --- el contrato con el núcleo ----------------------------------------------------------------

export function nucleoDisponible(global = globalThis) {
  const nucleo = global && global.apkcWisp;
  return !!nucleo && nucleo.version === CONTRATO_NUCLEO && typeof nucleo.obtener === "function";
}

// La carpeta de OPFS donde el núcleo deja el artefacto: el grupo se trocea con barras, igual que
// hace el núcleo (`strings.ReplaceAll(grupo, ".", "/")`), no con puntos como la vía del índice.
// El nombre del fichero lo decide el núcleo, porque sin índice no se sabe si el artefacto es `.jar` o `.aar`.
export function destinoDeCoordenada(coordenada) {
  const partes = String(coordenada == null ? "" : coordenada).trim().split(":");
  if (partes.length !== 3 ||
      partes.some((p) => !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(p) || p.includes("..")) ||
      partes[0].split(".").some((s) => !s)) {
    throw new Error("la coordenada no tiene la forma grupo:artefacto:versión: " + JSON.stringify(coordenada));
  }
  return "/deps/" + partes[0].replaceAll(".", "/") + "/" + partes[1] + "/" + partes[2] + "/";
}

// La llamada al núcleo. Sin él, el error dice exactamente qué falta y no se abre ningún socket:
// esta página no trae cliente WISP ni cliente TLS en JavaScript (ver DEPS.md).
export async function resolverPorWisp({ relay, coordenada, destino, hospedador, cas, global = globalThis } = {}) {
  const problema = urlRelayValida(relay);
  if (problema) throw new Error(problema);
  const coord = String(coordenada == null ? "" : coordenada).trim();
  if (!coord) throw new Error("escribe una coordenada Maven: grupo:artefacto:versión");
  if (!COORDENADA.test(coord)) throw new Error("la coordenada no tiene la forma grupo:artefacto:versión: " + JSON.stringify(coord));
  if (!hospedador || typeof hospedador.escribir !== "function") {
    throw new Error("no hay OPFS donde guardar el artefacto");
  }
  const nucleoVivo = nucleoDisponible(global);
  const reposo = !nucleoVivo && global && global.apkcWispEnReposo &&
    typeof global.apkcWispEnReposo.obtener === "function" ? global.apkcWispEnReposo : null;
  if (!nucleoVivo && !reposo) {
    throw new Error("núcleo WISP no disponible en esta compilación: el módulo no está construido en " +
      "esta página, así que no se abre ningún relay; Resolver sigue limitado a deps-index.json del propio origen");
  }
  // Las CAs se cargan antes de abrir el relay. El bundle ya viene verificado por `prepararCAS`:
  // con núcleo vivo se pasa `{pem, huella}` aparte; en reposo viajan en la petición de `wisp-get`,
  // que las fija con `CargarCAsPEMFijadas` antes de tocar la red. En los dos casos la respuesta se
  // contrasta abajo con `validarRespuestaNucleo` antes de pintarse.
  if (cas && nucleoVivo) await cargarCAsEnNucleo({ pem: cas.pem, huella: cas.huella, global });
  const peticion = {
    version: CONTRATO_NUCLEO, relay: String(relay).trim(), coordenada: coord,
    destino: destino || destinoDeCoordenada(coord),
  };
  if (reposo && cas) { peticion.pem = cas.pem; peticion.huella = cas.huella; }
  const respuesta = nucleoVivo
    ? await global.apkcWisp.obtener(peticion)
    : await reposo.obtener(peticion);
  // La respuesta se contrasta antes de devolverla: la página pinta `bytes`, `sha256` y `ruta`
  // sin mirarlos, así que un núcleo falso no puede colar aquí un fichero que no sea el que dice.
  await validarRespuestaNucleo(respuesta);
  return respuesta;
}

// --- las CAs del núcleo: un fichero del dispositivo, nunca un bundle del relay -----------------

// En `js/wasm` no existe `x509.SystemCertPool` (`apkc/wispcerts_js.go`), así que el `RootCAs` lo
// inyecta la página. El bundle se lee del disco con un input `file`, nunca se descarga: un bundle
// que llegara por el relay convertiría al relay en una CA y le dejaría firmar el certificado de
// cualquier host. El tamaño se acota antes de mirar el contenido.
export const MAX_CAS_BYTES = 64 * 1024;
const EXTENSION_CAS = /\.(pem|crt)$/i;
const NOMBRE_CON_ESQUEMA = /^[a-z][a-z0-9+.-]*:/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const INICIO_CERTIFICADO = "-----BEGIN CERTIFICATE-----";
const FIN_CERTIFICADO = "-----END CERTIFICATE-----";

// El nombre del fichero tiene que ser el de un fichero local con extensión de PEM. Un nombre con
// esquema (`https://…`) o con separadores no viene del selector de ficheros y se rechaza antes de
// leer un solo byte: esta página no descarga CAs de ninguna URL.
export function nombreCASValido(nombre) {
  const texto = String(nombre == null ? "" : nombre).trim();
  if (!texto) return "el fichero de CAs no tiene nombre";
  if (NOMBRE_CON_ESQUEMA.test(texto) || /[\/\\]/.test(texto)) {
    return "el bundle de CAs tiene que venir del disco, no de una URL: " + texto;
  }
  if (!EXTENSION_CAS.test(texto)) {
    return "el fichero de CAs tiene que acabar en .pem o .crt: " + texto;
  }
  return "";
}

// La misma exigencia que `CargarCAsPEM` del núcleo (`apkc/depswisp.go:104`): solo bloques
// CERTIFICATE, base64, cero bytes fuera de bloque y al menos un certificado. Aquí no se parsea
// X.509 —eso lo hace Go, que es el oráculo—, pero la basura se rechaza antes de cruzar el puente.
export function validarCAsPEM(texto) {
  const todo = String(texto == null ? "" : texto);
  if (!todo.trim()) return "el bundle de CAs está vacío";
  let i = 0;
  let certificados = 0;
  while (i < todo.length) {
    while (i < todo.length && /\s/.test(todo[i])) i++;
    if (i >= todo.length) break;
    if (!todo.startsWith(INICIO_CERTIFICADO, i)) {
      return "hay bytes fuera de un bloque CERTIFICATE en la posición " + i;
    }
    const fin = todo.indexOf(FIN_CERTIFICADO, i + INICIO_CERTIFICADO.length);
    if (fin < 0) return "hay un bloque CERTIFICATE sin cerrar";
    const cuerpo = todo.slice(i + INICIO_CERTIFICADO.length, fin).replace(/\s+/g, "");
    if (!cuerpo) return "el bloque CERTIFICATE está vacío";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cuerpo)) return "el bloque CERTIFICATE no es base64";
    certificados++;
    i = fin + FIN_CERTIFICADO.length;
  }
  if (!certificados) return "el bundle de CAs no trae ningún bloque CERTIFICATE";
  return "";
}

async function huellaSHA256(bytes) {
  const datos = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const resumen = await globalThis.crypto.subtle.digest("SHA-256", datos);
  return [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Tope de la respuesta del núcleo. `tope` es un parámetro del helper para poder falsificar el
// desbordamiento en las pruebas sin asignar 64 MiB; `resolverPorWisp` siempre usa el de producción.
export const MAX_RESPUESTA_WISP = 64 * 1024 * 1024;

// Contraste de la respuesta del núcleo antes de pintarla. Puro: no escribe nada, no rellena campos
// y no admite respaldos silenciosos; cualquier campo ausente o coherente solo a medias se lanza
// como Error con un mensaje literal. El sha256 se exige en minúscula, que es lo que emite
// `huellaSHA256`, y se compara con el sha256 calculado sobre los bytes recibidos.
export async function validarRespuestaNucleo(respuesta, tope = MAX_RESPUESTA_WISP) {
  if (!respuesta || typeof respuesta !== "object") {
    throw new Error("el núcleo WISP no devolvió una respuesta con bytes, sha256 y ruta");
  }
  if (!(respuesta.bytes instanceof Uint8Array)) {
    throw new Error("el núcleo WISP no devolvió los bytes como Uint8Array");
  }
  const bytes = respuesta.bytes;
  if (bytes.length === 0) {
    throw new Error("el núcleo WISP devolvió cero bytes");
  }
  if (bytes.length > tope) {
    throw new Error("el núcleo WISP devolvió " + bytes.length + " bytes, por encima del tope de " + tope + " bytes");
  }
  if (typeof respuesta.sha256 !== "string" || !SHA256_HEX.test(respuesta.sha256)) {
    throw new Error("el núcleo WISP no devolvió un sha256 hexadecimal de 64 dígitos: " + recorte(respuesta.sha256));
  }
  const huellaReal = await huellaSHA256(bytes);
  if (respuesta.sha256 !== huellaReal) {
    throw new Error("el sha256 del núcleo WISP no coincide con los bytes: declarado " +
      respuesta.sha256 + ", real " + huellaReal);
  }
  if (typeof respuesta.ruta !== "string" || !respuesta.ruta.startsWith("/deps/")) {
    throw new Error("la ruta del núcleo WISP no empieza por /deps/: " + recorte(respuesta.ruta));
  }
  if (respuesta.ruta.includes("..") || respuesta.ruta.includes("\\") ||
      respuesta.ruta.includes("?") || respuesta.ruta.includes("#")) {
    throw new Error("la ruta del núcleo WISP lleva «..», «\\», «?» o «#»: " + recorte(respuesta.ruta));
  }
  return respuesta;
}

// La huella esperada es opcional. Si viene, se aceptan los 64 hex en minúscula o mayúscula y con
// separadores «:»; cualquier otra cosa se rechaza en vez de compararse a ojo.
export function normalizarHuella(huella) {
  const texto = String(huella == null ? "" : huella).trim().toLowerCase().replace(/:/g, "");
  if (!texto) return "";
  if (!SHA256_HEX.test(texto)) {
    throw new Error("la huella esperada no es un sha256 en hexadecimal (64 dígitos): " + recorte(huella));
  }
  return texto;
}

function recorte(valor) {
  return String(valor == null ? "" : valor).slice(0, 80);
}

// El BOM UTF-8 (`EF BB BF`) no es contenido del PEM: es una marca del editor que no viaja al
// núcleo. Se decodifica con `ignoreBOM: true` para que el decodificador no lo borre a escondidas y
// se quita exactamente un U+FEFF al principio. Un segundo BOM, o un U+FEFF en medio, es un byte
// fuera de bloque y se rechaza: el BOM no puede colar nada que no esté dentro de un `CERTIFICATE`.
const BOM_UTF8 = 0xfeff;

// Prepara el payload que espera el núcleo: `{ pem, huella }` con el sha256 del PEM **entregado**,
// como `HuellaCAsPEM` en Go. La huella se calcula sobre los bytes de `pem` (sin BOM), no sobre el
// fichero crudo: `apkcWispCargarCAs` compara su huella con el PEM que recibe y una huella tomada
// del fichero crudo no coincidiría con el texto que se le pasa. Rechaza extensión, nombre con
// esquema, tamaño, codificación y PEM.
export async function prepararCAS({ nombre, bytes, huellaEsperada } = {}) {
  const problemaNombre = nombreCASValido(nombre);
  if (problemaNombre) throw new Error(problemaNombre);
  const datos = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!datos.length) throw new Error("el fichero de CAs está vacío: " + nombre);
  if (datos.length > MAX_CAS_BYTES) {
    throw new Error("el fichero de CAs pasa de 64 KiB (" + datos.length + " bytes): el bundle se " +
      "lee del dispositivo y no se acepta uno más grande");
  }
  let texto;
  try { texto = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(datos); }
  catch (e) { throw new Error("el fichero de CAs no es texto UTF-8: " + nombre); }
  if (texto.charCodeAt(0) === BOM_UTF8) texto = texto.slice(1);
  // `\s` de JavaScript cuenta U+FEFF como espacio, así que un BOM de más pasaría el validador y
  // llegaría al núcleo, cuyo `bytes.TrimSpace` de Go no lo traga. Se rechaza aquí, explícito.
  if (texto.includes("\ufeff")) {
    throw new Error("el fichero de CAs lleva un BOM (U+FEFF) fuera del principio: son bytes fuera " +
      "de un bloque CERTIFICATE (" + nombre + ")");
  }
  const problemaPEM = validarCAsPEM(texto);
  if (problemaPEM) throw new Error(problemaPEM + " (" + nombre + ")");
  const esperada = normalizarHuella(huellaEsperada);
  const bytesPEM = new TextEncoder().encode(texto);
  const huella = await huellaSHA256(bytesPEM);
  if (esperada && esperada !== huella) {
    throw new Error("la huella del bundle de CAs no coincide: esperada " + esperada + ", real " + huella);
  }
  // `bytes` es el tamaño del PEM entregado, no el del fichero: con BOM no coinciden, y quien lo
  // pinta («CAs aceptadas: N bytes») debe hablar de lo que viaja al núcleo.
  return { pem: texto, huella, nombre: String(nombre), bytes: bytesPEM.length };
}

// El puente con el núcleo, congelado en DEPS.md: `globalThis.apkcWispCargarCAs({ pem, huella })`.
// Se registra aparte de `globalThis.apkcWisp` para que la carga de CAs no cambie el contrato de
// `obtener`. Devuelve la respuesta del núcleo y exige `ok: true`.
export function nucleoAceptaCAs(global = globalThis) {
  return !!global && typeof global.apkcWispCargarCAs === "function";
}

export async function cargarCAsEnNucleo({ pem, huella, global = globalThis } = {}) {
  const texto = String(pem == null ? "" : pem);
  if (!texto.trim()) throw new Error("no hay bundle de CAs que cargar en el núcleo");
  // Invariante del contrato: la huella que ve el núcleo es el sha256 exacto del PEM que se le
  // entrega (`sha256(pem) === huella`). Si un llamador trae una huella del fichero crudo —con BOM—
  // o de otro texto, se corta aquí en vez de fijar en el núcleo una huella que no valida nada.
  const huellaPedida = normalizarHuella(huella);
  if (!huellaPedida) throw new Error("el bundle de CAs no lleva huella sha256 que entregar al núcleo");
  const huellaReal = await huellaSHA256(new TextEncoder().encode(texto));
  if (huellaPedida !== huellaReal) {
    throw new Error("la huella entregada al núcleo no es el sha256 del PEM que se entrega: " +
      "huella " + huellaPedida + ", real " + huellaReal);
  }
  if (!nucleoDisponible(global)) {
    throw new Error("núcleo WISP no disponible en esta compilación: las CAs no se pueden cargar ni " +
      "se abre ningún relay; Resolver sigue limitado a deps-index.json del propio origen");
  }
  if (!nucleoAceptaCAs(global)) {
    throw new Error("núcleo WISP sin carga de CAs en esta compilación: no acepta " +
      "apkcWispCargarCAs, así que no se usa el bundle y no se abre ningún relay");
  }
  const respuesta = await global.apkcWispCargarCAs({ pem: texto, huella: String(huella || "") });
  if (!respuesta || respuesta.ok !== true) {
    const motivo = respuesta && respuesta.error ? ": " + respuesta.error : "";
    throw new Error("el núcleo WISP rechazó el bundle de CAs" + motivo);
  }
  return respuesta;
}

// --- el aviso ---------------------------------------------------------------------------------

// Lo que el aviso tiene que decir, en el orden en que importa. La prueba comprueba las ideas
// sobre el texto que se pinta en `index.html`, no sobre una copia: si alguien suaviza el aviso,
// la comprobación falla.
export const AVISO = [
  "El módulo WISP es opcional y está apagado.",
  "Sirve para saltarse el CORS: Maven no manda cabeceras CORS y un relay WISP abre la conexión TCP desde su servidor, así que la respuesta llega por el WebSocket como si fuera del mismo origen.",
  "Descarga archivos extra del módulo desde este mismo origen: el binario del núcleo WISP (wasm) y su lista de relays.",
  "Si el núcleo TLS propio no está en esta compilación, el contenido viaja en claro por el relay: el relay, y cualquiera en su camino, puede leerlo y sustituirlo (MITM).",
  "El bundle de CAs se lee de tu dispositivo (un fichero PEM local), nunca del relay: se pasa al núcleo para que verifique el TLS.",
  "Si cargas el bundle de CAs de otro, conviertes a ese relay en una CA: podría firmar el certificado de cualquier host y leer lo que pase.",
  "Los relays de la lista son de terceros y no están auditados: nadie revisó quién los opera.",
];

// --- el panel ---------------------------------------------------------------------------------

// Engancha el bloque del panel y el diálogo del aviso. Devuelve una API pequeña para que el panel
// de dependencias decida antes de tocar la red:
//   asegurarDecision() -> Promise<boolean>   (abre el aviso solo si no hay decisión)
//   activo() / relayActual() / desactivar()
export function crearPanelWisp({ hospedador, almacen, fetchImpl, documento } = {}) {
  const doc = documento || (typeof document === "undefined" ? null : document);
  const porId = (id) => (doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null);
  const eleccion = crearEleccion({ almacen: almacen || (typeof localStorage === "undefined" ? null : localStorage) });

  const estadoTexto = porId("wisp-estado");
  const botonActivar = porId("wisp-activar");
  const botonDesactivar = porId("wisp-desactivar");
  const selector = porId("wisp-selector");
  const lista = porId("wisp-relay");
  const urlPropia = porId("wisp-url");
  const urlEstado = porId("wisp-url-estado");
  const aviso = porId("wisp-aviso");
  const recordar = porId("wisp-recordar");
  const casEntrada = porId("wisp-cas");
  const casHuella = porId("wisp-cas-huella");
  const casEstado = porId("wisp-cas-estado");

  let relays = null;
  let cargando = null;
  let cargaError = "";
  let resolverAviso = null;
  // El bundle de CAs ya validado (`{ pem, huella, nombre, bytes }`) o null. Se lee del disco al
  // elegir el fichero y no se toca más: el payload que recibe el núcleo es este.
  let cas = null;

  const decir = (texto, clase) => {
    if (!estadoTexto) return;
    estadoTexto.textContent = texto;
    estadoTexto.classList.toggle("mal", clase === "mal");
    estadoTexto.classList.toggle("bien", clase === "bien");
  };

  const pintar = () => {
    const activo = eleccion.activo();
    if (selector) selector.hidden = !activo;
    if (botonDesactivar) botonDesactivar.hidden = !activo;
    if (botonActivar) botonActivar.hidden = activo;
    if (!activo) {
      decir("módulo desactivado: Resolver solo lee deps-index.json del propio origen y no hace " +
        "ninguna petición fuera de él");
      return;
    }
    if (cargaError) {
      decir("módulo activo (" + eleccion.estado.origen + "), pero no se pudo leer wisp-relays.json: " +
        cargaError, "mal");
      return;
    }
    const nota = relays
      ? relays.relays.length + " relays conocidos, de terceros y sin auditar; la latencia es la de " +
        "un handshake de prueba y cambia"
      : "cargando la lista de relays del propio origen…";
    decir("módulo activo (" + eleccion.estado.origen + "): " + nota, "bien");
  };

  // La lista se pide una sola vez, al activar el módulo. Si el fichero no está, el módulo queda
  // activo y el panel lo dice: no se inventan relays.
  const cargar = () => {
    if (relays) return Promise.resolve(relays);
    if (cargando) return cargando;
    cargando = (async () => {
      try {
        const leidos = await cargarRelays({ fetchImpl });
        relays = leidos;
        cargaError = "";
        if (lista) {
          lista.textContent = "";
          if (doc && typeof doc.createElement === "function") {
            for (const relay of leidos.relays) {
              const opcion = doc.createElement("option");
              opcion.value = relay.url;
              opcion.textContent = hostDeRelay(relay.url) + " · " + relay.latencyMs + " ms · tercero";
              lista.appendChild(opcion);
            }
          }
        }
        return leidos;
      } catch (e) {
        relays = null;
        cargaError = String((e && e.message) || e);
        throw e;
      } finally {
        cargando = null;
        pintar();
      }
    })();
    return cargando;
  };

  const cerrarAviso = (usar) => {
    const persistir = !!(recordar && recordar.checked);
    if (usar) eleccion.decidir(true, { recordar: persistir });
    else eleccion.decidir(false, { recordar: persistir });
    if (aviso && typeof aviso.close === "function" && aviso.open) aviso.close();
    const pendiente = resolverAviso;
    resolverAviso = null;
    pintar();
    if (usar) cargar().catch(() => { /* el aviso ya lo dice */ });
    if (typeof pendiente === "function") pendiente(usar);
    return usar;
  };

  // Si no hay diálogo en el documento (la prueba de node, un panel suelto), la decisión segura es
  // no activar el módulo: el modo por defecto no puede romperse por un elemento que falta.
  const abrirAviso = () => {
    if (!aviso || typeof aviso.showModal !== "function") {
      return Promise.resolve(false);
    }
    if (recordar) recordar.checked = false;
    return new Promise((resolver) => {
      resolverAviso = resolver;
      try { aviso.showModal(); }
      catch (e) { resolverAviso = null; resolver(false); }
    });
  };

  const asegurarDecision = async () => {
    if (eleccion.decidido()) return eleccion.activo();
    return abrirAviso();
  };

  const relayActual = () => {
    const propia = urlPropia && typeof urlPropia.value === "string" ? urlPropia.value.trim() : "";
    if (propia) {
      const problema = urlRelayValida(propia);
      if (problema) throw new Error(problema);
      return propia;
    }
    const elegida = lista && typeof lista.value === "string" ? lista.value.trim() : "";
    if (!elegida) throw new Error("elige un relay de la lista o escribe la URL de tu WISP");
    const problema = urlRelayValida(elegida);
    if (problema) throw new Error(problema);
    return elegida;
  };

  const alEscribirUrl = () => {
    if (!urlEstado) return;
    const propia = urlPropia && typeof urlPropia.value === "string" ? urlPropia.value.trim() : "";
    if (!propia) {
      urlEstado.textContent = "vacío: se usa el relay elegido en la lista";
      urlEstado.classList.remove("mal", "bien");
      return;
    }
    const problema = urlRelayValida(propia);
    urlEstado.textContent = problema || "URL válida: se usará esta y no la de la lista";
    urlEstado.classList.toggle("mal", !!problema);
    urlEstado.classList.toggle("bien", !problema);
  };

  // --- las CAs: del disco al núcleo -------------------------------------------------------------

  const decirCAS = (texto, clase) => {
    if (!casEstado) return;
    casEstado.textContent = texto;
    casEstado.classList.toggle("mal", clase === "mal");
    casEstado.classList.toggle("bien", clase === "bien");
  };

  // El `File` del selector (o el doble de la prueba) se lee aquí y en ningún otro sitio: ni fetch
  // ni una URL. La validación y la huella viven en `prepararCAS`, para que la prueba de node use
  // exactamente el mismo camino que la página.
  const seleccionarCAS = async (archivo) => {
    cas = null;
    try {
      if (!archivo) throw new Error("no se eligió ningún fichero de CAs");
      let bytes;
      if (typeof archivo.arrayBuffer === "function") bytes = new Uint8Array(await archivo.arrayBuffer());
      else if (archivo.bytes instanceof Uint8Array) bytes = archivo.bytes;
      else if (archivo.bytes != null) bytes = new Uint8Array(archivo.bytes);
      else throw new Error("no se pudo leer el fichero de CAs del disco");
      const esperada = casHuella && typeof casHuella.value === "string" ? casHuella.value : "";
      const preparado = await prepararCAS({ nombre: archivo.name, bytes, huellaEsperada: esperada });
      cas = preparado;
      decirCAS("CAs aceptadas: " + preparado.bytes + " bytes, sha256 " + preparado.huella +
        "; se pasan al núcleo al resolver", "bien");
      return preparado;
    } catch (e) {
      const motivo = String((e && e.message) || e);
      decirCAS("CAs rechazadas: " + motivo, "mal");
      throw e;
    } finally {
      if (casEntrada && "value" in casEntrada) casEntrada.value = "";
    }
  };

  const quitarCAS = () => {
    cas = null;
    decirCAS("sin CAs: el bundle se lee del dispositivo y se pasa al núcleo; nunca se descarga " +
      "por el relay", "");
  };

  if (botonActivar) botonActivar.addEventListener("click", () => { abrirAviso(); });
  if (botonDesactivar) botonDesactivar.addEventListener("click", () => {
    eleccion.desactivar();
    cas = null;
    pintar();
  });
  if (urlPropia) urlPropia.addEventListener("input", alEscribirUrl);
  if (casEntrada) casEntrada.addEventListener("change", () => {
    const archivo = casEntrada.files && casEntrada.files[0];
    seleccionarCAS(archivo).catch(() => { /* el estado ya dice el motivo */ });
  });
  const botonAceptar = porId("wisp-aviso-activar");
  const botonCancelar = porId("wisp-aviso-cancelar");
  if (botonAceptar) botonAceptar.addEventListener("click", (evento) => { if (evento) evento.preventDefault(); cerrarAviso(true); });
  if (botonCancelar) botonCancelar.addEventListener("click", (evento) => { if (evento) evento.preventDefault(); cerrarAviso(false); });
  if (aviso) aviso.addEventListener("cancel", (evento) => { evento.preventDefault(); cerrarAviso(false); });

  // Antes de pintar, la lista puede venir de «recordar elección»: se carga ya, y sigue siendo una
  // petición del propio origen (el módulo está activo por decisión previa de la persona).
  pintar();
  if (eleccion.activo()) cargar().catch(() => { /* el aviso ya lo dice */ });

  return {
    asegurarDecision, abrirAviso, relayActual, cargar,
    activo: () => eleccion.activo(),
    decidido: () => eleccion.decidido(),
    desactivar: () => { eleccion.desactivar(); cas = null; pintar(); },
    relays: () => relays,
    eleccion,
    pintar,
    // El contrato de CAs: lo elegido se lee del disco y se pasa al núcleo como `{pem, huella}`.
    casActual: () => cas,
    seleccionarCAS,
    quitarCAS,
    // Fija la elección sin pasar por el diálogo: lo usan las pruebas de node, y sirve para un
    // enganche futuro que ya haya preguntado por su cuenta.
    decidir: (usar, opciones) => {
      const activo = eleccion.decidir(usar, opciones);
      pintar();
      if (activo) cargar().catch(() => { /* el panel ya lo dice */ });
      return activo;
    },
  };
}
