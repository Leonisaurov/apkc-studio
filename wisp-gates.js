// Los dos gates del módulo WISP, en un solo sitio y sin DOM: así la página, la prueba de la
// pestaña y la falsificación de node usan exactamente la misma regla.
//
//   (1) Gate por defecto: el módulo está apagado y la pestaña no puede sacar ni una petición ni
//       abrir un WebSocket fuera de su propio origen (`http://127.0.0.1:<puerto>` y los `data:` y
//       `blob:` cuyo origen incrustado —si lo llevan— también es el local). Un `wss://` cuenta como
//       ajeno y hace fallar el gate, aunque vaya dentro de un `data:` o un `blob:`, y también si lo
//       abre un worker: `urlDeEvento`/`acumularRed` no filtran por sesión porque el tráfico de un
//       worker es tráfico de la pestaña.
//   (2) Gate del modo externo: con `APKC_WISP_EXTERNO=1`, el módulo está encendido y cableado. Se
//       valida `wisp-relays.json` (seis relays verificados, con latencia y protocolo v1), se hace
//       solo el handshake inicial (CONTINUE con `streamID=0`, sin pedir artefactos) a cada relay y
//       se exige que todo el tráfico salga de los hosts declarados en ese fichero. Sin núcleo
//       WISP cableado, el gate falla con el motivo y **sin abrir ni un socket**.
//
// Este fichero no habla WISP ni TLS: el handshake de verdad vive en el núcleo (`apkc/wisp.go`).
// Aquí solo se comprueba la forma del primer paquete y se cierra la conexión.

import { leerRelays, urlRelayValida } from "./wisp.js";

export const MOTIVO_SIN_NUCLEO =
  "núcleo WISP no disponible en esta compilación";
export const RELAYS_ESPERADOS = 6;

export const TIPO_CONNECT = 0x01;
export const TIPO_DATA = 0x02;
export const TIPO_CONTINUE = 0x03;
export const TIPO_CLOSE = 0x04;

// La URL incrustada que hay que mirar en un `data:` o un `blob:`, si la hay.
//
//   `blob:` sí lleva un origen delante del uuid (`blob:https://host/uuid`): se extrae ese prefijo
//   —esquema, host y puerto, sin ruta— y se compara como una URL. Un `blob:null/uuid`, sin origen,
//   no incrusta nada.
//   `data:` no lleva origen, solo contenido; desde un documento `data:` lo único que puede salir a
//   la red como conexión es un WebSocket, así que se buscan sus `ws://`/`wss://`. Mirar además cada
//   `http://` del contenido marcaría como ajeno un namespace legítimo (`http://www.w3.org/2000/svg`)
//   sin ganar ninguna comprobación de egress.
function origenesIncrustados(texto) {
  const blob = /^blob:(?:https?|wss?):\/\/[^\s"'<>\\/]+/i.exec(String(texto));
  if (blob) return [blob[0].replace(/^blob:/i, "")];
  if (/^data:/i.test(texto)) return String(texto).match(/wss?:\/\/[^\s"'<>\\]+/gi) || [];
  return [];
}

// ¿La URL incrustada apunta al origen local? Se compara host y puerto, no el texto: así el prefijo
// `127.0.0.1:8791` de `127.0.0.1:87910` no se cuela, y el esquema (`http:`, `ws:`) no importa.
function esOrigenEmbebidoLocal(incrustada, puerto) {
  try {
    const analizada = new URL(incrustada);
    return analizada.hostname === "127.0.0.1" && analizada.port === String(puerto);
  } catch (e) { return false; }
}

// El filtro del gate por defecto, tal como se documenta en `prueba-pestana.js`: el prefijo local y
// los dos esquemas de contenido opaco. Se exige que tras el prefijo venga el principio de una
// ruta, una consulta o un ancla; así `http://127.0.0.1:87910/…` no se cuela por empezar igual que
// `http://127.0.0.1:8791`. Es más estricto que el `startsWith` antiguo, nunca más laxo.
//
// `data:` y `blob:` no se aceptan por el mero esquema: se miran las URLs que incrustan. Sin ninguna
// (un `data:text/plain,hola` o el `blob:null/uuid` de un origen opaco) cuenta como local, porque no
// hay a dónde salir; con alguna, todas tienen que apuntar a `127.0.0.1:<puerto>`. Decisión: estricta
// — un `blob:https://relay-ajeno.example/uuid` o un `data:` con un `wss://` ajeno se clasifican como
// ajenos, aunque `new WebSocket` sobre ellos lance y hoy no haya egress probado.
export function esUrlDelOrigen(url, puerto) {
  const texto = String(url == null ? "" : url);
  if (/^(?:data|blob):/i.test(texto)) {
    const incrustadas = origenesIncrustados(texto);
    return incrustadas.every((u) => esOrigenEmbebidoLocal(u, puerto));
  }
  const prefijo = "http://127.0.0.1:" + puerto;
  if (!texto.startsWith(prefijo)) return false;
  const resto = texto.slice(prefijo.length);
  return resto === "" || /^[\/?#]/.test(resto);
}

// Clasifica una lista de URLs observadas. `hostsPermitidos` solo se usa en el modo externo y es la
// lista de hosts de `wisp-relays.json`; en el modo por defecto va vacía y cualquier host de fuera
// cae en `ajenas`. Devuelve las dos listas para que el mensaje del gate pueda enseñar la primera
// URL culpable en vez de un «falló» sin pruebas.
export function clasificarUrls(urls, { puerto, hostsPermitidos = [] } = {}) {
  const permitidos = new Set((hostsPermitidos || []).map((h) => String(h).toLowerCase()));
  const locales = [];
  const ajenas = [];
  for (const url of urls || []) {
    const texto = String(url == null ? "" : url);
    if (esUrlDelOrigen(texto, puerto)) { locales.push(texto); continue; }
    let analizada = null;
    try { analizada = new URL(texto); } catch (e) { analizada = null; }
    if (analizada && permitidos.has(analizada.host.toLowerCase())) { locales.push(texto); continue; }
    ajenas.push(texto);
  }
  return { locales, ajenas };
}

// Qué eventos de red de CDP suman al gate y con qué URL. Un evento llega con la **sesión del
// target que lo produjo** (`sessionId`): la de la página o la de un worker. Aquí no se filtra por
// sesión a propósito: un `wss://` creado dentro de un worker es tráfico ajeno igual que uno de la
// página, y el gate que solo miraba `page` lo dejaba pasar. Devuelve `null` para lo que no cuenta.
export function urlDeEvento(mensaje) {
  const metodo = mensaje && mensaje.method;
  const params = (mensaje && mensaje.params) || {};
  if (metodo === "Network.requestWillBeSent") {
    const url = params.request && params.request.url;
    return url == null ? null : String(url);
  }
  if (metodo === "Network.webSocketCreated") {
    return params.url == null ? null : String(params.url);
  }
  return null;
}

// Vuelca un mensaje de CDP en el registro del gate, sea de la sesión de la página o de la de un
// worker: `peticiones` para el HTTP y `webSockets` para las aperturas, que es donde cae un `wss://`
// (no aparece en `requestWillBeSent`). Devuelve `true` si el mensaje contaba.
export function acumularRed(registro, mensaje) {
  const url = urlDeEvento(mensaje);
  if (url === null) return false;
  const destino = (mensaje && mensaje.method) === "Network.webSocketCreated" ? registro.webSockets
    : registro.peticiones;
  if (!destino) return false;
  destino.push(url);
  return true;
}

// Los hosts de la lista, sin repetir. Es la lista blanca del modo externo: si una conexión sale
// hacia otro host, el gate falla aunque el relay elegido sí estuviera en el JSON.
export function hostsDeRelays(relays) {
  const hosts = new Set();
  for (const relay of relays || []) {
    try { const u = new URL(relay.url); if (u.host) hosts.add(u.host.toLowerCase()); }
    catch (e) { /* una URL rota ya la rechaza `revisarRelays` */ }
  }
  return [...hosts];
}

// La lista versionada, con las exigencias del gate externo: seis relays, verificados por handshake,
// con latencia medida y protocolo v1. `leerRelays` ya rechaza el fichero entero si una fila no
// cumple; aquí solo se añade el número, que es lo que se acordó medir.
export function revisarRelays(datos, { esperados = RELAYS_ESPERADOS } = {}) {
  const leidos = leerRelays(datos);
  if (leidos.relays.length !== esperados) {
    throw new Error("wisp-relays.json trae " + leidos.relays.length + " relays y el gate exige " +
      esperados + ": la lista se re-mide en el modo externo");
  }
  for (const relay of leidos.relays) {
    if (relay.verified !== true) throw new Error("el relay no consta verificado por handshake: " + relay.url);
    if (relay.protocol !== "v1") throw new Error("el relay no declara protocolo v1: " + relay.url);
    if (!Number.isInteger(relay.latencyMs) || relay.latencyMs < 0) {
      throw new Error("el relay no tiene latencia medida: " + relay.url);
    }
  }
  return leidos;
}

// Lee el primer paquete del mensaje: `[tipo u8][streamID u32 LE][carga…]`. El CONTINUE inicial
// lleva la carga `[bufferRemaining u32 LE]`, en paquetes y no en bytes; el relay no lo manda igual
// en todos los casos (128 en unos, 2147483647 en otros), así que aquí se lee y se devuelve, no se
// asume ningún valor.
export function leerPaqueteInicial(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 5) return null;
  const vista = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tipo = b[0];
  const flujo = vista.getUint32(1, true);
  let bufferPackets = null;
  if (b.length >= 9) bufferPackets = vista.getUint32(5, true);
  return { tipo, flujo, bufferPackets };
}

function aBytes(datos) {
  if (datos instanceof Uint8Array) return datos;
  if (datos instanceof ArrayBuffer) return new Uint8Array(datos);
  if (ArrayBuffer.isView(datos)) return new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength);
  return new Uint8Array(0);
}

// El handshake mínimo contra un relay: abrir el WebSocket y esperar **solo** el CONTINUE inicial
// del `streamID` 0. No se manda CONNECT, no se pide ningún artefacto y se cierra en cuanto llega
// el primer paquete. Devuelve `{ok, url, protocol, bufferPackets}` o rechaza con el motivo.
export function sondearRelay(url, { WebSocketImpl, plazoMs = 10000 } = {}) {
  const problema = urlRelayValida(url);
  if (problema) return Promise.reject(new Error(problema));
  const Ctor = WebSocketImpl || globalThis.WebSocket;
  if (typeof Ctor !== "function") {
    return Promise.reject(new Error("no hay WebSocket disponible para sondear el relay"));
  }
  return new Promise((ok, falla) => {
    let ws = null;
    let plazo = null;
    let terminado = false;
    const acabar = (error, valor) => {
      if (terminado) return;
      terminado = true;
      if (plazo) clearTimeout(plazo);
      try { if (ws && typeof ws.close === "function") ws.close(); } catch (e) { /* ya cerrado */ }
      if (error) falla(error); else ok(valor);
    };
    try { ws = new Ctor(url); }
    catch (e) { acabar(new Error("no se pudo abrir el relay " + url + ": " + ((e && e.message) || e))); return; }
    try { ws.binaryType = "arraybuffer"; } catch (e) { /* algunos dobles de prueba no lo admiten */ }
    plazo = setTimeout(() => acabar(new Error("el relay " + url + " no mandó el CONTINUE inicial en " +
      plazoMs + " ms")), plazoMs);
    ws.addEventListener("message", (evento) => {
      const paquete = leerPaqueteInicial(aBytes(evento && evento.data));
      if (!paquete) return acabar(new Error("el primer mensaje del relay no lleva cabecera WISP: " + url));
      if (paquete.tipo !== TIPO_CONTINUE) {
        return acabar(new Error("el relay " + url + " no empezó con CONTINUE: tipo 0x" +
          paquete.tipo.toString(16).padStart(2, "0")));
      }
      if (paquete.flujo !== 0) {
        return acabar(new Error("el CONTINUE inicial del relay " + url + " no es del flujo 0: streamID " +
          paquete.flujo));
      }
      acabar(null, { ok: true, url, protocol: "v1", bufferPackets: paquete.bufferPackets });
    });
    ws.addEventListener("error", () => acabar(new Error("el WebSocket del relay " + url +
      " falló antes del CONTINUE inicial")));
    ws.addEventListener("close", (evento) => {
      if (terminado) return;
      const codigo = evento && evento.code != null ? evento.code : "?";
      acabar(new Error("el relay " + url + " cerró antes del CONTINUE inicial (código " + codigo + ")"));
    });
  });
}

// El gate externo completo. `nucleo` es el resultado de `nucleoDisponible()` de la página (o una
// función que lo devuelve). Sin núcleo se devuelve el fallo con su motivo **antes** de llamar a
// `abrir`: `sockets` queda a 0 y la prueba puede demostrar que no se tocó la red.
export async function ejecutarGateExterno({ datos, nucleo, abrir, puerto } = {}) {
  let leidos = null;
  try { leidos = revisarRelays(datos); }
  catch (e) { return { ok: false, motivo: String((e && e.message) || e), sockets: 0, hosts: [] }; }

  const cableado = typeof nucleo === "function" ? nucleo() : nucleo;
  if (!cableado) {
    return { ok: false, motivo: MOTIVO_SIN_NUCLEO, sockets: 0, hosts: hostsDeRelays(leidos.relays) };
  }
  if (typeof abrir !== "function") {
    return { ok: false, motivo: "no hay sonda de handshake para el modo externo", sockets: 0,
      hosts: hostsDeRelays(leidos.relays) };
  }

  const hosts = hostsDeRelays(leidos.relays);
  const observadas = [];
  const detalles = [];
  for (const relay of leidos.relays) {
    let visto = null;
    try { visto = await abrir(relay.url); }
    catch (e) {
      return { ok: false, motivo: "handshake con " + relay.url + " falló: " + ((e && e.message) || e),
        sockets: observadas.length + 1, hosts };
    }
    observadas.push(visto && visto.url ? String(visto.url) : relay.url);
    detalles.push({ url: relay.url, bufferPackets: visto && visto.bufferPackets != null ? visto.bufferPackets : null });
    if (!visto || visto.ok !== true) {
      return { ok: false, motivo: "handshake con " + relay.url + " no devolvió ok", sockets: observadas.length, hosts };
    }
    if (visto.protocol && visto.protocol !== "v1") {
      return { ok: false, motivo: "el relay " + relay.url + " no habla protocolo v1: " + visto.protocol,
        sockets: observadas.length, hosts };
    }
  }

  const { ajenas } = clasificarUrls(observadas, { puerto, hostsPermitidos: hosts });
  if (ajenas.length) {
    return { ok: false, motivo: "conexiones fuera de la lista de relays: " + [...new Set(ajenas)].join(", "),
      sockets: observadas.length, hosts };
  }
  return { ok: true, motivo: "", sockets: observadas.length, hosts, relays: leidos.relays.length,
    detalles };
}
