// prueba de humo con node: genera el zip con el mismo código que la página y lo escribe en
// disco; después python zipfile y zipcheck.py del harness tienen que estar de acuerdo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject, makeZip, analyze, RULES, crc32 } from "./app.js";
import * as pestanaMod from "./pestana.js";
import { Historial } from "./historial.js";
import { fusionar } from "./fusion.js";
import { leerZip, zipDelArbol, paqueteDelManifiesto, nombreDeZip, rutaSegura,
  ajustesDelManifiesto, conAjustes } from "./proyecto.js";
import * as vistaPrevia from "./vista-previa.js";
import * as previaPanel from "./previa-panel.js";
import * as autocompletado from "./autocompletado-datos.js";
import * as xmlEditor from "./xml-editor.js";
import * as vistaXml from "./vista-xml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const a = { buildProject, makeZip, analyze, RULES, crc32 };

const estado = {
  name: "Hola apkc", package: "com.hola.apkcstudio", minsdk: "21", targetsdk: "33",
  hello: "Hello World!", button: true, kotlin: process.env.STUDIO_KOTLIN === "1", libs: true,
  native: true, assets: true, device: true,
};
if (estado.kotlin) estado.package = "com.hola.apkcstudio.kt";

let fallos = 0;
const mal = (msg) => { fallos++; console.log("  FALLO:", msg); };

const p = a.buildProject(estado);
const entradas = Object.entries(p.files).map(([r, t]) => [estado.package + "/" + r, t]);
for (const d of p.dirs) entradas.push([estado.package + "/" + d + "/", ""]);

// 1. lo que se genera es código: un carácter fuera de ascii dentro de una plantilla copia
//    literal de apkc/template/* rompe el XML y aapt2 lo rechaza en el telefono. Los LEEME
//    son prosa para quien descomprime, y esos si pueden llevar tildes.
for (const [ruta, texto] of Object.entries(p.files)) {
  if (!/\.(xml|java|kt)$/.test(ruta)) continue;
  const raros = [...new Set([...texto].filter((c) => c.charCodeAt(0) > 127))];
  if (raros.length) mal(`${ruta} lleva ${raros.length} caracteres no ascii: ${raros.join(" ")}`);
  // un placeholder que no se sustituyo, o un undefined que JS convirtio en texto: el fichero
  // compila y la app sale diciendo "undefined" o mostrando "{{toast}}"
  for (const mala of texto.match(/\{\{\w+\}\}/g) || []) mal(`${ruta} conserva ${mala}`);
  for (const linea of texto.split("\n")) if (/\bundefined\b/.test(linea)) mal(`${ruta}: ${linea.trim()}`);
  const llaves = (texto.match(/\{/g) || []).length, cierres = (texto.match(/\}/g) || []).length;
  if (/\.(java|kt)$/.test(ruta) && llaves !== cierres) mal(`${ruta}: ${llaves} llaves abiertas, ${cierres} cerradas`);
}

// 2. y las partes fijas tienen que ser las del repo, no la versión que uno recuerda: lo que
//    se exige es que todo atributo que apkc escribe esté ahí y bien escrito. La página añade
//    cosas que la plantilla del repo no tiene (un Boton, extractNativeLibs) y eso no es un fallo.
const repo = process.env.APKC_REPO || path.join(process.env.HOME, "Develop/Go/apkc");
const plantillas = { "AndroidManifest.xml": "manifest", "res/layout/main.xml": "layout", "res/values/styles.xml": "styles" };
const token = (s) => [...s.matchAll(/android:[A-Za-z][A-Za-z0-9]*|<[?/]?[A-Za-z][\w.-]*/g)].map((m) => m[0]);
for (const [ruta] of Object.entries(plantillas)) {
  const origen = path.join(repo, "template", path.basename(ruta));
  if (!fs.existsSync(origen)) { console.log("  (sin repo en", origen, ": comparacion omitida)"); continue; }
  const esperado = new Set(token(fs.readFileSync(origen, "utf8")));
  const obtenido = new Set(token(p.files[ruta]));
  // maxSdkVersion se omite a propósito: fijar la API máxima en el manifiesto generado deja la
  // app sin poder instalarse en versiones futuras (docs/plan.md, B1)
  const faltan = [...esperado].filter((t) => !obtenido.has(t) && !t.startsWith("<?") &&
    t !== "</manifest>" && t !== "android:maxSdkVersion");
  if (faltan.length) mal(`${ruta} no tiene ${faltan.join(", ")} como en ${origen}`);
}

const buf = Buffer.from(a.makeZip(entradas));
const tmp = process.env.PREFIX ? path.join(process.env.PREFIX, "tmp") : process.env.TMPDIR || ".";
const salida = path.join(tmp, process.env.STUDIO_OUT || "studio-test.zip");
fs.writeFileSync(salida, buf);
console.log("zip:", salida, buf.length, "bytes,", entradas.length, "entradas");

// 2b. la plantilla Contador no puede ser un adorno: cambia el layout y la actividad, y conserva
// el package y el manifiesto. Se comprueba en node y e2e la compila de verdad.
const contador = a.buildProject({ ...estado, template: "contador", kotlin: false, libs: false,
  native: false, assets: false, device: false });
const actContador = contador.files["src/" + estado.package.split(".").join("/") + "/MainActivity.java"];
const layContador = contador.files["res/layout/main.xml"];
if (!/TextView total;/.test(actContador) || !/total\.setText\("Pulsos: " \+ pulsos\)/.test(actContador)) {
  mal("la plantilla Contador no escribe el campo y la cuenta");
}
if (!/@\+id\/total/.test(layContador) || !/@\+id\/pulsar/.test(layContador)) {
  mal("la plantilla Contador no declara los ids que usa la actividad");
}
if (/Hello World!/.test(layContador)) mal("la plantilla Contador conserva el texto de Hola mundo");

// 2c. las tres plantillas nuevas se comprueban igual: mismo rigor de ascii y placeholders que el
// proyecto base, y contenido propio en los ficheros que las distinguen. e2e.sh las compila.
const plantillasNuevas = {
  ciclo: { java: [/public void onCreate\(Bundle savedInstanceState\)/, /public void onStart\(\)/,
    /super\.onStart\(\)/] },
  menu: { java: [/public boolean onCreateOptionsMenu\(Menu menu\)/, /menu\.add\("Opciones"\)/,
    /new MenuItem\.OnMenuItemClickListener\(\)/] },
  traducido: {
    java: [/public void onCreate\(Bundle savedInstanceState\)/],
    "res/layout/main.xml": [/android:text="@string\/saludo"/],
    "res/values/strings.xml": [/<string name="saludo">Hello!<\/string>/],
    "res/values-es/strings.xml": [/<string name="saludo">Hola!<\/string>/],
  },
};
const rutaJava = "src/" + estado.package.split(".").join("/") + "/MainActivity.java";
for (const [nombre, esperado] of Object.entries(plantillasNuevas)) {
  const pr = a.buildProject({ ...estado, template: nombre, kotlin: false, libs: false,
    native: false, assets: false, device: false });
  for (const [ruta, texto] of Object.entries(pr.files)) {
    const raros = [...new Set([...texto].filter((c) => c.charCodeAt(0) > 127))];
    if (raros.length) mal(`plantilla ${nombre}: ${ruta} lleva ${raros.join(" ")}`);
    for (const mala of texto.match(/\{\{\w+\}\}/g) || []) mal(`plantilla ${nombre}: ${ruta} conserva ${mala}`);
    for (const re of esperado[ruta] || (ruta === rutaJava ? esperado.java : []) || []) {
      if (!re.test(texto)) mal(`plantilla ${nombre}: ${ruta} no contiene ${re}`);
    }
  }
  if (nombre === "traducido") {
    if (!pr.dirs.includes("res/values-es")) mal("la plantilla traducida no crea res/values-es");
    if (!/android:label="@string\/app_name"/.test(pr.files["AndroidManifest.xml"])) {
      mal("la plantilla traducida no etiqueta la app desde @string/app_name");
    }
  }
}

// 3. el EOCD y los modos: un lector estricto (zipcheck.py) es el que ve lo que zipfile tolera
const eocd = buf.readUInt16LE(buf.lastIndexOf(Buffer.from("PK\x05\x06", "latin1")) + 8);
if (eocd !== entradas.length) mal(`el EOCD anuncia ${eocd} entradas y hay ${entradas.length}`);

// 4. analizador contra salidas reales de apkc, no contra cómo uno se imagina un error
const muestras = JSON.parse(fs.readFileSync(path.join(__dirname, "muestras.json"), "utf8"));
let cubiertas = 0;
for (const m of muestras) {
  const { hits } = a.analyze(m.texto);
  const ok = hits.some((h) => h.id === m.esperada);
  if (ok) cubiertas++;
  else mal(`sin cubrir: ${m.esperada} <- ${m.texto.split("\n")[0].slice(0, 70)}`);
}
console.log("reglas confirmadas contra salidas reales:", cubiertas + "/" + muestras.length);

// 5. y ninguna regla puede estar inventada: la de apkc se busca en el fuente, la de otra
//    herramienta tiene que estar en alguna salida capturada. Sin esto, la página explicaría
//    un mensaje que nadie imprime, que es peor que no explicarlo.
let fuentes = "";
try {
  fuentes = fs.readdirSync(repo).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
    .map((f) => fs.readFileSync(path.join(repo, f), "utf8")).join("\n");
} catch (e) {
  // este repo se puede probar solo (CI de apkc-studio): sin el fuente de apkc no se puede anclar
  // cada regla a su línea, pero las capturas de muestras.json siguen valiendo
  console.log("  (sin fuente de apkc en " + repo + ": no se ancla cada regla)");
}
const capturado = muestras.map((m) => m.texto).join("\n");
let sinEvidencia = 0;
for (const r of a.RULES) {
  if (!r.lit) { mal(`${r.id}: sin lit:, no se puede comprobar de donde salio`); continue; }
  if (r.de === "apkc") {
    if (fuentes && !fuentes.includes(r.lit)) mal(`${r.id}: "${r.lit}" no esta en el fuente de apkc: regla inventada`);
  } else if (!capturado.includes(r.lit)) {
    sinEvidencia++;
    console.log(`  (sin captura: ${r.id} para "${r.lit}", dicha por ${r.de})`);
  }
}
console.log("reglas:", a.RULES.length, "| ancladas al fuente de apkc o a una salida capturada:",
  a.RULES.length - sinEvidencia, "| sin captura propia:", sinEvidencia);

// 6. el cableado del DOM, que es lo unico que prueba.js no puede ejecutar: todo id que vistas.js
//    pide tiene que estar en index.html, y todo name del formulario lo tiene que leer el creador
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "vistas.js"), "utf8");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g))
  if (!ids.has(m[1])) mal(`vistas.js pide #${m[1]} y index.html no lo tiene`);
// lo mismo para la pestaña: es el otro fichero que toca el DOM, y un id que no existe se traduce
// en un `addEventListener` sobre null que solo se ve cuando alguien pulsa el boton
const pestana = fs.readFileSync(path.join(__dirname, "pestana.js"), "utf8");
for (const m of pestana.matchAll(/getElementById\("([^"]+)"\)/g))
  if (!ids.has(m[1])) mal(`pestana.js pide #${m[1]} y index.html no lo tiene`);
for (const fichero of ["diagnostico.js", "temas.js", "historial.js", "vista-previa.js",
  "previa-panel.js", "autocompletado.js", "diagnostico-vivo.js"]) {
  const fuente = fs.readFileSync(path.join(__dirname, fichero), "utf8");
  for (const m of fuente.matchAll(/getElementById\("([^"]+)"\)/g))
    if (!ids.has(m[1])) mal(`${fichero} pide #${m[1]} y index.html no lo tiene`);
}
// la tercera vista es contrato: su botón en la barra de actividad, su pestaña y su sección. Sin
// el id, vistas.js cae a Inicio y la vista previa nunca se ve.
const botonesVista = [...html.matchAll(/<button[^>]*data-vista="([^"]+)"/g)].map((m) => m[1]);
for (const v of botonesVista) if (!ids.has(v)) mal(`el botón data-vista="${v}" no tiene sección con ese id`);
if (!botonesVista.includes("vista")) mal("nav.actividad no tiene el botón de la vista previa");
if (!/class="pestana-vista"[^>]*data-vista="vista"|data-vista="vista"[^>]*class="pestana-vista"/.test(html)) {
  mal("la pestaña .pestana-vista de la vista previa no está en index.html");
}
for (const m of html.matchAll(/<input[^>]*name="([^"]+)"/g))
  if (!new RegExp(`"(f\\.get|f\\.has)\\(\"${m[1]}\"`).test(js) && !js.includes(`"${m[1]}"`))
    mal(`el formulario tiene ${m[1]} y estado() no lo lee`);

// 6b. la vista previa: el modelo de `apkc preview` y el pintor. Las funciones de modelo son puras
//     (sin DOM) y esta es su prueba de node; que el canvas pinte se comprueba en chromium. El
//     modelo es el medido sobre la plantilla Contador (docs/plan-vista-previa.md, Fase 1).
const modeloPrevia = {
  paquete: "com.hola.contador", version: "0.1", actividad: ".MainActivity",
  layout: "res/layout/main.xml",
  pantalla: { x: 0, y: 0, ancho: 360, alto: 640 }, aproximado: true, nodos: 3,
  raiz: {
    tipo: "LinearLayout", ancho: "match_parent", alto: "match_parent",
    rect: { x: 0, y: 0, ancho: 360, alto: 640 },
    hijos: [
      { tipo: "TextView", id: "id/total", idRef: "0x7f010001", texto: "Pulsos: 0",
        estilo: "@0x01030042", ancho: "wrap_content", alto: "wrap_content",
        rect: { x: 0, y: 0, ancho: 88, alto: 24 } },
      { tipo: "Button", id: "id/pulsar", idRef: "0x7f010000", texto: "Pulsar",
        ancho: "wrap_content", alto: "wrap_content",
        rect: { x: 0, y: 24, ancho: 64, alto: 48 } },
    ],
  },
};
const lineaModelo = "un aviso suelto\n" + JSON.stringify(modeloPrevia) + "\n[apkc] finished in 3ms\n";
const leido = vistaPrevia.modeloDeSalida(lineaModelo);
if (!leido || leido.layout !== "res/layout/main.xml" || leido.raiz.tipo !== "LinearLayout") {
  mal("modeloDeSalida no encuentra la línea del modelo entre la consola");
}
if (vistaPrevia.modeloDeSalida("sin json\n[apkc] finished") !== null) mal("modeloDeSalida inventa un modelo sin JSON");
if (vistaPrevia.modeloDeSalida('{"no":"es un modelo"}') !== null) mal("modeloDeSalida acepta un JSON que no es un modelo");
// el texto: `texto` es el respaldo y un campo de texto dinámico de la Fase 2 gana sin romper nada
if (vistaPrevia.textoDeNodo({ texto: "Pulsos: 0" }) !== "Pulsos: 0") mal("textoDeNodo no lee texto");
if (vistaPrevia.textoDeNodo({ texto: "Pulsos: 0", textoDinamico: "Pulsos: 3" }) !== "Pulsos: 3") {
  mal("textoDeNodo no prefiere el texto dinámico");
}
if (vistaPrevia.textoDeNodo({ texto: "estático", otraCosa: "x" }) !== "estático") mal("textoDeNodo se pierde con campos nuevos");
if (vistaPrevia.textoDeNodo(null) !== "" || vistaPrevia.textoDeNodo({}) !== "") mal("textoDeNodo no tolera nodos vacíos");
const planos = vistaPrevia.nodosAplanados(modeloPrevia);
if (planos.length !== 3 || planos[0].nodo.tipo !== "LinearLayout" || planos[1].nodo.tipo !== "TextView") {
  mal("nodosAplanados no recorre el árbol en orden: " + planos.map((p) => p.nodo.tipo).join(","));
}
const cajaPrevia = vistaPrevia.escalaPara(modeloPrevia, 360, 640);
if (cajaPrevia.escala !== 1 || cajaPrevia.x !== 0 || cajaPrevia.y !== 0) mal("escalaPara no deja 1:1 la pantalla de 360x640");
const cajaDoble = vistaPrevia.escalaPara(modeloPrevia, 720, 1280);
if (cajaDoble.escala !== 2 || cajaDoble.ancho !== 720 || cajaDoble.alto !== 1280) mal("escalaPara no escala x2");
const rectsPrevia = vistaPrevia.rectsEscalados(modeloPrevia, 720, 1280);
if (rectsPrevia.length !== 3) mal("rectsEscalados no devuelve un rectángulo por nodo: " + rectsPrevia.length);
const [raizR, totalR, botonR] = rectsPrevia;
if (raizR.x !== 0 || raizR.y !== 0 || raizR.ancho !== 720 || raizR.alto !== 1280 || raizR.profundidad !== 0) {
  mal("el rectángulo de la raíz no cubre la pantalla escalada");
}
if (totalR.x !== 0 || totalR.y !== 0 || totalR.ancho !== 176 || totalR.alto !== 48 || totalR.texto !== "Pulsos: 0") {
  mal("el rectángulo del TextView no coincide con el modelo: " + JSON.stringify(totalR));
}
if (totalR.tipo !== "TextView" || totalR.id !== "id/total") mal("el rectángulo no lleva tipo e id");
if (botonR.y !== 48 || botonR.ancho !== 128 || botonR.alto !== 96) {
  mal("el rectángulo del Button no coincide con el modelo: " + JSON.stringify(botonR));
}
// un nodo sin rect se omite en vez de pintarse en (0,0); y la cota corta un árbol desmedido
const sinRect = { pantalla: { ancho: 100, alto: 100 }, raiz: { tipo: "X", hijos: [{ tipo: "Y" }] } };
if (vistaPrevia.rectsEscalados(sinRect, 100, 100).length !== 0) mal("rectsEscalados pinta un nodo sin rect");
// la frontera de las medidas: `1e400` es Infinity en JS y `Number(null)` es 0. Ninguno puede
// acabar en NaN dentro del canvas: la pantalla cae a su respaldo y el rect que no se puede medir
// se omite. Se prueban también cadenas (un JSON puede traerlas) y valores no numéricos.
const finitos = (caja) => [caja.escala, caja.x, caja.y, caja.ancho, caja.alto].every(Number.isFinite);
const fronteras = [
  ["1e400", { ancho: 1e400, alto: 640 }, 360, 640],
  ["NaN e Infinity", { ancho: NaN, alto: Infinity }, 360, 640],
  ["null", null, null, null],
  ["cadenas", { ancho: "360", alto: "640" }, "360", "640"],
  ["basura", { ancho: {}, alto: [] }, "", " "],
];
for (const [nombre, pantalla, ancho, alto] of fronteras) {
  const caja = vistaPrevia.escalaPara({ pantalla }, ancho, alto);
  if (!finitos(caja)) mal(`escalaPara deja NaN con ${nombre}: ${JSON.stringify(caja)}`);
  if (!(caja.escala > 0) || caja.ancho <= 0 || caja.alto <= 0) mal(`escalaPara no da una caja usable con ${nombre}`);
}
const modeloRoto = { pantalla: { ancho: 1e400, alto: 640 },
  raiz: { tipo: "X", rect: { x: 0, y: 0, ancho: 1e400, alto: 10 } } };
if (vistaPrevia.rectsEscalados(modeloRoto, 360, 640).length !== 0) {
  mal("rectsEscalados pinta un rect con 1e400");
}
for (const roto of [null, Infinity, NaN, "no", {}]) {
  const r = vistaPrevia.rectsEscalados(
    { pantalla: { ancho: 10, alto: 10 }, raiz: { tipo: "X", rect: { x: roto, y: 0, ancho: 1, alto: 1 } } }, 10, 10);
  if (r.length !== 0) mal("rectsEscalados acepta " + String(roto) + " como coordenada");
  if (!finitos(vistaPrevia.escalaPara({ pantalla: { ancho: 10, alto: 10, x: roto, y: roto } }, 10, 10))) {
    mal("escalaPara deja NaN con pantalla.x/y = " + String(roto));
  }
}
let cadena = { tipo: "A", rect: { x: 0, y: 0, ancho: 1, alto: 1 }, hijos: [] };
let punta = cadena;
for (let i = 0; i < 600; i++) {
  const hijo = { tipo: "A" + i, rect: { x: 0, y: 0, ancho: 1, alto: 1 }, hijos: [] };
  punta.hijos.push(hijo); punta = hijo;
}
if (vistaPrevia.nodosAplanados({ raiz: cadena }).length > 512) mal("nodosAplanados no pone cota al árbol");

// 6c. el texto de un nodo pintado es el dinámico si existe: el rect que va al canvas no puede
//     quedarse con el texto del layout cuando la app ya escribió otro.
const conDinamico = vistaPrevia.rectsEscalados({ pantalla: { ancho: 100, alto: 100 },
  raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 100, alto: 100 },
    hijos: [{ tipo: "TextView", texto: "Pulsos: 0", textoDinamico: "Pulsos: 1",
      rect: { x: 0, y: 0, ancho: 88, alto: 24 } }] } }, 100, 100);
if (conDinamico.length !== 2 || conDinamico[1].texto !== "Pulsos: 1") {
  mal("rectsEscalados no usa textoDinamico: " + JSON.stringify(conDinamico.map((r) => r.texto)));
}

// 6d. la vista dividida: ancho del separador, ruta del layout y bloque `ejecucion`. Son funciones
//     puras; el DOM y los píxeles se prueban en chromium (prueba-pestana.js).
const ancho = previaPanel.anchoValido;
if (ancho(400, 240, 900) !== 400) mal("anchoValido no respeta un ancho dentro del rango");
if (ancho("400", 240, 900) !== 400) mal("anchoValido no acepta un ancho guardado como cadena");
if (ancho(10, 240, 900) !== 240 || ancho(5000, 240, 900) !== 900) mal("anchoValido no recorta a los extremos");
if (ancho(NaN, 240, 900) !== 340 || ancho("basura", 240, 900) !== 340) mal("anchoValido no cae al respaldo");
if (ancho(500, 600, 400) !== 600) mal("anchoValido no corrige un máximo menor que el mínimo");
if (ancho(300, 240, 900) !== 300) mal("anchoValido redondea mal");

// 6d-bis. el reparto de una esquina o una arista: la arista que se mueve sigue al puntero y la de
//        enfrente se queda; el alto no deja hueco fuera del marco. Puro, probado aquí.
const repartir = previaPanel.cajaRedimensionada;
const desde = { ancho: 400, alto: 500, arriba: 0 };
const limites = { anchoMin: 240, anchoMax: 900, altoMin: 320, altoMax: 700 };
const oeste = repartir(desde, "oeste", -40, 0, limites);
if (oeste.ancho !== 440 || oeste.alto !== 500 || oeste.arriba !== 0) {
  mal("cajaRedimensionada no agranda desde la arista oeste: " + JSON.stringify(oeste));
}
const este = repartir(desde, "este", -40, 0, limites);
if (este.ancho !== 360) mal("cajaRedimensionada no encoge desde la arista este: " + JSON.stringify(este));
const norte = repartir(desde, "norte", 0, 60, limites);
if (norte.alto !== 440 || norte.arriba !== 60 || norte.alto + norte.arriba !== 500) {
  mal("cajaRedimensionada no mueve la arista norte dejando la de abajo quieta: " + JSON.stringify(norte));
}
const sureste = repartir(desde, "sureste", 30, 40, limites);
if (sureste.ancho !== 430 || sureste.alto !== 540 || sureste.arriba !== 0) {
  mal("cajaRedimensionada no combina las dos aristas en una esquina: " + JSON.stringify(sureste));
}
const topado = repartir({ ancho: 400, alto: 500, arriba: 300 }, "norte", 0, -200, limites);
if (topado.arriba !== 100 || topado.alto !== 600) {
  mal("cajaRedimensionada no detiene la arista norte al llegar al tope: " + JSON.stringify(topado));
}
const minimo = repartir({ ancho: 400, alto: 340, arriba: 0 }, "norte", 0, 200, limites);
if (minimo.alto !== 320) mal("cajaRedimensionada deja un alto por debajo del mínimo: " + JSON.stringify(minimo));
const anchoMinimo = repartir(desde, "este", -400, 0, limites);
if (anchoMinimo.ancho !== 240) mal("cajaRedimensionada deja un ancho por debajo del mínimo");
if (previaPanel.numeroOpcional("", 320, 900) !== null || previaPanel.numeroOpcional("basura", 320, 900) !== null) {
  mal("numeroOpcional no distingue «sin alto» de una preferencia rota");
}
if (previaPanel.numeroOpcional("600", 320, 900) !== 600 || previaPanel.numeroOpcional(10, 320, 900) !== 320) {
  mal("numeroOpcional no acepta una cadena ni recorta al mínimo");
}

const esLayout = previaPanel.esRutaDeLayout;
if (!esLayout("/proyecto/res/layout/main.xml")) mal("esRutaDeLayout no reconoce res/layout");
if (!esLayout("/proyecto/res/layout-land/girado.xml")) mal("esRutaDeLayout no reconoce layout-land");
if (esLayout("/proyecto/res/values/strings.xml") || esLayout(null) || esLayout(3)) {
  mal("esRutaDeLayout acepta algo que no es un layout");
}

const candidatos = previaPanel.candidatosDeLayout;
const soloAbierta = candidatos({ abierta: "/proyecto/res/layout/x.xml", proyecto: "/proyecto" });
if (soloAbierta.length !== 1 || soloAbierta[0] !== "/proyecto/res/layout/x.xml") {
  mal("candidatosDeLayout no empieza por el fichero abierto: " + JSON.stringify(soloAbierta));
}
const conModelo = candidatos({ abierta: "/proyecto/src/A.java", layout: "main", proyecto: "/proyecto" });
if (conModelo[0] !== "/proyecto/res/layout/main.xml") mal("candidatosDeLayout no normaliza el nombre del layout: " + JSON.stringify(conModelo));
const conRutaModelo = candidatos({ layout: "res/layout/main.xml", proyecto: "/proyecto/" });
if (conRutaModelo[0] !== "/proyecto/res/layout/main.xml") mal("candidatosDeLayout duplica el prefijo res/: " + JSON.stringify(conRutaModelo));
const conArbol = candidatos({ layout: "main", proyecto: "/proyecto",
  nodos: ["/proyecto/res/layout/zz.xml", "/proyecto/res/layout/main.xml", "/proyecto/src/A.java"] });
if (conArbol.join(",") !== "/proyecto/res/layout/main.xml,/proyecto/res/layout/zz.xml") {
  mal("candidatosDeLayout no ordena main primero y descarta lo que no es layout: " + JSON.stringify(conArbol));
}
const borrado = candidatos({ layout: "main", proyecto: "/proyecto", nodos: ["/proyecto/res/layout/otro.xml"] });
if (borrado.join(",") !== "/proyecto/res/layout/otro.xml") {
  mal("candidatosDeLayout insiste en un layout que ya no está: " + JSON.stringify(borrado));
}
if (candidatos({ proyecto: "/proyecto", nodos: ["/proyecto/src/A.java"] }).length !== 0) {
  mal("candidatosDeLayout inventa un layout sin ninguno en el árbol");
}
// el árbol del fs trae todo el almacenamiento: un layout de otra carpeta no es de este proyecto
const ajeno = candidatos({ proyecto: "/proyecto", abierta: "/estudio/build/res/layout/main.xml",
  nodos: ["/estudio/build/res/layout/main.xml", "/proyecto/res/layout/main.xml"] });
if (ajeno.join(",") !== "/proyecto/res/layout/main.xml") {
  mal("candidatosDeLayout acepta un layout fuera del proyecto: " + JSON.stringify(ajeno));
}
// build/ es la copia generada: no se enseña como si fuera el layout que se edita
const generado = candidatos({ proyecto: "/proyecto", abierta: "/proyecto/build/res/layout/main.xml",
  nodos: ["/proyecto/build/res/layout/main.xml"] });
if (generado.length !== 0) {
  mal("candidatosDeLayout toma el layout generado de build/: " + JSON.stringify(generado));
}

// 6e. el modo «en vivo» dibuja el layout: el XML del editor se convierte en modelo con la misma
//     forma que el de `apkc preview` (pantalla + nodos con rect). Es puro y se prueba aquí.
const layoutHola = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical" android:layout_width="match_parent"
    android:layout_height="match_parent" android:gravity="center">
  <TextView android:id="@+id/saludo" android:layout_width="wrap_content"
      android:layout_height="wrap_content" android:text="@string/saludo"/>
  <Button android:id="@+id/pulsar" android:layout_width="wrap_content"
      android:layout_height="wrap_content" android:text="Pulsar"/>
</LinearLayout>`;
const enVivo = vistaXml.modeloDeLayout(layoutHola, { layout: "res/layout/main.xml", strings: { saludo: "Hello!" } });
if (!enVivo.ok) {
  mal("modeloDeLayout no convierte el layout de la plantilla: " + enVivo.error);
} else {
  const m = enVivo.modelo;
  if (m.layout !== "res/layout/main.xml" || m.aproximado !== true || m.nodos !== 3 ||
      m.pantalla.ancho !== 360 || m.pantalla.alto !== 640) {
    mal("modeloDeLayout pierde la cabecera del modelo: " + JSON.stringify({ layout: m.layout, nodos: m.nodos, pantalla: m.pantalla }));
  }
  if (m.raiz.tipo !== "LinearLayout" || m.raiz.rect.ancho !== 360 || m.raiz.rect.alto !== 640) {
    mal("la raíz no ocupa la pantalla: " + JSON.stringify(m.raiz.rect));
  }
  const [texto, boton] = m.raiz.hijos;
  if (texto.tipo !== "TextView" || texto.id !== "id/saludo" || texto.texto !== "Hello!") {
    mal("el TextView no resuelve @string ni @+id: " + JSON.stringify(texto));
  }
  if (boton.tipo !== "Button" || boton.texto !== "Pulsar" || boton.rect.alto !== 48) {
    mal("el Button no se mide con su alto: " + JSON.stringify(boton));
  }
  // gravity=center del LinearLayout vertical: cada hijo centrado en horizontal y la pila centrada
  if (texto.rect.y !== 284 || boton.rect.y !== 308 ||
      Math.round(texto.rect.x) !== 151 || Math.round(boton.rect.x) !== 143) {
    mal("gravity/centrado del LinearLayout no se aplica: " + JSON.stringify({ texto: texto.rect, boton: boton.rect }));
  }
  if (texto.rect.alto !== 24 || Math.round(texto.rect.ancho) !== 58) {
    mal("el TextView de wrap_content no se mide por su texto: " + JSON.stringify(texto.rect));
  }
  for (const nodo of [texto, boton]) {
    if (nodo.rect.x < 0 || nodo.rect.y < 0 || nodo.rect.x + nodo.rect.ancho > 361 ||
        nodo.rect.y + nodo.rect.alto > 641) mal("un nodo se sale de la pantalla: " + JSON.stringify(nodo.rect));
  }
}

// pesos: dos hijos 0dp con weight 1 en un LinearLayout horizontal se reparten la mitad
const conPesos = vistaXml.modeloDeLayout(`<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:orientation="horizontal" android:layout_width="match_parent" android:layout_height="match_parent">
  <TextView android:layout_width="0dp" android:layout_height="match_parent" android:layout_weight="1" android:text="A"/>
  <TextView android:layout_width="0dp" android:layout_height="match_parent" android:layout_weight="1" android:text="B"/>
</LinearLayout>`);
if (!conPesos.ok || conPesos.modelo.raiz.hijos.map((h) => Math.round(h.rect.ancho)).join(",") !== "180,180") {
  mal("layout_weight no reparte el ancho: " + JSON.stringify(conPesos.ok ? conPesos.modelo.raiz.hijos.map((h) => h.rect) : conPesos));
}

// padding en el contenedor y margen en el hijo
const conMargen = vistaXml.modeloDeLayout(`<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:layout_width="match_parent" android:layout_height="match_parent" android:padding="8dp">
  <TextView android:layout_width="match_parent" android:layout_height="wrap_content"
    android:layout_margin="4dp" android:text="x"/>
</FrameLayout>`);
if (!conMargen.ok) {
  mal("modeloDeLayout no lee padding/margen: " + conMargen.error);
} else {
  const hijo = conMargen.modelo.raiz.hijos[0];
  if (Math.round(hijo.rect.x) !== 12 || Math.round(hijo.rect.ancho) !== 336) {
    mal("padding/margen no desplazan al hijo: " + JSON.stringify(hijo.rect));
  }
}

// @string sin resolver y entidades: el modelo no inventa texto y cuenta lo que falta
const sinString = vistaXml.modeloDeLayout(`<TextView xmlns:android="http://schemas.android.com/apk/res/android"
  android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="@string/nada"/>`);
if (!sinString.ok || sinString.modelo.raiz.texto !== "" || sinString.modelo.sinStrings !== 1) {
  mal("modeloDeLayout no cuenta los @string sin resolver: " + JSON.stringify(sinString));
}
const conEntidades = vistaXml.modeloDeLayout(`<TextView xmlns:android="http://schemas.android.com/apk/res/android"
  android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="A &amp; B &lt;x&gt;"/>`);
if (!conEntidades.ok || conEntidades.modelo.raiz.texto !== "A & B <x>") {
  mal("modeloDeLayout no decodifica las entidades del texto: " + JSON.stringify(conEntidades.modelo && conEntidades.modelo.raiz.texto));
}

// un XML a medias no produce modelo: el panel conserva el último render bueno
for (const [nombre, roto] of [
  ["etiqueta sin cerrar", "<LinearLayout><TextView android:text=\"x\""],
  ["cierre que no toca", "<LinearLayout></FrameLayout>"],
  ["sin etiquetas", "android:text=\"x\""],
  ["comentario abierto", "<LinearLayout><!-- hola"],
]) {
  const r = vistaXml.modeloDeLayout(roto);
  if (r.ok !== false || !r.error) mal("modeloDeLayout acepta un XML roto (" + nombre + "): " + JSON.stringify(r));
}
const conLinea = vistaXml.modeloDeLayout("<LinearLayout>\n<TextView\nandroid:text=\"x\"");
if (conLinea.ok !== false || !(conLinea.linea >= 1)) {
  mal("modeloDeLayout no dice la línea del XML roto: " + JSON.stringify(conLinea));
}

// el bloque que emite el intérprete: capturas en orden, avisos aparte, cuentas y error tolerantes
const ejecucionContador = {
  actividad: "com.hola.contador.MainActivity", metodo: "onCreate", pasos: 128, interacciones: 1,
  capturas: [
    { origen: "TextView.setText", id: "id/total", idRef: "0x7f010001", texto: "Pulsos: 1" },
    { origen: "Log.d", texto: "arrancada" },
    { origen: "println", texto: "hola" },
  ],
  avisos: ["stub sin resolver: android.widget.Toast", ""],
};
const resumen = previaPanel.resumenEjecucion({ ejecucion: ejecucionContador });
if (!resumen) mal("resumenEjecucion no ve el bloque ejecucion");
else {
  if (resumen.pasos !== 128 || resumen.interacciones !== 1 || resumen.metodo !== "onCreate") {
    mal("resumenEjecucion pierde las cuentas: " + JSON.stringify(resumen));
  }
  if (resumen.capturas.length !== 3 || resumen.capturas[0].texto !== "Pulsos: 1" ||
      resumen.capturas[0].id !== "id/total" || resumen.capturas[1].origen !== "Log.d") {
    mal("resumenEjecucion no conserva el orden de las capturas: " + JSON.stringify(resumen.capturas));
  }
  if (resumen.avisos.length !== 1 || !/Toast/.test(resumen.avisos[0])) {
    mal("resumenEjecucion no filtra los avisos vacíos: " + JSON.stringify(resumen.avisos));
  }
  if (resumen.error !== "") mal("resumenEjecucion inventa un error");
}
if (previaPanel.resumenEjecucion({ raiz: {} }) !== null) mal("resumenEjecucion inventa ejecución sin bloque");
if (previaPanel.resumenEjecucion({ ejecucion: { capturas: [{ texto: "<script>x</script>" }] } })
  .capturas[0].texto !== "<script>x</script>") {
  mal("resumenEjecucion no deja el texto tal cual (lo escapa el DOM, no el modelo)");
}
const muchas = { ejecucion: { capturas: Array.from({ length: 90 }, (_, i) => ({ origen: "Log.d", texto: "v" + i })),
  avisos: Array.from({ length: 40 }, (_, i) => "a" + i) } };
const acotado = previaPanel.resumenEjecucion(muchas);
if (acotado.capturas.length !== 64 || acotado.avisos.length !== 24) {
  mal("resumenEjecucion no acota capturas/avisos: " + acotado.capturas.length + "/" + acotado.avisos.length);
}
const basura = previaPanel.resumenEjecucion({ ejecucion: { capturas: "no", avisos: [1, null, {}], pasos: -3, error: 42 } });
if (!basura || basura.capturas.length !== 0 || basura.avisos.length !== 0 || basura.pasos !== 0 ||
    basura.error !== "") {
  mal("resumenEjecucion no tolera un JSON hostil: " + JSON.stringify(basura));
}

// la consola de la app es un canal aparte del registro: `consola` no se mezcla con `capturas`, cada
// línea conserva su origen y su secuencia, y se acota igual que el resto
const conConsola = previaPanel.resumenEjecucion({ ejecucion: {
  ...ejecucionContador,
  consola: [
    { origen: "Log.d", texto: "pulso 1", secuencia: 1 },
    { origen: "println", texto: "contador: pulso 1", secuencia: 2 },
    { origen: "", texto: "" },
  ],
  oyentes: [{ id: "id/pulsar", idRef: "0x7f010000" }, { idRef: "0x7f010009" }, null],
  pulsaciones: ["id/pulsar", ""],
} });
if (conConsola.consola.length !== 2 || conConsola.consola[0].origen !== "Log.d" ||
    conConsola.consola[0].secuencia !== 1 || conConsola.consola[1].texto !== "contador: pulso 1") {
  mal("resumenEjecucion no separa la consola de las capturas: " + JSON.stringify(conConsola.consola));
}
if (conConsola.capturas.length !== 3) mal("la consola se comió las capturas: " + conConsola.capturas.length);
if (conConsola.oyentes.length !== 2 || conConsola.oyentes[0].idRef !== "0x7f010000") {
  mal("resumenEjecucion no lee los oyentes: " + JSON.stringify(conConsola.oyentes));
}
if (conConsola.pulsaciones.length !== 1 || conConsola.pulsaciones[0] !== "id/pulsar") {
  mal("resumenEjecucion no lee las pulsaciones: " + JSON.stringify(conConsola.pulsaciones));
}
const consolaHostil = previaPanel.resumenEjecucion({ ejecucion: { consola: "no", oyentes: 42, pulsaciones: {} } });
if (consolaHostil.consola.length !== 0 || consolaHostil.oyentes.length !== 0 ||
    consolaHostil.pulsaciones.length !== 0) {
  mal("resumenEjecucion tolera mal una consola hostil: " + JSON.stringify(consolaHostil));
}
const consolaLarga = previaPanel.resumenEjecucion({ ejecucion: {
  consola: Array.from({ length: 200 }, (_, i) => ({ origen: "println", texto: "l" + i, secuencia: i + 1 })),
} });
if (consolaLarga.consola.length !== 128) mal("resumenEjecucion no acota la consola: " + consolaLarga.consola.length);

// las vistas que responden a un clic, con su etiqueta tomada del árbol, y la vista bajo un punto del
// canvas: las dos son puras y son lo que convierte un clic en un `--pulsar`
const modeloEmulador = {
  layout: "res/layout/main.xml", pantalla: { x: 0, y: 0, ancho: 360, alto: 640 }, aproximado: true,
  raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 360, alto: 640 }, hijos: [
    { tipo: "TextView", id: "id/total", idRef: "0x7f010001", texto: "Pulsos: 0",
      rect: { x: 0, y: 0, ancho: 88, alto: 24 } },
    { tipo: "Button", id: "id/pulsar", idRef: "0x7f010000", texto: "Pulsar", oyente: true,
      rect: { x: 0, y: 24, ancho: 96, alto: 48 } },
  ] },
  ejecucion: { interacciones: 0, oyentes: [{ id: "id/pulsar", idRef: "0x7f010000" }], capturas: [], consola: [] },
};
const oyentes = previaPanel.oyentesDeModelo(modeloEmulador);
if (oyentes.length !== 1 || oyentes[0].idRef !== "0x7f010000" || oyentes[0].tipo !== "Button" ||
    oyentes[0].texto !== "Pulsar") {
  mal("oyentesDeModelo no cruza el idRef con el árbol: " + JSON.stringify(oyentes));
}
if (previaPanel.oyentesDeModelo({ raiz: {} }).length !== 0) mal("oyentesDeModelo inventa oyentes sin ejecución");
// el lienzo mide 270x480: la escala es 0,75 y el botón cae en y 18..54, x 0..72
const enBoton = previaPanel.nodoEnPunto(modeloEmulador, 270, 480, 20, 30);
if (!enBoton || enBoton.idRef !== "0x7f010000" || enBoton.oyente !== true) {
  mal("nodoEnPunto no encuentra el botón oyente: " + JSON.stringify(enBoton));
}
const enTexto = previaPanel.nodoEnPunto(modeloEmulador, 270, 480, 20, 5);
if (!enTexto || enTexto.idRef !== "0x7f010001" || enTexto.oyente !== false) {
  mal("nodoEnPunto no distingue la vista sin listener: " + JSON.stringify(enTexto));
}
if (previaPanel.nodoEnPunto(modeloEmulador, 270, 480, 900, 900) !== null) {
  mal("nodoEnPunto devuelve una vista fuera del dibujo");
}
if (previaPanel.nodoEnPunto(modeloEmulador, 270, 480, NaN, 0) !== null) mal("nodoEnPunto acepta NaN");
// un toque sobre un hijo sube al contenedor que escucha; sin oyente encima, no hay clic
const conOyenteArriba = { ...modeloEmulador, raiz: { ...modeloEmulador.raiz, hijos: [
  { tipo: "LinearLayout", id: "id/zona", idRef: "0x7f010000", oyente: true,
    rect: { x: 0, y: 0, ancho: 200, alto: 200 }, hijos: [
      { tipo: "TextView", id: "id/total", idRef: "0x7f010001", texto: "Pulsos: 0",
        rect: { x: 0, y: 0, ancho: 88, alto: 24 } },
    ] },
] } };
const hijo = previaPanel.oyenteEnPunto(conOyenteArriba, 270, 480, 20, 10);
if (!hijo || hijo.idRef !== "0x7f010000") {
  mal("oyenteEnPunto no sube del hijo al contenedor que escucha: " + JSON.stringify(hijo));
}
if (previaPanel.oyenteEnPunto(modeloEmulador, 270, 480, 20, 5) !== null) {
  mal("oyenteEnPunto devuelve una vista sin listener");
}

// la vista dividida es contrato: sin estos ids y roles, `previa-panel.js` no engancha y las
// pruebas de chromium no tienen qué conducir
for (const [id, donde] of [
  ["editor-fila", "la fila que divide editor y previa"],
  ["marco-previa", "el marco que reparte el panel de la vista previa"],
  ["separador-previa", "la arista izquierda de la vista previa"],
  ["tirador-previa-este", "la arista derecha de la vista previa"],
  ["tirador-previa-norte", "la arista superior de la vista previa"],
  ["tirador-previa-sur", "la arista inferior de la vista previa"],
  ["tirador-previa-noroeste", "la esquina superior izquierda de la vista previa"],
  ["tirador-previa-noreste", "la esquina superior derecha de la vista previa"],
  ["tirador-previa-suroeste", "la esquina inferior izquierda de la vista previa"],
  ["tirador-previa-sureste", "la esquina inferior derecha de la vista previa"],
  ["previa-aviso-estrecho", "el aviso de que en pantalla estrecha no se redimensiona"],
  ["previa-lateral", "el panel de la vista previa"],
  ["previa-alternar", "el botón que lo muestra y lo oculta"],
  ["previa-modo-vivo", "la pestaña Vista previa"],
  ["previa-modo-render", "la pestaña Emulador"],
  ["previa-vivo-canvas", "el canvas del layout en vivo"],
  ["previa-vivo-estado", "la línea de estado del layout en vivo"],
  ["previa-lateral-canvas", "el canvas del emulador"],
  ["previa-pulsos", "los controles de clic del emulador"],
  ["previa-oyentes", "los botones de las vistas que responden a un clic"],
  ["previa-pulsos-cuenta", "la cuenta de clics entregados"],
  ["previa-consola", "la consola de la app"],
  ["previa-consola-lista", "las líneas de la consola de la app"],
  ["previa-consola-cabecera", "el resumen de la consola de la app"],
  ["previa-consola-vacio", "el mensaje de «sin salida»"],
  ["previa-log-lista", "la consola de la ejecución"],
  ["previa-log-cabecera", "el resumen de la ejecución"],
  ["previa-log-vacio", "el mensaje de «sin ejecución»"],
  ["vista-modo-previa", "la pestaña Vista previa de la vista Pantalla"],
  ["vista-modo-emulador", "la pestaña Emulador de la vista Pantalla"],
  ["vista-layout", "el panel de Vista previa de la vista Pantalla"],
  ["vista-layout-canvas", "el canvas de Vista previa de la vista Pantalla"],
  ["vista-layout-estado", "la línea de estado de Vista previa en la vista Pantalla"],
  ["vista-emulador", "el panel del Emulador de la vista Pantalla"],
  ["vista-log-lista", "la consola de la ejecución en la vista Pantalla"],
  ["vista-log-cabecera", "el resumen de la ejecución en la vista Pantalla"],
  ["vista-log-vacio", "el mensaje de «sin ejecución» en la vista Pantalla"],
  ["marco-vista-lado", "el marco redimensionable de la vista Pantalla"],
  ["vista-tirador-oeste", "la arista izquierda del panel de la vista Pantalla"],
  ["vista-tirador-este", "la arista derecha del panel de la vista Pantalla"],
  ["vista-tirador-norte", "la arista superior del panel de la vista Pantalla"],
  ["vista-tirador-sur", "la arista inferior del panel de la vista Pantalla"],
  ["vista-tirador-noroeste", "la esquina superior izquierda del panel de la vista Pantalla"],
  ["vista-tirador-noreste", "la esquina superior derecha del panel de la vista Pantalla"],
  ["vista-tirador-suroeste", "la esquina inferior izquierda del panel de la vista Pantalla"],
  ["vista-tirador-sureste", "la esquina inferior derecha del panel de la vista Pantalla"],
  ["vista-lado", "la columna de estado y consola de la vista Pantalla"],
]) {
  if (!ids.has(id)) mal(`${donde} (${id}) no está en index.html`);
}
// el modo «en vivo» dibuja el layout: no puede quedar ni un visor de código XML en el panel
for (const idViejo of ["previa-xml", "previa-xml-codigo", "previa-xml-estado", "previa-modo-xml"]) {
  if (ids.has(idViejo)) mal(`el visor de código XML (${idViejo}) sigue en index.html`);
}
const panelPrevia = /<aside id="previa-lateral"[^]*?<\/aside>/.exec(html);
if (!panelPrevia) {
  mal("no se encuentra el panel de la vista previa en index.html");
} else {
  if (/<pre\b/.test(panelPrevia[0])) mal("el panel de la previa enseña un <pre>: eso es código, no un layout");
  if (/previa-xml/.test(panelPrevia[0])) mal("el panel de la previa conserva el visor de XML");
  if (!/<canvas id="previa-vivo-canvas"/.test(panelPrevia[0])) mal("el modo en vivo no tiene canvas propio");
}
if (!/<div[^>]*id="separador-previa"[^>]*role="separator"/.test(html) &&
    !/<div[^>]*role="separator"[^>]*id="separador-previa"/.test(html)) {
  mal("el separador no declara role=separator");
}
if (!/id="separador-previa"[^>]*tabindex="0"|tabindex="0"[^>]*id="separador-previa"/.test(html)) {
  mal("el separador no es enfocable por teclado");
}
if (!/id="previa-modo-vivo"[^>]*role="tab"/.test(html) || !/id="previa-modo-render"[^>]*role="tab"/.test(html)) {
  mal("los dos modos de la previa no son role=tab");
}
if (!/id="previa-log"[^>]*role="log"/.test(html)) mal("el registro del emulador no es role=log");
if (!/id="previa-consola"[^>]*role="log"/.test(html)) mal("la consola de la app no es role=log");
// los dos paneles son distintos y se llaman distinto: uno es el registro del emulador y el otro la
// salida de la app. La consola de los comandos es la del panel inferior, que conserva su id
if (!/id="previa-log"[^>]*aria-label="Registro del emulador"/.test(html)) {
  mal("el panel de capturas no se llama «Registro del emulador»");
}
if (!/id="previa-consola"[^>]*aria-label="Consola de la app"/.test(html)) {
  mal("el panel de salida no se llama «Consola de la app»");
}
if (!/id="consola-pestana"/.test(html)) mal("la consola de los comandos desapareció del panel inferior");
// el canvas del render se puede pulsar: sin foco ni manejador no habría forma de tocar la app
if (!/<canvas id="previa-lateral-canvas"[^>]*tabindex="0"/.test(html)) {
  mal("el canvas del render no es enfocable: no se puede pulsar con el teclado");
}
if (!/id="previa-vivo"[^>]*role="tabpanel"/.test(html) || !/id="previa-render"[^>]*role="tabpanel"/.test(html)) {
  mal("los paneles en vivo y emulador no son role=tabpanel");
}
// los modos se llaman por lo que hacen: «Vista previa» dibuja el XML y «Emulador» ejecuta los
// eventos de la app. Los nombres viejos no pueden volver a la interfaz.
if (/Render \(eventos\)|En vivo<|>En vivo/.test(html)) {
  mal("index.html conserva un nombre viejo de modo (Render (eventos) o En vivo)");
}
if (!/>Vista previa<\/button>/.test(html) || !/>Emulador<\/button>/.test(html)) {
  mal("las pestañas de modo no se llaman Vista previa y Emulador");
}
if (!/id="previa-modo-vivo"[^>]*>Vista previa</.test(html) || !/id="previa-modo-render"[^>]*>Emulador</.test(html)) {
  mal("los ids de modo no llevan el nombre nuevo en su texto");
}
// los ocho tiradores de cada marco: role=separator, el eje en data-eje y el cursor que toca
for (const tirador of html.matchAll(/<div id="([^"]*tirador[^"]*|[^"]*separador-previa)"[^>]*>/g)) {
  const etiqueta = tirador[0];
  if (!/role="separator"/.test(etiqueta)) mal("el tirador " + tirador[1] + " no es role=separator");
  if (!/data-eje="(oeste|este|norte|sur|noroeste|noreste|suroeste|sureste)"/.test(etiqueta)) {
    mal("el tirador " + tirador[1] + " no declara su eje");
  }
  if (!/aria-controls="(previa-lateral|vista-lado)"/.test(etiqueta)) {
    mal("el tirador " + tirador[1] + " no dice qué panel redimensiona");
  }
}
const tiradoresPanel = [...html.matchAll(/id="(tirador-previa-[a-z]+|separador-previa)"/g)].length;
if (tiradoresPanel !== 8) mal("la vista previa no tiene sus ocho tiradores: " + tiradoresPanel);
const tiradoresVista = [...html.matchAll(/id="vista-tirador-[a-z]+"/g)].length;
if (tiradoresVista !== 8) mal("la vista Pantalla no tiene sus ocho tiradores: " + tiradoresVista);
// el rótulo de tipo/id sobre un nodo lo pinta el pintor compartido; este módulo no añade el suyo,
// porque el panel y el emulador deben enseñar lo mismo sin duplicar el dibujo
const fuentePrevia = fs.readFileSync(path.join(__dirname, "previa-panel.js"), "utf8");
if (/\bfillText\s*\(/.test(fuentePrevia)) {
  mal("previa-panel.js pinta texto en el canvas: el rótulo del nodo es del pintor compartido");
}

// 7. el resaltador del editor es puro y se puede probar sin DOM; si se rompe, el código se
// queda sin color o, peor, el HTML del resaltado se come el texto
const java = pestanaMod.resaltar("package x;\n// hola\npublic class X {}\n", "java");
if (!/<span class="palabra">package<\/span>/.test(java)) mal("el resaltador no pinta package");
if (!/<span class="comentario">\/\/ hola<\/span>/.test(java)) mal("el resaltador no pinta el comentario");
const anotado = pestanaMod.resaltar("@Override int x = 42; char c = 'a';", "java");
if (!/class="anotacion">@Override</.test(anotado)) mal("el resaltador no pinta la anotación");
if (!/class="numero">42</.test(anotado)) mal("el resaltador no pinta el número");
if (!/class="cadena">'a'</.test(anotado)) mal("el resaltador no pinta el char");
const xml = pestanaMod.resaltar('<manifest package="x">', "xml");
if (!/class="etiqueta">manifest</.test(xml)) mal("el resaltador no pinta la etiqueta XML");
if (!/class="atributo">package</.test(xml)) mal("el resaltador no pinta el atributo XML");
if (pestanaMod.esXml("package x;") || !pestanaMod.esXml('<?xml version="1.0"?>')) mal("esXml no distingue Java de XML");
if (pestanaMod.esXml("package x; import java.util.List; class X { List<String> xs; }"))
  mal("esXml confunde los genéricos de Java con etiquetas XML");
if (!pestanaMod.esXml('<!-- c --><resources><string name="x">y</string></resources>'))
  mal("esXml no reconoce un recurso que empieza por comentario");

// los códigos ANSI de apkc no se enseñan crudos: se convierten en spans con su color
const color = pestanaMod.consolaHtml("\u001b[31mrojo\u001b[0m y \u001b[1;34mazul\u001b[0m");
if (!/class="consola-fg-1">rojo</.test(color) || !/class="consola-fuerte consola-fg-4">azul</.test(color))
  mal("consolaHtml no traduce los colores ANSI");
if (/\u001b/.test(color)) mal("consolaHtml deja códigos de escape en la consola");
if (!/&lt;b&gt;/.test(pestanaMod.consolaHtml("<b>"))) mal("consolaHtml no escapa el HTML");
// una salida `ruta:línea` se convierte en un enlace que abre el fichero
const conSalto = pestanaMod.consolaHtml("src/com/x/Main.java:7: error: falta ;");
if (!/<a href="#" class="salto" data-ruta="src\/com\/x\/Main\.java" data-linea="7">src\/com\/x\/Main\.java:7<\/a>/.test(conSalto)) {
  mal("consolaHtml no enlaza ruta:línea: " + conSalto);
}
if (/class="salto"[^>]*>.*&lt;/.test(conSalto)) mal("el enlace de la consola se come el texto escapado");

// 8. el árbol de deshacer: ramas, reconstrucción y poda sin tocar la rama actual
const historial = Historial;
const h = historial.crear("/proyecto/A.java", "uno");
historial.agregar(h, "uno\ndos");
historial.agregar(h, "uno\ndos\ntres");
if (historial.textoDe(h, h.actual) !== "uno\ndos\ntres") mal("el árbol no reconstruye el texto actual");
historial.deshacer(h);
historial.agregar(h, "uno\nRAMA");
const raiz = h.nodos[h.raiz];
const rama = raiz.h[0] ? h.nodos[raiz.h[0]] : null;
if (!rama || rama.h.length !== 2) mal("deshacer + escribir no creó una rama");
if (historial.textoDe(h, h.actual) !== "uno\nRAMA") mal("la rama nueva no se lee");
historial.restaurar(h, h.nodos[raiz.h[0]].h[0]);
if (historial.textoDe(h, h.actual) !== "uno\ndos\ntres") mal("la rama vieja no se conserva");
const recorrido = historial.recorrer(h);
if (recorrido.length !== 4 || recorrido[0].nivel !== 0) mal("recorrer no devuelve el árbol con niveles");
for (let i = 0; i < 300; i++) historial.agregar(h, "v" + i);
const nodos = Object.keys(h.nodos).length;
if (nodos > historial.MAX_NODOS) mal("la poda no respeta MAX_NODOS: " + nodos);
if (!h.nodos[h.actual]) mal("la poda borró el nodo actual");

// 9. fusión de tres vías: cambios separados se combinan; los que se pisan, conflicto
const baseFusion = "uno\ndos\ntres\n";
const auto = fusionar(baseFusion, "uno\nDOS\ntres\n", "uno\ndos\nTRES\n");
if (auto.estado !== "auto" || auto.texto !== "uno\nDOS\nTRES\n") mal("la fusión automática no combina cambios separados");
const choque = fusionar(baseFusion, "uno\nMIO\ntres\n", "uno\nSUYO\ntres\n");
if (choque.estado !== "conflicto") mal("la fusión no detecta el cambio en la misma línea");
if (fusionar(baseFusion, baseFusion, "uno\ndos\nTRES\n").estado !== "suyo") mal("la fusión no toma el remoto si el local no cambió");
if (fusionar(baseFusion, "uno\nDOS\ntres\n", baseFusion).estado !== "nuestro") mal("la fusión no conserva el local si el remoto no cambió");

// 9. el paquete oficial de la plataforma es un zip con android-34/android.jar: el editor tiene
// que sacarlo sin depender de un unzip externo. Se prueba con el mismo makeZip de la página.
(async () => {
  const interior = "PK" + "x".repeat(2048);
  const zip = a.makeZip([["android-34/android.jar", interior]]);
  const jar = await pestanaMod.jarDeSeleccion(zip);
  if (new TextDecoder().decode(jar) !== interior) mal("jarDeSeleccion no extrae android.jar del .zip oficial");

  // 10. exportar e importar el proyecto: binarios intactos, carpetas, y rutas que no salen
  const icono = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 1, 254]);
  const zipProyecto = zipDelArbol([
    ["AndroidManifest.xml", '<manifest package="com.hola.apkcstudio"/>'],
    ["res/drawable/icono.png", icono],
    ["res/drawable/", new Uint8Array(0)],
  ]);
  const vuelta = await leerZip(zipProyecto);
  const png = vuelta.find((e) => e.ruta === "res/drawable/icono.png");
  if (!png || png.datos.length !== icono.length || png.datos.some((b, i) => b !== icono[i])) {
    mal("leerZip no devuelve el PNG byte a byte");
  }
  if (!vuelta.some((e) => e.ruta === "res/drawable/" && e.dir)) mal("leerZip pierde las carpetas");

  // un zip hecho con DEFLATE (lo normal fuera de esta página) también entra
  const texto = "package x;\nclass X {}\n";
  const crudo = Buffer.from(texto);
  const comprimido = new Uint8Array(await new Response(
    new Blob([crudo]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const nombre = Buffer.from("src/x/X.java");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(a.crc32(crudo), 14);
  local.writeUInt32LE(comprimido.length, 18); local.writeUInt32LE(crudo.length, 22);
  local.writeUInt16LE(nombre.length, 26);
  const centralD = Buffer.alloc(46);
  centralD.writeUInt32LE(0x02014b50, 0); centralD.writeUInt16LE(20, 4); centralD.writeUInt16LE(20, 6);
  centralD.writeUInt16LE(0x0800, 8); centralD.writeUInt16LE(8, 10);
  centralD.writeUInt32LE(a.crc32(crudo), 16); centralD.writeUInt32LE(comprimido.length, 20);
  centralD.writeUInt32LE(crudo.length, 24); centralD.writeUInt16LE(nombre.length, 28);
  centralD.writeUInt32LE(0, 42);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(1, 8); fin.writeUInt16LE(1, 10);
  fin.writeUInt32LE(46 + nombre.length, 12); fin.writeUInt32LE(30 + nombre.length + comprimido.length, 16);
  const zipDeflate = Buffer.concat([local, nombre, comprimido, centralD, nombre, fin]);
  const deflate = await leerZip(new Uint8Array(zipDeflate));
  if (deflate.length !== 1 || new TextDecoder().decode(deflate[0].datos) !== texto) {
    mal("leerZip no infla una entrada DEFLATE");
  }

  // B4: un central directory que declara 128 MB por entrada se rechaza antes de descomprimir
  const zipBombo = Buffer.from(zipDeflate);
  const centralEn = 30 + nombre.length + comprimido.length;
  zipBombo.writeUInt32LE(128 * 1024 * 1024, centralEn + 24);
  let rechazoCota = false;
  try { await leerZip(new Uint8Array(zipBombo)); }
  catch (e) { rechazoCota = /demasiado grande/.test(String(e && e.message ? e.message : e)); }
  if (!rechazoCota) mal("leerZip no pone cota al tamaño declarado de una entrada");

  if (rutaSegura("../fuera.txt") || rutaSegura("/abs.txt") || rutaSegura("a\\b.txt") || !rutaSegura("a/b.txt")) {
    mal("rutaSegura no filtra las rutas que salen del proyecto");
  }
  if (paqueteDelManifiesto('<manifest package="com.x.y">') !== "com.x.y") mal("no lee el paquete del manifiesto");
  if (nombreDeZip("com.x.y") !== "com.x.y.zip" || nombreDeZip("") !== "proyecto.zip") mal("nombreDeZip no nombra el zip");

  // 11. los ajustes se escriben en el manifiesto y no en un fichero paralelo
  const manifiesto = p.files["AndroidManifest.xml"];
  if (/maxSdkVersion/.test(manifiesto)) mal("la plantilla sigue fijando maxSdkVersion");
  const ajustado = conAjustes(manifiesto, { minSdk: 24, targetSdk: 35, versionCode: 7, versionName: "1.0" });
  const leidos = ajustesDelManifiesto(ajustado);
  if (leidos.minSdk !== "24" || leidos.targetSdk !== "35" || leidos.versionCode !== "7" ||
      leidos.versionName !== "1.0") mal("conAjustes no escribe los cuatro valores: " + JSON.stringify(leidos));
  if (/maxSdkVersion/.test(ajustado)) mal("conAjustes no quita maxSdkVersion");
  if ((ajustado.match(/<uses-sdk/g) || []).length !== 1) mal("conAjustes duplica el bloque uses-sdk");
  // sin uses-sdk se añade, y los atributos que ya estaban no se pierden
  const sinUsos = conAjustes('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.x">\n</manifest>',
    { minSdk: 21, targetSdk: 34, versionCode: 1, versionName: "0.1" });
  if (!/<uses-sdk[^>]*android:minSdkVersion="21"/.test(sinUsos) || !/package="com.x"/.test(sinUsos)) {
    mal("conAjustes no añade uses-sdk cuando falta");
  }
  let rechazo = "";
  try { conAjustes(manifiesto, { minSdk: 34, targetSdk: 21, versionCode: 1, versionName: "1" }); }
  catch (e) { rechazo = e.message; }
  if (!/targetSdk no puede ser menor/.test(rechazo)) mal("conAjustes acepta targetSdk menor que minSdk");
  let rechazoNombre = "";
  try { conAjustes(manifiesto, { minSdk: 21, targetSdk: 34, versionCode: 1, versionName: "1<2" }); }
  catch (e) { rechazoNombre = e.message; }
  if (!/versionName/.test(rechazoNombre)) mal("conAjustes acepta un versionName con <");

  // 12. la consola redacta contraseñas, pero el comando que se ejecuta no se toca (M1).
  const argv = ["sign", "--keystore", "/ks.p12", "--storepass", "saludo", "--keyalias", "k",
    "--old-storepass=anterior", "--out", "/salida.apk"];
  const redactado = pestanaMod.redactarArgv(argv);
  if (redactado.join(" ").includes("saludo") || redactado.join(" ").includes("anterior")) {
    mal("redactarArgv deja una contraseña en la copia que se pinta");
  }
  if (!redactado.includes("***") || !redactado.includes("--old-storepass=***")) {
    mal("redactarArgv no pone *** en las opciones con pass");
  }
  if (argv[4] !== "saludo" || argv[7] !== "--old-storepass=anterior") {
    mal("redactarArgv cambia el argv real que se ejecuta");
  }


  // 11. autocompletado: la parte que no necesita DOM. Los recursos salen del árbol y de los XML,
  // y el jar se parte por su directorio central; si esto se rompe, la lista sugiere basura.
  {
    const tipos = autocompletado.recursosDeRutas([
      "/proyecto/res/layout/main.xml",
      "/proyecto/res/layout-land/main.xml",
      "/proyecto/res/drawable-hdpi/icono.9.png",
      "/proyecto/res/mipmap/ic_launcher.webp",
      "/proyecto/res/values/strings.xml",
      "/proyecto/src/com/x/R.java",
    ]);
    if (!tipos.layout || !tipos.layout.has("main")) mal("recursosDeRutas pierde res/layout/main.xml");
    if (!tipos.drawable || !tipos.drawable.has("icono")) mal("recursosDeRutas no quita el .9.png");
    if (!tipos.mipmap || !tipos.mipmap.has("ic_launcher")) mal("recursosDeRutas pierde el mipmap");
    if (tipos.values || tipos.java) mal("recursosDeRutas mete values o src como si fueran recursos");

    const valores = autocompletado.agregarValores(`<resources>
      <string name="hola">Hola</string>
      <string-array name="dias"><item>lun</item></string-array>
      <style name="AppTheme" parent="@android:style/Theme"/>
      <item type="id" name="suelto"/>
      <declare-styleable name="Propia"><attr name="modo" format="integer"/></declare-styleable>
    </resources>`, {});
    if (!valores.string || !valores.string.has("hola")) mal("agregarValores pierde el <string>");
    if (!valores.array || !valores.array.has("dias")) mal("agregarValores no mapea string-array a array");
    if (!valores.style || !valores.style.has("AppTheme")) mal("agregarValores pierde el <style>");
    if (!valores.id || !valores.id.has("suelto")) mal("agregarValores pierde el <item type=\"id\">");
    if (!valores.styleable || !valores.styleable.has("Propia")) mal("agregarValores pierde el declare-styleable");

    const ids = autocompletado.agregarIdsDeXml(`<LinearLayout><TextView android:id="@+id/total"/></LinearLayout>`, {});
    if (!ids.id || !ids.id.has("total")) mal("agregarIdsDeXml pierde el @+id/total");

    // con la forma que escriben aapt2 y el enlazador de apkc: una clase por tipo y un campo por línea
    const deR = autocompletado.recursosDeRJava(`package a;
public final class R {
  public static final class layout {
    public static final int main=0x7f020000;
  }
  public static final class styleable {
    public static final int[] Propia = { 0x7f010000 };
    public static final int Propia_modo = 0;
  }
}`, {});
    if (!deR.layout || !deR.layout.has("main")) mal("recursosDeRJava pierde R.layout.main");
    if (!deR.styleable || !deR.styleable.has("Propia")) mal("recursosDeRJava pierde el styleable");

    const casos = [
      ["R.layout.ma", "valores", "layout", "ma"],
      ["R.", "tipos", null, ""],
      ["Toast.", "metodos", null, ""],
    ];
    for (const [texto, modo, tipo, prefijo] of casos) {
      const ctx = autocompletado.contextoDeCompletado(texto, texto.length);
      if (!ctx || ctx.modo !== modo) mal(`contextoDeCompletado no ve ${modo} en ${JSON.stringify(texto)}`);
      else if (tipo && ctx.tipo !== tipo) mal(`contextoDeCompletado se equivoca de tipo en ${JSON.stringify(texto)}`);
      else if (ctx.prefijo !== prefijo) mal(`contextoDeCompletado se equivoca de prefijo en ${JSON.stringify(texto)}`);
    }
    if (autocompletado.contextoDeCompletado('String s = "R.layout.";', 21)) {
      mal("contextoDeCompletado sugiere dentro de una cadena");
    }
    if (autocompletado.contextoDeCompletado("// R.layout.", 12)) {
      mal("contextoDeCompletado sugiere dentro de un comentario");
    }

    // el zip del jar: el mismo makeZip de la página, leído por el directorio central
    const zipJar = a.makeZip([["android/app/Activity.class", "PK" + "x".repeat(64)],
      ["android/widget/Toast.class", "PK" + "x".repeat(64)]]);
    const fin = autocompletado.buscarFinDirectorio(new Uint8Array(zipJar));
    if (!fin || fin.entradas !== 2) mal(`buscarFinDirectorio no ve las dos entradas: ${JSON.stringify(fin)}`);
    else {
      const central = autocompletado.leerEntradasDirectorio(new Uint8Array(zipJar.subarray(fin.inicioDirectorio)));
      // el offset del registro central es absoluto: la cabecera local tiene que estar ahí
      const primera = central[0];
      const cabeceraLocal = autocompletado.offsetDeDatosLocales(
        new Uint8Array(zipJar.subarray(primera.local, primera.local + 30)));
      if (primera.local >= zipJar.length || cabeceraLocal < 30) {
        mal(`el offset local de ${primera.nombre} no apunta a una cabecera local (${primera.local} de ${zipJar.length})`);
      }
      const clases = autocompletado.clasesDelJar(central);
      if (clases.length !== 2) mal(`clasesDelJar ve ${clases.length} clases y hay dos`);
      if (!clases.some((c) => c.simple === "Toast" && c.ruta === "android.widget.Toast")) {
        mal("clasesDelJar no nombra android.widget.Toast");
      }
    }

    // un .class mínimo: pool con "hola" y "()V", un método publico estatico y ningún atributo
    const clase = new Uint8Array(43);
    const v = new DataView(clase.buffer);
    v.setUint32(0, 0xcafebabe, false);
    v.setUint16(4, 0); v.setUint16(6, 52);
    v.setUint16(8, 3);                       // constant_pool_count = 3 (dos entradas)
    v.setUint8(10, 1); v.setUint16(11, 4);   // Utf8 "hola"
    clase.set(new TextEncoder().encode("hola"), 13);
    v.setUint8(17, 1); v.setUint16(18, 3);   // Utf8 "()V"
    clase.set(new TextEncoder().encode("()V"), 20);
    v.setUint16(23, 0x0021);                 // ACC_PUBLIC | ACC_SUPER
    v.setUint16(25, 0); v.setUint16(27, 0);  // this, super
    v.setUint16(29, 0);                      // interfaces
    v.setUint16(31, 0);                      // campos
    v.setUint16(33, 1);                      // métodos
    v.setUint16(35, 0x0009);                 // public static
    v.setUint16(37, 1); v.setUint16(39, 2);  // nombre y descriptor
    v.setUint16(41, 0);                      // atributos del método
    const metodos = autocompletado.metodosDeClase(clase);
    if (metodos.length !== 1 || metodos[0].nombre !== "hola" || metodos[0].descriptor !== "()V" ||
        !metodos[0].publico || !metodos[0].estatico) {
      mal(`metodosDeClase no lee el método del .class: ${JSON.stringify(metodos)}`);
    }
  }

  // 11b. el XML del editor: contexto de tecleo, catálogo y linter. Es la parte pura de la rama
  // XML de `autocompletado.js` y de `diagnostico-vivo.js`; sin DOM se prueba aquí. Las
  // comprobaciones de que la lista y el subrayado se pintan van en `prueba-pestana.js`.
  {
    const ruta = "/proyecto/res/layout/main.xml";
    const ctxDe = (texto) => xmlEditor.contextoXml(texto, texto.length);

    const etiqueta = ctxDe("<LinearLayout>\n  <TextVie");
    if (!etiqueta || etiqueta.modo !== "etiqueta" || etiqueta.prefijo !== "TextVie" ||
        etiqueta.desde !== "<LinearLayout>\n  <".length) {
      mal(`contextoXml no ve la etiqueta a medio escribir: ${JSON.stringify(etiqueta)}`);
    }
    const atributo = ctxDe("<LinearLayout android:te");
    if (!atributo || atributo.modo !== "atributo" || atributo.prefijo !== "android:te" ||
        atributo.desde !== "<LinearLayout ".length) {
      mal(`contextoXml no ve el atributo a medio escribir: ${JSON.stringify(atributo)}`);
    }
    const valor = ctxDe('<TextView android:layout_width="wrap');
    if (!valor || valor.modo !== "valor" || valor.atributo !== "android:layout_width" ||
        valor.prefijo !== "wrap") {
      mal(`contextoXml no ve el valor entre comillas: ${JSON.stringify(valor)}`);
    }
    const referencia = ctxDe('<TextView android:text="@string/ap');
    if (!referencia || referencia.modo !== "referencia" || referencia.tipo !== "string" ||
        referencia.prefijo !== "ap") {
      mal(`contextoXml no ve la referencia @string/: ${JSON.stringify(referencia)}`);
    }
    if (ctxDe('<TextView android:text="@')?.tipo !== "") {
      mal("contextoXml no ofrece los tipos de recurso tras una @ suelta");
    }
    for (const fuera of ['<TextView>Hola', "<!-- <TextVie -->", "<TextView></TextV",
      "<?xml version=\"1.0\"?>"]) {
      if (ctxDe(fuera)) mal(`contextoXml sugiere XML donde no toca: ${JSON.stringify(fuera)}`);
    }

    const etiquetas = xmlEditor.sugerenciasXml(
      { modo: "etiqueta", prefijo: "Text", desde: 0, hasta: 4 }, { ruta });
    if (!etiquetas.lista.some((i) => i.texto === "TextView") || !/^xml ·/.test(etiquetas.estado)) {
      mal(`las etiquetas del layout no incluyen TextView o el estado no dice xml: ${etiquetas.estado}`);
    }
    const deValores = xmlEditor.sugerenciasXml(
      { modo: "etiqueta", prefijo: "", desde: 0, hasta: 0 },
      { ruta: "/proyecto/res/values/strings.xml" });
    if (!deValores.lista.some((i) => i.texto === "string") ||
        deValores.lista.some((i) => i.texto === "LinearLayout")) {
      mal("un res/values ofrece etiquetas de layout en vez de las suyas");
    }
    const deManifiesto = xmlEditor.sugerenciasXml(
      { modo: "etiqueta", prefijo: "", desde: 0, hasta: 0 },
      { ruta: "/proyecto/AndroidManifest.xml" });
    if (!deManifiesto.lista.some((i) => i.texto === "uses-permission")) {
      mal("el manifiesto no ofrece <uses-permission>");
    }
    const atributos = xmlEditor.sugerenciasXml(
      { modo: "atributo", prefijo: "", desde: 0, hasta: 0 }, { ruta });
    if (!atributos.lista.some((i) => i.insertar === "android:layout_width") ||
        !atributos.lista.some((i) => i.insertar === "tools:text")) {
      mal("faltan android:/tools: en la lista de atributos");
    }
    const porLocal = xmlEditor.sugerenciasXml(
      { modo: "atributo", prefijo: "textS", desde: 0, hasta: 5 }, { ruta });
    if (!porLocal.lista.some((i) => i.insertar === "android:textSize" && i.filtro === "textSize")) {
      mal("un atributo sin prefijo no se encuentra por su nombre local");
    }
    const enumerados = xmlEditor.sugerenciasXml(
      { modo: "valor", atributo: "android:layout_width", prefijo: "", desde: 0, hasta: 0 },
      { ruta, recursos: {} });
    if (!enumerados.lista.some((i) => i.texto === "match_parent") ||
        !enumerados.lista.some((i) => i.texto === "wrap_content")) {
      mal("layout_width no ofrece match_parent/wrap_content");
    }
    const visibilidad = xmlEditor.sugerenciasXml(
      { modo: "valor", atributo: "android:visibility", prefijo: "", desde: 0, hasta: 0 },
      { ruta, recursos: {} });
    if (!["visible", "gone", "invisible"].every((v) => visibilidad.lista.some((i) => i.texto === v))) {
      mal("visibility no ofrece visible/invisible/gone");
    }
    const propios = xmlEditor.sugerenciasXml(
      { modo: "referencia", tipo: "string", prefijo: "", desde: 0, hasta: 0 },
      { ruta, recursos: { string: new Set(["app_name", "saludo"]) } });
    if (!propios.lista.some((i) => i.texto === "app_name") || !/@string/.test(propios.estado)) {
      mal(`las referencias @string no salen del proyecto: ${JSON.stringify(propios)}`);
    }

    const recursos = { string: new Set(["app_name"]), layout: new Set(["main"]) };
    const errores = xmlEditor.diagnosticarXml(
      "<LinearLayout>\n  <TextView\n  <Button android:id=\"@+id/a\"/>\n" +
      "<Button android:id=\"@+id/a\" android:layout_widht=\"3dp\"\n" +
      "  android:text=\"@string/noexiste\"/>\n", { archivo: ruta, recursos });
    if (!errores.length || !errores.every((e) => e.origen === "XML" && e.linea > 0 && e.columna > 0)) {
      mal(`el linter no devuelve diagnósticos con línea y columna: ${JSON.stringify(errores)}`);
    }
    const texto = (e) => e.mensaje;
    if (!errores.some((e) => /no se cierra/.test(texto(e)))) mal("el linter no ve una etiqueta sin cerrar");
    if (!errores.some((e) => /no lleva valor/.test(texto(e)))) mal("el linter no ve un atributo sin valor");
    if (!errores.some((e) => /layout_widht/.test(texto(e)) && /layout_width/.test(texto(e)))) {
      mal("el linter no propone layout_width para layout_widht");
    }
    if (!errores.some((e) => /@string\/noexiste/.test(texto(e)))) {
      mal("el linter no ve un @string que no existe");
    }
    const duplicado = xmlEditor.diagnosticarXml(
      "<LinearLayout>\n<TextView android:id=\"@+id/a\"/>\n<TextView android:id=\"@+id/a\"/>\n</LinearLayout>",
      { archivo: ruta, recursos });
    if (duplicado.length !== 1 || duplicado[0].linea !== 3 || !/el id a ya se declaró/.test(duplicado[0].mensaje)) {
      mal(`el linter no ve el @+id repetido: ${JSON.stringify(duplicado)}`);
    }
    // sin datos del proyecto no se acusa una referencia: no se puede saber si existe
    if (xmlEditor.diagnosticarXml("<TextView android:text=\"@string/x\"/>", { archivo: ruta, recursos: {} }).length) {
      mal("el linter acusa @string sin haber barrido res/values");
    }
    // el `<string>` que se acaba de escribir en el propio buffer cuenta como declarado
    if (xmlEditor.diagnosticarXml(
      "<resources><string name=\"nuevo\">N</string><color name=\"c\">#fff</color></resources>",
      { archivo: "/proyecto/res/values/mia.xml", recursos: {} }).length) {
      mal("el linter no acepta los recursos declarados en el propio fichero");
    }
    // la columna va en runes: un astral delante del token cuenta una sola celda
    const conAstral = "<Button android:text=\"@string/noexiste\"/>";
    const lineaAstral = "/* \uD83D\uDE00 */ " + conAstral;
    const astral = xmlEditor.diagnosticarXml(lineaAstral, { archivo: ruta, recursos });
    const columnaEsperada = Array.from("/* \uD83D\uDE00 */ <Button android:text=\"").length + 1;
    if (astral.length !== 1 || astral[0].columna !== columnaEsperada) {
      mal(`la columna del linter no cuenta runes: ${JSON.stringify(astral)} (esperado ${columnaEsperada})`);
    }
    // CDATA, comentarios y DOCTYPE no son marcado: lo que va dentro no se tokeniza. Sin esto, el
    // `<b>` de un `<![CDATA[<b>…</b>]]>` se leía como etiqueta y el fichero salía con dos errores
    // falsos (hallazgo H1 del crítico).
    const casosCdata = [
      ['<string name="a"><![CDATA[<b>text & stuff</b>]]></string>', "el CDATA exacto del hallazgo"],
      ['<string name="b"><![CDATA[a &amp; <b>c</b> &lt;d&gt;]]></string>', "entidades y etiquetas dentro de CDATA"],
      ['<resources>\n  <string name="c"><![CDATA[<i>\n no rompe\n</i>]]></string>\n</resources>',
        "un CDATA de varias líneas"],
      ['<!-- <b> -->\n<string name="d">x</string>', "un comentario con etiquetas dentro"],
      ['<!DOCTYPE resources [ <!ELEMENT resources (string)> ]>\n' +
        '<resources><string name="e">x</string></resources>', "un DOCTYPE con subconjunto interno"],
    ];
    for (const [texto, que] of casosCdata) {
      const salida = xmlEditor.diagnosticarXml(texto, { archivo: "/proyecto/res/values/strings.xml" });
      if (salida.length) mal(`el linter inventa errores en ${que}: ${JSON.stringify(salida)}`);
    }
    const dentroCdata = "<string><![CDATA[<b>";
    if (xmlEditor.contextoXml(dentroCdata, dentroCdata.length)) {
      mal("contextoXml sugiere etiquetas dentro de un CDATA");
    }
    // el CDATA no tapa los errores de verdad: lo que va después se sigue comprobando
    const fueraCdata = xmlEditor.diagnosticarXml(
      '<LinearLayout>\n  <![CDATA[<b>x</b> & stuff]]>\n' +
      '  <TextView android:text="@string/noexiste"/>\n</LinearLayout>',
      { archivo: "/proyecto/res/layout/m.xml", recursos: { string: new Set(["f"]) } });
    if (fueraCdata.length !== 1 || !/@string\/noexiste/.test(fueraCdata[0].mensaje)) {
      mal(`el CDATA silencia errores de fuera: ${JSON.stringify(fueraCdata)}`);
    }
  }

  console.log(fallos ? `PRUEBA FALLA: ${fallos} problemas` : "prueba: todo en orden");
  process.exit(fallos ? 1 : 0);
})();
