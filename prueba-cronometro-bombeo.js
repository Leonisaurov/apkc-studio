// Falsación del defecto del cronómetro sin chromium: el mismo `crearPreviaPanel` de la pestaña,
// con un hospedador que emula `apkc preview --sesion … --avanzar N` sobre el JSON que publica la
// plantilla `cronometro`, y un reloj de pared de mentira que dispara sus temporizadores.
//
//   node prueba-cronometro-bombeo.js
//
// Demuestra tres cosas: (1) tras el clic en `iniciar` el panel programa un pulso de pared; (2) ese
// pulso mueve el reloj lógico con `--avanzar` y el TextView `tiempo` deja de valer 00:00.00 sin
// que el usuario mande ningún avance; (3) al retirar `bombeoReloj.arrancar()` del código, el mismo
// guion no programa nada y el cronómetro se queda en 00:00.00. El avance a mano y el id de sesión
// también se comprueban: el bombeo no sustituye a la orden manual, la comparte.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as panelReal from "./previa-panel.js";
import { argvDeAvance, argvDeOrden, crearBombeoReloj, cronometroCorriendo, LATIDO_RELOJ_MS } from "./previa-panel.js";
import { mensajeVistaPrevia, modeloActual } from "./vista-previa.js";

let fallos = 0;
function bien(nombre) { console.log("  bien  " + nombre); }
function mal(nombre, error) {
  fallos++;
  console.log("  FALLO " + nombre + ": " + (error && error.message ? error.message : error));
}
async function comprueba(nombre, fn) {
  try { await fn(); bien(nombre); } catch (e) { mal(nombre, e); }
}

// --- el DOM mínimo que necesita el panel para construirse y pintar -------------------------------
// `crearPreviaPanel` se construye sin tocar el DOM; solo hacen falta los ids por los que pregunta
// al clicar y al publicar el modelo. No se llama a `iniciar()`: no hay manejadores ni chromium.
const IDS = new Set([
  "previa-render-estado", "vista-previa-estado", "previa-lateral-canvas", "vista-previa",
  "previa-detalle-modelo", "vista-lado-detalle",
]);
globalThis.document = {
  getElementById: (id) => (IDS.has(id) ? { id, textContent: "", title: "" } : null),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
};
globalThis.CustomEvent = class {
  constructor(tipo, init) { this.type = tipo; this.detail = init && init.detail; }
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

// --- reloj de pared de mentira -----------------------------------------------------------------
// Captura los `setTimeout` que programa el panel y los dispara a mano. El panel se reprograma al
// terminar cada orden, así que cada `tic()` deja otra cita pendiente: se puede contar y parar.
function relojDePared() {
  const citas = [];
  return {
    setTimeout(fn, ms) { citas.push({ fn, ms }); return citas.length; },
    clearTimeout(id) { if (id > 0 && id <= citas.length) citas[id - 1] = null; },
    pendientes: () => citas.filter(Boolean).length,
    async tic() {
      const i = citas.findIndex(Boolean);
      if (i < 0) throw new Error("no hay ningún pulso programado: el bombeo no arrancó");
      const cita = citas[i];
      citas[i] = null;
      assert.equal(cita.ms, LATIDO_RELOJ_MS);
      await cita.fn();
    },
  };
}

// --- el JSON que publicaría `apkc preview` sobre la plantilla cronómetro ------------------------
function dos(cifras) { return (cifras < 10 ? "0" : "") + cifras; }
function textoDelTiempo(ms) {
  return dos(Math.floor(ms / 60000)) + ":" + dos(Math.floor(ms / 1000) % 60) + "." +
    dos(Math.floor(ms / 10) % 100);
}
function modeloCronometro(ms, corriendo, pulsos) {
  return {
    pantalla: { ancho: 360, alto: 640 },
    raiz: { tipo: "LinearLayout", id: "", rect: { x: 0, y: 0, ancho: 360, alto: 640 }, hijos: [] },
    ejecucion: {
      actividad: "MainActivity", metodo: "onCreate", pasos: 1,
      capturas: [
        { origen: "TextView.setText", id: "id/tiempo", texto: textoDelTiempo(ms) },
        { origen: "TextView.setText", id: "id/estado",
          texto: (corriendo ? "corriendo" : "parado") + " - pulsos " + pulsos },
      ],
    },
  };
}
function tiempoDelModelo(modelo) {
  const capturas = (modelo && modelo.ejecucion && modelo.ejecucion.capturas) || [];
  const tiempo = capturas.find((c) => c.id === "id/tiempo");
  return tiempo ? tiempo.texto : null;
}

// El hospedador guarda el reloj lógico y solo lo mueve cuando recibe `--avanzar`. Es la misma
// semántica que el intérprete: el clic no avanza nada por sí mismo.
function hospedadorFalso() {
  const h = { reloj: 0, pulsos: 0, sesion: null, ordenes: [], modelo: null };
  h.ejecutar = async (argv) => {
    h.ordenes.push(argv.slice());
    let corriendo = false;
    if (argv[1] === "--sesion") {
      if (h.sesion === null) h.sesion = argv[2];
      assert.equal(argv[2], h.sesion, "todas las órdenes deben hablar con la MISMA sesión");
      assert.match(argv[2], /^previa-\d+$/);
      const i = argv.indexOf("--avanzar");
      if (i >= 0) {
        assert.equal(argv.length, i + 2, "--avanzar lleva un solo valor");
        const delta = Number(argv[i + 1]);
        assert.ok(Number.isInteger(delta) && delta >= 0, "--avanzar solo admite enteros >= 0");
        h.reloj += delta;
        h.pulsos++;
        corriendo = true;
      } else {
        const pulso = argv.indexOf("--pulsar");
        assert.ok(pulso >= 0, "una orden de sesión es --avanzar o --pulsar");
        corriendo = argv[pulso + 1] !== "id/pausar";
      }
    } else {
      assert.deepEqual(argv.slice(0, 2), ["preview", "--pulsar"]);
      assert.equal(argv[2], "id/iniciar");
      corriendo = true;
    }
    h.modelo = modeloCronometro(h.reloj, corriendo, h.pulsos);
    return { consola: JSON.stringify(h.modelo) + "\n" };
  };
  h.cwd = async () => {};
  return h;
}

// Un escenario completo: el panel real, un clic en `iniciar` y tantos latidos de pared como se
// pidan. Devuelve el estado antes y después para comparar con el escenario sin bombeo.
async function correr(Modulo, latidos = 2) {
  mensajeVistaPrevia("reinicio de la prueba");
  const host = hospedadorFalso();
  const pared = relojDePared();
  const setTimeoutReal = globalThis.setTimeout;
  const clearTimeoutReal = globalThis.clearTimeout;
  globalThis.setTimeout = pared.setTimeout;
  globalThis.clearTimeout = pared.clearTimeout;
  try {
    const panel = Modulo.crearPreviaPanel({ hospedador: host, proyecto: "/proyecto" });
    await panel.pulsar("id/iniciar");
    const antes = {
      reloj: host.reloj, texto: tiempoDelModelo(modeloActual()), citas: pared.pendientes(),
      ordenes: host.ordenes.slice(), sesion: panel.estado().sesion,
    };
    for (let i = 0; i < latidos; i++) await pared.tic();
    return { host, pared, panel, antes, despues: {
      reloj: host.reloj, texto: tiempoDelModelo(modeloActual()), citas: pared.pendientes(),
      ordenes: host.ordenes.slice(), sesion: panel.estado().sesion,
    } };
  } finally {
    globalThis.setTimeout = setTimeoutReal;
    globalThis.clearTimeout = clearTimeoutReal;
  }
}

console.log("cronometro-bombeo (node, sin CDP):");

await comprueba("argvDeAvance conserva --sesion y --avanzar con un entero", () => {
  assert.deepEqual(argvDeAvance("previa-7", 50),
    ["preview", "--sesion", "previa-7", "--avanzar", "50"]);
  assert.deepEqual(argvDeAvance("previa-7", 12.9),
    ["preview", "--sesion", "previa-7", "--avanzar", "12"]);
  // el clic manual sigue siendo un clic: el bombeo no cambia la orden de sesión de un paso
  assert.deepEqual(argvDeOrden({ tipo: "pulsar", valor: "id/iniciar" }, "previa-7"),
    ["preview", "--sesion", "previa-7", "--pulsar", "id/iniciar"]);
});

await comprueba("cronometroCorriendo lee el estado del MODELO, no del documento", () => {
  assert.equal(cronometroCorriendo(modeloCronometro(0, true, 0)), true);
  assert.equal(cronometroCorriendo(modeloCronometro(0, false, 0)), false);
  assert.equal(cronometroCorriendo(null), false);
  // el mismo estado también viaja en el nodo pintado, sin capturas
  const conNodo = { pantalla: { ancho: 360, alto: 640 }, raiz: {
    tipo: "TextView", id: "id/estado", textoDinamico: "corriendo - pulsos 3", hijos: [],
  } };
  assert.equal(cronometroCorriendo(conNodo), true);
  assert.equal(cronometroCorriendo({ ...conNodo, raiz: {
    ...conNodo.raiz, textoDinamico: "parado - pulsos 3",
  } }), false);
});

let vivas;
await comprueba("el clic todavía no avanza, pero enciende un pulso de pared", async () => {
  vivas = await correr(panelReal, 0);
  assert.equal(vivas.antes.texto, "00:00.00");
  assert.equal(vivas.antes.reloj, 0);
  assert.equal(vivas.antes.citas, 1, "debe quedar un temporizador del bombeo");
  // el usuario mandó un clic, NO un --avanzar: la causa del defecto era que no se bombeaba
  assert.ok(!vivas.antes.ordenes.some((a) => a.includes("--avanzar")));
});

await comprueba("sin que el usuario avance, el reloj pasa de 00:00.00 a un valor >0", async () => {
  const conBombeo = await correr(panelReal, 2);
  assert.equal(conBombeo.antes.texto, "00:00.00");
  assert.equal(conBombeo.despues.reloj, 100);
  assert.notEqual(conBombeo.despues.texto, "00:00.00");
  assert.equal(conBombeo.despues.texto, "00:00.10");
  assert.equal(conBombeo.despues.sesion, conBombeo.antes.sesion);
  const avances = conBombeo.despues.ordenes.filter((a) => a.includes("--avanzar"));
  assert.equal(avances.length, 2);
  assert.ok(avances.every((a) => a[2] === conBombeo.antes.sesion));
  assert.equal(cronometroCorriendo(modeloActual()), true);
});

await comprueba("el avance a mano usa la misma sesión y no cambia el guion de clics", async () => {
  const conBombeo = await correr(panelReal, 0);
  const antes = conBombeo.panel.estado();
  const pintado = await conBombeo.panel.avanzar(200);
  assert.ok(pintado !== null || modeloActual(), "el avance a mano debe repintar");
  assert.equal(conBombeo.host.reloj, 200);
  assert.equal(tiempoDelModelo(modeloActual()), "00:00.20");
  const despues = conBombeo.panel.estado();
  assert.equal(despues.sesion, antes.sesion);
  assert.deepEqual(despues.pulsos, antes.pulsos);
  assert.deepEqual(despues.guion, antes.guion);
});

await comprueba("el bombeo se detiene cuando el modelo deja de decir que corre", async () => {
  const conBombeo = await correr(panelReal, 1);
  // una pausa publica «parado - pulsos N»; el golpe que ya estaba pendiente no manda --avanzar
  await conBombeo.panel.pulsar("id/pausar");
  assert.equal(cronometroCorriendo(modeloActual()), false);
  await conBombeo.pared.tic();
  const avances = conBombeo.host.ordenes.filter((a) => a.includes("--avanzar")).length;
  assert.equal(avances, 1);
  assert.equal(conBombeo.host.reloj, 50);
  assert.equal(conBombeo.pared.pendientes(), 0);
});

// Falsación: se importa el MISMO módulo con las llamadas `arrancar()` retiradas. Las importaciones
// relativas se vuelven absolutas para que el módulo `data:` cargue los mismos archivos del repo.
const fuente = fs.readFileSync(new URL("./previa-panel.js", import.meta.url), "utf8");
const falsa = fuente.replace(/bombeoReloj\.arrancar\(\);/g, "/* bombeo retirado */");
assert.notEqual(falsa, fuente, "la falsación tiene que retirar alguna llamada real");
const conUrls = falsa.replace(/from "\.\/([^"]+)"/g,
  (_, nombre) => `from "${new URL("./" + nombre, import.meta.url).href}"`);
const ModuloSinBombeo = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(conUrls));

await comprueba("FALSACIÓN: sin arrancar el bombeo, el cronómetro sigue en 00:00.00", async () => {
  const sinBombeo = await correr(ModuloSinBombeo, 0);
  assert.equal(sinBombeo.antes.texto, "00:00.00");
  assert.equal(sinBombeo.antes.reloj, 0);
  assert.equal(sinBombeo.antes.citas, 0, "sin arrancar no hay ningún pulso de pared");
  assert.ok(!sinBombeo.antes.ordenes.some((a) => a.includes("--avanzar")));
});

if (fallos) {
  console.log("cronometro-bombeo: " + fallos + " fallo(s)");
  process.exitCode = 1;
} else {
  console.log("cronometro-bombeo: todo en orden");
}
