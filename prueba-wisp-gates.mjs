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

console.log(fallos ? "\nfalsificación FALLA: " + fallos + " problemas" :
  "\nfalsificación: los dos gates rechazan lo que tienen que rechazar");
process.exit(fallos ? 1 : 0);
