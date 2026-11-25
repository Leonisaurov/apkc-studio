// Falsificación de los dos gates del módulo WISP, sin red y sin navegador: usa la misma regla que
// `prueba-pestana.js` (`wisp-gates.js`) y comprueba que **falla** cuando debe fallar.
//
// uso: node studio/prueba-wisp-gates.mjs
// sale 0 si las dos falsificaciones se comportan como se espera; 1 si alguna deja pasar lo que
// tenía que rechazar.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gates from "./wisp-gates.js";
import { resolverPorWisp, nucleoDisponible, CONTRATO_NUCLEO } from "./wisp.js";
import { instalarPuenteWisp } from "./wisp-puente.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUERTO = 8791;
let fallos = 0;
function comprueba(nombre, cond, detalle) {
  if (cond) console.log("  ok   " + nombre + (detalle ? " — " + detalle : ""));
  else { fallos++; console.log("  FALLA " + nombre + (detalle ? " — " + detalle : "")); }
}
if (typeof WebSocket !== "function") {
  // `sondearRelay` admite un doble, pero si el propio node no trae WebSocket el handshake real
  // tampoco podría correr en el modo externo: se avisa en vez de fingir que el gate está listo.
  console.log("  aviso: este node no trae WebSocket global; el handshake real del modo externo no podría ejecutarse");
}

// --- el paquete WISP de mentira: [tipo u8][streamID u32 LE][carga...] ---------------------------
function paqueteWisp(tipo, flujo, bufferPackets) {
  const b = new Uint8Array(9);
  const vista = new DataView(b.buffer);
  b[0] = tipo;
  vista.setUint32(1, flujo, true);
  vista.setUint32(5, bufferPackets == null ? 0 : bufferPackets, true);
  return b;
}

// Un WebSocket de mentira que no sale a la red: dispara `open` y luego un `message` con el paquete
// indicado. Sirve para ejercitar el framing del handshake sin tocar un relay de terceros.
function socketFalso({ tipo = gates.TIPO_CONTINUE, flujo = 0, bufferPackets = 128 } = {}) {
  return class WebSocketFalso {
    constructor(url) {
      this.url = url;
      this.oyentes = new Map();
      setTimeout(() => this.dispara("open", {}), 0);
      setTimeout(() => this.dispara("message", { data: paqueteWisp(tipo, flujo, bufferPackets) }), 5);
    }
    addEventListener(nombre, fn) {
      if (!this.oyentes.has(nombre)) this.oyentes.set(nombre, []);
      this.oyentes.get(nombre).push(fn);
    }
    dispara(nombre, evento) { for (const fn of this.oyentes.get(nombre) || []) fn(evento); }
    close() { this.dispara("close", { code: 1000 }); }
  };
}

const datosRelays = JSON.parse(fs.readFileSync(path.join(__dirname, "wisp-relays.json"), "utf8"));
const leidos = gates.revisarRelays(datosRelays);
const hosts = gates.hostsDeRelays(leidos.relays);

// --- gate por defecto ---------------------------------------------------------------------------
{
  const locales = [
    "http://127.0.0.1:" + PUERTO + "/index.html",
    "http://127.0.0.1:" + PUERTO + "/wisp-relays.json",
    "data:text/plain,hola",
    "blob:http://127.0.0.1:" + PUERTO + "/descarga",
  ];
  const limpio = gates.clasificarUrls(locales, { puerto: PUERTO });
  comprueba("gate por defecto: las URLs del propio origen, data: y blob: pasan",
    limpio.ajenas.length === 0, limpio.locales.length + " locales, cero ajenas");

  // el puerto vecino no se cuela aunque comparta prefijo de texto
  const vecino = gates.clasificarUrls(["http://127.0.0.1:87910/apkc.wasm"], { puerto: PUERTO });
  comprueba("gate por defecto: un puerto que empieza igual no cuenta como el origen",
    vecino.ajenas.length === 1, vecino.ajenas[0]);

  // falsificación 1: un wss:// ajeno tiene que hacer fallar el gate por defecto
  const conAjeno = gates.clasificarUrls(
    locales.concat(["wss://relay-ajeno.example/wisp/"]), { puerto: PUERTO });
  comprueba("falsificación 1: un wss:// ajeno rompe el gate por defecto",
    conAjeno.ajenas.length === 1 && conAjeno.ajenas[0] === "wss://relay-ajeno.example/wisp/",
    "ajenas: " + conAjeno.ajenas.join(", "));
  console.log("  salida falsificación 1: gate por defecto -> " +
    (conAjeno.ajenas.length ? "FALLA con " + conAjeno.ajenas.length + " URL ajena (" + conAjeno.ajenas[0] + ")"
      : "PASA (mal: no detectó el wss://)"));

  // falsificación 3: `data:` y `blob:` no se aceptan por el esquema, sino por el origen que
  // incrustan. Un host ajeno dentro del texto opaco tiene que romper el gate igual que un `wss://`
  for (const [que, url, local] of [
    ["blob: con origin ajeno incrustado", "blob:https://relay-ajeno.example/uuid", false],
    ["data: con wss:// ajeno incrustado", "data:text/html,wss://relay-ajeno.example/wisp/", false],
    ["blob: con origin local incrustado", "blob:http://127.0.0.1:" + PUERTO + "/uuid", true],
    ["data: sin contenido externo", "data:text/html,<b>hola</b>", true],
  ]) {
    const r = gates.clasificarUrls([url], { puerto: PUERTO });
    comprueba("gate por defecto: " + que + " se clasifica como " + (local ? "local" : "ajena"),
      local ? (r.locales.length === 1 && r.ajenas.length === 0) : (r.locales.length === 0 && r.ajenas.length === 1),
      "locales: [" + r.locales.join(", ") + "] ajenas: [" + r.ajenas.join(", ") + "]");
  }

  // la regla anterior (aceptar `data:`/`blob:` por el mero esquema) es la que dejaba pasar el host
  // ajeno; se reproduce aquí para dejar escrito qué es lo que el filtro nuevo impide
  const filtroAnterior = (texto) => /^(?:data|blob):/i.test(String(texto));
  comprueba("falsificación 3: sin el filtro de origen incrustado, el blob: ajeno sería local",
    filtroAnterior("blob:https://relay-ajeno.example/uuid") === true &&
    gates.clasificarUrls(["blob:https://relay-ajeno.example/uuid"], { puerto: PUERTO }).ajenas.length === 1,
    "regla anterior: local; regla actual: ajena");
  console.log("  salida falsificación 3: regla anterior -> " +
    (filtroAnterior("blob:https://relay-ajeno.example/uuid") ? "local (mal)" : "ajena") +
    " | regla actual -> " +
    (gates.clasificarUrls(["blob:https://relay-ajeno.example/uuid"], { puerto: PUERTO }).ajenas.length
      ? "ajena (bien)" : "local (mal)"));
}

// --- gate de red: toda sesión cuenta ------------------------------------------------------------
// El registro del gate se llena con los mensajes de CDP de la sesión de la página **y** de la de
// cada worker. Un evento de un worker llega con su `sessionId`; filtrar por sesión —lo que hacía
// el gate cuando la conexión solo enganchaba `page`— deja el `wss://` del worker fuera de las dos
// listas y el gate lo da por bueno. Aquí se prueba la regla con mensajes de mentira.
{
  const registro = { peticiones: [], webSockets: [] };
  const eventos = [
    { method: "Network.requestWillBeSent",
      params: { request: { url: "http://127.0.0.1:" + PUERTO + "/index.html" } } },
    { method: "Network.webSocketCreated",
      params: { url: "blob:http://127.0.0.1:" + PUERTO + "/descarga" } },
    { method: "Network.webSocketCreated", params: { url: "wss://relay-ajeno.example/wisp/" },
      sessionId: "sesion-de-worker" },
    { method: "Network.requestWillBeSent",
      params: { request: { url: "http://127.0.0.1:" + PUERTO + "/apkc.wasm" } },
      sessionId: "sesion-de-worker" },
    { method: "Runtime.consoleAPICalled", params: {} },
    { method: "Network.webSocketCreated", params: {} }, // sin URL: no suma y no revienta
  ];
  let sumados = 0;
  for (const evento of eventos) if (gates.acumularRed(registro, evento)) sumados++;
  comprueba("gate de red: los eventos de la sesión de un worker entran en el mismo registro",
    sumados === 4 && registro.peticiones.length === 2 && registro.webSockets.length === 2,
    sumados + " sumados, " + registro.peticiones.length + " peticiones, " +
      registro.webSockets.length + " websockets");

  const { ajenas: delWorker } = gates.clasificarUrls(registro.webSockets, { puerto: PUERTO });
  comprueba("gate de red: el wss:// abierto en un worker se clasifica como ajeno",
    delWorker.length === 1 && delWorker[0] === "wss://relay-ajeno.example/wisp/",
    delWorker.join(", ") || "no se vio ningún wss:// ajeno");

  // falsificación 4: la regla vieja, la que solo miraba los mensajes de la sesión de la página
  const soloPagina = { peticiones: [], webSockets: [] };
  for (const evento of eventos) if (!evento.sessionId) gates.acumularRed(soloPagina, evento);
  const { ajenas: conSoloPagina } = gates.clasificarUrls(soloPagina.webSockets, { puerto: PUERTO });
  comprueba("falsificación 4: mirando solo la sesión de la página, el wss:// del worker escapa",
    conSoloPagina.length === 0 && soloPagina.webSockets.length === 1,
    soloPagina.webSockets.length + " websocket(s) vistos y " + conSoloPagina.length + " ajenos");
  console.log("  salida falsificación 4: solo la sesión de la página -> PASA (mal: el wss:// del " +
    "worker no se vio)");
}

// --- gate del modo externo ----------------------------------------------------------------------
{
  // la lista versionada pasa sus exigencias
  comprueba("modo externo: la lista versionada tiene 6 relays verificados, con latencia y v1",
    leidos.relays.length === gates.RELAYS_ESPERADOS && hosts.length > 0,
    leidos.relays.length + " relays, " + hosts.length + " hosts");

  // sin núcleo no se abre ni un socket y el motivo es el acordado
  let llamadas = 0;
  const sinNucleo = await gates.ejecutarGateExterno({
    datos: datosRelays, nucleo: false, puerto: PUERTO,
    abrir: () => { llamadas++; return Promise.resolve({ ok: true, url: "wss://x/" }); },
  });
  comprueba("modo externo: sin núcleo falla con el motivo y sin abrir socket",
    sinNucleo.ok === false && sinNucleo.motivo === gates.MOTIVO_SIN_NUCLEO &&
    sinNucleo.sockets === 0 && llamadas === 0,
    JSON.stringify({ motivo: sinNucleo.motivo, sockets: sinNucleo.sockets, llamadas }).slice(0, 240));

  // la lista se rechaza si pierde un relay, si uno no está verificado o si habla v2
  const cinco = { ...datosRelays, relays: datosRelays.relays.slice(0, 5) };
  let motivoCinco = "";
  try { gates.revisarRelays(cinco); } catch (e) { motivoCinco = String(e.message); }
  comprueba("modo externo: una lista de 5 relays se rechaza",
    /exige 6/.test(motivoCinco), motivoCinco);

  for (const [que, roto] of [
    ["no verificado", { ...datosRelays.relays[0], verified: false }],
    ["sin latencia", { ...datosRelays.relays[0], latencyMs: null }],
    ["protocolo v2", { ...datosRelays.relays[0], protocol: "v2" }],
  ]) {
    let motivo = "";
    try {
      gates.revisarRelays({ ...datosRelays, relays: [roto, ...datosRelays.relays.slice(1)] });
    } catch (e) { motivo = String(e.message); }
    comprueba("modo externo: un relay " + que + " se rechaza", motivo.length > 0, motivo.slice(0, 180));
  }

  // con núcleo y todos los hosts en la lista, el gate pasa
  const bueno = await gates.ejecutarGateExterno({
    datos: datosRelays, nucleo: true, puerto: PUERTO,
    abrir: (url) => Promise.resolve({ ok: true, url, protocol: "v1", bufferPackets: 128 }),
  });
  comprueba("modo externo: con núcleo y los 6 hosts declarados, el gate pasa",
    bueno.ok === true && bueno.sockets === gates.RELAYS_ESPERADOS,
    JSON.stringify({ ok: bueno.ok, sockets: bueno.sockets }).slice(0, 160));

  // falsificación 2: una conexión a un host que no está en la lista rompe el modo externo
  const fuera = await gates.ejecutarGateExterno({
    datos: datosRelays, nucleo: true, puerto: PUERTO,
    abrir: () => Promise.resolve({ ok: true, url: "wss://relay-ajeno.example/wisp/", protocol: "v1" }),
  });
  comprueba("falsificación 2: un relay fuera de la lista rompe el modo externo",
    fuera.ok === false && /fuera de la lista de relays/.test(fuera.motivo),
    fuera.motivo.slice(0, 240));
  console.log("  salida falsificación 2: modo externo -> " +
    (fuera.ok === false ? "FALLA: " + fuera.motivo : "PASA (mal: no detectó el host ajeno)"));

  // el handshake: solo CONTINUE con streamID 0; DATA, otro stream o un cierre se rechazan
  const handshake = await gates.sondearRelay("wss://wisp.local/wisp/",
    { WebSocketImpl: socketFalso({ tipo: gates.TIPO_CONTINUE, flujo: 0, bufferPackets: 2147483647 }) });
  comprueba("handshake: CONTINUE con streamID 0 se acepta y devuelve bufferPackets",
    handshake.ok === true && handshake.bufferPackets === 2147483647,
    JSON.stringify(handshake).slice(0, 200));

  for (const [que, doble] of [
    ["DATA como primer paquete", socketFalso({ tipo: gates.TIPO_DATA, flujo: 0 })],
    ["CONTINUE de otro flujo", socketFalso({ tipo: gates.TIPO_CONTINUE, flujo: 7 })],
  ]) {
    let motivo = "";
    try {
      await gates.sondearRelay("wss://wisp.local/wisp/", { WebSocketImpl: doble, plazoMs: 1000 });
    } catch (e) { motivo = String(e.message); }
    comprueba("handshake: " + que + " se rechaza", motivo.length > 0, motivo.slice(0, 180));
  }
}

// --- el puente del núcleo: la página solo ve apkcWisp cuando el wasm lo anuncia ------------------
// Sin red y sin navegador: el doble de `enviar` contesta con bytes enlatados y un sha256 calculado
// aquí, que es lo que `validarRespuestaNucleo` (wisp.js:294-323) exige antes de pintar el artefacto.
{
  const bytes = new TextEncoder().encode("artefacto enlatado para el puente WISP\n");
  const resumen = await crypto.subtle.digest("SHA-256", bytes);
  const huella = [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const pagina = {};
  let llamadas = 0;
  const puente = instalarPuenteWisp({
    global: pagina, contrato: CONTRATO_NUCLEO,
    enviar: (mensaje) => {
      if (mensaje.metodo === "obtener") llamadas++;
      if (mensaje.tipo !== "wisp") throw new Error("el puente envió " + mensaje.tipo + ", no wisp");
      return Promise.resolve({
        id: llamadas, tipo: "wisp",
        respuesta: {
          ok: true, bytes: buffer, sha256: huella,
          ruta: "/deps/com/example/prueba/1.0/prueba-1.0.jar",
        },
      });
    },
  });
  const consultar = () => resolverPorWisp({
    relay: "wss://wisp.local/wisp/", coordenada: "com.example:prueba:1.0",
    hospedador: { escribir() {} }, global: pagina,
  });

  comprueba("puente WISP: al instalarlo, la página no ve ningún núcleo",
    nucleoDisponible(pagina) === false && puente.estaActivo() === false);

  let motivo = "";
  try { await consultar(); } catch (e) { motivo = String(e.message); }
  comprueba("puente WISP: sin activar falla con el error del contrato y sin hablar con el worker",
    /núcleo WISP no disponible/.test(motivo) && llamadas === 0,
    motivo.slice(0, 130) + " — llamadas " + llamadas);

  let contratoAjeno = "";
  try { puente.activar({ contrato: "apkc-wisp/2", activo: true }); }
  catch (e) { contratoAjeno = String(e.message); }
  comprueba("puente WISP: un contrato ajeno no activa el núcleo",
    contratoAjeno.length > 0 && nucleoDisponible(pagina) === false && llamadas === 0,
    contratoAjeno.slice(0, 130));

  puente.activar({ contrato: CONTRATO_NUCLEO, activo: true });
  comprueba("puente WISP: activar con el contrato expone los dos globales del contrato",
    nucleoDisponible(pagina) === true &&
    typeof pagina.apkcWispCargarCAs === "function" && puente.estaActivo() === true);

  const recibido = await consultar();
  comprueba("puente WISP: un mensaje obtener devuelve bytes, sha256 y ruta validados",
    llamadas === 1 && recibido.bytes instanceof Uint8Array &&
    recibido.sha256 === huella && recibido.ruta.startsWith("/deps/"),
    JSON.stringify({ llamadas, sha256: recibido.sha256 === huella, ruta: recibido.ruta }).slice(0, 160));

  puente.desactivar();
  let sinNucleoDespues = "";
  try { await consultar(); } catch (e) { sinNucleoDespues = String(e.message); }
  comprueba("puente WISP: desactivar retira el núcleo y vuelve al error de sin núcleo",
    nucleoDisponible(pagina) === false && !pagina.apkcWispCargarCAs &&
    /núcleo WISP no disponible/.test(sinNucleoDespues) && llamadas === 1,
    sinNucleoDespues.slice(0, 130) + " — llamadas " + llamadas);
}

console.log(fallos ? "\nfalsificación FALLA: " + fallos + " problemas" :
  "\nfalsificación: los dos gates rechazan lo que tienen que rechazar");
process.exit(fallos ? 1 : 0);
