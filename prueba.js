// prueba de humo con node: genera el zip con el mismo código que la página y lo escribe en
// disco; después python zipfile y zipcheck.py del harness tienen que estar de acuerdo.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildProject, makeZip, analyze, RULES, crc32 } from "./app.js";
import * as pestanaMod from "./pestana.js";
import { Historial } from "./historial.js";
import { fusionar } from "./fusion.js";
import { leerZip, normalizarEntradas, zipDelArbol, paqueteDelManifiesto, nombreDeZip, rutaSegura,
  ajustesDelManifiesto, conAjustes } from "./proyecto.js";
import * as vistaPrevia from "./vista-previa.js";
import * as previaPanel from "./previa-panel.js";
import * as autocompletado from "./autocompletado-datos.js";
import * as xmlEditor from "./xml-editor.js";
import * as vistaXml from "./vista-xml.js";
import * as layoutEditor from "./layout-editor.js";
import * as depsMod from "./deps.js";
import * as wispMod from "./wisp.js";
import { bufferDelManifiesto } from "./ajustes.js";
import { crearFs } from "./fs-fragmento.js";

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

// 2d. las cinco apps de banco/apps-ejemplo son plantillas de verdad: su opcion esta en el selector
//     de la pagina y buildProject escribe sus fuentes completas, no el esqueleto de Hola mundo.
//     e2e.sh no las compila todavia; la compilacion se midio en el banco y esta prueba vigila que
//     el generador no pierda un fichero por el camino.
const htmlPlantillas = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const vistasPlantillas = fs.readFileSync(path.join(__dirname, "vistas.js"), "utf8");
const appsEjemplo = {
  lienzo: { java: ["Lienzo.java", "MainActivity.java"], layouts: [] },
  notas: { java: ["MainActivity.java"], layouts: ["principal.xml", "item.xml"] },
  chatbt: { java: ["MainActivity.java"], layouts: ["principal.xml", "item.xml"] },
  tareas: { java: ["MainActivity.java"], layouts: ["principal.xml", "item.xml"] },
  cronometro: { java: ["MainActivity.java"], layouts: ["principal.xml", "item.xml"] },
};
const fuentesApp = "src/" + estado.package.split(".").join("/");
for (const [nombre, esperado] of Object.entries(appsEjemplo)) {
  if (!new RegExp('value="' + nombre + '"').test(htmlPlantillas)) {
    mal(`el selector de plantillas no ofrece la app ${nombre}`);
  }
  // vistas.js filtra la plantilla elegida: si no la nombra, crear el proyecto cae en hola sin avisar
  if (!new RegExp('"' + nombre + '"').test(vistasPlantillas)) {
    mal(`vistas.js no reconoce la plantilla ${nombre} y la cambiaria por hola`);
  }
  const app = a.buildProject({ ...estado, template: nombre, kotlin: false, libs: false,
    native: false, assets: false, device: false });
  if (app.files["res/layout/main.xml"] !== undefined) {
    mal(`la plantilla ${nombre} conserva el layout main.xml de Hola mundo`);
  }
  for (const fichero of esperado.java) {
    if (typeof app.files[fuentesApp + "/" + fichero] !== "string") {
      mal(`la plantilla ${nombre} no escribe ${fuentesApp}/${fichero}`);
    }
  }
  for (const fichero of esperado.layouts) {
    if (typeof app.files["res/layout/" + fichero] !== "string") {
      mal(`la plantilla ${nombre} no escribe res/layout/${fichero}`);
    }
  }
  if (!(app.files["res/values/strings.xml"] || "").includes('name="app_name"')) {
    mal(`la plantilla ${nombre} no escribe app_name en res/values/strings.xml`);
  }
  if (!/android:label="@string\/app_name"/.test(app.files["AndroidManifest.xml"])) {
    mal(`la plantilla ${nombre} no etiqueta la app desde @string/app_name`);
  }
  for (const [ruta, contenido] of Object.entries(app.files)) {
    if (!/\.(xml|java)$/.test(ruta)) continue;
    const raros = [...new Set([...contenido].filter((c) => c.charCodeAt(0) > 127))];
    if (raros.length) mal(`plantilla ${nombre}: ${ruta} lleva ${raros.join(" ")}`);
    for (const mala of contenido.match(/\{\{\w+\}\}/g) || []) mal(`plantilla ${nombre}: ${ruta} conserva ${mala}`);
  }
}
const chatbt = a.buildProject({ ...estado, template: "chatbt", kotlin: false, libs: false,
  native: false, assets: false, device: false });
if (!/BLUETOOTH_CONNECT/.test(chatbt.files["AndroidManifest.xml"])) {
  mal("la plantilla chatbt no declara los permisos de Bluetooth en el manifiesto");
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
  "previa-panel.js", "autocompletado.js", "diagnostico-vivo.js", "layout-editor.js", "deps.js",
  "wisp.js"]) {
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
// El modelo de apkc da 64x48 dp, pero Widget.Material.Button impone minWidth=88dp: el
// pintor ensancha el rect del botón sin tocar el modelo ni la posición.
if (botonR.y !== 48 || botonR.ancho !== 176 || botonR.alto !== 96) {
  mal("el rectángulo del Button no aplica el ancho mínimo medido en ART: " + JSON.stringify(botonR));
}
if (totalR.ancho !== 176 || raizR.ancho !== 720) mal("el ancho mínimo del botón no respeta el modelo");
// 6b-bis. la apariencia por defecto del tema del aparato, medida sobre Contador.apk en Droidloom
// (fondo blanco, texto #30323a, botón #d6d7d7, 14sp, botón 88x48dp con relleno 16/8dp).
const textoPlano = vistaPrevia.aparienciaDe({ tipo: "TextView", texto: "hola" });
const botonPlano = vistaPrevia.aparienciaDe({ tipo: "Button", texto: "Pulsar" });
if (textoPlano.fondo !== "" || textoPlano.colorTexto !== "#30323a" ||
    textoPlano.tamanoDp !== 14 || textoPlano.peso !== 400 || textoPlano.mayusculas !== false) {
  mal("un TextView sin atributos no toma la apariencia del tema claro medido: " + JSON.stringify(textoPlano));
}
if (botonPlano.fondo !== "" || botonPlano.colorTexto !== "#30323a" ||
    botonPlano.tamanoDp !== 14 || botonPlano.peso !== 500 || botonPlano.mayusculas !== true ||
    botonPlano.relleno.izq !== 16 || botonPlano.relleno.der !== 16 ||
    botonPlano.relleno.arr !== 8 || botonPlano.relleno.aba !== 8) {
  mal("un Button sin atributos no tiene el fondo, peso y relleno de Widget.Material.Button: " +
    JSON.stringify(botonPlano));
}
const textoLarge = vistaPrevia.aparienciaDe({ tipo: "TextView", estilo: "@0x01030042" });
const declarado = vistaPrevia.aparienciaDe({ tipo: "TextView", tamTexto: "24sp",
  color: "#123456", fondo: "#654321", estiloTexto: "bold",
  padding: { izq: 4, arr: 2, der: 6, aba: 3 } });
if (textoLarge.tamanoDp !== 22) mal("TextAppearance.Large no se traduce a 22sp");
if (declarado.tamanoDp !== 24 || declarado.peso !== 700 || declarado.colorTexto !== "#123456" ||
    declarado.fondo !== "#654321" || declarado.relleno.izq !== 4 || declarado.relleno.der !== 6 ||
    declarado.relleno.arr !== 2 || declarado.relleno.aba !== 3) {
  mal("lo que declara el modelo no gana al tema por defecto: " + JSON.stringify(declarado));
}
const conArriba = vistaPrevia.aparienciaDe({ tipo: "Button",
  padding: { arriba: 3, abajo: 5 } });
if (conArriba.relleno.arr !== 3 || conArriba.relleno.aba !== 5) {
  mal("no se lee el relleno del modelo del editor (arriba/abajo): " + JSON.stringify(conArriba.relleno));
}
const botonEstrecho = vistaPrevia.rectsEscalados({ pantalla: { ancho: 100, alto: 100 },
  raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 100, alto: 100 },
    hijos: [{ tipo: "Button", texto: "x", rect: { x: 4, y: 6, ancho: 40, alto: 20 } }] } }, 100, 100);
if (botonEstrecho.length !== 2 || botonEstrecho[1].ancho !== 88 || botonEstrecho[1].alto !== 48 ||
    botonEstrecho[1].x !== 4 || botonEstrecho[1].y !== 6) {
  mal("el botón estrecho no se ensancha a 88x48dp desde su esquina: " + JSON.stringify(botonEstrecho[1]));
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

// 6b-sexies. el `onDraw` de una vista propia se pinta dentro de su rect: `previewdibujo.go` publica
// `nodo.dibujo.operaciones` (color, linea, rectangulo, circulo y texto, con el color y el grosor
// del Paint) y el pintor tiene que consumirlas. El canvas es falso y cuenta las llamadas: la
// prueba no necesita navegador y falsifica el enganche (sin él, ninguna operación llega al ctx).
function lienzoFalso(ancho, alto) {
  const llamadas = [];
  const ctx = new Proxy({}, {
    get(_destino, propiedad) {
      return (...args) => { llamadas.push({ tipo: "metodo", nombre: String(propiedad), args }); };
    },
    set(_destino, propiedad, valor) {
      llamadas.push({ tipo: "propiedad", nombre: String(propiedad), valor });
      return true;
    },
  });
  const canvas = { width: 0, height: 0, clientWidth: ancho, clientHeight: alto, dataset: {},
    getContext: () => ctx };
  return { canvas, llamadas };
}
// el último valor que se puso a una propiedad antes de la llamada `indice`
function estiloAntes(llamadas, indice, propiedad) {
  for (let i = indice - 1; i >= 0; i--) {
    if (llamadas[i].tipo === "propiedad" && llamadas[i].nombre === propiedad) return llamadas[i].valor;
  }
  return null;
}
const modeloDibujo = {
  pantalla: { x: 0, y: 0, ancho: 100, alto: 100 }, aproximado: true, nodos: 2,
  raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 100, alto: 100 }, hijos: [{
    tipo: "p.q.Lienzo", id: "id/lienzo", rect: { x: 10, y: 20, ancho: 50, alto: 40 },
    dibujo: { operaciones: [
      { operacion: "color", color: "#ffeedd" },
      { operacion: "linea", x1: 0, y1: 0, x2: 20, y2: 10, color: "#336699", grosor: 4 },
      { operacion: "rectangulo", x1: 1, y1: 2, x2: 11, y2: 12, color: "#112233", grosor: 2 },
      { operacion: "circulo", x1: 5, y1: 5, radio: 3, color: "#80ff0000" },
      { operacion: "texto", x1: 2, y1: 8, texto: "hola", color: "#445566" },
      { operacion: "drawArc", x1: 1, y1: 1 },
    ] },
  }] },
};
{
  const { canvas, llamadas } = lienzoFalso(100, 100);
  const pintado = vistaPrevia.pintarModelo(canvas, modeloDibujo);
  if (!pintado || pintado.valida !== true) mal("pintarModelo no pinta el modelo con dibujo");
  // cinco operaciones pintadas: la desconocida (`drawArc`) se ignora sin romper el resto
  if (!pintado || pintado.operaciones !== 5) {
    mal("pintarModelo no consume las operaciones del dibujo: " + (pintado && pintado.operaciones));
  }
  // el tamaño del canvas y la escala no cambian por traer dibujo
  if (pintado.escala !== 1 || canvas.width !== 100 || canvas.height !== 100) {
    mal("el dibujo del nodo cambia el canvas o la escala: " + JSON.stringify(
      { escala: pintado.escala, ancho: canvas.width, alto: canvas.height }));
  }
  // `color` rellena el rect entero del nodo con su color (el relleno del fondo del nodo usa el
  // mismo rect, así que lo que distingue la operación es el color con el que se rellena)
  const relleno = llamadas.findIndex((c, i) => c.nombre === "fillRect" &&
    c.args.join(",") === "10,20,50,40" && estiloAntes(llamadas, i, "fillStyle") === "#ffeedd");
  if (relleno < 0) mal("el drawColor no rellena el rect del nodo con el color del modelo");
  // `linea`: del punto al punto, con el color y el grosor del Paint
  const fin = llamadas.findIndex((c) => c.nombre === "lineTo" && c.args.join(",") === "30,30");
  const trazo = llamadas.findIndex((c, i) => c.nombre === "stroke" && i > fin && fin >= 0);
  if (fin < 0) mal("la linea no llega al segundo punto del modelo");
  else if (llamadas.findIndex((c) => c.nombre === "moveTo" && c.args.join(",") === "10,20") < 0) {
    mal("la linea no arranca en el primer punto del modelo");
  }
  if (trazo < 0) mal("la linea no se traza");
  else if (estiloAntes(llamadas, trazo, "lineWidth") !== 4 ||
    estiloAntes(llamadas, trazo, "strokeStyle") !== "#336699") {
    mal("la linea no usa el grosor o el color del modelo: " + JSON.stringify(
      [estiloAntes(llamadas, trazo, "lineWidth"), estiloAntes(llamadas, trazo, "strokeStyle")]));
  }
  // `rectangulo` con grosor se traza como contorno en su esquina escalada
  const contorno = llamadas.findIndex((c) => c.nombre === "strokeRect" && c.args[0] === 11 && c.args[1] === 22);
  if (contorno < 0) mal("el rectangulo del dibujo no se traza en su esquina");
  else if (estiloAntes(llamadas, contorno, "lineWidth") !== 2 ||
    estiloAntes(llamadas, contorno, "strokeStyle") !== "#112233") {
    mal("el rectangulo no usa el grosor o el color del modelo");
  }
  // `circulo` sin grosor se rellena; el alfa ARGB del modelo pasa a `rgba()` del canvas
  const arco = llamadas.findIndex((c) => c.nombre === "arc" && c.args[0] === 15 && c.args[1] === 25 &&
    c.args[2] === 3);
  const rellenoCirculo = llamadas.findIndex((c, i) => c.nombre === "fill" && i > arco && arco >= 0);
  if (arco < 0) mal("el circulo no se centra donde dice el modelo");
  if (rellenoCirculo < 0) mal("el circulo sin grosor no se rellena");
  else if (estiloAntes(llamadas, rellenoCirculo, "fillStyle") !== "rgba(255, 0, 0, 0.502)") {
    mal("el circulo no traduce el ARGB del modelo: " + estiloAntes(llamadas, rellenoCirculo, "fillStyle"));
  }
  // `texto`: en su punto, con la línea base de `drawText` y sin rotular el nodo con su tipo
  const letras = llamadas.findIndex((c) => c.nombre === "fillText" && c.args[0] === "hola");
  if (letras < 0) mal("el drawText del modelo no se pinta");
  else if (llamadas[letras].args[1] !== 12 || llamadas[letras].args[2] !== 28 ||
    estiloAntes(llamadas, letras, "textBaseline") !== "alphabetic") {
    mal("el drawText no usa el punto ni la línea base del modelo: " +
      JSON.stringify(llamadas[letras].args));
  }
  // y con una pantalla al doble, las coordenadas y el grosor se escalan, no el canvas
  const doble = lienzoFalso(200, 200);
  const pintadoDoble = vistaPrevia.pintarModelo(doble.canvas, modeloDibujo);
  const dobleFin = doble.llamadas.findIndex((c) => c.nombre === "lineTo" && c.args.join(",") === "60,60");
  if (pintadoDoble.escala !== 2 || dobleFin < 0) {
    mal("el dibujo del nodo no se escala con la pantalla: " + (pintadoDoble && pintadoDoble.escala));
  }
  // un modelo sin `dibujo` se pinta exactamente como antes: cero operaciones
  const sinDibujo = lienzoFalso(360, 640);
  const pintadoSin = vistaPrevia.pintarModelo(sinDibujo.canvas, modeloPrevia);
  if (!pintadoSin || pintadoSin.operaciones !== 0) mal("un modelo sin dibujo pinta operaciones");
}

// 6b-ter. el pintor usa los colores y la letra del tema del aparato, no los del editor: la
// pantalla se rellena de blanco, el botón de gris y el estilo Large se pinta a 22px.
{
  const { canvas, llamadas } = lienzoFalso(360, 640);
  vistaPrevia.pintarModelo(canvas, modeloPrevia, { ancho: 360, alto: 640 });
  const pantalla = llamadas.findLastIndex((c) => c.nombre === "fillRect" && c.args.join(",") === "0,0,360,640");
  if (pantalla < 0 || estiloAntes(llamadas, pantalla, "fillStyle") !== "#ffffff") {
    mal("el fondo de la pantalla no es el blanco del tema de la app: " +
      (pantalla < 0 ? "sin relleno" : estiloAntes(llamadas, pantalla, "fillStyle")));
  }
  const boton = llamadas.findIndex((c) => c.nombre === "roundRect");
  const rellenoBoton = llamadas.findIndex((c, i) => c.nombre === "fill" && i > boton);
  if (boton < 0 || rellenoBoton < 0 || estiloAntes(llamadas, rellenoBoton, "fillStyle") !== "#d6d7d7") {
    mal("el botón sin background no pinta el gris medido en ART");
  }
  const rotulo = llamadas.find((c) => c.nombre === "fillText" && c.args[0] === "Pulsos: 0");
  const fuente = rotulo ? estiloAntes(llamadas, llamadas.indexOf(rotulo), "font") : "";
  if (!/\b22px\b/.test(String(fuente)) || !/Roboto/.test(String(fuente))) {
    mal("el estilo Large no se pinta a 22px con fuente del sistema: " + fuente);
  }
  const pulsar = llamadas.find((c) => c.nombre === "fillText" && c.args[0] === "PULSAR");
  if (!pulsar) mal("el texto del botón no se pinta en mayúsculas como en textAllCaps");
}

// 6b-quater. el estado vacío y la línea del emulador son uno solo: el panel (`previa-panel.js`) los
// importa de aquí, así que las dos superficies —la vista dividida y Pantalla— dicen lo mismo del
// mismo modelo y ninguna llama «vista previa» al canvas que ejecuta la app.
if (!/emulador/.test(vistaPrevia.MENSAJE_SIN_MODELO) || /vista previa/i.test(vistaPrevia.MENSAJE_SIN_MODELO)) {
  mal("MENSAJE_SIN_MODELO no habla del emulador: " + vistaPrevia.MENSAJE_SIN_MODELO);
}
const textoEmulador = vistaPrevia.textoDelModelo(modeloPrevia);
if (!/^Emulador/.test(textoEmulador) || !/3 nodos/.test(textoEmulador) || !/360×640 dp/.test(textoEmulador)) {
  mal("textoDelModelo no describe el modelo: " + textoEmulador);
}
if (!/^Emulador de /.test(vistaPrevia.textoDelModelo({ ...modeloPrevia, aproximado: false }))) {
  mal("textoDelModelo sigue diciendo «aproximado» con aproximado: false");
}
if (!/^Emulador aproximado de el layout/.test(vistaPrevia.textoDelModelo({ pantalla: {}, raiz: {} }))) {
  mal("textoDelModelo no cae a «el layout» y a la pantalla por defecto: " +
    vistaPrevia.textoDelModelo({ pantalla: {}, raiz: {} }));
}
// La línea visible del emulador ya no cuenta el modelo: el párrafo `role=status` está fuera del
// flujo (`.previa-estado-oculto`, solo para `aria-live`) y el detalle se enseña en la capa
// flotante de registro y consola y en el `title` del canvas. Así ningún modelo puede cambiar la
// altura del dibujo. `textoDelModelo` sigue siendo la fuente única de ese detalle.
const fuenteEstilo = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");
if (!/\.previa-estado-oculto\s*\{[^}]*position:\s*absolute/.test(fuenteEstilo)) {
  mal("style.css no saca del flujo la línea de estado del emulador (.previa-estado-oculto)");
}
for (const id of ["previa-render-estado", "vista-previa-estado"]) {
  const etiqueta = new RegExp(`<p id="${id}"[^>]*class="([^"]*)"`).exec(html);
  if (!etiqueta || !/previa-estado-oculto/.test(etiqueta[1])) {
    mal(`la línea de estado del emulador ${id} no está fuera del flujo (previa-estado-oculto)`);
  }
}
const fuentePreviaEstado = fs.readFileSync(path.join(__dirname, "previa-panel.js"), "utf8");
for (const id of ["previa-detalle-modelo", "vista-lado-detalle"]) {
  if (!fuentePreviaEstado.includes(id)) {
    mal(`previa-panel.js no escribe el detalle del modelo en la capa flotante (${id})`);
  }
}
// La consola de Pantalla es una capa desprendida: los tres modos son `fixed` (no reparten) y su
// modo, borde y posición se recuerdan en localStorage.
if (!/\[data-modo="libre"\][\s\S]{0,400}position:\s*fixed/.test(fuenteEstilo)) {
  mal("style.css no desprende la consola de Pantalla (data-modo=libre con position: fixed)");
}
for (const clave of ["apkc-studio/previa-lado-modo", "apkc-studio/previa-lado-borde",
  "apkc-studio/previa-lado-x", "apkc-studio/previa-lado-y"]) {
  if (!fuentePreviaEstado.includes(clave)) {
    mal(`previa-panel.js no persiste la consola flotante (${clave})`);
  }
}
// La cabecera de las dos capas no intercepta el clic: solo el asa y los botones lo reciben, así el
// puntero llega al canvas que hay debajo (el botón del contador cae en esa franja).
const cabecerasCss = [...fuenteEstilo.matchAll(/\.previa-inspector-cab\s*\{([^}]*)\}/g)].map((m) => m[1]);
if (!cabecerasCss.some((c) => /pointer-events:\s*none/.test(c))) {
  mal("style.css no deja pasar el clic por la cabecera de la consola (pointer-events: none)");
}
if (!/\.previa-inspector-cab\s+button[^{]*\{[^}]*pointer-events:\s*auto/.test(fuenteEstilo)) {
  mal("style.css no reactiva el puntero en los botones de la cabecera de la consola");
}
if (!/\.previa-inspector-asidero[^{]*\{[^}]*pointer-events:\s*auto/.test(fuenteEstilo) ||
    !/\.previa-inspector-asidero\s*\{[^}]*cursor:\s*move/.test(fuenteEstilo)) {
  mal("style.css no da un asa de arrastre pequeña a la consola (pointer-events: auto, cursor: move)");
}
// El registro del panel es la misma capa desprendida que la consola de Pantalla: los tres modos son
// `fixed`, así que ninguno reparte ni un píxel del canvas.
if (!/\.previa-inspector\[data-modo="libre"\][\s\S]{0,400}?position:\s*fixed/.test(fuenteEstilo)) {
  mal("style.css no desprende el registro del panel (data-modo=libre con position: fixed)");
}
// Pantalla completa: la clase tiene que fijar las dos superficies con el id en el selector, porque
// `#previa-render { position: relative }` (1,0,0) gana a una clase suelta y el botón no hacía nada.
for (const id of ["#previa-render", "#vista-cuerpo"]) {
  if (!new RegExp(id + "\\.pantalla-completa[\\s\\S]{0,240}?position:\\s*fixed").test(fuenteEstilo)) {
    mal(`style.css no lleva a pantalla completa ${id} (position: fixed con el id en el selector)`);
  }
}
if (!/superficie === "panel" \? el\("previa-render"\) : el\("vista-cuerpo"\)/.test(fuentePreviaEstado)) {
  mal("previa-panel.js no aplica la pantalla completa al contenedor de cada superficie");
}
// Las dos superficies comparten el motor de capa desprendida, y el arrastre empieza en el asa: la
// cabecera entera ya no mueve nada.
for (const superficie of ["panel", "vista"]) {
  if (!fuentePreviaEstado.includes(`conectarFlotante("${superficie}")`)) {
    mal(`previa-panel.js no conecta la capa desprendida de ${superficie}`);
  }
}
if (!/asa\.addEventListener\("pointerdown"/.test(fuentePreviaEstado)) {
  mal("previa-panel.js no arrastra la capa desde su asa");
}
if (/cabecera\.addEventListener\("pointerdown"/.test(fuentePreviaEstado)) {
  mal("previa-panel.js vuelve a arrastrar la capa desde la cabecera entera");
}
for (const clave of ["apkc-studio/previa-inspector-modo", "apkc-studio/previa-inspector-borde",
  "apkc-studio/previa-inspector-x", "apkc-studio/previa-inspector-y",
  "apkc-studio/previa-inspector-ancho", "apkc-studio/previa-inspector-alto"]) {
  if (!fuentePreviaEstado.includes(clave)) {
    mal(`previa-panel.js no persiste el registro desprendido del panel (${clave})`);
  }
}
// Un gesto de la consola no reescala el lienzo. El `ResizeObserver` de la fila se despierta con el
// cambio de la capa, así que el ajuste se salta mientras dura el gesto y `ajustarCanvas` es
// idempotente para la misma caja y el mismo par de dp. El ajuste por ventana o por preset sigue
// pasando porque cambia la caja o el par de dp. La geometría se verifica con navegador; esto fija
// el mecanismo.
if (!/medidasCanvasAplicadas/.test(fuentePreviaEstado) ||
    !/if \(!apagado && !pausaCanvas\) ajustarPantallas\(\)/.test(fuentePreviaEstado)) {
  mal("previa-panel.js no protege el lienzo del aviso de tamaño que provoca la capa flotante");
}
if (!/function aplicarModoFlotantePorModo[\s\S]{0,600}?pausarAjusteCanvas\(\)/.test(fuentePreviaEstado)) {
  mal("previa-panel.js no pausa el ajuste del lienzo al acoplar o cambiar de modo la consola");
}
const pausasCanvas = (fuentePreviaEstado.match(/pausarAjusteCanvas\(\)/g) || []).length;
if (pausasCanvas < 6) {
  mal("previa-panel.js no pausa el ajuste del lienzo en todos los gestos de la consola: " + pausasCanvas);
}

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

// Un apk soltado sobre el emulador: el tipo MIME no basta (en Linux suele llegar vacío), la
// extensión sí; y la puerta del zip rechaza con nombre lo que no es un apk antes de escribir en
// OPFS. Un zip válido pasa a `apkc preview`, que es quien dice el motivo exacto si le falta algo.
if (!previaPanel.esArchivoApk({ name: "app.apk", type: "" })) {
  mal("esArchivoApk no reconoce un .apk por la extensión");
}
if (!previaPanel.esArchivoApk({ name: "sin-extension", type: "application/vnd.android.package-archive" })) {
  mal("esArchivoApk no reconoce el tipo MIME del paquete de Android");
}
if (previaPanel.esArchivoApk({ name: "foto.png", type: "image/png" }) || previaPanel.esArchivoApk(null)) {
  mal("esArchivoApk acepta algo que no es un apk");
}
const apkValido = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
if (previaPanel.motivoApkInvalido(apkValido) !== "") {
  mal("motivoApkInvalido rechaza una cabecera de zip válida");
}
if (!previaPanel.motivoApkInvalido(new Uint8Array()).includes("vacío")) {
  mal("motivoApkInvalido no nombra un apk vacío");
}
if (!previaPanel.motivoApkInvalido(new Uint8Array([0x25, 0x50, 0x44, 0x46])).includes("no es un zip")) {
  mal("motivoApkInvalido no nombra un fichero que no es zip");
}
const rechazoApk = previaPanel.mensajeApkRechazado("roto.apk", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
if (!rechazoApk.startsWith("no se cargó roto.apk: ") || !rechazoApk.includes("no es un zip")) {
  mal("mensajeApkRechazado no nombra el fichero y el motivo: " + rechazoApk);
}
if (previaPanel.mensajeApkRechazado("app.apk", apkValido) !== "") {
  mal("mensajeApkRechazado rechaza un apk con cabecera válida");
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
  // gravity=center del LinearLayout vertical: cada hijo centrado en horizontal y la pila centrada.
  // El botón mide 88dp de ancho (minWidth de Widget.Material.Button), no los 74dp del texto.
  if (texto.rect.y !== 284 || boton.rect.y !== 308 ||
      Math.round(texto.rect.x) !== 151 || Math.round(boton.rect.x) !== 136) {
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

// 6e-bis. un tipo propio TOTALMENTE CUALIFICADO cuenta como contenedor por declaración: el editor
// no resuelve la herencia de Java, así que se dibuja como lineal para que sus hijos se repartan.
// Falsificación: si se apaga el reconocimiento, los hijos vuelven a apilarse en (0,0) y esta
// comprobación falla con ese síntoma, que es el que dejó abierto el frente de la vista propia.
const layoutPropia = `<?xml version="1.0" encoding="utf-8"?>
<com.ejemplo.lienzo.Lienzo xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/lienzo"
    android:layout_width="match_parent"
    android:layout_height="match_parent">
    <TextView android:id="@+id/uno" android:layout_width="wrap_content"
        android:layout_height="wrap_content" android:text="Uno"/>
    <Button android:id="@+id/dos" android:layout_width="wrap_content"
        android:layout_height="wrap_content" android:text="Dos"/>
</com.ejemplo.lienzo.Lienzo>`;
const propia = vistaXml.modeloDeLayout(layoutPropia, { layout: "res/layout/main.xml" });
if (!propia.ok) {
  mal("modeloDeLayout no lee un layout de vista propia: " + propia.error);
} else {
  const raiz = propia.modelo.raiz;
  if (raiz.tipo !== "Lienzo" || raiz.contenedor !== "lineal") {
    mal("un tipo propio cualificado no se reconoce como contenedor: " +
      JSON.stringify({ tipo: raiz.tipo, contenedor: raiz.contenedor }));
  }
  const [uno, dos] = raiz.hijos;
  if (uno.rect.y === 0 && dos.rect.y === 0) {
    mal("los hijos de un tipo propio se apilan en el origen: " + JSON.stringify([uno.rect, dos.rect]));
  }
  if (dos.rect.y !== uno.rect.alto) {
    mal("los hijos de un tipo propio no se reparten en vertical: " + JSON.stringify([uno.rect, dos.rect]));
  }
  const capas = vistaPrevia.nodosAplanados(propia.modelo).map((p) => p.nodo.tipo);
  if (capas.join(",") !== "Lienzo,TextView,Button") {
    mal("el modelo no refleja la jerarquía de la vista propia: " + capas.join(","));
  }
}
// el editor acepta hijos en el contenedor propio y los deja en la posición pedida
const enPropia = layoutEditor.insertarElemento(layoutPropia, { tipo: "Button", padre: [], indice: 0 });
if (!enPropia.ok) {
  mal("el editor no admite hijos en un contenedor propio: " + enPropia.error);
} else {
  const modeloPropia = vistaXml.modeloDeLayout(enPropia.xml);
  const hijosPropia = modeloPropia.ok ? modeloPropia.modelo.raiz.hijos : [];
  if (JSON.stringify(enPropia.ruta) !== "[0]" || !hijosPropia[0] || hijosPropia[0].tipo !== "Button" ||
      hijosPropia.length !== 3) {
    mal("el hijo soltado en un contenedor propio no entra en su posición: " +
      JSON.stringify({ ruta: enPropia.ruta, tipos: hijosPropia.map((h) => h.tipo) }));
  }
  if (hijosPropia[0] && hijosPropia[1] && hijosPropia[0].rect.y === hijosPropia[1].rect.y) {
    mal("el hijo nuevo del contenedor propio se apila sobre el primero en el origen");
  }
}
// una vista del framework escrita con su paquete no es un contenedor: manda el nombre simple
if (vistaXml.tipoDeContenedor("android.widget.TextView") !== "") {
  mal("un TextView cualificado se confunde con un contenedor");
}
const textoPropio = `<android.widget.TextView xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="x"/>`;
const enTextoPropio = layoutEditor.insertarElemento(textoPropio, { tipo: "Button" });
if (enTextoPropio.ok || !/no es un contenedor/.test(String(enTextoPropio.error))) {
  mal("el editor mete un hijo en un TextView cualificado: " +
    (enTextoPropio.error || enTextoPropio.xml));
}
// sin cualificar, un nombre desconocido sigue siendo hoja: no se inventa un contenedor
if (vistaXml.tipoDeContenedor("Lienzo") !== "") {
  mal("un tipo desconocido sin paquete se trata como contenedor");
}
// la precedencia es del PAQUETE, no del sufijo: `MiLayout` cualificado reparte aunque acabe en
// «Layout», y el mismo nombre sin paquete sigue siendo hoja porque la herencia no se adivina.
if (vistaXml.tipoDeContenedor("com.ejemplo.MiLayout") !== "lineal") {
  mal("un tipo cualificado que acaba en Layout no se reconoce como contenedor: " +
    vistaXml.tipoDeContenedor("com.ejemplo.MiLayout"));
}
if (vistaXml.tipoDeContenedor("MiLayout") !== "") {
  mal("un tipo sin paquete que acaba en Layout se adivina contenedor: " +
    vistaXml.tipoDeContenedor("MiLayout"));
}
// el modelo con raíz `com.ejemplo.MiLinearLayout` reparte a sus hijos: es el caso que el sufijo
// `Layout` tumbaba al evaluarse antes que el paquete.
const layoutMiLineal = `<com.ejemplo.MiLinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent" android:layout_height="match_parent">
    <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="Uno"/>
    <Button android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="Dos"/>
</com.ejemplo.MiLinearLayout>`;
const miLineal = vistaXml.modeloDeLayout(layoutMiLineal);
if (!miLineal.ok) {
  mal("modeloDeLayout no lee una raíz MiLinearLayout: " + miLineal.error);
} else {
  const raiz = miLineal.modelo.raiz;
  const [uno, dos] = raiz.hijos;
  if (raiz.contenedor !== "lineal" || !uno || !dos || dos.rect.y !== uno.rect.alto) {
    mal("la raíz MiLinearLayout no reparte a sus hijos: " +
      JSON.stringify({ contenedor: raiz.contenedor, uno: uno && uno.rect, dos: dos && dos.rect }));
  }
}

// 6b-bis. el editor de layout del modo editar: añadir, mover, reordenar y borrar son operaciones
// de TEXTO sobre el XML. Se prueban aquí porque son puras; que el panel las aplique con el canvas
// y el undo tree se conduce en `prueba-pestana.js`.
const layoutBase = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Hola"/>
</LinearLayout>
`;
const insertado = layoutEditor.insertarElemento(layoutBase, { tipo: "Button" });
if (!insertado.ok) mal("el editor de layout no añade un Button: " + insertado.error);
else {
  if (!/<Button\b/.test(insertado.xml) || !/@\+id\/boton\b/.test(insertado.xml)) {
    mal("el Button añadido no trae su id: " + insertado.xml.slice(-240));
  }
  if (!/android:layout_width="wrap_content"/.test(insertado.xml) || !/android:text="Boton"/.test(insertado.xml)) {
    mal("el Button añadido no trae wrap_content y texto");
  }
  const modeloInsertado = vistaXml.modeloDeLayout(insertado.xml);
  if (!modeloInsertado.ok) mal("el XML con el Button añadido no se puede analizar: " + modeloInsertado.error);
  else {
    const boton = modeloInsertado.modelo.raiz.hijos.find((h) => h.tipo === "Button");
    if (!boton || boton.id !== "id/boton" || boton.texto !== "Boton") {
      mal("el modelo en vivo no ve el Button añadido: " + JSON.stringify(modeloInsertado.modelo.raiz.hijos.map((h) => h.tipo)));
    }
  }
  const otro = layoutEditor.insertarElemento(insertado.xml, { tipo: "Button" });
  if (!otro.ok || otro.id !== "boton2" || !/@\+id\/boton2/.test(otro.xml)) {
    mal("el segundo Button no recibe un id libre: " + otro.id);
  }
  const contenedor = layoutEditor.insertarElemento(layoutBase, { tipo: "FrameLayout" });
  // el contenedor entra SOLO: sin el TextView «Texto» que se veía primero y parecía el insertado
  if (!contenedor.ok || !/<FrameLayout\b/.test(contenedor.xml) ||
      (contenedor.xml.match(/<TextView\b/g) || []).length !== 1) {
    mal("el FrameLayout añadido no entra solo, sin un TextView dentro: " +
      (contenedor.error || contenedor.xml));
  }
}
const conMarco = `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <TextView
        android:id="@+id/uno"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_gravity="center"
        android:text="Uno"/>

    <TextView
        android:id="@+id/dos"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Dos"/>
</FrameLayout>
`;
const movido = layoutEditor.moverEnMarco(conMarco, [1], { izquierda: 40, arriba: 24 });
if (!movido.ok || !/android:layout_marginLeft="40dp"/.test(movido.xml) ||
    !/android:layout_marginTop="24dp"/.test(movido.xml)) {
  mal("mover en un marco no escribe los márgenes: " + (movido.error || movido.xml));
} else {
  const m = vistaXml.modeloDeLayout(movido.xml);
  const dos = m.ok ? m.modelo.raiz.hijos[1] : null;
  if (!dos || dos.rect.x !== 40 || dos.rect.y !== 24) {
    mal("el margen escrito no coloca el nodo donde se arrastró: " + JSON.stringify(dos && dos.rect));
  }
}
const sinGravedad = layoutEditor.moverEnMarco(conMarco, [0], { izquierda: 8, arriba: 6 });
if (!sinGravedad.ok || /layout_gravity/.test(sinGravedad.xml)) {
  mal("mover no quita layout_gravity: el margen no se aplicaría");
}
const ordenado = layoutEditor.reordenarHijo(conMarco, [0], 1);
if (!ordenado.ok || !ordenado.cambio) mal("no reordena dos hijos del mismo LinearLayout/marco: " + ordenado.error);
else {
  const m = vistaXml.modeloDeLayout(ordenado.xml);
  const ids = m.ok ? m.modelo.raiz.hijos.map((h) => h.id) : [];
  if (ids.join(",") !== "id/dos,id/uno") mal("reordenar no cambia el orden del XML: " + ids.join(","));
}
const quitado = layoutEditor.borrarElemento(conMarco, [1]);
if (!quitado.ok || /id\/dos/.test(quitado.xml) || !vistaXml.modeloDeLayout(quitado.xml).ok) {
  mal("borrar un nodo no deja el XML válido sin él: " + (quitado.error || ""));
}
if (layoutEditor.borrarElemento(conMarco, []).ok) mal("el editor de layout deja borrar la raíz");
if (layoutEditor.insertarElemento("<LinearLayout>", { tipo: "Button" }).ok) {
  mal("el editor de layout acepta un XML roto para añadir");
}
const raizVacia = "<FrameLayout xmlns:android=\"http://schemas.android.com/apk/res/android\" " +
  "android:layout_width=\"match_parent\" android:layout_height=\"match_parent\" />";
const enVacia = layoutEditor.insertarElemento(raizVacia, { tipo: "TextView" });
if (!enVacia.ok || !vistaXml.modeloDeLayout(enVacia.xml).ok || !/<TextView\b/.test(enVacia.xml)) {
  mal("añadir sobre una raíz autocerrada no abre la etiqueta: " + (enVacia.error || enVacia.xml));
}

// 6b-quater. Todos los tipos de la paleta entran COMO EL TIPO PEDIDO y solos. El caso que confundió
// al usuario: un LinearLayout metía un TextView «Texto» dentro y se veía primero. Además, el tamaño
// con el que entra cada tipo es el mismo que pinta el indicador de destino (`tamanoDeTipo`).
const tablaTipos = [];
for (const tipo of layoutEditor.tiposDisponibles()) {
  const r = layoutEditor.insertarElemento(layoutBase, { tipo });
  const modelo = r.ok ? vistaXml.modeloDeLayout(r.xml) : { ok: false };
  const nodo = modelo.ok ? (() => {
    let n = modelo.modelo.raiz;
    for (const i of r.ruta || []) n = n && (n.hijos || [])[i];
    return n || null;
  })() : null;
  const tamano = layoutEditor.tamanoDeTipo(tipo);
  tablaTipos.push({ tipo, ruta: r.ruta, nodo: nodo ? nodo.tipo : null,
    hijos: nodo ? (nodo.hijos || []).length : -1,
    ancho: nodo && nodo.rect ? nodo.rect.ancho : null,
    alto: nodo && nodo.rect ? nodo.rect.alto : null });
  if (!r.ok || !modelo.ok || !nodo) {
    mal("el tipo " + tipo + " no entra en el layout: " + (r.error || "sin nodo"));
    continue;
  }
  if (nodo.tipo !== tipo) {
    mal("la paleta inserta " + nodo.tipo + " cuando se pide " + tipo);
  }
  if (tamano && (Math.abs(nodo.rect.ancho - tamano.ancho) > 0.5 ||
      Math.abs(nodo.rect.alto - tamano.alto) > 0.5)) {
    mal("el tamaño del indicador de " + tipo + " no es el del nodo: " +
      JSON.stringify({ indicador: tamano, nodo: { ancho: nodo.rect.ancho, alto: nodo.rect.alto } }));
  }
  if (layoutEditor.infoTipo(tipo).contenedor && (nodo.hijos || []).length) {
    mal("el contenedor " + tipo + " entra con hijos: " +
      nodo.hijos.map((h) => h.tipo).join(","));
  }
}
console.log("tipos de la paleta: " + tablaTipos.map((f) => f.tipo + "→" + f.nodo +
  " " + f.ancho + "×" + f.alto + (f.hijos ? " (" + f.hijos + " hijos)" : "")).join(", "));

// 6b-quinquies. soltar un tipo de la paleta en el dibujo: entra en el contenedor de la ruta, en la
// posición pedida y, si es un marco, con los márgenes del punto. Es el gesto que conduce
// `prueba-pestana.js`; aquí se prueba el texto que devuelve.
const conAnidado = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <FrameLayout
        android:id="@+id/marco"
        android:layout_width="match_parent"
        android:layout_height="wrap_content">

        <TextView
            android:id="@+id/uno"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Uno"/>
    </FrameLayout>

    <TextView
        android:id="@+id/dos"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Dos"/>
</LinearLayout>
`;
const soltadoEnMarco = layoutEditor.insertarElemento(conAnidado, {
  tipo: "Button", padre: [0], indice: 0, margen: { izquierda: 40, arriba: 24 },
});
if (!soltadoEnMarco.ok) {
  mal("el tipo soltado en un marco no se añade: " + soltadoEnMarco.error);
} else if (JSON.stringify(soltadoEnMarco.ruta) !== "[0,0]") {
  mal("el tipo soltado en un marco no devuelve su ruta: " + JSON.stringify(soltadoEnMarco.ruta));
} else {
  const modeloAnidado = vistaXml.modeloDeLayout(soltadoEnMarco.xml);
  const botonMarco = modeloAnidado.ok ? modeloAnidado.modelo.raiz.hijos[0].hijos[0] : null;
  if (!botonMarco || botonMarco.tipo !== "Button" || !botonMarco.rect ||
      botonMarco.rect.x !== 40 || botonMarco.rect.y !== 24) {
    mal("soltar en un marco no coloca el nodo en el punto: " +
      JSON.stringify(botonMarco && { tipo: botonMarco.tipo, rect: botonMarco.rect }));
  }
  if (!/android:layout_marginLeft="40dp"/.test(soltadoEnMarco.xml) ||
      !/android:layout_marginTop="24dp"/.test(soltadoEnMarco.xml)) {
    mal("soltar en un marco no escribe los márgenes del punto");
  }
}
const soltadoEnLineal = layoutEditor.insertarElemento(conAnidado, { tipo: "Button", indice: 0 });
if (!soltadoEnLineal.ok) {
  mal("el tipo soltado en un lineal no se añade: " + soltadoEnLineal.error);
} else {
  const modeloLineal = vistaXml.modeloDeLayout(soltadoEnLineal.xml);
  const primero = modeloLineal.ok ? modeloLineal.modelo.raiz.hijos[0] : null;
  if (!primero || primero.tipo !== "Button" || JSON.stringify(soltadoEnLineal.ruta) !== "[0]") {
    mal("soltar en un lineal no respeta la posición pedida: " +
      JSON.stringify({ tipo: primero && primero.tipo, ruta: soltadoEnLineal.ruta }));
  }
}
const soltadoEnTexto = layoutEditor.insertarElemento(conAnidado, { tipo: "Button", padre: [1] });
if (soltadoEnTexto.ok || !/no es un contenedor/.test(String(soltadoEnTexto.error))) {
  mal("el editor de layout mete un hijo en un TextView: " + (soltadoEnTexto.error || soltadoEnTexto.xml));
}
const soltadoEnRutaMala = layoutEditor.insertarElemento(conAnidado, { tipo: "Button", padre: [7] });
if (soltadoEnRutaMala.ok) mal("el editor de layout acepta una ruta de padre que no existe");

// 6b-ter. las propiedades de un nodo: se leen y se escriben sobre el texto, con entidades, ids,
// colores y la orientación de la raíz. Todo puro; el panel solo pone los campos.
const conProps = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#101010">

    <TextView
        android:id="@+id/saludo"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="A &amp; B"
        android:textColor="#ff0000"/>
</LinearLayout>
`;
const propsTexto = layoutEditor.leerPropiedades(conProps, [0]);
if (!propsTexto.ok || propsTexto.tipo !== "TextView" || propsTexto.raiz !== false) {
  mal("leerPropiedades no ve el TextView: " + JSON.stringify(propsTexto));
} else if (propsTexto.valores["android:text"] !== "A & B" ||
    propsTexto.valores["android:id"] !== "@+id/saludo" ||
    propsTexto.valores["android:textColor"] !== "#ff0000") {
  mal("leerPropiedades no devuelve los valores del XML: " + JSON.stringify(propsTexto.valores));
}
const propsRaiz = layoutEditor.leerPropiedades(conProps, []);
if (!propsRaiz.ok || propsRaiz.raiz !== true || propsRaiz.tipo !== "LinearLayout" ||
    propsRaiz.valores["android:orientation"] !== "vertical" ||
    propsRaiz.valores["android:background"] !== "#101010") {
  mal("leerPropiedades no lee la raíz y su orientación: " + JSON.stringify(propsRaiz));
}
const textoEscrito = layoutEditor.escribirPropiedad(conProps, [0], "android:text", "Hola <tú> & yo");
if (!textoEscrito.ok || textoEscrito.valor !== "Hola <tú> & yo" ||
    !/android:text="Hola &lt;tú&gt; &amp; yo"/.test(textoEscrito.xml)) {
  mal("escribirPropiedad no escapa el texto: " + (textoEscrito.error || textoEscrito.xml));
} else {
  const m = vistaXml.modeloDeLayout(textoEscrito.xml);
  if (!m.ok || m.modelo.raiz.hijos[0].texto !== "Hola <tú> & yo") {
    mal("el texto escapado no vuelve igual al modelo: " + JSON.stringify(m.modelo && m.modelo.raiz.hijos[0].texto));
  }
}
const idEscrito = layoutEditor.escribirPropiedad(conProps, [0], "android:id", "@id/viejo");
if (!idEscrito.ok || !/android:id="@\+id\/viejo"/.test(idEscrito.xml)) {
  mal("escribirPropiedad no normaliza el id a @+id: " + (idEscrito.error || idEscrito.xml));
}
if (layoutEditor.escribirPropiedad(conProps, [0], "android:id", "1 dos").ok) {
  mal("escribirPropiedad acepta un id que no es un identificador");
}
const colorEscrito = layoutEditor.escribirPropiedad(conProps, [0], "android:background", "#00ff00");
if (!colorEscrito.ok) mal("escribirPropiedad rechaza un color #RRGGBB: " + colorEscrito.error);
else {
  const m = vistaXml.modeloDeLayout(colorEscrito.xml);
  const hijo = m.ok ? m.modelo.raiz.hijos[0] : null;
  if (!hijo || hijo.fondo !== "#00ff00" || hijo.colorTexto !== "#ff0000") {
    mal("el color escrito no llega al modelo en vivo: " + JSON.stringify(hijo && { f: hijo.fondo, t: hijo.colorTexto }));
  }
}
if (layoutEditor.escribirPropiedad(conProps, [0], "android:background", "rojo").ok) {
  mal("escribirPropiedad acepta «rojo» como color");
}
const conRef = vistaXml.modeloDeLayout(
  '<TextView xmlns:android="http://schemas.android.com/apk/res/android" ' +
  'android:background="@color/marca" android:textColor="#80ff0000" android:text="x"/>',
  { colores: { marca: "#123456" } });
if (!conRef.ok || conRef.modelo.raiz.fondo !== "#123456" ||
    conRef.modelo.raiz.colorTexto !== "#ff000080") {
  mal("el modelo en vivo no resuelve @color ni reordena el alfa: " +
    JSON.stringify(conRef.modelo && { f: conRef.modelo.raiz.fondo, t: conRef.modelo.raiz.colorTexto }));
}
const dimensionEscrita = layoutEditor.escribirPropiedad(conProps, [0], "android:layout_width", "match_parent");
if (!dimensionEscrita.ok || !/android:layout_width="match_parent"/.test(dimensionEscrita.xml)) {
  mal("escribirPropiedad no escribe match_parent: " + (dimensionEscrita.error || ""));
}
if (layoutEditor.escribirPropiedad(conProps, [0], "android:layout_width", "ancho").ok) {
  mal("escribirPropiedad acepta «ancho» como dimensión");
}
const pesoEscrito = layoutEditor.escribirPropiedad(conProps, [0], "android:layout_weight", "2");
if (!pesoEscrito.ok || !/android:layout_weight="2"/.test(pesoEscrito.xml)) {
  mal("escribirPropiedad no escribe el peso: " + (pesoEscrito.error || ""));
}
if (layoutEditor.escribirPropiedad(conProps, [0], "android:layout_weight", "-1").ok) {
  mal("escribirPropiedad acepta un peso negativo");
}
const gravedadEscrita = layoutEditor.escribirPropiedad(conProps, [0], "android:gravity", "center|right");
if (!gravedadEscrita.ok || !/android:gravity="center\|right"/.test(gravedadEscrita.xml)) {
  mal("escribirPropiedad no escribe la gravedad: " + (gravedadEscrita.error || ""));
}
if (layoutEditor.escribirPropiedad(conProps, [0], "android:gravity", "centro").ok) {
  mal("escribirPropiedad acepta una gravedad inventada");
}
const orientacionEscrita = layoutEditor.escribirPropiedad(conProps, [], "android:orientation", "horizontal");
if (!orientacionEscrita.ok) mal("escribirPropiedad no cambia la orientación de la raíz: " + orientacionEscrita.error);
else {
  const m = vistaXml.modeloDeLayout(orientacionEscrita.xml);
  if (!m.ok || vistaXml.atributoLocal(m.modelo.raiz.atributos, "orientation") !== "horizontal") {
    mal("la orientación escrita no llega a la raíz del modelo");
  }
}
const desconocida = layoutEditor.escribirPropiedad(conProps, [0], "android:style", "x");
if (desconocida.ok || !/propiedad desconocida/.test(desconocida.error)) {
  mal("escribirPropiedad no rechaza por nombre una propiedad desconocida");
}

// 6b-septies. la imagen de un ImageView: `android:src` se valida (proyecto o framework),
// `contentDescription` se escribe escapado y la lista de iconos es la de API 34.
const conImagen = `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <ImageView
        android:id="@+id/foto"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:src="@drawable/retrato"/>
</FrameLayout>
`;
const propsImg = layoutEditor.leerPropiedades(conImagen, [0]);
if (!propsImg.ok || propsImg.valores["android:src"] !== "@drawable/retrato") {
  mal("leerPropiedades no lee android:src: " + JSON.stringify(propsImg.valores || propsImg));
}
const nombresImg = (propsImg.propiedades || []).map((p) => p.nombre);
if (nombresImg.indexOf("android:src") < 0 || nombresImg.indexOf("android:contentDescription") < 0) {
  mal("la ficha de una imagen no ofrece src y contentDescription: " + nombresImg.join(","));
}
if ((layoutEditor.leerPropiedades(conProps, [0]).propiedades || [])
  .some((p) => p.nombre === "android:src")) {
  mal("la ficha de un TextView ofrece android:src");
}
const srcSistema = layoutEditor.escribirPropiedad(conImagen, [0], "android:src",
  "@android:drawable/ic_delete");
if (!srcSistema.ok || !/android:src="@android:drawable\/ic_delete"/.test(srcSistema.xml)) {
  mal("escribirPropiedad no escribe un icono del sistema: " + (srcSistema.error || srcSistema.xml));
}
const srcProyecto = layoutEditor.escribirPropiedad(conImagen, [0], "android:src", "@drawable/otra");
if (!srcProyecto.ok || !/android:src="@drawable\/otra"/.test(srcProyecto.xml)) {
  mal("escribirPropiedad no escribe un drawable del proyecto: " + (srcProyecto.error || srcProyecto.xml));
}
if (layoutEditor.escribirPropiedad(conImagen, [0], "android:src", "foto.png").ok) {
  mal("escribirPropiedad acepta un nombre suelto como android:src");
}
const descImagen = layoutEditor.escribirPropiedad(conImagen, [0], "android:contentDescription",
  "Retrato & fondo");
if (!descImagen.ok || !/android:contentDescription="Retrato &amp; fondo"/.test(descImagen.xml)) {
  mal("escribirPropiedad no escribe contentDescription escapado: " +
    (descImagen.error || descImagen.xml));
}
const modeloImagen = vistaXml.modeloDeLayout(conImagen);
const imgModelo = modeloImagen.ok ? modeloImagen.modelo.raiz.hijos[0] : null;
if (!imgModelo || imgModelo.recurso !== "@drawable/retrato") {
  mal("el modelo en vivo no conserva android:src: " +
    JSON.stringify(imgModelo && imgModelo.recurso));
}
const iconos = layoutEditor.iconosSistema();
if (iconos.join(",") !== "ic_delete,ic_info,ic_menu_add,ic_menu_camera,ic_menu_delete," +
    "ic_menu_edit,ic_menu_gallery,ic_menu_help,ic_menu_search,ic_menu_share") {
  mal("la lista de iconos del sistema cambió sin volver a medirla contra API 34: " + iconos.join(","));
}
if (!iconos.every((n) => /^ic_[a-z0-9_]+$/.test(n))) {
  mal("la lista de iconos del sistema tiene un nombre que no es un recurso de framework");
}

// el tipo del layout raíz: se conservan atributos e hijos; RelativeLayout se rechaza por nombre
const aMarco = layoutEditor.cambiarTipoRaiz(conProps, "FrameLayout");
if (!aMarco.ok || !/<FrameLayout\b/.test(aMarco.xml) || /<LinearLayout\b/.test(aMarco.xml) ||
    !/<TextView\b/.test(aMarco.xml) || /android:orientation/.test(aMarco.xml)) {
  mal("cambiarTipoRaiz no pasa a FrameLayout conservando los hijos: " + (aMarco.error || aMarco.xml));
}
const aLineal = aMarco.ok ? layoutEditor.cambiarTipoRaiz(aMarco.xml, "LinearLayout") : aMarco;
if (!aLineal.ok || !/android:orientation="vertical"/.test(aLineal.xml)) {
  mal("cambiarTipoRaiz no vuelve a LinearLayout con orientación: " + (aLineal.error || ""));
}
const relativo = layoutEditor.cambiarTipoRaiz(conProps, "RelativeLayout");
if (relativo.ok || relativo.rechazado !== "RelativeLayout" || !/RelativeLayout/.test(relativo.error)) {
  mal("cambiarTipoRaiz no rechaza RelativeLayout por su nombre: " + JSON.stringify(relativo));
}
const desdeRelativo = layoutEditor.cambiarTipoRaiz(
  '<RelativeLayout xmlns:android="http://schemas.android.com/apk/res/android"/>', "LinearLayout");
if (desdeRelativo.ok) mal("cambiarTipoRaiz acepta cambiar una raíz que no es lineal ni marco");

// la paleta: ordenada, sin duplicados, cada tipo deja un XML válido y avisa si el dibujo no lo imita
const paleta = layoutEditor.tiposDisponibles();
const requeridos = ["TextView", "Button", "ImageView", "ImageButton", "EditText", "CheckBox",
  "RadioButton", "Switch", "ProgressBar", "SeekBar", "View", "LinearLayout", "FrameLayout",
  "RelativeLayout", "ScrollView", "TableLayout", "GridLayout", "Space"];
if (new Set(paleta).size !== paleta.length) mal("la paleta repite tipos: " + paleta.join(","));
for (const tipo of requeridos) if (!paleta.includes(tipo)) mal("la paleta no ofrece " + tipo);
for (const tipo of paleta) {
  const info = layoutEditor.infoTipo(tipo);
  if (!info || info.tipo !== tipo) mal("infoTipo no describe " + tipo);
  const insertado2 = layoutEditor.insertarElemento(layoutBase, { tipo });
  if (!insertado2.ok) mal("la paleta no puede añadir " + tipo + ": " + insertado2.error);
  else if (!vistaXml.modeloDeLayout(insertado2.xml).ok) mal("el XML de " + tipo + " no se analiza");
}
if (layoutEditor.infoTipo("CheckBox").aviso === "" || layoutEditor.infoTipo("TextView").aviso !== "") {
  mal("la paleta no marca con aviso los tipos que el dibujo no imita");
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
if (acotado.capturas.length !== 90 || acotado.avisos.length !== 40) {
  mal("resumenEjecucion recorta capturas/avisos: " + acotado.capturas.length + "/" + acotado.avisos.length);
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
if (consolaLarga.consola.length !== 200) mal("resumenEjecucion recorta la consola: " + consolaLarga.consola.length);

// El selector de tamaño no ejecuta la app: reescala el mismo modelo y conserva el original. La
// pantalla destino y todos los rect se ajustan por eje; el objeto de entrada no se muta.
const modeloBase = {
  pantalla: { x: 0, y: 0, ancho: 360, alto: 640 },
  raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 360, alto: 640 }, hijos: [
    { tipo: "Button", rect: { x: 18, y: 32, ancho: 324, alto: 48 } },
  ] },
};
const modelo411 = previaPanel.modeloConPantalla(modeloBase, 411, 823);
const cerca = (a, b) => Math.abs(a - b) < 0.001;
if (!modelo411 || modelo411.pantalla.ancho !== 411 || modelo411.pantalla.alto !== 823) {
  mal("modeloConPantalla no cambia la pantalla destino");
} else if (!cerca(modelo411.raiz.rect.ancho, 411) || !cerca(modelo411.raiz.rect.alto, 823) ||
    !cerca(modelo411.raiz.hijos[0].rect.x, 18 * 411 / 360) ||
    !cerca(modelo411.raiz.hijos[0].rect.alto, 48 * 823 / 640)) {
  mal("modeloConPantalla no reescala los rectángulos por eje: " + JSON.stringify(modelo411.raiz));
} else if (modeloBase.pantalla.ancho !== 360 || modeloBase.raiz.rect.ancho !== 360) {
  mal("modeloConPantalla muta el modelo original");
}
if (previaPanel.modeloConPantalla(modeloBase, 360, 640) !== modeloBase) {
  mal("modeloConPantalla clona sin cambiar cuando el tamaño ya es el del modelo");
}

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

// la lista de clics solo se borra ante una ejecución nueva: un repintado del mismo modelo que
// devolvió el clic (entrar en Pantalla, cambiar el tamaño) llega con `pulsando` en false y no puede
// tirar los clics ya entregados. Es la causa del contador que se quedaba en «Pulsos: 1».
const modeloDeUnClic = { ...modeloEmulador };
if (previaPanel.reiniciaPulsos({ pulsando: true, modelo: modeloDeUnClic, modeloDeClics: null })) {
  mal("reiniciaPulsos borra la lista mientras el clic está en vuelo");
}
if (previaPanel.reiniciaPulsos({ pulsando: false, modelo: modeloDeUnClic, modeloDeClics: modeloDeUnClic })) {
  mal("reiniciaPulsos borra la lista al repintar el modelo que devolvió el clic");
}
if (!previaPanel.reiniciaPulsos({ pulsando: false, modelo: { ...modeloEmulador }, modeloDeClics: modeloDeUnClic })) {
  mal("reiniciaPulsos no reinicia con un modelo distinto (build nuevo)");
}
if (!previaPanel.reiniciaPulsos({ pulsando: false, modelo: null, modeloDeClics: modeloDeUnClic })) {
  mal("reiniciaPulsos no reinicia cuando el aviso no trae modelo");
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
  ["previa-log-lista", "el registro del emulador"],
  ["previa-log-cabecera", "la cabecera del registro del emulador"],
  ["previa-log-vacio", "el mensaje de «sin ejecución» del registro del emulador"],
  ["previa-modo-editar", "el lápiz que entra y sale del modo editar"],
  ["previa-paleta", "la paleta de añadir elementos"],
  ["previa-anadir-textview", "el botón que añade un TextView"],
  ["previa-anadir-button", "el botón que añade un Button"],
  ["previa-anadir-imageview", "el botón que añade un ImageView"],
  ["previa-anadir-linearlayout", "el botón que añade un LinearLayout"],
  ["previa-anadir-framelayout", "el botón que añade un FrameLayout"],
  ["previa-anadir-edittext", "el botón que añade un EditText"],
  ["previa-anadir-imagebutton", "el botón que añade un ImageButton"],
  ["previa-anadir-checkbox", "el botón que añade un CheckBox"],
  ["previa-anadir-radiobutton", "el botón que añade un RadioButton"],
  ["previa-anadir-switch", "el botón que añade un Switch"],
  ["previa-anadir-progressbar", "el botón que añade un ProgressBar"],
  ["previa-anadir-seekbar", "el botón que añade un SeekBar"],
  ["previa-anadir-view", "el botón que añade un View"],
  ["previa-anadir-space", "el botón que añade un Space"],
  ["previa-anadir-relativelayout", "el botón que añade un RelativeLayout"],
  ["previa-anadir-scrollview", "el botón que añade un ScrollView"],
  ["previa-anadir-tablelayout", "el botón que añade un TableLayout"],
  ["previa-anadir-gridlayout", "el botón que añade un GridLayout"],
  ["previa-propiedades", "la ficha de propiedades del modo editar"],
  ["previa-propiedades-titulo", "el título de la ficha de propiedades"],
  ["previa-propiedades-campos", "los campos de la ficha de propiedades"],
  ["previa-propiedades-vacio", "el aviso de que no hay nada seleccionado"],
  ["previa-propiedades-plegar", "el botón que pliega la ficha de propiedades"],
  ["previa-propiedades-cerrar", "el botón que cierra la ficha de propiedades"],
  ["previa-propiedades-padre", "el botón que sube la selección al padre"],
  ["previa-propiedades-eliminar", "el botón de basura de la ficha"],
  ["previa-paleta-plegar", "el botón que pliega la paleta"],
  ["previa-paleta-scroll", "la lista con scroll de la paleta"],
  ["previa-editar-deshacer", "el botón que deshace el último cambio del diseño"],
  ["previa-editar-rehacer", "el botón que rehace el último cambio del diseño"],
  ["previa-editar-eliminar", "el botón de basura de la barra del modo editar"],
  ["previa-jerarquia-alternar", "el botón que abre y cierra la jerarquía"],
  ["previa-jerarquia", "la capa del visor de jerarquía"],
  ["previa-jerarquia-lista", "las filas del visor de jerarquía"],
  ["previa-jerarquia-cerrar", "el botón que cierra la jerarquía"],
  ["previa-destino-linea", "la línea de inserción del arrastre"],
  ["previa-destino-hueco", "el hueco discontinuo del arrastre"],
  ["previa-imagen-archivo", "el selector de fichero de imagen de la ficha"],
  ["previa-editar-estado", "la línea de estado del modo editar"],
  ["vista-modo-previa", "la pestaña Vista previa de la vista Pantalla"],
  ["vista-modo-emulador", "la pestaña Emulador de la vista Pantalla"],
  ["vista-layout", "el panel de Vista previa de la vista Pantalla"],
  ["vista-layout-canvas", "el canvas de Vista previa de la vista Pantalla"],
  ["vista-layout-estado", "la línea de estado de Vista previa en la vista Pantalla"],
  ["vista-emulador", "el panel del Emulador de la vista Pantalla"],
  ["vista-log-lista", "el registro del emulador en la vista Pantalla"],
  ["vista-log-cabecera", "la cabecera del registro del emulador en la vista Pantalla"],
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
  ["previa-seccion-pulsos", "la pestaña Pulsar del emulador"],
  ["previa-seccion-registro", "la pestaña Registro del emulador"],
  ["previa-seccion-consola", "la pestaña Consola de la app del emulador"],
  ["vista-seccion-pulsos", "la pestaña Pulsar del emulador en la vista Pantalla"],
  ["vista-seccion-registro", "la pestaña Registro del emulador en la vista Pantalla"],
  ["vista-seccion-consola", "la pestaña Consola de la app en la vista Pantalla"],
  ["vista-pulsos", "los controles de clic en la vista Pantalla"],
  ["vista-oyentes", "los botones de las vistas que responden a un clic en la vista Pantalla"],
  ["vista-pulsos-cuenta", "la cuenta de clics entregados en la vista Pantalla"],
  ["vista-pulsos-nota", "el aviso de que no hay vistas que pulsar en la vista Pantalla"],
  ["vista-consola", "la consola de la app en la vista Pantalla"],
  ["vista-consola-lista", "las líneas de la consola de la app en la vista Pantalla"],
  ["vista-consola-cabecera", "el resumen de la consola de la app en la vista Pantalla"],
  ["vista-consola-vacio", "el mensaje de «sin salida» en la vista Pantalla"],
  ["previa-pulsos-nota", "la nota de las vistas que responden a un clic"],
  ["previa-emulador-controles", "la barra de controles del emulador"],
  ["previa-energia", "el control de energía del emulador"],
  ["previa-reiniciar", "el botón de reiniciar el emulador"],
  ["previa-usar-ultima", "el botón de usar la última apk guardada"],
  ["previa-pantalla-tamano", "el selector de tamaño de pantalla del emulador"],
  ["previa-pantalla-personalizada", "los campos del tamaño personalizado del emulador"],
  ["previa-pantalla-ancho", "el ancho personalizado del emulador"],
  ["previa-pantalla-alto", "el alto personalizado del emulador"],
  ["previa-pantalla-completa", "el botón de pantalla completa del emulador"],
  ["previa-salir-completa", "el botón de salir de pantalla completa del emulador"],
  ["previa-inspector", "la capa flotante de registro y consola del panel"],
  ["previa-inspector-asidero", "el asa de arrastre del registro y consola del panel"],
  ["previa-inspector-minimizar", "el botón que minimiza y restaura el registro y consola del panel"],
  ["previa-inspector-acoplar-izquierda", "el botón que acopla el panel al borde izquierdo"],
  ["previa-inspector-acoplar-derecha", "el botón que acopla el panel al borde derecho"],
  ["previa-inspector-cerrar", "el botón que cierra el registro y la consola del panel"],
  ["previa-inspector-abrir", "el botón que abre el registro y la consola del panel"],
  ["previa-detalle-modelo", "el detalle del modelo en la capa flotante del panel"],
  ["vista-cuerpo", "la superficie del emulador de la vista Pantalla"],
  ["vista-emulador-controles", "la barra de controles del emulador en Pantalla"],
  ["vista-energia", "el control de energía del emulador en Pantalla"],
  ["vista-reiniciar", "el botón de reiniciar el emulador en Pantalla"],
  ["vista-usar-ultima", "el botón de usar la última apk guardada en Pantalla"],
  ["vista-pantalla-tamano", "el selector de tamaño de pantalla en Pantalla"],
  ["vista-pantalla-personalizada", "los campos del tamaño personalizado en Pantalla"],
  ["vista-pantalla-ancho", "el ancho personalizado en Pantalla"],
  ["vista-pantalla-alto", "el alto personalizado en Pantalla"],
  ["vista-pantalla-completa", "el botón de pantalla completa en Pantalla"],
  ["vista-salir-completa", "el botón de salir de pantalla completa en Pantalla"],
  ["vista-inspector-cerrar", "el botón que cierra el registro y la consola en Pantalla"],
  ["vista-inspector-abrir", "el botón que abre el registro y la consola en Pantalla"],
  ["vista-lado-detalle", "el detalle del modelo en la consola flotante de Pantalla"],
  ["vista-lado-asidero", "el asa de arrastre de la consola flotante de Pantalla"],
  ["vista-lado-minimizar", "el botón que minimiza y restaura la consola de Pantalla"],
  ["vista-lado-acoplar-izquierda", "el botón que acopla la consola al borde izquierdo"],
  ["vista-lado-acoplar-derecha", "el botón que acopla la consola al borde derecho"],
]) {
  if (!ids.has(id)) mal(`${donde} (${id}) no está en index.html`);
}

// Las secciones del emulador son contrato: tres pestañas por superficie, cada una apuntando a su
// panel con aria-controls, y exactamente una activa. Así alternar no esconde contenido perdido: los
// tres paneles siguen en el DOM y solo cambia `hidden`.
for (const [nombre, botones, paneles] of [
  ["panel", ["previa-seccion-pulsos", "previa-seccion-registro", "previa-seccion-consola"],
    { pulsos: "previa-pulsos", registro: "previa-log", consola: "previa-consola" }],
  ["Pantalla", ["vista-seccion-pulsos", "vista-seccion-registro", "vista-seccion-consola"],
    { pulsos: "vista-pulsos", registro: "vista-log", consola: "vista-consola" }],
]) {
  let activos = 0;
  for (const id of botones) {
    const etiqueta = new RegExp(`<button id="${id}"[^>]*>`).exec(html);
    if (!etiqueta) { mal(`la pestaña ${id} de las secciones del emulador no está en index.html`); continue; }
    const control = /aria-controls="([^"]+)"/.exec(etiqueta[0]);
    if (!control) { mal(`la pestaña ${id} no declara aria-controls`); continue; }
    if (!ids.has(control[1])) mal(`la pestaña ${id} apunta a ${control[1]}, que no existe`);
    if (!/role="tab"/.test(etiqueta[0])) mal(`la pestaña ${id} no declara role="tab"`);
    if (/aria-selected="true"/.test(etiqueta[0])) activos++;
  }
  if (activos !== 1) mal(`las secciones del emulador (${nombre}) tienen ${activos} pestañas activas y debe haber una`);
  for (const [clave, idPanel] of Object.entries(paneles)) {
    const etiqueta = new RegExp(`<(section|div) id="${idPanel}"[^>]*>`).exec(html);
    if (!etiqueta) { mal(`el panel ${idPanel} de las secciones del emulador no está en index.html`); continue; }
    if (!new RegExp(`data-seccion="${clave}"`).test(etiqueta[0])) {
      mal(`el panel ${idPanel} no declara data-seccion="${clave}"`);
    }
    const oculto = /hidden/.test(etiqueta[0]);
    if (clave !== "pulsos" && !oculto) mal(`el panel ${idPanel} no empieza oculto`);
    if (clave === "pulsos" && oculto) mal(`el panel ${idPanel} es la sección por defecto y empieza oculto`);
    if (!/previa-seccion/.test(etiqueta[0])) mal(`el panel ${idPanel} no lleva la clase previa-seccion`);
  }
}
if (!/id="previa-modo-editar"[^>]*aria-label="Editar layout"/.test(html)) {
  mal("el lápiz del modo editar no se llama «Editar layout»");
}
if (!/id="previa-modo-editar"[^>]*aria-pressed="false"/.test(html)) {
  mal("el lápiz del modo editar no declara aria-pressed");
}
if (!/id="previa-paleta"[^>]*hidden/.test(html)) {
  mal("la paleta de añadir empieza visible: solo debe verse en modo editar");
}
for (const tipo of ["TextView", "Button", "ImageView", "LinearLayout", "FrameLayout", "EditText",
  "ImageButton", "CheckBox", "RadioButton", "Switch", "ProgressBar", "SeekBar", "View", "Space",
  "RelativeLayout", "ScrollView", "TableLayout", "GridLayout"]) {
  if (!new RegExp('data-tipo="' + tipo + '"').test(html)) mal("la paleta no ofrece " + tipo);
  // cada botón se anuncia con su nombre y se alcanza con Tab: no basta el `title`
  if (!new RegExp('<button[^>]*data-tipo="' + tipo + '"[^>]*aria-label=').test(html)) {
    mal("el botón de la paleta de " + tipo + " no tiene aria-label");
  }
}
// La paleta se agrupa por categorías y el orden del HTML es el de la herramienta: una lista
// corrida de 18 tipos no se recorre. Cada tipo aparece una vez y el grupo tiene su encabezado.
const gruposDePaleta = layoutEditor.gruposPaleta();
const tiposAgrupados = gruposDePaleta.flatMap((g) => g.tipos);
const tiposDeLaPaleta = layoutEditor.tiposDisponibles();
if (gruposDePaleta.length !== 7) mal("la paleta no tiene siete categorías: " + gruposDePaleta.length);
for (const grupo of gruposDePaleta) {
  if (!grupo.tipos.length) mal("la categoría " + grupo.titulo + " está vacía");
  if (!new RegExp('<span class="previa-paleta-categoria">' + grupo.titulo + "</span>").test(html)) {
    mal("index.html no pinta la categoría " + grupo.titulo);
  }
}
if (tiposAgrupados.length !== tiposDeLaPaleta.length) {
  mal("la paleta agrupada no cubre los tipos: " + tiposAgrupados.length + " de " + tiposDeLaPaleta.length);
}
if (new Set(tiposAgrupados).size !== tiposAgrupados.length) mal("la paleta repite un tipo");
for (const tipo of tiposDeLaPaleta) {
  if (!tiposAgrupados.includes(tipo)) mal("la paleta no agrupa " + tipo);
}
const tiposEnElHtml = [...html.matchAll(/data-tipo="([^"]+)"/g)].map((m) => m[1]);
if (tiposEnElHtml.join(",") !== tiposAgrupados.join(",")) {
  mal("el orden de la paleta del HTML no es el de layout-editor.js: " + tiposEnElHtml.join(","));
}
if (!/id="previa-paleta-scroll"[^>]*aria-label=/.test(html)) {
  mal("la lista de la paleta no se anuncia para lectores de pantalla");
}
// la raíz se selecciona con un clic en el hueco del dibujo, no con un botón
if (ids.has("previa-seleccionar-raiz")) {
  mal("el botón «Layout raíz» sigue en index.html: la raíz se selecciona con el clic en el hueco");
}
// las capas del modo editar: acciones, visor de jerarquía, indicador de destino y selector de imagen
for (const [id, donde] of [
  ["previa-editar-deshacer", "el botón de deshacer del diseñador"],
  ["previa-editar-rehacer", "el botón de rehacer del diseñador"],
  ["previa-editar-eliminar", "la basura de la barra del modo editar"],
  ["previa-propiedades-eliminar", "la basura de la ficha"],
  ["previa-propiedades-padre", "el botón «↑ Padre» de la ficha"],
  ["previa-jerarquia-alternar", "el interruptor del visor de jerarquía"],
  ["previa-jerarquia", "la capa del visor de jerarquía"],
  ["previa-jerarquia-lista", "la lista del visor de jerarquía"],
  ["previa-jerarquia-cerrar", "el botón que cierra la jerarquía"],
  ["previa-destino-linea", "la línea de destino del arrastre"],
  ["previa-destino-hueco", "el hueco de destino del arrastre"],
  ["previa-imagen-archivo", "el selector de fichero de imagen"],
]) {
  if (!ids.has(id)) mal(`falta ${donde} (${id}) en index.html`);
}
if (!/id="previa-editar-eliminar"[^>]*aria-label="Eliminar elemento"/.test(html)) {
  mal("la basura del modo editar no se llama «Eliminar elemento»");
}
if (!/id="previa-propiedades-eliminar"[^>]*aria-label="Eliminar elemento"/.test(html)) {
  mal("la basura de la ficha no se llama «Eliminar elemento»");
}
if (!/id="previa-jerarquia"[^>]*hidden/.test(html)) {
  mal("el visor de jerarquía no empieza cerrado");
}
if (!/id="previa-destino-linea"[^>]*hidden/.test(html) ||
    !/id="previa-destino-hueco"[^>]*hidden/.test(html)) {
  mal("los indicadores de destino no empiezan ocultos");
}
if (!/id="previa-imagen-archivo"[^>]*accept="image\/\*"/.test(html)) {
  mal("el selector de imagen no acepta image/*");
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
// el nombre viejo tampoco vale en un `aria-label`: el mismo control —el canvas del emulador— decía
// «Vista previa aproximada…» en el panel y «Emulador: …» en Pantalla. Las dos superficies se
// anuncian igual, y el modo Vista previa no se cuela en el canvas que ejecuta la app.
if (/aria-label="Vista previa[^"]*pantalla del apk/.test(html)) {
  mal("el canvas del emulador conserva «Vista previa» en su aria-label");
}
const canvasEmulador = [...html.matchAll(/<canvas id="(previa-lateral-canvas|vista-previa)"[^>]*aria-label="([^"]*)"/g)];
if (canvasEmulador.length !== 2) mal("los dos canvas del emulador no declaran aria-label");
for (const [, idCanvas, rotulo] of canvasEmulador) {
  if (!/^Emulador: /.test(rotulo)) mal("el canvas " + idCanvas + " no se anuncia como «Emulador: …»: " + rotulo);
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
// La firma automática del modo intercambio se deriva del .java activo sin tocar el DOM.
const firmaAuto = pestanaMod.firmaPorDefectoDe(
  "package com.hola.apkcstudio;\npublic class MainActivity extends Activity {}\n",
  "/proyecto/src/com/hola/apkcstudio/MainActivity.java");
if (firmaAuto !== "Lcom/hola/apkcstudio/MainActivity;") {
  mal("la firma automática no deriva la clase del .java activo: " + firmaAuto);
}
if (pestanaMod.firmaPorDefectoDe("class SinPaquete {}", "/proyecto/src/SinPaquete.java") !==
    "LSinPaquete;") {
  mal("la firma automática no admite el paquete por defecto");
}
if (pestanaMod.firmaPorDefectoDe("", "/proyecto/res/layout/main.xml") !== "") {
  mal("la firma automática inventa una clase donde no hay fuente Java");
}

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

// el guardado del manifiesto tiene un veto: pasa lo que deja `<manifest>` por raíz después de los
// prólogos que apkc traga (BOM, espacios, declaración XML, comentarios y DOCTYPE), y no pasa el
// XML de un layout ni otro elemento raíz. El XML de un layout no puede guardarse en esa pestaña.
if (!pestanaMod.pareceManifiesto('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="x"/>'))
  mal("pareceManifiesto rechaza un manifiesto sin declaración");
if (!pestanaMod.pareceManifiesto('<?xml version="1.0" encoding="utf-8"?>\n<manifest package="x">\n</manifest>\n'))
  mal("pareceManifiesto rechaza un manifiesto con declaración XML");
if (!pestanaMod.pareceManifiesto('\uFEFF  \n<?xml version="1.0"?><manifest package="x"/>'))
  mal("pareceManifiesto rechaza un manifiesto con BOM y espacios delante");
// los prólogos que el parser de apkc se salta no pueden hacer que el veto sea más estricto
if (!pestanaMod.pareceManifiesto('<!--x--><manifest package="x"/>'))
  mal("pareceManifiesto rechaza un comentario delante de manifest");
if (!pestanaMod.pareceManifiesto('<?xml version="1.0"?><!--c--><manifest/>'))
  mal("pareceManifiesto rechaza declaración y comentario delante de manifest");
if (!pestanaMod.pareceManifiesto('<!DOCTYPE manifest><manifest/>'))
  mal("pareceManifiesto rechaza un DOCTYPE delante de manifest");
if (!pestanaMod.pareceManifiesto('<!DOCTYPE manifest [ <!ENTITY x "y"> ]>\n<!--a\nb--><manifest\n package="x"/>'))
  mal("pareceManifiesto rechaza DOCTYPE con subconjunto interno y comentario multilínea");
if (!pestanaMod.pareceManifiesto('<!doctype manifest><manifest/>'))
  mal("pareceManifiesto rechaza un doctype en minúsculas");
if (!pestanaMod.pareceManifiesto('<!DOCTYPE manifest SYSTEM "a>b"><manifest/>'))
  mal("pareceManifiesto rechaza un DOCTYPE con > dentro de las comillas");
if (!pestanaMod.pareceManifiesto("<!DOCTYPE manifest PUBLIC 'a>b' [ <!ENTITY x \"y>z\"> ]><manifest/>"))
  mal("pareceManifiesto rechaza un DOCTYPE con comillas simples y dobles antes del manifiesto");
if (!pestanaMod.pareceManifiesto('<manifest\n xmlns:android="http://schemas.android.com/apk/res/android">'))
  mal("pareceManifiesto rechaza manifest con salto de línea");
if (pestanaMod.pareceManifiesto('<?xml version="1.0" encoding="utf-8"?>\n<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" />'))
  mal("pareceManifiesto acepta el XML de un layout");
if (pestanaMod.pareceManifiesto('<LinearLayout manifest="x"/>') ||
    pestanaMod.pareceManifiesto('<manifestacion/>') || pestanaMod.pareceManifiesto('<android:manifest/>'))
  mal("pareceManifiesto acepta otro elemento que empieza por manifest");
if (pestanaMod.pareceManifiesto("") || pestanaMod.pareceManifiesto("package x;"))
  mal("pareceManifiesto acepta un contenido vacío o Java");

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
//
// `zipBomba` fabrica el zip que miente: el directorio central declara `declarado` bytes para una
// entrada cuyo flujo deflate expande `megas` MiB. Se comprime en streaming para no materializar el
// origen aquí. Vive en el módulo porque lo usan el lote de los zips y el del autocompletado.
async function zipBomba(megas, ruta, declarado) {
  const cero = new Uint8Array(1 << 20);
  const origen = new ReadableStream({
    start(c) { for (let i = 0; i < megas; i++) c.enqueue(cero); c.close(); },
  });
  const comprimido = new Uint8Array(await new Response(
    origen.pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const nombre = Buffer.from(ruta);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(a.crc32(cero), 14);
  local.writeUInt32LE(comprimido.length, 18); local.writeUInt32LE(declarado, 22);
  local.writeUInt16LE(nombre.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(a.crc32(cero), 16); central.writeUInt32LE(comprimido.length, 20);
  central.writeUInt32LE(declarado, 24); central.writeUInt16LE(nombre.length, 28);
  central.writeUInt32LE(0, 42);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(1, 8); fin.writeUInt16LE(1, 10);
  fin.writeUInt32LE(46 + nombre.length, 12); fin.writeUInt32LE(30 + nombre.length + comprimido.length, 16);
  return new Uint8Array(Buffer.concat([local, nombre, comprimido, central, nombre, fin]));
}

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

  // «Download ZIP» de GitHub: todo dentro de una carpeta raíz. El import recorta ese prefijo, y
  // solo si es único y lleva el manifiesto dentro; con dos raíces o un fichero suelto no adivina.
  const zipGithub = zipDelArbol([
    ["ApkShare-main/", new Uint8Array(0)],
    ["ApkShare-main/AndroidManifest.xml", '<manifest package="com.apkshare"/>'],
    ["ApkShare-main/res/values/strings.xml", "<resources/>"],
    ["ApkShare-main/src/Main.java", "class Main {}\n"],
  ]);
  const github = normalizarEntradas(await leerZip(zipGithub));
  const githubManifiesto = github.find((e) => e.ruta === "AndroidManifest.xml" && !e.dir);
  const githubJava = github.find((e) => e.ruta === "src/Main.java");
  if (!githubManifiesto || !githubJava || github.some((e) => e.ruta.startsWith("ApkShare-main"))) {
    mal("normalizarEntradas no recorta la carpeta raíz del zip de GitHub");
  }
  if (github.some((e) => e.ruta === "")) mal("normalizarEntradas deja la entrada del directorio raíz");
  if (githubManifiesto && new TextDecoder().decode(githubManifiesto.datos) !== '<manifest package="com.apkshare"/>') {
    mal("normalizarEntradas altera los datos del manifiesto");
  }
  if (githubJava && githubJava.dir !== false) mal("normalizarEntradas cambia el tipo de una entrada");
  if (normalizarEntradas(vuelta) !== vuelta) mal("normalizarEntradas toca un zip que ya está normalizado");
  const dosRaices = [
    { ruta: "A/AndroidManifest.xml", dir: false, datos: new Uint8Array([1]) },
    { ruta: "B/AndroidManifest.xml", dir: false, datos: new Uint8Array([2]) },
  ];
  const suelto = [
    { ruta: "A/AndroidManifest.xml", dir: false, datos: new Uint8Array([1]) },
    { ruta: "LEEME.txt", dir: false, datos: new Uint8Array([2]) },
  ];
  for (const [nombreCaso, entradasCaso] of [["dos raíces", dosRaices], ["fichero suelto", suelto]]) {
    let motivo = "";
    try { normalizarEntradas(entradasCaso); } catch (e) { motivo = String(e && e.message ? e.message : e); }
    if (!/AndroidManifest\.xml en la raíz/.test(motivo)) {
      mal("normalizarEntradas no explica el rechazo con " + nombreCaso + ": " + motivo);
    }
  }
  let raizSinManifiesto = "";
  try { normalizarEntradas([{ ruta: "ApkShare-main/LEEME.txt", dir: false, datos: new Uint8Array([1]) }]); }
  catch (e) { raizSinManifiesto = String(e && e.message ? e.message : e); }
  if (!/no trae AndroidManifest\.xml/.test(raizSinManifiesto)) {
    mal("normalizarEntradas acepta una carpeta raíz sin manifiesto: " + raizSinManifiesto);
  }

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

  // B5: el tamaño declarado es una promesa del fichero, no un hecho. La auditoría infló 1024 B
  // declarados a 200 MiB; aquí el zip se fabrica con un central directory que dice poco y un flujo
  // deflate que expande mucho. Sin el tope por bytes producidos, la entrada termina en «no cuadra»
  // después de materializar los 200 MiB.
  const antesBomba = process.memoryUsage().rss;
  let rechazoBomba = "";
  try { await leerZip(await zipBomba(200, "res/bomba.bin", 1024)); }
  catch (e) { rechazoBomba = String(e && e.message ? e.message : e); }
  const rssBomba = (process.memoryUsage().rss - antesBomba) / (1024 * 1024);
  if (!/demasiado grande/.test(rechazoBomba)) {
    mal("leerZip no corta por los bytes producidos: " + (rechazoBomba || "la entrada pasó entera") +
      "; pasaron " + Math.round(rssBomba) + " MB de RSS");
  }
  // el tope es 64 MiB: cortar en el flujo no puede engordar el proceso como los 653 MB del informe
  if (rssBomba > 200) {
    mal("leerZip se pasó de memoria con 1024 B declarados: " + Math.round(rssBomba) + " MB de RSS");
  }

  // el mismo agujero estaba en el jar anidado del paquete de la plataforma: se corta igual
  let rechazoJarBomba = "";
  try { await pestanaMod.jarDeSeleccion(await zipBomba(160, "android-34/android.jar", 1024)); }
  catch (e) { rechazoJarBomba = String(e && e.message ? e.message : e); }
  if (!/demasiado grande/.test(rechazoJarBomba)) {
    mal("jarDeSeleccion no corta por los bytes producidos: " + (rechazoJarBomba || "la entrada pasó entera"));
  }

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
  // una contraseña que empieza por guion también es una contraseña (y viaja a `ULTIMO.argv`)
  const raro = pestanaMod.redactarArgv(["--storepass", "-clave-rara"]);
  if (raro[1] !== "***") mal("redactarArgv deja una contraseña que empieza por -");


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

    // D6: el receptor `v.` no se adivina, se resuelve por la declaración del buffer. Sin
    // declaración no hay lista (mejor nada que los métodos de otra clase).
    const tipo = (texto, nombre) => autocompletado.tipoDeVariable(texto, nombre, texto.length);
    const tiposVistos = [
      ["TextView v = null;", "v", "TextView"],
      ["private final Button boton;", "boton", "Button"],
      ["void f(EditText campo, int n) {", "campo", "EditText"],
      ["for (String s : lista) {", "s", "String"],
      ["android.widget.TextView vista;", "vista", "TextView"],
      ["Map<String, TextView> mapa;", "mapa", "Map"],
      ["TextView[] filas;", "filas", "TextView"],
      ["catch (IOException e) {", "e", "IOException"],
    ];
    for (const [texto, nombre, esperado] of tiposVistos) {
      if (tipo(texto, nombre) !== esperado) {
        mal(`tipoDeVariable no resuelve ${nombre} en ${JSON.stringify(texto)}: ${tipo(texto, nombre)}`);
      }
    }
    if (tipo("TextView v = null;", "otra")) mal("tipoDeVariable inventa un tipo para una variable que no está");

    const contextoVariable = (texto) => autocompletado.contextoDeCompletado(texto, texto.length);
    const receptores = [
      ["TextView v = null;\nv.", "TextView", "v"],
      ["private Button boton;\nvoid f() { boton.", "Button", "boton"],
      ["void f(EditText campo) {\n campo.", "EditText", "campo"],
      ["android.widget.Toast aviso;\nthis.aviso.", "Toast", "aviso"],
    ];
    for (const [texto, clase, variable] of receptores) {
      const ctx = contextoVariable(texto);
      if (!ctx || ctx.modo !== "metodos" || ctx.clase !== clase || ctx.variable !== variable) {
        mal(`el completado tras ${variable}. no resuelve ${clase}: ${JSON.stringify(ctx)}`);
      }
    }
    if (contextoVariable("desconocida.")) {
      mal("el completado tras una variable sin declaración ofrece una lista inventada");
    }

    // los bloques `/* … */` de varias líneas ya no dejan la lista abierta dentro (frontera de D3)
    const dentroDeBloque = [
      ["/* R.layout.\n   sigue el comentario */", "un bloque de varias líneas"],
      ["/*\n * R.layout.\n */", "un bloque con asteriscos"],
      ['String s = """\nR.layout.', "un bloque de texto"],
    ];
    for (const [texto, que] of dentroDeBloque) {
      const corte = que === "un bloque de texto" ? texto.length : texto.lastIndexOf("*/");
      const ctx = autocompletado.contextoDeCompletado(texto, corte);
      if (ctx) mal(`contextoDeCompletado sugiere dentro de ${que}: ${JSON.stringify(ctx)}`);
    }
    const despuesDeBloque = "Texto v = null;\n/* una línea */\nv.";
    const ctxBloque = contextoVariable(despuesDeBloque);
    if (!ctxBloque || ctxBloque.modo !== "metodos") {
      mal(`contextoDeCompletado no vuelve tras un bloque cerrado: ${JSON.stringify(ctxBloque)}`);
    }
    if (!contextoVariable("char c = '/'; R.layout.")) {
      mal("un carácter con barra no corta el completado de R.layout.");
    }
    if (contextoVariable('String s = "\\"R.layout.')) {
      mal("una cadena abierta con comilla escapada no corta el completado");
    }

    // la matriz Java: los cuatro modos se alcanzan desde el texto que se teclea de verdad
    const matrizJava = [
      ["R.", "tipos"], ["R.lay", "tipos"], ["R.layout.ma", "valores"], ["R.id.", "valores"],
      ["android.R.layout.", "valores"], ["Toast.", "metodos"], ["TextView v = null;\nv.", "metodos"],
      ["MainAct", "clases"],
    ];
    const modosVistos = new Set();
    for (const [texto, modo] of matrizJava) {
      const ctx = contextoVariable(texto);
      if (!ctx || ctx.modo !== modo) mal(`matriz Java: ${JSON.stringify(texto)} no da ${modo}: ${JSON.stringify(ctx)}`);
      else modosVistos.add(ctx.modo);
    }
    if (modosVistos.size !== 4) mal(`matriz Java: faltan modos, vistos ${[...modosVistos].join(", ")}`);

    // tipos del proyecto: se leen del árbol y del buffer, sin abrir ni parsear los `.java`
    const declaradas = autocompletado.clasesDeclaradas(
      "public class MainActivity extends Activity {}\ninterface Lista {}\nenum Modo { A, B }");
    if (!["MainActivity", "Lista", "Modo"].every((c) => declaradas.includes(c))) {
      mal(`clasesDeclaradas pierde tipos del buffer: ${JSON.stringify(declaradas)}`);
    }
    const delProyecto = autocompletado.clasesDeRutas([
      "/proyecto/src/com/x/MainActivity.java",
      "/proyecto/src/com/x/Util.java",
      "/proyecto/src/com/x/R.java",
      "/proyecto/src/com/x/utilidad.txt",
    ]);
    if (!delProyecto.includes("MainActivity") || !delProyecto.includes("Util") ||
        delProyecto.includes("R") || delProyecto.includes("utilidad")) {
      mal(`clasesDeRutas no separa tipos de proyecto: ${JSON.stringify(delProyecto)}`);
    }

    // los dos contextos se eligen por extensión y no se cruzan: `.xml` es la rama de
    // `contextoXml` y `.java` la de `contextoDeCompletado`
    if (!autocompletado.esRutaXml("/proyecto/res/layout/main.xml") ||
        !autocompletado.esRutaXml("/proyecto/AndroidManifest.XML") ||
        autocompletado.esRutaXml("/proyecto/src/MainActivity.java") ||
        autocompletado.esRutaXml("")) {
      mal("esRutaXml no separa los dos contextos");
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

    // D6: la matriz XML. Cada etiqueta, atributo y valor del catálogo tiene que ofrecerse en su
    // modo y en el grupo de fichero que le toca, y ninguno puede colarse en el catálogo del otro
    // lenguaje ni el de otro grupo.
    const pedir = (ctx, datos) => xmlEditor.sugerenciasXml(ctx, datos);
    const textos = (r) => new Set((r.lista || []).map((i) => i.texto));
    const inserts = (r) => new Set((r.lista || []).map((i) => i.insertar));

    const grupos = [
      ["/proyecto/res/layout/main.xml", xmlEditor.ETIQUETAS_VISTA],
      ["/proyecto/res/values/strings.xml", xmlEditor.ETIQUETAS_VALORES],
      ["/proyecto/AndroidManifest.xml", xmlEditor.ETIQUETAS_MANIFIESTO],
    ];
    for (const [archivo, catalogo] of grupos) {
      const r = pedir({ modo: "etiqueta", prefijo: "", desde: 0, hasta: 0 }, { ruta: archivo });
      if (!/^xml ·/.test(r.estado)) mal(`la matriz XML no marca el origen xml en ${archivo}: ${r.estado}`);
      for (const etiqueta of catalogo) {
        if (!textos(r).has(etiqueta)) mal(`la matriz XML pierde la etiqueta <${etiqueta}> de ${archivo}`);
      }
      if (r.lista.some((i) => /^(?:android|tools):/.test(i.texto) || i.texto === "R.")) {
        mal(`la matriz XML cruza atributos o Java en las etiquetas de ${archivo}`);
      }
    }

    const atributosLayout = pedir({ modo: "atributo", prefijo: "", desde: 0, hasta: 0 }, { ruta });
    for (const a of xmlEditor.ATRIBUTOS_ANDROID) {
      if (!inserts(atributosLayout).has("android:" + a)) mal(`falta android:${a} en la lista de atributos`);
    }
    for (const a of xmlEditor.ATRIBUTOS_TOOLS) {
      if (!inserts(atributosLayout).has("tools:" + a)) mal(`falta tools:${a} en la lista de atributos`);
    }
    if (textos(atributosLayout).has("LinearLayout")) mal("la lista de atributos cruza una etiqueta del layout");
    const atributosValores = pedir({ modo: "atributo", prefijo: "", desde: 0, hasta: 0 },
      { ruta: "/proyecto/res/values/strings.xml" });
    for (const a of xmlEditor.ATRIBUTOS_SIN_PREFIJO) {
      if (!inserts(atributosValores).has(a)) mal(`falta ${a} en los atributos sin prefijo de values`);
    }
    if ([...inserts(atributosValores)].some((t) => t.startsWith("android:"))) {
      mal("un res/values ofrece android: como atributo (no se escribe así en values)");
    }

    for (const [atributo, valores] of Object.entries(xmlEditor.VALORES)) {
      const r = pedir({ modo: "valor", atributo, prefijo: "", desde: 0, hasta: 0 }, { ruta, recursos: {} });
      for (const valor of valores) {
        if (!textos(r).has(valor)) mal(`el valor ${valor} de ${atributo} no se ofrece`);
      }
    }
    for (const [atributo, tipos] of Object.entries(xmlEditor.TIPOS_POR_ATRIBUTO)) {
      const recursos = {};
      for (const t of tipos) recursos[t] = new Set(["recurso"]);
      const r = pedir({ modo: "valor", atributo, prefijo: "", desde: 0, hasta: 0 }, { ruta, recursos });
      for (const t of tipos) {
        if (!inserts(r).has("@" + t + "/recurso")) {
          mal(`el atributo ${atributo} no ofrece @${t}/recurso`);
        }
      }
    }
    for (const atributo of xmlEditor.ATRIBUTOS_COLOR) {
      const r = pedir({ modo: "valor", atributo, prefijo: "", desde: 0, hasta: 0 },
        { ruta, recursos: { color: new Set(["rojo"]) } });
      if (!inserts(r).has("@color/rojo")) mal(`el atributo de color ${atributo} no ofrece @color/rojo`);
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

    // comprensión: el mensaje nombra lo que no se resolvió (el atributo, la referencia, la
    // etiqueta) y no repite `archivo:línea:columna`, que ya viaja en `posicion`.
    for (const e of errores) {
      if (!e.mensaje || !/^[^\s]/.test(e.mensaje)) mal(`un error del linter no dice qué pasa: ${JSON.stringify(e)}`);
      if (/\b\d+:\d+/.test(e.mensaje)) mal(`el mensaje repite la posición: ${e.mensaje}`);
    }
    if (!errores.some((e) => e.mensaje.includes("layout_widht"))) {
      mal("el aviso de errata no nombra el atributo que no existe");
    }
    if (!errores.some((e) => e.mensaje.includes("@string/noexiste"))) {
      mal("el aviso de recurso no nombra la referencia que no existe");
    }
    // un `<` sin nombre no se queda en «error»: dice qué falta
    const sinNombre = xmlEditor.diagnosticarXml("<>", { archivo: ruta, recursos });
    if (!sinNombre.length || !/nombre válido|vacía/.test(sinNombre[0].mensaje) || sinNombre[0].origen !== "XML") {
      mal(`el linter no explica una etiqueta sin nombre: ${JSON.stringify(sinNombre)}`);
    }
  }

  // 11c. overhead del autocompletado: el índice del jar se reutiliza, los métodos se cachean por
  // clase y el popup no puede lanzar `apkc check` ni recorrer OPFS por tecla. Se comprueba en la
  // fuente porque estos módulos necesitan DOM; la medición de tiempo es de las funciones puras.
  {
    const fuenteAuto = fs.readFileSync(path.join(__dirname, "autocompletado.js"), "utf8");
    const fuenteRecursos = fs.readFileSync(path.join(__dirname, "recursos-proyecto.js"), "utf8");
    if (!/if \(jar\) return jar;/.test(fuenteAuto)) mal("el índice del jar no se reutiliza entre pulsaciones");
    if (!/if \(metodosVistos\.has\(entrada\.local\)\) return/.test(fuenteAuto)) {
      mal("los métodos de una clase se vuelven a leer en cada pulsación");
    }
    if (/hospedador\.ejecutar|["']check["']/.test(fuenteAuto)) {
      mal("el autocompletado lanza apkc check: el popup no puede reparar nada");
    }
    if (!/medida: \(\) =>/.test(fuenteAuto)) {
      mal("el autocompletado no expone las lecturas para poder medir el overhead");
    }
    if (!/if \(listoRecursos\) return cache/.test(fuenteRecursos)) {
      mal("el barrido de recursos no se cachea: se recorrería OPFS por tecla");
    }
    if (!/if \(listoClases\) return cacheClases/.test(fuenteRecursos)) {
      mal("la lista de clases del proyecto no se cachea");
    }
    if (!/apkc:proyecto-cambio/.test(fuenteRecursos)) {
      mal("la caché de recursos no se invalida con los cambios del proyecto");
    }
    const fuentePestana = fs.readFileSync(path.join(__dirname, "pestana.js"), "utf8");
    if (!/CustomEvent\("apkc:proyecto-cambio"/.test(fuentePestana) ||
        !/function publicar\(mensaje\) \{\s*avisarCambioDeProyecto/.test(fuentePestana)) {
      mal("el guardado/creación no avisa a la caché de recursos");
    }
    // el linter de XML es local: ni `apkc check` ni temporal
    const fuenteXml = fs.readFileSync(path.join(__dirname, "xml-editor.js"), "utf8");
    if (/hospedador|\.apkc-check\.java|ejecutar/.test(fuenteXml)) {
      mal("el linter de XML toca el hospedador o `apkc check`");
    }
    if (!/origen: "XML"/.test(fuenteXml)) mal("el linter de XML no etiqueta sus avisos como XML");
    // el diagnóstico Java compone `archivo:línea[:columna]` si `apkc` no manda `posicion`; el
    // mensaje no repite esa posición
    const fuenteVivo = fs.readFileSync(path.join(__dirname, "diagnostico-vivo.js"), "utf8");
    if (!/e\.posicion \|\|/.test(fuenteVivo)) {
      mal("una fila de Java sin `posicion` se queda sin decir dónde");
    }

    // coste de las funciones puras que corren por pulsación (no es un umbral de producto: es la
    // cifra que se registra en la salida para comparar con la de la pestaña)
    const textoJava = "public class MainActivity extends Activity {\n" +
      "  private TextView titulo;\n  void f(Button b) { titulo.setText(\"hola\"); b. }\n}\n";
    const t0 = Date.now();
    const cursorJava = textoJava.indexOf("b. }") + 2;
    let contextos = 0;
    for (let i = 0; i < 20000; i++) {
      if (autocompletado.contextoDeCompletado(textoJava, cursorJava)) contextos++;
    }
    const msJava = Date.now() - t0;
    const textoXml = "<LinearLayout xmlns:android=\"http://schemas.android.com/apk/res/android\">\n" +
      "  <TextView android:text=\"@string/ap\" />\n</LinearLayout>";
    const t1 = Date.now();
    let xml = 0;
    for (let i = 0; i < 20000; i++) {
      if (xmlEditor.contextoXml(textoXml, textoXml.indexOf("@string/ap") + 10)) xml++;
    }
    const msXml = Date.now() - t1;
    console.log(`  (medida: 20000 contextos Java en ${msJava} ms y 20000 de XML en ${msXml} ms; ` +
      `${contextos + xml} con resultado)`);
    if (msJava > 3000 || msXml > 3000) mal(`el contexto por pulsación es demasiado caro: ${msJava} ms Java, ${msXml} ms XML`);
  }

  // 11c-bis. el diagnóstico en vivo no repite un check que no puede cambiar de resultado y no
  // cancela uno obsoleto porque la medición en la pestaña no lo justifica (sonda-check.js). Se
  // comprueba en la fuente de los dos módulos, que necesitan DOM y worker para correr.
  {
    const fuenteVivo = fs.readFileSync(path.join(__dirname, "diagnostico-vivo.js"), "utf8");
    if (!/function mismaEstructura/.test(fuenteVivo)) {
      mal("el diagnóstico no tiene la regla que evita un check cuando solo cambian espacios");
    }
    if (!/ultimaLimpia\.api === clave\.api/.test(fuenteVivo) ||
        !/ultimaLimpia\.codename === clave\.codename/.test(fuenteVivo) ||
        !/ultimaLimpia\.jar === clave\.jar/.test(fuenteVivo)) {
      mal("la clave de la pasada limpia no incluye la API, el codename y el jar");
    }
    if (!/estado\.textContent = ultimaLimpia\.estado;/.test(fuenteVivo)) {
      mal("saltar una pasada no restaura el resumen: el estado se quedaría en «comprobando…»");
    }
    if (!/apkc:proyecto-cambio", \(\) => \{ ultimaLimpia = null; \}/.test(fuenteVivo)) {
      mal("un cambio del proyecto no invalida la última pasada limpia: se saltaría el check que hace falta");
    }
    if (!/saltadas\+\+/.test(fuenteVivo)) mal("el diagnóstico no cuenta las pasadas que se salta");
    if (/cancelarSiNadieEspera|hospedador\.cancelar/.test(fuenteVivo)) {
      mal("el diagnóstico cancela el worker: la medición de la pestaña no lo justifica (esperar cuesta menos)");
    }
    const fuentePestana = fs.readFileSync(path.join(__dirname, "pestana.js"), "utf8");
    if (!/cancelarSiNadieEspera\(\) \{ return comandosDelUsuario > 0 \? false : detener\(\); \}/.test(fuentePestana)) {
      mal("el hospedador no niega la cancelación cuando hay un comando del usuario en la cola");
    }
    if (!/comandosDelUsuario\+\+;/.test(fuentePestana) || !/comandosDelUsuario--;/.test(fuentePestana)) {
      mal("los comandos de la interfaz no cuentan para protegerlos de la cancelación del diagnóstico");
    }
    // la primitiva existe y, sin worker, no finge que canceló: es lo que la sonda mide después
    if (typeof pestanaMod.hospedador.cancelarSiNadieEspera !== "function") {
      mal("el hospedador no expone cancelarSiNadieEspera");
    } else if (pestanaMod.hospedador.cancelarSiNadieEspera() !== false) {
      mal("cancelarSiNadieEspera sin worker devuelve algo distinto de false");
    }
  }

  // 11c-bis. el worker que no carga y el que se queda mudo. Sin estos dos caminos la promesa de
  // `pedir` no se resuelve nunca: el velo de carga se queda encima y el comando parece colgado
  // (solo lo salvaba pulsar «Detener»). Se conduce el hospedador real con un Worker de mentira.
  {
    const hospedador = pestanaMod.hospedador;
    const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
    const descNavegador = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const WorkerReal = globalThis.Worker;
    const armar = () => {
      Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
        value: { storage: { getDirectory: async () => ({ nombre: "raiz-de-prueba" }) } } });
    };
    const soltar = () => {
      if (WorkerReal === undefined) delete globalThis.Worker; else globalThis.Worker = WorkerReal;
      if (descNavegador) Object.defineProperty(globalThis, "navigator", descNavegador);
      else delete globalThis.navigator;
      hospedador.cancelar();
    };
    // (a) el módulo del worker no carga: el navegador dispara `error` en el Worker
    {
      const creados = [];
      class WorkerRoto {
        constructor(url, opciones) {
          this.url = String(url); this.opciones = opciones; this.oyentes = {};
          creados.push(this);
        }
        addEventListener(tipo, fn) { (this.oyentes[tipo] = this.oyentes[tipo] || []).push(fn); }
        postMessage() { /* el módulo no cargó: nunca contesta */ }
        terminate() { this.terminado = true; }
      }
      globalThis.Worker = WorkerRoto;
      armar();
      try {
        const t0 = Date.now();
        const promesa = hospedador.ejecutar(["version"]);
        await pausa(20);
        for (const fn of (creados[0] && creados[0].oyentes.error) || []) {
          fn({ type: "error", message: "Failed to fetch dynamically imported module hospedador.js" });
        }
        const salida = await promesa;
        const ms = Date.now() - t0;
        if (ms >= 2000) mal("el fallo de import del worker tardó " + ms + " ms en resolverse");
        if (!salida || salida.tipo !== "error" ||
            !/hospedador no arrancó/i.test(String(salida.error || ""))) {
          mal("el fallo de import del worker no resolvió con un error con nombre: " +
            JSON.stringify(salida).slice(0, 200));
        }
        if (!/módulo|module|import/i.test(String(salida && salida.mensaje || ""))) {
          mal("el mensaje del fallo no dice que el worker no cargó: " +
            String(salida && salida.mensaje).slice(0, 160));
        }
        if (!creados[0] || creados[0].terminado !== true) {
          mal("el worker roto no se terminó: la siguiente petición reutilizaría uno muerto");
        }
      } catch (e) {
        mal("el fallo de import del worker rechazó en vez de resolver: " + ((e && e.message) || e));
      } finally {
        soltar();
      }
    }
    // (b) el worker arranca y se queda mudo: el vigilante resuelve con un mensaje y lo reinicia
    {
      class WorkerMudo {
        constructor() { this.oyentes = {}; this.terminado = false; }
        addEventListener() { /* nada: no hay eventos que lleguen */ }
        postMessage() { /* traga el mensaje */ }
        terminate() { this.terminado = true; }
      }
      globalThis.Worker = WorkerMudo;
      armar();
      const setTimeoutReal = globalThis.setTimeout;
      const clearTimeoutReal = globalThis.clearTimeout;
      // se acelera SOLO el vigilante (espera de segundos): el temporizador de la prueba sigue real
      globalThis.setTimeout = (fn, ms) => {
        if (Number(ms) >= 1000) {
          const asa = { fn, ms, cancelado: false };
          setTimeoutReal(() => { if (!asa.cancelado) fn(); }, 10);
          return asa;
        }
        return setTimeoutReal(fn, ms);
      };
      globalThis.clearTimeout = (asa) => {
        if (asa && typeof asa === "object" && "cancelado" in asa) { asa.cancelado = true; return; }
        clearTimeoutReal(asa);
      };
      try {
        const t0 = Date.now();
        const salida = await hospedador.arbol();
        const ms = Date.now() - t0;
        if (ms >= 2000) mal("el vigilante del worker mudo tardó " + ms + " ms");
        if (!salida || salida.tipo !== "error" || !/no respondió/i.test(String(salida.error || ""))) {
          mal("un worker mudo no resolvió con «no respondió»: " + JSON.stringify(salida).slice(0, 200));
        }
        // el siguiente comando ya no espera: el recuerdo del fallo contesta al momento
        const despues = await hospedador.arbol();
        if (!despues || despues.tipo !== "error") {
          mal("tras el vigilante, el hospedador siguió esperando a un worker muerto: " +
            JSON.stringify(despues).slice(0, 160));
        }
      } catch (e) {
        mal("el vigilante del worker mudo rechazó en vez de resolver: " + ((e && e.message) || e));
      } finally {
        globalThis.setTimeout = setTimeoutReal;
        globalThis.clearTimeout = clearTimeoutReal;
        // «Detener» olvida el fallo: `cancelar` deja el hospedador disponible otra vez
        soltar();
      }
    }
  }

  // 11d. la lista de clases se invalida sin `refrescar()`: crear o renombrar un `.java` publica
  // `apkc:proyecto-cambio` (lo mismo que hace `pestana.js` al guardar/crear/mover) y el siguiente
  // `cargarClasesProyecto()` vuelve a mirar el árbol. Se conduce con un OPFS de mentira y un
  // `document` mínimo, porque el módulo registra el oyente al importarse.
  {
    const hospedador = pestanaMod.hospedador;
    const arbolReal = hospedador.arbol;
    const bytesReal = hospedador.bytes;
    let nodos = ["/proyecto/src/Vieja.java"];
    hospedador.arbol = async () => ({ nodos: nodos.map((ruta) => ({ ruta, dir: false })) });
    hospedador.bytes = async () => null;
    const oyentes = [];
    globalThis.document = {
      addEventListener(tipo, fn) { if (tipo === "apkc:proyecto-cambio") oyentes.push(fn); },
      dispatchEvent(evento) { for (const fn of oyentes) fn(evento); return true; },
    };
    try {
      const recursos = await import("./recursos-proyecto.js");
      if (!oyentes.length) mal("recursos-proyecto.js no escucha apkc:proyecto-cambio");
      const publicar = (detalle) =>
        globalThis.document.dispatchEvent(
          new CustomEvent("apkc:proyecto-cambio", { detail: detalle }));
      recursos.invalidarRecursosProyecto();
      const antes = await recursos.cargarClasesProyecto();
      if (!antes.has("Vieja") || antes.has("Nueva")) {
        mal(`la caché de clases no parte del árbol falso: ${[...antes].join(", ")}`);
      }
      nodos.push("/proyecto/src/Nueva.java");
      publicar({ tipo: "mutacion", accion: "crear", rutas: ["/proyecto/src/Nueva.java"] });
      const trasCrear = await recursos.cargarClasesProyecto();
      if (!trasCrear.has("Nueva")) {
        mal(`crear un .java no invalida la caché de clases sin refrescar(): ${[...trasCrear].join(", ")}`);
      }
      nodos = nodos.filter((r) => r !== "/proyecto/src/Vieja.java")
        .concat("/proyecto/src/Renombrada.java");
      publicar({ tipo: "mutacion", accion: "renombrar",
        origen: "/proyecto/src/Vieja.java", destino: "/proyecto/src/Renombrada.java" });
      const trasRenombrar = await recursos.cargarClasesProyecto();
      if (!trasRenombrar.has("Renombrada") || trasRenombrar.has("Vieja")) {
        mal(`renombrar un .java no invalida la caché de clases: ${[...trasRenombrar].join(", ")}`);
      }
    } finally {
      hospedador.arbol = arbolReal;
      hospedador.bytes = bytesReal;
      delete globalThis.document;
    }
  }

  // 11d-ter. el autocompletado infla el `.class` que va a completar, y ese camino tenía el mismo
  // agujero: el directorio central declara poco y el flujo expande mucho. Se importa el módulo aquí,
  // con `document` ya borrado (el IIFE se retira sin DOM) y después de 11d, que necesita importar
  // `recursos-proyecto.js` con su `document` de mentira para ver el registro del oyente.
  {
    const { inflarConTope } = await import("./autocompletado.js");
    const zipClase = await zipBomba(64, "com/x/Bomba.class", 1024);
    const finClase = autocompletado.buscarFinDirectorio(zipClase);
    const entradasClase = finClase && !finClase.zip64
      ? autocompletado.leerEntradasDirectorio(
        zipClase.subarray(finClase.inicioDirectorio, finClase.inicioDirectorio + finClase.tamanoDirectorio))
      : [];
    const entradaClase = entradasClase[0];
    if (!entradaClase || entradaClase.descomprimido !== 1024) {
      mal("el zip de la clase bomba no se parte: no se pudo probar el tope del autocompletado");
    } else {
      // se recorre la vía real: el zip se parte con el lector de autocompletado-datos y solo la
      // entrada comprimida llega al inflador, como en `metodosDe`
      const inicioClase = autocompletado.offsetDeDatosLocales(
        zipClase.subarray(entradaClase.local, entradaClase.local + 30));
      const crudoClase = zipClase.subarray(entradaClase.local + inicioClase,
        entradaClase.local + inicioClase + entradaClase.comprimido);
      const antesClase = process.memoryUsage().rss;
      let rechazoClase = "";
      try { await inflarConTope(crudoClase, 8 * 1024 * 1024, "com.x.Bomba"); }
      catch (e) { rechazoClase = String(e && e.message ? e.message : e); }
      const rssClase = (process.memoryUsage().rss - antesClase) / (1024 * 1024);
      if (!/com\.x\.Bomba/.test(rechazoClase) || !/8 MiB/.test(rechazoClase)) {
        mal("el autocompletado no corta el .class por los bytes producidos: " +
          (rechazoClase || "la clase pasó entera"));
      }
      // 64 MiB declarados como 1024 B: sin tope se materializan y el proceso engorda; con el tope
      // de 8 MiB la lectura se corta sin llegar a esos números
      if (rssClase > 100) {
        mal("inflarConTope del autocompletado se pasó de memoria: " + Math.round(rssClase) + " MB de RSS");
      }
    }
  }

  // 11d-bis. conducción del diagnóstico en vivo con un DOM y un hospedador de mentira: una pasada
  // que se invalida y otra que se salta no pueden dejar «comprobando…» en el indicador, y bajar la
  // API tiene que invalidar la pasada limpia aunque el texto solo cambie en espacios. El módulo
  // registra oyentes al importarse, así que va después de 11d (que importa recursos-proyecto).
  {
    const hospedador = pestanaMod.hospedador;
    const reales = { escribir: hospedador.escribir, ejecutar: hospedador.ejecutar, limpiar: hospedador.limpiar };
    const previos = { document: globalThis.document, window: globalThis.window,
      getComputedStyle: globalThis.getComputedStyle };
    const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
    const nodo = () => ({
      className: "", textContent: "", dataset: {}, style: {}, children: [],
      appendChild(hijo) { this.children.push(hijo); },
      addEventListener(tipo, fn) { (this.oyentes ||= {})[tipo] = fn; },
      setAttribute() {}, remove() {}, focus() {},
    });
    const area = nodo();
    const marcas = nodo();
    const lista = nodo();
    const indicador = nodo();
    const api = Object.assign(nodo(), { value: "34" });
    const codename = Object.assign(nodo(), { value: "14" });
    const porId = {
      codigo: area, "diagnostico-marcas": marcas, "diagnostico-vivo-lista": lista,
      "diagnostico-vivo-estado": indicador, "sdk-version": api, codename,
    };
    globalThis.document = {
      getElementById: (id) => porId[id] || null,
      createElement: () => nodo(),
      addEventListener() {}, dispatchEvent() { return true; },
    };
    globalThis.window = { addEventListener() {} };
    globalThis.getComputedStyle = () => ({ lineHeight: "20px" });
    const cola = [];
    hospedador.escribir = async () => ({ tipo: "montado" });
    hospedador.limpiar = async () => ({ tipo: "limpiado" });
    hospedador.ejecutar = (argv) => new Promise((resolver) => cola.push({ argv, resolver }));
    const responder = () => {
      const turno = cola.shift();
      if (!turno) return false;
      turno.resolver({ tipo: "terminado", codigo: 0,
        consola: JSON.stringify({ tipo: "check", fichero: "MainActivity.java", lineas: 2,
          emisor: true, recursos: "R.java del proyecto", errores: [] }) });
      return true;
    };
    try {
      pestanaMod.estadoPestana.ruta = "/proyecto/src/com/myapp/MainActivity.java";
      area.value = "public class MainActivity {}\n";
      await import("./diagnostico-vivo.js");
      await pausa(500);
      if (!responder()) mal("el diagnóstico no lanzó el primer check al importarse");
      await pausa(80);
      if (indicador.textContent !== "sin errores · Java") {
        mal(`el primer check no dejó el resumen limpio: «${indicador.textContent}»`);
      }

      // una pasada con otro texto queda en vuelo; el texto vuelve al limpio y la invalida. La
      // pasada vieja termina sin pintar y la nueva se salta: el indicador no puede quedarse mudo.
      area.value = "public class MainActivity { int x; }\n";
      area.oyentes.input();
      await pausa(450);
      if (!cola.length) mal("la pasada con otro texto no llegó a lanzarse");
      area.value = "public class MainActivity {}   \n";
      area.oyentes.input();
      await pausa(450); // la pasada nueva invalida la vieja (enCurso) antes de que esta termine
      if (!responder()) mal("la pasada invalidada no tenía comando que resolver");
      await pausa(700); // el finally programa otra, que se salta
      if (indicador.textContent !== "sin errores · Java") {
        mal(`el estado se quedó en «${indicador.textContent}» tras una pasada invalidada y una saltada`);
      }

      // bajar la API cambia el classpath: el mismo texto con espacios de sobra tiene que relanzar
      api.value = "21";
      area.value = "public class MainActivity {}    \n";
      area.oyentes.input();
      await pausa(450);
      if (!cola.length) {
        mal("bajar la API no relanzó el check: se saltó con la clave vieja");
      } else if (!responder()) {
        mal("el check tras bajar la API no tenía comando que resolver");
      }
      await pausa(80);
      if (indicador.textContent !== "sin errores · Java") {
        mal(`el check tras bajar la API no dejó el resumen limpio: «${indicador.textContent}»`);
      }
    } catch (e) {
      mal("no se pudo conducir el diagnóstico en vivo: " + ((e && e.message) || e));
    } finally {
      hospedador.escribir = reales.escribir;
      hospedador.ejecutar = reales.ejecutar;
      hospedador.limpiar = reales.limpiar;
      pestanaMod.estadoPestana.ruta = null;
      for (const [clave, valor] of Object.entries({ document: previos.document,
        window: previos.window, getComputedStyle: previos.getComputedStyle })) {
        if (valor === undefined) delete globalThis[clave];
        else globalThis[clave] = valor;
      }
    }
  }

  // 13. la sección de dependencias (R4): importa a OPFS un paquete estático del propio origen.
  //     Aquí se prueban el índice, la validación, el hash y el camino completo con un fetch y un
  //     hospedador de mentira; en `prueba-pestana.js` se conduce el panel real en chromium y se
  //     cuenta que no salga ni una petición del origen.
  {
    // el rechazo del proxy se queda como regresión: el usuario no quiere red en tiempo de ejecución
    const fuenteDeps = fs.readFileSync(path.join(__dirname, "deps.js"), "utf8");
    const servidor = fs.readFileSync(path.join(__dirname, "servidor.js"), "utf8");
    if (/deps-proxy/.test(fuenteDeps) || /deps-proxy/.test(servidor)) {
      mal("sigue habiendo un endpoint /deps-proxy; la red en tiempo de ejecución está descartada");
    }
    for (const fichero of ["index.html", "main.js", "vistas.js", "hospedador.js", "sw.js"]) {
      if (/deps-proxy/.test(fs.readFileSync(path.join(__dirname, fichero), "utf8"))) {
        mal(fichero + " menciona /deps-proxy");
      }
    }

    // rutas del índice: relativas y siempre dentro de deps/
    const ficheroBueno = "deps/com.example/prueba/1.0/prueba-1.0.jar";
    if (!depsMod.ficheroDelOrigenSeguro(ficheroBueno)) mal("el cargador rechaza un fichero válido de deps/");
    for (const malo of ["../fuera.jar", "/deps/x.jar", "deps/../../x.jar", "deps\\x.jar",
      "deps/x.jar?x", "deps/x.jar#y", "otra/x.jar", "deps//x.jar", "deps/./x.jar", ""]) {
      if (depsMod.ficheroDelOrigenSeguro(malo)) mal("el cargador acepta un fichero fuera de deps/: " + JSON.stringify(malo));
    }

    const bytesFalsos = new TextEncoder().encode("PK\u0003\u0004prueba de dependencias de apkc studio\n");
    const hashFalso = await depsMod.sha256Hex(bytesFalsos);
    const entradaBuena = {
      coordenada: "com.example:prueba:1.0", grupo: "com.example", artefacto: "prueba",
      version: "1.0", extension: "jar", fichero: ficheroBueno,
      bytes: bytesFalsos.length, sha256: hashFalso,
    };
    if (depsMod.validarEntrada(entradaBuena) !== "") mal("validarEntrada rechaza una entrada correcta: " + depsMod.validarEntrada(entradaBuena));
    for (const rota of [
      { ...entradaBuena, sha256: "arriba" },
      { ...entradaBuena, bytes: 0 },
      { ...entradaBuena, fichero: "../x.jar" },
      { ...entradaBuena, extension: "apk" },
      { ...entradaBuena, grupo: "com/example" },
      { ...entradaBuena, version: ".." },
      {},
    ]) if (!depsMod.validarEntrada(rota)) mal("validarEntrada acepta una entrada rota: " + JSON.stringify(rota).slice(0, 120));

    // fetch de mentira: el índice y el artefacto, del mismo origen, sin tocar la red de verdad
    const llamadas = [];
    const respuesta = (cuerpo, tipo) => ({
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? tipo : null) },
      text: async () => (typeof cuerpo === "string" ? cuerpo : new TextDecoder().decode(cuerpo)),
      arrayBuffer: async () => cuerpo.buffer.slice(cuerpo.byteOffset, cuerpo.byteOffset + cuerpo.byteLength),
    });
    const indice = { version: 1, generado: "2026-11-22T00:00:00Z", artefactos: [entradaBuena] };
    const fetchMentira = async (ruta) => {
      llamadas.push(ruta);
      if (ruta === "./deps-index.json") return respuesta(JSON.stringify(indice), "application/json");
      if (ruta === "./" + ficheroBueno) return respuesta(bytesFalsos, "application/java-archive");
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => "no" };
    };
    const escritos = new Map();
    // el bloqueo entre ventanas se espía: el artefacto y su descriptor tienen que entrar dentro
    const ordenBloqueo = [];
    const conBloqueoMentira = async (tarea) => {
      ordenBloqueo.push("toma");
      try { return await tarea(); } finally { ordenBloqueo.push("suelta"); }
    };
    const hospedadorMentira = {
      escribir: async (ruta, datos) => {
        ordenBloqueo.push("escribe:" + ruta);
        escritos.set(ruta, datos);
        return { tipo: "montado", ruta, bytes: datos.length };
      },
    };
    const leido = await depsMod.leerIndice({ fetchImpl: fetchMentira });
    if (leido.artefactos.length !== 1 || leido.generado !== "2026-11-22T00:00:00Z") mal("leerIndice no devuelve el índice válido");
    if (!depsMod.buscarArtefacto(leido, "com.example:prueba:1.0") || depsMod.buscarArtefacto(leido, "com.example:otra:1.0")) {
      mal("buscarArtefacto no distingue la coordenada del índice");
    }
    const baseLlamadas = llamadas.length;
    const importado = await depsMod.resolverDependencia({
      coord: "com.example:prueba:1.0", hospedador: hospedadorMentira, fetchImpl: fetchMentira,
      conBloqueo: conBloqueoMentira,
    });
    const llamadasImport = llamadas.slice(baseLlamadas);
    const rutaEsperada = "/deps/com.example/prueba/1.0/prueba-1.0.jar";
    if (importado.ruta !== rutaEsperada || importado.hash !== hashFalso ||
        importado.bytes !== bytesFalsos.length || importado.nombre !== "prueba-1.0.jar") {
      mal("resolverDependencia no importa el artefacto con su hash y su ruta: " + JSON.stringify(importado).slice(0, 240));
    }
    if (!escritos.has(rutaEsperada) || escritos.get(rutaEsperada).length !== bytesFalsos.length) {
      mal("resolverDependencia no escribe el artefacto en OPFS bajo /deps/");
    }
    if (JSON.stringify(ordenBloqueo) !== JSON.stringify([
      "toma", "escribe:" + rutaEsperada,
      "escribe:/deps/com.example/prueba/1.0/deps.json", "suelta",
    ])) {
      mal("resolverDependencia no escribe el artefacto y su descriptor dentro de conBloqueo: " +
        JSON.stringify(ordenBloqueo));
    }
    const descriptor = JSON.parse(new TextDecoder().decode(escritos.get("/deps/com.example/prueba/1.0/deps.json") || new Uint8Array([123, 125])));
    if (descriptor.sha256 !== hashFalso || descriptor.bytes !== bytesFalsos.length || descriptor.coordenada !== "com.example:prueba:1.0") {
      mal("el descriptor de OPFS no repite coordenada, tamaño y sha256");
    }
    if (llamadasImport.length !== 2 || llamadasImport[0] !== "./deps-index.json" || llamadasImport[1] !== "./" + ficheroBueno) {
      mal("la importación no lee exactamente el índice y su fichero, del propio origen: " + JSON.stringify(llamadasImport));
    }
    if (llamadasImport.some((u) => /^https?:|^\/\//.test(u))) mal("la importación construye una URL absoluta: " + JSON.stringify(llamadasImport));

    // un índice ausente no se inventa: 404 con mensaje que manda al workflow
    let falloIndice = "";
    try { await depsMod.leerIndice({ fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => "" }) }); }
    catch (e) { falloIndice = String(e && e.message ? e.message : e); }
    if (!/no hay deps-index\.json/.test(falloIndice) || !/workflow/.test(falloIndice)) {
      mal("sin índice el cargador no explica que hay que ejecutar el workflow: " + falloIndice);
    }
    // un 200 con HTML no es un índice
    let falloHtml = "";
    try { await depsMod.leerIndice({ fetchImpl: async () => respuesta("<html></html>", "text/html") }); }
    catch (e) { falloHtml = String(e && e.message ? e.message : e); }
    if (!/HTML/.test(falloHtml)) mal("el cargador acepta HTML como índice");
    // un artefacto con otro hash no entra en OPFS
    const escritosMalos = new Map();
    const fetchAlterado = async (ruta) => {
      if (ruta === "./deps-index.json") return respuesta(JSON.stringify(indice), "application/json");
      return respuesta(new TextEncoder().encode("otro contenido"), "application/java-archive");
    };
    let falloHash = "";
    try {
      await depsMod.resolverDependencia({ coord: "com.example:prueba:1.0", fetchImpl: fetchAlterado,
        hospedador: { escribir: async (r, d) => { escritosMalos.set(r, d); return { tipo: "montado", bytes: d.length }; } } });
    } catch (e) { falloHash = String(e && e.message ? e.message : e); }
    if (!/tamaño no coincide|sha256 no coincide/.test(falloHash) || escritosMalos.size) {
      mal("un artefacto alterado no se rechaza antes de escribir en OPFS: " + falloHash);
    }

    // vía local, sin red: el .zip con la forma de apkc-deps se queda en jar/, lib/<abi>/ y
    // res/__deps/; lo demás (src/, el res/ propio, assets/) no se pisa desde dependencias.
    const texto = (s) => new TextEncoder().encode(s);
    const paquete = [
      { ruta: "res/__deps/0123456789ab/values/strings.xml", dir: false, datos: texto("<resources/>") },
      { ruta: "jar/gson-2.10.1.jar", dir: false, datos: bytesFalsos },
      { ruta: "lib/arm64-v8a/libgson.so", dir: false, datos: new Uint8Array([1, 2, 3]) },
      { ruta: "src/com/example/Main.java", dir: false, datos: texto("class Main {}") },
      { ruta: "res/values/strings.xml", dir: false, datos: texto("<resources/>") },
      { ruta: "lib/../x.so", dir: false, datos: new Uint8Array([1]) },
      { ruta: "res/__deps/no-es-hex/values/x.xml", dir: false, datos: texto("<resources/>") },
      { ruta: "jar/sub/anidado.jar", dir: false, datos: new Uint8Array([1]) },
    ];
    const planPaquete = depsMod.planDePaquete(paquete);
    if (JSON.stringify(planPaquete.ficheros.map((f) => f.ruta)) !== JSON.stringify([
      "res/__deps/0123456789ab/values/strings.xml", "jar/gson-2.10.1.jar",
      "lib/arm64-v8a/libgson.so",
    ])) {
      mal("planDePaquete no deja solo jar/, lib/<abi>/ y res/__deps/: " +
        JSON.stringify(planPaquete.ficheros.map((f) => f.ruta)));
    }
    if (planPaquete.ignorados !== 5) mal("planDePaquete no cuenta los ficheros ignorados: " + planPaquete.ignorados);
    let falloPaqueteVacio = "";
    try { depsMod.planDePaquete([{ ruta: "src/A.java", dir: false, datos: texto("x") }]); }
    catch (e) { falloPaqueteVacio = String(e && e.message ? e.message : e); }
    if (!/no trae jar/.test(falloPaqueteVacio)) mal("un zip sin jar/, lib/ ni res/__deps/ no se rechaza: " + falloPaqueteVacio);

    // un .aar se abre como zip y se reparte en las tres carpetas; el manifiesto y el R.txt no se
    // finge que se fusionan
    const aar = makeZip([
      ["classes.jar", bytesFalsos],
      ["libs/inner.jar", texto("PK\u0003\u0004interno")],
      ["jni/arm64-v8a/libnativo.so", new Uint8Array([9, 9])],
      ["res/values/strings.xml", texto("<resources/>")],
      ["AndroidManifest.xml", texto("<manifest/>")],
      ["R.txt", texto("")],
    ]);
    const planAar = depsMod.planDeAar("material-1.12.0.aar", await leerZip(new Uint8Array(aar)));
    const isla = depsMod.hashCorto("material-1.12.0");
    if (!/^[0-9a-f]{12}$/.test(isla) || isla !== depsMod.hashCorto("material-1.12.0")) {
      mal("hashCorto no es estable ni de doce hex: " + isla);
    }
    if (JSON.stringify(planAar.ficheros.map((f) => f.ruta)) !== JSON.stringify([
      "jar/material-1.12.0.jar", "jar/material-1.12.0-inner.jar", "lib/arm64-v8a/libnativo.so",
      "res/__deps/" + isla + "/values/strings.xml",
    ])) {
      mal("planDeAar no reparte classes.jar, libs/, jni/ y res/: " +
        JSON.stringify(planAar.ficheros.map((f) => f.ruta)));
    }
    if (planAar.ignorados !== 2) mal("planDeAar no ignora manifiesto y R.txt: " + planAar.ignorados);
    const planJar = depsMod.planDeJar("gson-2.10.1.jar", bytesFalsos);
    if (planJar.ficheros.length !== 1 || planJar.ficheros[0].ruta !== "jar/gson-2.10.1.jar") {
      mal("planDeJar no deja el .jar en jar/: " + JSON.stringify(planJar.ficheros.map((f) => f.ruta)));
    }

    // el plan unido va en orden de ruta (el orden en el que se escribe) y dos artefactos que
    // escriben la misma ruta son un error visible, no el último que gana
    const planUnido = depsMod.unirPlanes([planAar, planJar]);
    const ordenEsperado = [
      "jar/gson-2.10.1.jar", "jar/material-1.12.0-inner.jar", "jar/material-1.12.0.jar",
      "lib/arm64-v8a/libnativo.so", "res/__deps/" + isla + "/values/strings.xml",
    ];
    if (JSON.stringify(planUnido.ficheros.map((f) => f.ruta)) !== JSON.stringify(ordenEsperado)) {
      mal("unirPlanes no ordena las rutas: " + JSON.stringify(planUnido.ficheros.map((f) => f.ruta)));
    }
    let falloDuplicado = "";
    try { depsMod.unirPlanes([planJar, depsMod.planDeJar("gson-2.10.1.jar", bytesFalsos)]); }
    catch (e) { falloDuplicado = String(e && e.message ? e.message : e); }
    if (!/misma ruta/.test(falloDuplicado)) mal("unirPlanes acepta dos artefactos con la misma ruta: " + falloDuplicado);
    let falloVacio = "";
    try { depsMod.unirPlanes([]); } catch (e) { falloVacio = String(e && e.message ? e.message : e); }
    if (!/nada que importar/.test(falloVacio)) mal("unirPlanes acepta un plan vacío: " + falloVacio);

    // la escritura: dentro de conBloqueo, en el orden del plan y con el registro al final
    const escritosImport = new Map();
    const ordenImport = [];
    const progresoImport = [];
    const hospedadorImport = {
      escribir: async (ruta, datos) => {
        ordenImport.push("escribe:" + ruta);
        escritosImport.set(ruta, datos);
        return { tipo: "montado", ruta, bytes: datos.length };
      },
      leer: async () => ({ ok: false, error: "ENOENT" }),
    };
    const importadoLocal = await depsMod.importarDependencias({
      plan: planUnido, hospedador: hospedadorImport,
      conBloqueo: async (tarea) => {
        ordenImport.push("toma");
        try { return await tarea(); } finally { ordenImport.push("suelta"); }
      },
      alProgreso: (p) => progresoImport.push(p.hechos),
    });
    const ordenEscritura = ["toma"];
    for (const ruta of ordenEsperado) ordenEscritura.push("escribe:/proyecto/" + ruta);
    ordenEscritura.push("escribe:/proyecto/deps.importado.json", "suelta");
    if (JSON.stringify(ordenImport) !== JSON.stringify(ordenEscritura)) {
      mal("importarDependencias no escribe en orden dentro de conBloqueo: " + JSON.stringify(ordenImport));
    }
    if (JSON.stringify(progresoImport) !== JSON.stringify([0, 1, 2, 3, 4, 5])) {
      mal("la barra de progreso no avanza de 0 a N: " + JSON.stringify(progresoImport));
    }
    if (importadoLocal.ficheros !== 5 || importadoLocal.bytes !==
        ordenEsperado.reduce((n, ruta) => n + escritosImport.get("/proyecto/" + ruta).length, 0)) {
      mal("importarDependencias no devuelve ficheros y bytes: " + JSON.stringify(importadoLocal).slice(0, 200));
    }
    const registroImport = JSON.parse(new TextDecoder().decode(escritosImport.get("/proyecto/deps.importado.json") || new Uint8Array([123, 125])));
    if (!Array.isArray(registroImport.artefactos) || registroImport.artefactos.length !== 5 ||
        registroImport.artefactos.map((a) => a.ruta).join(",") !== ordenEsperado.join(",")) {
      mal("deps.importado.json no registra los artefactos en orden");
    }
    if (registroImport.artefactos[0].sha256 !== await depsMod.sha256Hex(planJar.ficheros[0].bytes)) {
      mal("deps.importado.json no lleva el sha256 de lo que se escribió");
    }

    // pisar exige confirmación: si se dice que no, no se escribe nada
    let escritosCancelados = 0;
    let falloCancelado = "";
    try {
      await depsMod.importarDependencias({
        plan: planUnido,
        hospedador: { escribir: async () => { escritosCancelados++; return { tipo: "montado" }; },
          leer: async () => ({ bytes: 1 }) },
        confirmar: async () => false,
      });
    } catch (e) { falloCancelado = String(e && e.message ? e.message : e); }
    if (!/cancelada/.test(falloCancelado) || escritosCancelados) {
      mal("importarDependencias pisa sin confirmar: " + falloCancelado + " escritos=" + escritosCancelados);
    }
    // un fallo de cuota se explica como cuota, no como un error opaco
    if (!depsMod.esFalloDeCuota({ name: "QuotaExceededError" }) ||
        !/cuota de OPFS/.test(depsMod.mensajeDeImportacion({ message: "The quota has been exceeded." }))) {
      mal("el fallo de cuota de OPFS no se explica");
    }

    // el generador local sin red produce un índice que la página acepta y consume. Se lee del
    // disco con un fetch de mentira para no depender de un servidor en node.
    const dirIndice = fs.mkdtempSync(path.join(tmp, "deps-index-"));
    const fechaFija = "2026-11-22T00:00:00Z";
    execFileSync(process.execPath, [path.join(__dirname, "deps-index-local.mjs"),
      "--salida", dirIndice, "--licencia", "Apache-2.0", "--fecha", fechaFija], { stdio: "pipe" });
    const indiceLocal = JSON.parse(fs.readFileSync(path.join(dirIndice, "deps-index.json"), "utf8"));
    const entLocal = indiceLocal.artefactos[0];
    const artefactoLocal = fs.readFileSync(path.join(dirIndice, entLocal.fichero));
    const hashLocal = await depsMod.sha256Hex(new Uint8Array(artefactoLocal));
    if (indiceLocal.version !== 1 || !entLocal ||
        entLocal.coordenada !== "com.example:prueba:1.0" ||
        !depsMod.ficheroDelOrigenSeguro(entLocal.fichero) ||
        entLocal.bytes !== artefactoLocal.length || entLocal.sha256 !== hashLocal ||
        entLocal.licencia !== "Apache-2.0" || entLocal.fecha !== fechaFija) {
      mal("el generador local no deja coordenada, ruta, bytes, sha256, licencia y fecha: " +
        JSON.stringify({ ent: entLocal && { coordenada: entLocal.coordenada, fichero: entLocal.fichero,
          bytes: entLocal.bytes, sha: entLocal.sha256, licencia: entLocal.licencia, fecha: entLocal.fecha },
          real: artefactoLocal.length, hash: hashLocal }).slice(0, 360));
    }
    if (depsMod.validarEntrada(entLocal) !== "") mal("el índice del generador local no valida: " + depsMod.validarEntrada(entLocal));
    const fetchDisco = async (ruta) => {
      if (ruta === "./deps-index.json") {
        return { ok: true, status: 200,
          headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
          text: async () => fs.readFileSync(path.join(dirIndice, "deps-index.json"), "utf8") };
      }
      const rel = String(ruta).replace(/^\.\//, "");
      const datos = fs.readFileSync(path.join(dirIndice, rel));
      return { ok: true, status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/java-archive" : null) },
        arrayBuffer: async () => datos.buffer.slice(datos.byteOffset, datos.byteOffset + datos.byteLength) };
    };
    const escritoLocal = new Map();
    const importadoLocalGen = await depsMod.resolverDependencia({
      coord: entLocal.coordenada, fetchImpl: fetchDisco,
      hospedador: { escribir: async (r, d) => { escritoLocal.set(r, d); return { tipo: "montado", bytes: d.length }; } },
    });
    if (importadoLocalGen.hash !== hashLocal || importadoLocalGen.licencia !== "Apache-2.0" ||
        importadoLocalGen.fecha !== fechaFija ||
        !escritoLocal.has("/deps/com.example/prueba/1.0/prueba-1.0.jar")) {
      mal("la página no importa el índice del generador local: " + JSON.stringify({
        hash: importadoLocalGen.hash, licencia: importadoLocalGen.licencia,
        fecha: importadoLocalGen.fecha }).slice(0, 240));
    }
    // y el mismo generador indexa un jar real (--jar): el sha es el del fichero de entrada
    const dirJar = fs.mkdtempSync(path.join(tmp, "deps-jar-"));
    execFileSync(process.execPath, [path.join(__dirname, "deps-index-local.mjs"),
      "--salida", dirJar, "--jar", path.join(dirIndice, entLocal.fichero),
      "--coordenada", "com.example:real:2.0", "--licencia", "MIT"], { stdio: "pipe" });
    const indiceJar = JSON.parse(fs.readFileSync(path.join(dirJar, "deps-index.json"), "utf8"));
    const entJar = indiceJar.artefactos[0];
    if (entJar.coordenada !== "com.example:real:2.0" || entJar.sha256 !== hashLocal ||
        entJar.bytes !== artefactoLocal.length || entJar.licencia !== "MIT" ||
        entJar.fichero !== "deps/com.example/real/2.0/real-2.0.jar") {
      mal("el generador no indexa un jar real con su coordenada: " + JSON.stringify(entJar).slice(0, 240));
    }
    // La licencia no se presume: un jar real sin `--licencia` sale con `licencia: null` y el
    // generador avisa por stdout; solo el sintético, que creamos nosotros, nace con CC0-1.0.
    const dirJarSin = fs.mkdtempSync(path.join(tmp, "deps-jar-sin-licencia-"));
    const salidaSin = execFileSync(process.execPath, [path.join(__dirname, "deps-index-local.mjs"),
      "--salida", dirJarSin, "--jar", path.join(dirIndice, entLocal.fichero),
      "--coordenada", "com.example:tercero:3.0", "--fecha", fechaFija], { stdio: "pipe" });
    const entSin = JSON.parse(fs.readFileSync(path.join(dirJarSin, "deps-index.json"), "utf8")).artefactos[0];
    if (entSin.licencia !== null || !/aviso/.test(String(salidaSin)) || !/--licencia/.test(String(salidaSin))) {
      mal("un jar real sin --licencia no puede declararse CC0-1.0 en silencio: " +
        JSON.stringify({ licencia: entSin.licencia, salida: String(salidaSin).slice(0, 200) }).slice(0, 360));
    }
    if (depsMod.validarEntrada(entSin) !== "") {
      mal("el índice de un jar sin licencia no valida: " + depsMod.validarEntrada(entSin));
    }
    const dirSinteticoSin = fs.mkdtempSync(path.join(tmp, "deps-sin-licencia-"));
    execFileSync(process.execPath, [path.join(__dirname, "deps-index-local.mjs"),
      "--salida", dirSinteticoSin, "--fecha", fechaFija], { stdio: "pipe" });
    const entSintetica = JSON.parse(fs.readFileSync(path.join(dirSinteticoSin, "deps-index.json"), "utf8")).artefactos[0];
    if (entSintetica.licencia !== "CC0-1.0") {
      mal("el jar sintético del generador debería declararse CC0-1.0: " + JSON.stringify(entSintetica.licencia));
    }

    // ids contrato de la sección, y la pestaña propia separada de Compilar/Diagnóstico/Historial
    for (const id of ["deps-coordenada", "deps-resolver", "deps-estado", "deps-resultado",
      "deps-nombre", "deps-bytes", "deps-hash", "deps-licencia", "deps-fecha", "deps-ruta", "deps-indice",
      "deps-ficheros", "deps-soltar", "deps-progreso", "deps-importar-estado", "deps-importado",
      "deps-importado-ficheros", "deps-importado-bytes", "deps-importado-destino",
      "deps-importado-descriptor"]) {
      if (!ids.has(id)) mal("index.html no tiene el id de dependencias #" + id);
    }
    // la fecha del artefacto se pinta junto a la licencia, y no se inventa si el índice no la trae
    const pintarDeps = fuenteDeps.slice(fuenteDeps.indexOf("const pintar = (r) =>"),
      fuenteDeps.indexOf("const resolver = async"));
    if (!/deps-fecha/.test(fuenteDeps) ||
        !/fecha\.textContent = r\.fecha \|\| "sin declarar"/.test(pintarDeps)) {
      mal("el panel de dependencias no pinta la fecha del artefacto junto a la licencia");
    }
    if (!/data-panel="deps"/.test(html) || !/id="panel-deps"/.test(html)) {
      mal("la sección de dependencias no tiene su pestaña data-panel=deps");
    }
    // deps.js viaja en el shell del service worker o la recarga sin red se queda sin módulo
    if (!fs.readFileSync(path.join(__dirname, "sw.js"), "utf8").includes('"./deps.js"')) {
      mal("sw.js no cachea deps.js en el shell");
    }
    // el paquete de dependencias no se duplica en la caché del SW
    const sw = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
    if (!sw.includes("/^\\/deps-index\\.json$/") || !sw.includes("/^\\/deps\\//")) {
      mal("sw.js no deja el índice y los artefactos fuera de su caché (SOLO_RED)");
    }

    // el workflow es quien descarga de Maven; el índice tiene que salir con hash y tamaño
    const workflow = path.join(__dirname, "..", ".github", "workflows", "deps-maven.yml");
    if (!fs.existsSync(path.join(__dirname, "..", ".github"))) {
      console.log("  (sin el .github del repo padre: la comprobación del workflow se omite)");
    } else if (!fs.existsSync(workflow)) {
      mal("falta .github/workflows/deps-maven.yml: sin él no hay índice que importar");
    } else {
      const yml = fs.readFileSync(workflow, "utf8");
      for (const pieza of ["workflow_dispatch", "deps-index.json", "sha256sum", "repo1.maven.org",
        "dl.google.com", "upload-artifact", "licencia"]) {
        if (!yml.includes(pieza)) mal("deps-maven.yml no menciona " + pieza);
      }
      if (/deps-proxy/.test(yml)) mal("deps-maven.yml habla de un proxy en tiempo de ejecución");
    }
  }

  // 13b. el módulo WISP es opcional y apagado: la puerta, el aviso, la lista de relays y el
  //      contrato con el núcleo. Aquí no se abre ningún socket: el núcleo no existe en esta
  //      compilación y `resolverPorWisp` tiene que decirlo, no intentarlo.
  {
    // la lista versionada: seis relays medidos el 2026-11-23, con su latencia y sin auditoría
    const crudoRelays = JSON.parse(fs.readFileSync(path.join(__dirname, "wisp-relays.json"), "utf8"));
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(crudoRelays.generated))) {
      mal("wisp-relays.json no lleva la fecha de la medición");
    }
    if (!/terceros/i.test(String(crudoRelays.note)) || !/auditad/i.test(String(crudoRelays.note))) {
      mal("wisp-relays.json no avisa de que los relays son de terceros y no están auditados");
    }
    if (!crudoRelays.bufferPackets || crudoRelays.bufferPackets.medidoPorRelay !== false) {
      mal("wisp-relays.json no declara que bufferPackets no se midió por relay");
    }
    const rango = crudoRelays.bufferPackets && crudoRelays.bufferPackets.rangoObservado;
    if (!Array.isArray(rango) || rango[0] !== 128 || rango[1] !== 2147483647) {
      mal("wisp-relays.json no registra el rango observado de bufferPackets (128..2147483647)");
    }
    const verificado = wispMod.leerRelays(crudoRelays);
    if (verificado.relays.length !== 6) {
      mal("wisp-relays.json debería traer los 6 relays medidos: " + verificado.relays.length);
    }
    const latencias = {
      "wss://wisp.mercurywork.shop/wisp/": 400, "wss://terbiumon.top/wisp/": 430,
      "wss://anura.pro/wisp/": 447, "wss://lichology.com/wisp/": 509,
      "wss://wisp.waved.site/w/": 515, "wss://gointospace.app/wisp/": 519,
    };
    for (const relay of verificado.relays) {
      if (latencias[relay.url] !== relay.latencyMs) {
        mal("la latencia de " + relay.url + " no es la medida: " + relay.latencyMs);
      }
      if (!relay.url.endsWith("/") || relay.protocol !== "v1" || relay.verified !== true ||
          relay.bufferPackets !== null) {
        mal("relay mal descrito en wisp-relays.json: " + JSON.stringify(relay));
      }
    }

    // el validador no arregla nada: sin handshake, sin latencia, sin barra final o con v2, fuera
    for (const roto of [
      { ...verificado.relays[0], url: "wss://wisp.mercurywork.shop/wisp" },
      { ...verificado.relays[0], verified: false },
      { ...verificado.relays[0], latencyMs: null },
      { ...verificado.relays[0], protocol: "v2" },
      { ...verificado.relays[0], bufferPackets: 0 },
    ]) {
      if (!wispMod.validarRelay(roto)) mal("validarRelay acepta un relay roto: " + JSON.stringify(roto).slice(0, 120));
    }
    for (const malo of ["wss://x/wisp", "http://x/wisp/", "wss:// /wisp/", "", "x"]) {
      if (!wispMod.urlRelayValida(malo)) mal("urlRelayValida acepta una URL rota: " + JSON.stringify(malo));
    }
    if (wispMod.urlRelayValida("wss://wisp.local/wisp/") !== "" ||
        wispMod.urlRelayValida("ws://127.0.0.1:8080/") !== "") {
      mal("urlRelayValida rechaza un relay que la spec v1.2 admite");
    }
    let relaysRepetidos = "";
    try { wispMod.leerRelays({ version: 1, relays: [verificado.relays[0], verificado.relays[0]] }); }
    catch (e) { relaysRepetidos = String(e && e.message ? e.message : e); }
    if (!/repite/.test(relaysRepetidos)) mal("wisp-relays.json acepta dos veces el mismo relay");

    // la elección: por defecto no se guarda nada; «recordar» es lo único que escribe
    const almacen = {
      datos: new Map(),
      getItem(k) { return this.datos.has(k) ? this.datos.get(k) : null; },
      setItem(k, v) { this.datos.set(k, v); },
      removeItem(k) { this.datos.delete(k); },
    };
    const eleccion = wispMod.crearEleccion({ almacen });
    if (eleccion.decidido() || eleccion.activo() || eleccion.guardada() !== "") {
      mal("el módulo WISP arranca decidido o activo sin preguntar");
    }
    if (!/sin decisión/.test(eleccion.estado.origen)) mal("el estado inicial del módulo no es «sin decisión»");
    eleccion.decidir(true, { recordar: false });
    if (!eleccion.activo() || almacen.datos.size !== 0) {
      mal("«activar para esta sesión» escribe en localStorage: " + JSON.stringify([...almacen.datos]));
    }
    if (wispMod.crearEleccion({ almacen }).decidido()) {
      mal("una elección sin recordar se lee como si estuviera guardada");
    }
    eleccion.decidir(true, { recordar: true });
    if (almacen.datos.get(wispMod.CLAVE_ELECCION) !== "activo") {
      mal("«recordar elección» no guarda el módulo activo");
    }
    const recordada = wispMod.crearEleccion({ almacen });
    if (!recordada.decidido() || !recordada.activo() || !/recordada/.test(recordada.estado.origen)) {
      mal("una elección recordada no se recupera al arrancar");
    }
    recordada.decidir(false, { recordar: true });
    if (almacen.datos.get(wispMod.CLAVE_ELECCION) !== "inactivo") {
      mal("«recordar» no guarda también la decisión de no usar el módulo");
    }
    recordada.desactivar();
    if (almacen.datos.size !== 0 || recordada.decidido() !== true) {
      mal("«Desactivar» no borra la elección recordada y la deja decidida en la sesión");
    }

    // el contrato con el núcleo: sin él no se abre nada; con él se le pasan relay, coordenada y
    // destino de OPFS, sin que esta página hable WISP
    const hospedadorFalso = { escribir: async () => ({ tipo: "escrito" }), leer: async () => null };
    if (wispMod.nucleoDisponible()) mal("nucleoDisponible ve un núcleo que esta compilación no tiene");
    let sinNucleo = "";
    try {
      await wispMod.resolverPorWisp({
        relay: "wss://wisp.local/wisp/", coordenada: "com.example:prueba:1.0", hospedador: hospedadorFalso,
      });
    } catch (e) { sinNucleo = String(e && e.message ? e.message : e); }
    if (!/núcleo WISP no disponible en esta compilación/.test(sinNucleo)) {
      mal("sin núcleo, resolverPorWisp no dice qué falta: " + sinNucleo);
    }
    const visto = {};
    const globalConNucleo = {
      apkcWisp: {
        version: "apkc-wisp/1",
        obtener: async (peticion) => {
          Object.assign(visto, peticion);
          return { bytes: new Uint8Array([1, 2, 3]), sha256: "ff", ruta: peticion.destino + "prueba-1.0.jar" };
        },
      },
    };
    const conNucleo = await wispMod.resolverPorWisp({
      relay: "wss://wisp.local/wisp/", coordenada: "com.example:prueba:1.0",
      hospedador: hospedadorFalso, global: globalConNucleo,
    });
    if (!conNucleo || conNucleo.bytes.length !== 3 ||
        visto.relay !== "wss://wisp.local/wisp/" || visto.coordenada !== "com.example:prueba:1.0" ||
        visto.destino !== "/deps/com.example/prueba/1.0/") {
      mal("el contrato del núcleo no recibe relay, coordenada y destino: " + JSON.stringify(visto));
    }
    let relaySinBarra = "";
    try {
      await wispMod.resolverPorWisp({
        relay: "wss://wisp.local/wisp", coordenada: "com.example:prueba:1.0",
        hospedador: hospedadorFalso, global: globalConNucleo,
      });
    } catch (e) { relaySinBarra = String(e && e.message ? e.message : e); }
    if (!/acabar en «\/»/.test(relaySinBarra)) mal("el relay sin barra final no se rechaza: " + relaySinBarra);
    for (const mala of ["com.example:", "com.example:prueba", "../x:y:1.0", "a:b:1.0:extra"]) {
      let fallo = "";
      try { wispMod.destinoDeCoordenada(mala); } catch (e) { fallo = String(e && e.message ? e.message : e); }
      if (!fallo) mal("destinoDeCoordenada acepta una coordenada rota: " + JSON.stringify(mala));
    }

    // el contrato de CAs: el bundle sale del dispositivo, se valida como `CargarCAsPEM` y se pasa
    // al núcleo como `{pem, huella}`. La clave es texto: no hay ningún binario versionado.
    const derCA = "MIIDAjCCAeqgAwIBAgIUcfLu8HtBeK0Pc4ZtX36u3FU77OswDQYJKoZIhvcNAQEL" +
      "BQAwITEfMB0GA1UEAwwWYXBrYy1zdHVkaW8gcHJ1ZWJhIENBczAeFw0yNjExMjQw" +
      "NDE2MzZaFw0zNjExMjEwNDE2MzZaMCExHzAdBgNVBAMMFmFwa2Mtc3R1ZGlvIHBy" +
      "dWViYSBDQXMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCfNXjQA/mO" +
      "w6KFf77v0K4iszPUBH2P9x3GvgaThIx5Hk8j0Mc1URGaYFKPdAC6mIitGt+EB2MF" +
      "BfvIbBje564rZflcjKPzY0OMbfb4Kf3naZuNXehSFhoDCL49O5j8AmMkDnXVMe2M" +
      "Ns6W9kmAJRSQtD6z2tYHm5p4KDrSvDyapPmNT+5+4lVa/IZUUnBh1OUZtO6IVyjF" +
      "E9lXv4NZ2ToFgqzx0eMdwXNv/h6vjGjJ3mXM0vt1CyHB4OQxKt63bO6pDeou3HF2" +
      "B9WGbiSrhDacGzm5qGRSuswYSkJJ2Ed9xXH4CpdaNaxE+xpK4dPgy+IwoT3kHBpE" +
      "NWq1TcBmLSWLAgMBAAGjMjAwMB0GA1UdDgQWBBRIgcsCpoXOy9Z1uGO79MVtLAOn" +
      "pjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBizkZ9Glrqeuze" +
      "YyKe2ekq6SnTuqrTPuSre0+jWBTXsukdyZ1oW4K4IGFD30fb81PDsV1aMADUHtwO" +
      "Go1a3x3l/EypLdJtRkNt/hpyvdjjp0RJTc6p3pOxBMrDAQVKhtSn7cVU5xjhnbZb" +
      "FD48IEf8WgnXYs39VoDb5paybSnwUSGDUR+FvEcj4qpsaYoNunXSjBMR76TgRTyU" +
      "T+fMAgzuxdtiCNoSX7zj9rQLa/QhPpbDL0ivZRA6pas5NnRjgrwBMVLBXj7k4YOE" +
      "kGeizPtoymklUU1ak9Ag8Xyc2eGxT9VeztyRh7Y+RCNFA3HwdbkfPBFBW7O21tO5" +
      "11dIxSEU";
    const armarPEM = (b64) => "-----BEGIN CERTIFICATE-----\n" +
      String(b64).match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n";
    const pemCA = armarPEM(derCA);
    const bytesCA = new TextEncoder().encode(pemCA);
    // el PEM de prueba es un certificado autocertificado de verdad: node lo parsea
    const certCA = new X509Certificate(pemCA);
    if (!/apkc-studio/.test(certCA.subject)) {
      mal("el PEM de prueba no es el certificado autocertificado: " + certCA.subject);
    }
    const problemaPEM = wispMod.validarCAsPEM(pemCA);
    if (problemaPEM) mal("validarCAsPEM rechaza un bundle válido: " + problemaPEM);
    for (const basura of ["", "no es pem", "-----BEGIN CERTIFICATE-----\nAAAA\n",
      "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
      pemCA + "basura", "----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"]) {
      if (!wispMod.validarCAsPEM(basura)) {
        mal("validarCAsPEM acepta basura: " + JSON.stringify(basura).slice(0, 90));
      }
    }
    if (wispMod.nombreCASValido("ca.pem") || wispMod.nombreCASValido("CA.CRT")) {
      mal("nombreCASValido rechaza un .pem/.crt local");
    }
    for (const nombre of ["https://relay.example/ca.pem", "ca.pfx", "certificados/ca.pem", ""]) {
      if (!wispMod.nombreCASValido(nombre)) {
        mal("nombreCASValido acepta un fichero que no es un .pem/.crt local: " + JSON.stringify(nombre));
      }
    }

    const preparado = await wispMod.prepararCAS({ nombre: "ca.pem", bytes: bytesCA });
    const huellaCA = await depsMod.sha256Hex(bytesCA);
    if (preparado.pem !== pemCA || preparado.bytes !== bytesCA.length || preparado.huella !== huellaCA) {
      mal("prepararCAS no devuelve el PEM y su huella sha256: " + JSON.stringify(preparado).slice(0, 160));
    }
    const fijado = await wispMod.prepararCAS({
      nombre: "ca.pem", bytes: bytesCA, huellaEsperada: huellaCA.toUpperCase().replace(/(..)/g, "$1:").slice(0, -1),
    });
    if (fijado.huella !== huellaCA) mal("prepararCAS no acepta la huella esperada en mayúscula y con «:»");
    let huellaMala = "";
    try {
      await wispMod.prepararCAS({ nombre: "ca.pem", bytes: bytesCA, huellaEsperada: "00".repeat(32) });
    } catch (e) { huellaMala = String(e && e.message ? e.message : e); }
    if (!/no coincide/.test(huellaMala)) mal("prepararCAS acepta un bundle con la huella equivocada: " + huellaMala);
    let casGrande = "";
    try {
      await wispMod.prepararCAS({ nombre: "ca.pem", bytes: new Uint8Array(64 * 1024 + 1).fill(10) });
    } catch (e) { casGrande = String(e && e.message ? e.message : e); }
    if (!/64 KiB/.test(casGrande)) mal("prepararCAS no acota el bundle a 64 KiB: " + casGrande);
    let casBasura = "";
    try {
      await wispMod.prepararCAS({ nombre: "ca.pem", bytes: new TextEncoder().encode("basura") });
    } catch (e) { casBasura = String(e && e.message ? e.message : e); }
    if (!/CERTIFICATE/.test(casBasura)) mal("prepararCAS acepta un fichero que no es PEM: " + casBasura);
    let casUrl = "";
    try {
      await wispMod.prepararCAS({ nombre: "https://relay.example/ca.pem", bytes: bytesCA });
    } catch (e) { casUrl = String(e && e.message ? e.message : e); }
    if (!/no de una URL/.test(casUrl)) mal("prepararCAS acepta un nombre con URL: " + casUrl);

    // el puente: sin núcleo lo dice, con núcleo sin CAs lo dice, y con el puente recibe {pem, huella}
    let sinNucleoCA = "";
    try { await wispMod.cargarCAsEnNucleo({ pem: pemCA, huella: huellaCA, global: {} }); }
    catch (e) { sinNucleoCA = String(e && e.message ? e.message : e); }
    if (!/núcleo WISP no disponible en esta compilación/.test(sinNucleoCA)) {
      mal("sin núcleo, cargarCAsEnNucleo no dice qué falta: " + sinNucleoCA);
    }
    let sinPuente = "";
    try {
      await wispMod.cargarCAsEnNucleo({
        pem: pemCA, huella: huellaCA,
        global: { apkcWisp: { version: "apkc-wisp/1", obtener: async () => ({}) } },
      });
    } catch (e) { sinPuente = String(e && e.message ? e.message : e); }
    if (!/sin carga de CAs/.test(sinPuente)) {
      mal("un núcleo sin apkcWispCargarCAs no se rechaza con motivo: " + sinPuente);
    }
    let payloadCA = null;
    const globalCAS = {
      apkcWisp: { version: "apkc-wisp/1", obtener: async () => ({}) },
      apkcWispCargarCAs: async (peticion) => { payloadCA = peticion; return { ok: true }; },
    };
    await wispMod.cargarCAsEnNucleo({ pem: pemCA, huella: huellaCA, global: globalCAS });
    if (!payloadCA || payloadCA.pem !== pemCA || payloadCA.huella !== huellaCA ||
        Object.keys(payloadCA).sort().join(",") !== "huella,pem") {
      mal("apkcWispCargarCAs no recibe exactamente {pem, huella}: " + JSON.stringify(payloadCA).slice(0, 160));
    }
    // y Resolver carga las CAs antes de abrir el relay: el orden es contrato
    const ordenCA = [];
    const globalOrden = {
      apkcWisp: {
        version: "apkc-wisp/1",
        obtener: async () => { ordenCA.push("obtener"); return { bytes: new Uint8Array([1]), sha256: "ff", ruta: "/deps/x" }; },
      },
      apkcWispCargarCAs: async () => { ordenCA.push("cas"); return { ok: true }; },
    };
    await wispMod.resolverPorWisp({
      relay: "wss://wisp.local/wisp/", coordenada: "com.example:prueba:1.0",
      hospedador: hospedadorFalso, cas: preparado, global: globalOrden,
    });
    if (ordenCA.join(",") !== "cas,obtener") {
      mal("resolverPorWisp no carga las CAs antes de usar el relay: " + ordenCA.join(","));
    }

    // El BOM UTF-8 marca el fichero, no el PEM: la huella se calcula sobre el texto que se entrega
    // al núcleo, así que `sha256(pem) === huella` siempre. Falsificación que dejó la auditoría de
    // CAs: con la huella tomada del fichero crudo (70 bytes) y el PEM entregado (67), el núcleo
    // recibiría un par que no valida nada.
    const conBOM = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesCA]);
    const preparadoBOM = await wispMod.prepararCAS({ nombre: "ca.pem", bytes: conBOM });
    const huellaPEMEntregado = await depsMod.sha256Hex(new TextEncoder().encode(preparadoBOM.pem));
    const huellaFicheroCrudo = await depsMod.sha256Hex(conBOM);
    console.log("  BOM: bytes=" + conBOM.length + " pemBytes=" + preparadoBOM.bytes +
      " sha256(pem)=" + preparadoBOM.huella.slice(0, 12) +
      " sha256(fichero)=" + huellaFicheroCrudo.slice(0, 12));
    if (preparadoBOM.pem !== pemCA) {
      mal("el BOM (U+FEFF) llega al PEM que se entrega al núcleo");
    }
    if (preparadoBOM.bytes !== bytesCA.length) {
      mal("prepararCAS cuenta los bytes del fichero y no los del PEM entregado: " + preparadoBOM.bytes +
        " frente a " + bytesCA.length);
    }
    if (preparadoBOM.huella !== huellaPEMEntregado) {
      mal("sha256(pem) no es la huella del bundle: " + preparadoBOM.huella + " frente a " + huellaPEMEntregado);
    }
    if (huellaPEMEntregado === huellaFicheroCrudo) {
      mal("la falsificación por el fichero crudo no diverge: la prueba no prueba nada");
    }
    // y el núcleo recibe exactamente ese par, coherente
    let payloadBOM = null;
    const globalBOM = {
      apkcWisp: { version: "apkc-wisp/1", obtener: async () => ({}) },
      apkcWispCargarCAs: async (peticion) => { payloadBOM = peticion; return { ok: true }; },
    };
    await wispMod.cargarCAsEnNucleo({
      pem: preparadoBOM.pem, huella: preparadoBOM.huella, global: globalBOM,
    });
    if (!payloadBOM || payloadBOM.pem !== preparadoBOM.pem || payloadBOM.huella !== preparadoBOM.huella) {
      mal("apkcWispCargarCAs no recibe el par {pem, huella} del bundle con BOM: " +
        JSON.stringify(payloadBOM).slice(0, 160));
    }
    if (await depsMod.sha256Hex(new TextEncoder().encode(payloadBOM.pem)) !== payloadBOM.huella) {
      mal("el núcleo recibe una huella que no es el sha256 del PEM entregado");
    }
    // el puente corta el par incoherente: la huella del fichero crudo no vale con el PEM sin BOM
    let parIncoherente = "";
    try {
      await wispMod.cargarCAsEnNucleo({
        pem: preparadoBOM.pem, huella: huellaFicheroCrudo, global: globalBOM,
      });
    } catch (e) { parIncoherente = String(e && e.message ? e.message : e); }
    if (!/no es el sha256 del PEM/.test(parIncoherente)) {
      mal("cargarCAsEnNucleo acepta una huella que no es el sha256 del PEM: " + parIncoherente);
    }
    // el BOM no añade bytes fuera de bloque: un segundo BOM o basura detrás siguen rechazados
    for (const [etiqueta, bytesMalos] of [
      ["un BOM doble", new Uint8Array([0xef, 0xbb, 0xbf, ...conBOM])],
      ["un BOM con basura detrás", new Uint8Array([...conBOM, ...new TextEncoder().encode("basura")])],
    ]) {
      let rechazo = "";
      try { await wispMod.prepararCAS({ nombre: "ca.pem", bytes: bytesMalos }); }
      catch (e) { rechazo = String(e && e.message ? e.message : e); }
      if (!/fuera de un bloque|CERTIFICATE/.test(rechazo)) {
        mal("prepararCAS acepta " + etiqueta + ": " + rechazo);
      }
    }
    // la huella esperada se compara con la del PEM entregado, no con la del fichero
    const fijadoBOM = await wispMod.prepararCAS({
      nombre: "ca.pem", bytes: conBOM, huellaEsperada: huellaPEMEntregado,
    });
    if (fijadoBOM.huella !== preparadoBOM.huella) {
      mal("prepararCAS no acepta como esperada la huella del PEM entregado");
    }

    // el aviso dice las cuatro cosas que importan, y las dice el HTML que se pinta, no una copia
    const desdeAviso = html.indexOf('id="wisp-aviso"');
    const hastaAviso = desdeAviso < 0 ? -1 : html.indexOf("</dialog>", desdeAviso);
    const textoAviso = (desdeAviso >= 0 && hastaAviso > desdeAviso)
      ? html.slice(desdeAviso, hastaAviso).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
    if (!textoAviso) mal("index.html no tiene el diálogo #wisp-aviso");
    for (const frase of wispMod.AVISO) {
      if (!textoAviso.includes(frase.replace(/\s+/g, " ").trim())) {
        mal("el aviso de WISP no dice: «" + frase + "»");
      }
    }
    for (const id of ["wisp-aviso", "wisp-aviso-activar", "wisp-aviso-cancelar", "wisp-recordar",
      "wisp-estado", "wisp-activar", "wisp-desactivar", "wisp-selector", "wisp-relay", "wisp-url",
      "wisp-url-estado", "wisp-cas", "wisp-cas-huella", "wisp-cas-estado"]) {
      if (!ids.has(id)) mal("index.html no tiene el id del módulo WISP #" + id);
    }
    // el selector nace plegado: sin opt-in no hay nada que elegir
    const bloqueWisp = html.slice(html.indexOf('id="deps-wisp"'), desdeAviso);
    if (!/id="wisp-selector" hidden/.test(bloqueWisp)) {
      mal("el selector de relays no nace oculto en index.html");
    }
    const fuenteWisp = fs.readFileSync(path.join(__dirname, "wisp.js"), "utf8");
    const swFuente = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
    for (const pieza of ['"./wisp.js"', '"./wisp-relays.json"']) {
      if (!swFuente.includes(pieza)) mal("sw.js no cachea " + pieza + " en el shell");
    }
    // y no se cuela un cliente en JS: el framing y el TLS son del núcleo
    if (/new WebSocket|createWebSocket|crypto\.subtle\.sign|subtle\.encrypt/i.test(fuenteWisp)) {
      mal("wisp.js abre un socket o hace criptografía: ese trabajo es del núcleo");
    }

    // el panel: sin opt-in Resolver sigue por el índice del propio origen; con opt-in y sin
    // núcleo, dice qué falta y no pide nada
    const anteriorDocumento = globalThis.document;
    const nodo = (extra) => Object.assign({
      textContent: "", value: "", hidden: false, disabled: false, children: [],
      classList: { toggle() {}, remove() {}, add() {} },
      addEventListener() {}, appendChild(hijo) { this.children.push(hijo); },
    }, extra || {});
    const porId = {};
    for (const id of ["deps-coordenada", "deps-resolver", "deps-estado", "deps-resultado",
      "deps-nombre", "deps-bytes", "deps-hash", "deps-ruta", "deps-indice", "deps-licencia",
      "deps-fecha", "deps-ficheros", "deps-soltar", "deps-progreso", "deps-importar-estado",
      "deps-importado", "deps-importado-ficheros", "deps-importado-bytes",
      "deps-importado-destino", "deps-importado-descriptor"]) {
      porId[id] = nodo();
    }
    for (const id of ["wisp-estado", "wisp-activar", "wisp-desactivar", "wisp-selector",
      "wisp-relay", "wisp-url", "wisp-url-estado", "wisp-aviso", "wisp-recordar",
      "wisp-cas", "wisp-cas-huella", "wisp-cas-estado"]) {
      porId[id] = nodo();
    }
    porId["wisp-aviso"].open = false;
    porId["wisp-relay"].appendChild = function (hijo) { this.children.push(hijo); };
    globalThis.document = {
      getElementById: (id) => porId[id] || null,
      createElement: () => nodo(),
      addEventListener() {}, dispatchEvent() { return true; },
    };
    try {
      // (a) el selector no se ve con el módulo apagado, y se ve al decidirlo sin recordar
      const panelWisp = wispMod.crearPanelWisp({
        hospedador: hospedadorFalso, almacen: null,
        fetchImpl: async () => ({
          ok: true, status: 200, headers: { get: () => "application/json" },
          text: async () => JSON.stringify(crudoRelays),
        }),
      });
      if (!porId["wisp-selector"].hidden) mal("el selector de relays se pinta con el módulo apagado");
      const decision = await panelWisp.asegurarDecision();
      if (decision !== false || porId["wisp-selector"].hidden !== true) {
        mal("sin diálogo en el documento, «asegurarDecision» no cae al modo seguro (apagado)");
      }
      panelWisp.decidir(true);
      await new Promise((r) => setTimeout(r, 0));
      if (porId["wisp-selector"].hidden) mal("al activar el módulo no aparece el selector de relays");
      if (porId["wisp-relay"].children.length !== 6) {
        mal("el selector de relays no lista los 6 conocidos: " + porId["wisp-relay"].children.length);
      }
      if (!/400 ms/.test(String(porId["wisp-relay"].children[0].textContent))) {
        mal("el selector no muestra la latencia medida del primer relay");
      }

      // (a2) el fichero de CAs del dispositivo: válido se acepta con su huella, basura se rechaza
      const casPanel = await panelWisp.seleccionarCAS({ name: "ca.pem", bytes: bytesCA });
      if (!casPanel || !panelWisp.casActual() || panelWisp.casActual().huella !== huellaCA ||
          !/aceptadas/.test(String(porId["wisp-cas-estado"].textContent))) {
        mal("el panel no acepta un PEM local válido con su huella: " +
          String(porId["wisp-cas-estado"].textContent));
      }
      let casPanelBasura = "";
      try {
        await panelWisp.seleccionarCAS({ name: "ca.pem", bytes: new TextEncoder().encode("basura") });
      } catch (e) { casPanelBasura = String(e && e.message ? e.message : e); }
      if (!/CERTIFICATE/.test(casPanelBasura) || panelWisp.casActual() ||
          !/rechazadas/.test(String(porId["wisp-cas-estado"].textContent))) {
        mal("el panel no rechaza un fichero con basura y deja de tener CAs: " + casPanelBasura);
      }
      let casPanelUrl = "";
      try {
        await panelWisp.seleccionarCAS({ name: "https://relay.example/ca.pem", bytes: bytesCA });
      } catch (e) { casPanelUrl = String(e && e.message ? e.message : e); }
      if (!/no de una URL/.test(casPanelUrl) || panelWisp.casActual()) {
        mal("el panel acepta un .pem con nombre de URL: " + casPanelUrl);
      }

      // (b) sin opt-in, el panel de dependencias sigue pidiendo el índice del propio origen
      const llamadas = [];
      const fetchContador = async (url) => {
        llamadas.push(String(url));
        return { ok: false, status: 404, headers: { get: () => null }, text: async () => "" };
      };
      porId["deps-coordenada"].value = "com.example:prueba:1.0";
      const panelLocal = depsMod.crearPanelDeps({
        hospedador: hospedadorFalso,
        wisp: { asegurarDecision: async () => false, relayActual() { throw new Error("no se debe llamar"); } },
      });
      globalThis.fetchOriginal = globalThis.fetch;
      globalThis.fetch = fetchContador;
      try { await panelLocal.resolver(); } finally { globalThis.fetch = globalThis.fetchOriginal; }
      if (llamadas.length !== 1 || llamadas[0] !== "./deps-index.json") {
        mal("sin opt-in, Resolver no fue solo al índice del propio origen: " + JSON.stringify(llamadas));
      }
      if (!/no hay deps-index\.json/.test(String(porId["deps-estado"].textContent))) {
        mal("sin opt-in, Resolver no dice que falta el índice: " + porId["deps-estado"].textContent);
      }

      // (c) con opt-in y sin núcleo, Resolver no abre ningún relay y lo dice
      const llamadasWisp = [];
      const fetchWisp = async (url) => { llamadasWisp.push(String(url)); throw new Error("no hay red en esta compilación"); };
      const panelWispDeps = depsMod.crearPanelDeps({
        hospedador: hospedadorFalso,
        wisp: { asegurarDecision: async () => true, relayActual: () => "wss://wisp.local/wisp/" },
      });
      globalThis.fetchOriginal = globalThis.fetch;
      globalThis.fetch = fetchWisp;
      try { await panelWispDeps.resolver(); } finally { globalThis.fetch = globalThis.fetchOriginal; }
      if (llamadasWisp.length !== 0) {
        mal("con el módulo activo y sin núcleo se hizo una petición: " + JSON.stringify(llamadasWisp));
      }
      if (!/núcleo WISP no disponible en esta compilación/.test(String(porId["deps-estado"].textContent))) {
        mal("con el módulo activo y sin núcleo, el panel no dice qué falta: " + porId["deps-estado"].textContent);
      }
      if (!/^error/.test(String(porId["deps-estado"].textContent))) {
        mal("el fallo del núcleo no se pinta como error en el panel");
      }
    } finally {
      globalThis.document = anteriorDocumento;
      if (globalThis.fetchOriginal) { globalThis.fetch = globalThis.fetchOriginal; delete globalThis.fetchOriginal; }
    }
  }

  // 13. F1, C1-C4 y F2: contratos del editor que no se pueden conducir sin DOM. Aquí se fija la
  //     decisión pura y el orden del fuente; la carrera real de pestañas y el panel
  //     `#ultimo-codigo` se conducen en `prueba-pestana.js`, que necesita chromium.
  {
    // F2: los ajustes se aplican sobre el buffer abierto, no sobre la copia de OPFS
    const manifiestoSucio = { ruta: "/proyecto/AndroidManifest.xml", texto: "<manifest/>", sucio: true };
    if (bufferDelManifiesto(manifiestoSucio, true, "<manifest a/>") !== "<manifest a/>") {
      mal("bufferDelManifiesto ignora el buffer del documento activo");
    }
    if (bufferDelManifiesto(manifiestoSucio, false, null) !== "<manifest/>") {
      mal("bufferDelManifiesto pierde el texto de una pestaña sucia inactiva");
    }
    if (bufferDelManifiesto({ texto: null, sucio: false }, false, null) !== null ||
        bufferDelManifiesto(null, false, null) !== null) {
      mal("bufferDelManifiesto no cae a OPFS cuando no hay buffer");
    }

    // C1: la frase del panel cuando el build ni siquiera empieza
    if (pestanaMod.mensajeNoCompile("falta el android.jar") !== "no compilé: falta el android.jar" ||
        pestanaMod.mensajeNoCompile("") !== "no compilé") {
      mal("mensajeNoCompile no dice «no compilé» con y sin motivo");
    }

    // F1/C1-C4: el orden del fuente es el contrato que las pruebas CDP no pueden fijar
    const entre = (inicio, fin) => {
      const i = pestana.indexOf(inicio);
      const j = i < 0 ? -1 : pestana.indexOf(fin, i + inicio.length);
      return i < 0 || j < 0 ? "" : pestana.slice(i, j);
    };
    const guardarFn = entre("async function guardar()", "async function guardarParaCompilar()");
    const guardaIdx = guardarFn.indexOf("if (cargandoDocumento)");
    const primerAwaitGuardar = guardarFn.indexOf("await");
    if (guardaIdx < 0 || (primerAwaitGuardar > 0 && guardaIdx > primerAwaitGuardar)) {
      mal("F1: guardar() no se bloquea antes de su primer await mientras una pestaña lee OPFS");
    }
    const activarFn = entre("async function activarDocumento(", "async function cerrarDocumento(");
    const marcaIdx = activarFn.indexOf("cargandoDocumento += 1");
    const primerAwaitActivar = activarFn.indexOf("await");
    if (marcaIdx < 0 || primerAwaitActivar < 0 || marcaIdx > primerAwaitActivar ||
        !/finally/.test(activarFn)) {
      mal("F1: activarDocumento no marca la carga antes de leer OPFS con try/finally");
    }
    const compilarFn = entre("async function compilarCon(", "async function previsualizarLoCompilado(");
    if (!/noCompile\(/.test(compilarFn) || !/build: tipo/.test(compilarFn)) {
      mal("C1/C3: compilarCon no dice «no compilé» o no recuerda el build para Ctrl+Enter");
    }
    const verificarFn = entre("async function verificarLoCompilado(", "// --- ajustes del proyecto");
    if (!/recordar: false/.test(verificarFn)) {
      mal("C2: el verify interno sigue pisando #ultimo-codigo");
    }
    const correrFn = entre("async function correr(argv", "// Go wasm no se puede matar");
    if (!/ULTIMO\.argv = redactarArgv\(argv\)/.test(correrFn) || /ULTIMO\.argv = argv/.test(correrFn)) {
      mal("C4: correr guarda el argv con la contraseña en ULTIMO.argv");
    }
    const ejecutarFn = entre("async function ejecutarUltimo(", "// La línea que se pinta");
    if (!/ULTIMO\.build/.test(ejecutarFn) || !/compilarDebug\(\)/.test(ejecutarFn)) {
      mal("C3: Ctrl+Enter no repite un build por el camino que guarda los sucios");
    }

    // F5: el tecleo durante la ventana de carga se rechaza con aviso y no ensucia el documento
    // nuevo. La política es pura (tres funciones) y el orden del fuente prueba que el listener y
    // `marcarSucio` la consultan; si se acepta la entrada o se marca sucio un `texto=null`, falla.
    if (!/espera/.test(pestanaMod.rechazoTecleo(1) || "")) {
      mal("F5: no hay aviso al rechazar el tecleo durante la carga");
    }
    if (pestanaMod.rechazoTecleo(0) !== null) {
      mal("F5: rechaza el tecleo con la pestaña ya cargada");
    }
    const docNuevo = { ruta: "/proyecto/B.java", texto: null, sucio: false };
    if (pestanaMod.aceptarEntrada(docNuevo, 1)) {
      mal("F5: acepta tecleo mientras la pestaña lee OPFS: el texto se descartaría después");
    }
    if (!pestanaMod.aceptarEntrada(docNuevo, 0)) {
      mal("F5: rechaza el tecleo con la pestaña cargada");
    }
    if (pestanaMod.puedeMarcarSucio(docNuevo, 1)) {
      mal("F5: marca sucio un documento con texto=null durante la carga");
    }
    if (!pestanaMod.puedeMarcarSucio(docNuevo, 0)) {
      mal("F5: no deja marcar sucio un documento limpio ya cargado (texto=null es normal)");
    }
    if (!pestanaMod.puedeMarcarSucio({ ruta: "/proyecto/A.java", texto: "x" }, 1)) {
      mal("F5: pierde el estado sucio de un documento ya leído al terminar la carga");
    }
    const entradaFn = entre('area.addEventListener("input"', 'area.addEventListener("scroll"');
    const aceptaIdx = entradaFn.indexOf("aceptarEntrada(");
    const sucioIdx = entradaFn.indexOf("marcarSucio(true)");
    if (aceptaIdx < 0 || sucioIdx < 0 || aceptaIdx > sucioIdx) {
      mal("F5: el listener de input marca sucio antes de consultar la política de carga");
    }
    const marcarFn = entre("function marcarSucio(", "function estaSucio(");
    if (!/puedeMarcarSucio\(/.test(marcarFn)) {
      mal("F5: marcarSucio no consulta la política de carga");
    }
    const activarF5 = entre("async function activarDocumento(", "async function cargarDocumentoEnEditor(");
    const bloqueoIdx = activarF5.indexOf("bloquearTecleo()");
    const primerAwaitF5 = activarF5.indexOf("await");
    if (bloqueoIdx < 0 || primerAwaitF5 < 0 || bloqueoIdx > primerAwaitF5 ||
        !/finally[\s\S]*bloquearTecleo\(\)/.test(activarF5)) {
      mal("F5: el textarea no se cierra a la escritura antes de leer OPFS con try/finally");
    }
    const bloquearFn = entre("function bloquearTecleo(", "async function activarDocumento(");
    if (!/readOnly\s*=\s*bloqueado/.test(bloquearFn) || !/aria-busy/.test(bloquearFn)) {
      mal("F5: bloquearTecleo no cierra el textarea a la escritura ni marca aria-busy");
    }
  }

  // 14. F4: la importación no mezcla el zip con el árbol viejo ni deja un proyecto a medias.
  //     Decisión y rollback son puros (el fs entra por parámetro), así que se falsifican aquí.
  {
    // el borrado falla y hay proyecto previo: se aborta antes de escribir nada
    const aborta = pestanaMod.decidirImportacion({ nodos: 2, borradoDelDisco: false, existia: true });
    if (aborta.puede || !/cancela/.test(aborta.motivo)) {
      mal("F4: decidirImportacion deja pasar la importación con /proyecto sin borrar");
    }
    if (!pestanaMod.decidirImportacion({ nodos: 0, borradoDelDisco: true }).puede) {
      mal("F4: decidirImportacion bloquea la importación con /proyecto ya borrado");
    }
    if (!pestanaMod.decidirImportacion({ nodos: 0, borradoDelDisco: false, existia: false }).puede) {
      mal("F4: decidirImportacion bloquea la primera importación (no había /proyecto)");
    }
    if (pestanaMod.decidirImportacion(null).puede) {
      mal("F4: decidirImportacion acepta una limpieza sin respuesta");
    }

    // camino del aborto: no se escribe ni una entrada y el espejo del worker se refresca
    let escrituras = 0, refrescos = 0;
    const aborto = await pestanaMod.reemplazarProyecto({
      entradas: [{ ruta: "AndroidManifest.xml", datos: "nuevo" }],
      previo: [{ ruta: "A.java", datos: "viejo" }],
      prefijo: "/proyecto",
      limpiar: async () => ({ nodos: 1, borradoDelDisco: false, existia: true }),
      escribir: async () => { escrituras++; return { tipo: "montado" }; },
      refrescar: async () => { refrescos++; },
    });
    if (aborto.ok || aborto.restaurado !== true || escrituras !== 0 || refrescos !== 1) {
      mal("F4: con el borrado fallido la importación escribe o no refresca el árbol");
    }

    // falla la segunda escritura: vuelve la copia previa entera, sin restos del zip
    const disco = new Map([["/proyecto/A.java", "viejo"]]);
    let paso = 0;
    const vuelta = await pestanaMod.reemplazarProyecto({
      entradas: [{ ruta: "AndroidManifest.xml", datos: "nuevo" },
        { ruta: "B.java", datos: "nuevoB" }],
      previo: [{ ruta: "A.java", datos: "viejo" }],
      prefijo: "/proyecto",
      limpiar: async () => { disco.clear(); return { nodos: 1, borradoDelDisco: true, existia: true }; },
      escribir: async (ruta, datos) => {
        paso++;
        if (paso === 2) return { tipo: "error", error: "QuotaExceededError" };
        disco.set(ruta, datos);
        return { tipo: "montado" };
      },
      refrescar: async () => {},
    });
    if (vuelta.ok || vuelta.restaurado !== true) {
      mal("F4: una escritura fallida a mitad se da por buena");
    }
    if (disco.size !== 1 || disco.get("/proyecto/A.java") !== "viejo") {
      mal("F4: el rollback no devuelve la copia previa de /proyecto");
    }

    // tampoco se puede restaurar: /proyecto queda vacío y la respuesta dice que no hubo vuelta
    const sucio = new Map([["/proyecto/A.java", "viejo"]]);
    let otro = 0;
    const perdido = await pestanaMod.reemplazarProyecto({
      entradas: [{ ruta: "AndroidManifest.xml", datos: "nuevo" },
        { ruta: "B.java", datos: "nuevoB" }],
      previo: [{ ruta: "A.java", datos: "viejo" }],
      prefijo: "/proyecto",
      limpiar: async () => { sucio.clear(); return { nodos: 1, borradoDelDisco: true, existia: true }; },
      escribir: async (ruta, datos) => {
        otro++;
        if (otro >= 2) return { tipo: "error", error: "QuotaExceededError" };
        sucio.set(ruta, datos);
        return { tipo: "montado" };
      },
      refrescar: async () => {},
    });
    if (perdido.ok || perdido.restaurado !== false) {
      mal("F4: sin rollback posible la importación se declara buena");
    }
    if (sucio.size !== 0) {
      mal("F4: sin rollback posible queda una mezcla silenciosa en /proyecto");
    }

    // el orden del fuente: la copia se lee antes de limpiar y el fallo no sigue como éxito
    const importarFn = pestana.slice(
      pestana.indexOf("async function importarProyecto("),
      pestana.indexOf("// --- documentos abiertos"));
    if (!importarFn || importarFn.indexOf("copiaDelProyecto()") < 0 ||
        importarFn.indexOf("copiaDelProyecto()") > importarFn.indexOf("conBloqueo(")) {
      mal("F4: importarProyecto no copia /proyecto antes de limpiarlo");
    }
    if (!/reemplazarProyecto\(/.test(importarFn) || !/resultado\.ok/.test(importarFn)) {
      mal("F4: importarProyecto no comprueba el resultado del reemplazo");
    }
  }

  // 15. F3: la revisión y las escrituras compartidas van bajo `conBloqueo` (Web Locks). Es un
  //     contrato del fuente que la prueba de node no puede conducir sin DOM; la carrera real de
  //     dos pestañas se conduce en `prueba-pestana.js`, que necesita chromium.
  {
    const entreFuente = (fuente, inicio, fin) => {
      const i = fuente.indexOf(inicio);
      const j = i < 0 ? -1 : fuente.indexOf(fin, i + inicio.length);
      return i < 0 || j < 0 ? "" : fuente.slice(i, j);
    };

    // TOCTOU: en `guardar()` la revisión se lee y se confirma dentro del mismo bloqueo que escribe
    const guardarFn = entreFuente(pestana, "async function guardar()", "async function guardarParaCompilar()");
    const bloqueoGuardar = guardarFn.indexOf("await conBloqueo(async () => {");
    const lecturaRev = guardarFn.indexOf("revisionActual(ruta)");
    const confirmarRev = guardarFn.indexOf('window.confirm("Otra ventana guardó');
    if (bloqueoGuardar < 0 || lecturaRev < bloqueoGuardar || confirmarRev < bloqueoGuardar) {
      mal("guardar() lee o confirma la revisión fuera de conBloqueo: sigue el TOCTOU entre ventanas");
    }

    // el jar entra en OPFS por el mismo bloqueo en los dos caminos que lo escriben
    const jarUrl = entreFuente(pestana, "async function ponerJarDeUrl(", "async function traerJarDelSdk(");
    const jarElegido = entreFuente(pestana, "async function usarJarElegido(", "function actualizarEstadoSdk(");
    for (const [que, cuerpo] of [["ponerJarDeUrl", jarUrl], ["usarJarElegido", jarElegido]]) {
      if (!/conBloqueo\(\(\) => hospedador\.escribir\(RUTA_JAR/.test(cuerpo)) {
        mal(que + " escribe RUTA_JAR sin conBloqueo: dos ventanas pueden pisarse el jar");
      }
    }

    // la imagen del drawable: elegir nombre libre y escribir van bajo el mismo bloqueo
    if (!/export function crearPreviaPanel\(\{[^}]*conBloqueo/.test(fuentePrevia)) {
      mal("crearPreviaPanel no recibe conBloqueo: la importación de imágenes no coordina ventanas");
    }
    const importarFn = entreFuente(fuentePrevia, "async function importarImagen(", "function abrirSelectorImagen(");
    const bloqueoImagen = importarFn.indexOf("await bloquear(async () => {");
    if (bloqueoImagen < 0 ||
        importarFn.indexOf("nombreDrawableLibre(") < bloqueoImagen ||
        importarFn.indexOf("hospedador.escribir(") < bloqueoImagen) {
      mal("importarImagen elige el nombre o escribe el PNG fuera del bloqueo: dos ventanas escogen el mismo drawable");
    }
  }

  // 15. F3: ningún `window.confirm` de `guardar()` puede quedar fuera de un `conBloqueo`. La
  //     rama sin documento activo («Ya existe … ¿Reemplazarlo?») leía y confirmaba antes de
  //     entrar al bloqueo y, como el documento nuevo no traía `revision`, el guard del bloqueo
  //     no disparaba: otra ventana podía crear el fichero entre la confirmación y el `escribir`.
  //     Se recorre el fuente de verdad —los cuerpos de todos los `conBloqueo(...)`— en vez de
  //     dar por bueno el orden de un solo texto literal.
  {
    const fuenteGuardar = (() => {
      const i = pestana.indexOf("async function guardar()");
      const j = i < 0 ? -1 : pestana.indexOf("async function guardarParaCompilar()", i);
      return i < 0 || j < 0 ? "" : pestana.slice(i, j);
    })();
    // rangos [inicio, fin] de cada cuerpo `conBloqueo(… => { … })`, con las llaves emparejadas
    const rangosDeBloqueo = (fuente) => {
      const rangos = [];
      const marca = "conBloqueo(";
      for (let desde = 0; ;) {
        const i = fuente.indexOf(marca, desde);
        if (i < 0) break;
        const abre = fuente.indexOf("{", i);
        if (abre < 0) break;
        let nivel = 0;
        for (let j = abre; j < fuente.length; j++) {
          if (fuente[j] === "{") nivel += 1;
          else if (fuente[j] === "}" && --nivel === 0) { rangos.push([i, j]); break; }
        }
        desde = i + marca.length;
      }
      return rangos;
    };
    const rangos = rangosDeBloqueo(fuenteGuardar);
    const dentro = (indice) => rangos.some(([a, b]) => indice > a && indice < b);
    const confirmes = [...fuenteGuardar.matchAll(/window\.confirm\(/g)].map((m) => m.index);
    if (!confirmes.length) {
      mal("guardar() no tiene ningún window.confirm: la prueba no puede vigilar el TOCTOU");
    }
    for (const indice of confirmes) {
      if (!dentro(indice)) {
        mal("guardar() confirma fuera de conBloqueo: otra ventana puede escribir entre la confirmación y el guardado");
      }
    }
    // la lectura que decide si el fichero ya existe corre con el mismo bloqueo que la escritura
    for (const m of fuenteGuardar.matchAll(/hospedador\.leer\(/g)) {
      if (!dentro(m.index)) {
        mal("guardar() lee OPFS fuera de conBloqueo: la comprobación de «ya existe» sigue siendo TOCTOU");
      }
    }
  }

  // 16. El mtime de lo que ya está en OPFS es el del File, no el de la sesión. apkc mete el mtime
  //     del android.jar en la huella del jar (I5): si cambia al crear un worker nuevo, una recarga
  //     reindexa y recompila I3 entero sin que el fichero haya cambiado. Se falsifica con un OPFS
  //     de mentira, que es lo único que deja fijar el `lastModified` de un File en node.
  {
    const FECHA_JAR = 1700000000000;
    const trozo = (bytes) => ({ arrayBuffer: async () => bytes.slice().buffer });
    const ficheroFalso = (nombre, lastModified, contenido = "") => {
      const datos = { bytes: new TextEncoder().encode(contenido), lastModified };
      return {
        kind: "file", name: nombre,
        async getFile() {
          // lastModified null simula un mango cuyo File no se puede leer (permiso retirado)
          if (datos.lastModified === null) throw Object.assign(new Error("sin File"), { name: "NotReadableError" });
          return {
            name: nombre, size: datos.bytes.length, lastModified: datos.lastModified,
            slice: (ini, fin) => trozo(datos.bytes.slice(ini, fin)),
            arrayBuffer: async () => datos.bytes.slice().buffer,
          };
        },
        async createSyncAccessHandle() {
          return {
            getSize: () => datos.bytes.length,
            read: (buf, { at = 0 } = {}) => { buf.set(datos.bytes.subarray(at, at + buf.length)); return buf.length; },
            write: (buf, { at = 0 } = {}) => {
              const salida = new Uint8Array(Math.max(datos.bytes.length, at + buf.length));
              salida.set(datos.bytes); salida.set(buf, at); datos.bytes = salida;
              return buf.length;
            },
            truncate: (largo) => { datos.bytes = datos.bytes.slice(0, largo); },
            flush: () => {}, close: () => {},
          };
        },
      };
    };
    const carpetaFalsa = (nombre, hijos = {}) => ({
      kind: "directory", name: nombre,
      async getDirectoryHandle(n, { create } = {}) {
        const h = hijos[n];
        if (h && h.kind === "directory") return h;
        if (h) throw Object.assign(new Error("TypeMismatchError"), { name: "TypeMismatchError" });
        if (!create) throw Object.assign(new Error("NotFoundError"), { name: "NotFoundError" });
        const d = carpetaFalsa(n); hijos[n] = d; return d;
      },
      async getFileHandle(n, { create } = {}) {
        const h = hijos[n];
        if (h && h.kind === "file") return h;
        if (h) throw Object.assign(new Error("TypeMismatchError"), { name: "TypeMismatchError" });
        if (!create) throw Object.assign(new Error("NotFoundError"), { name: "NotFoundError" });
        const f = ficheroFalso(n, Date.now()); hijos[n] = f; return f;
      },
      async removeEntry(n) { delete hijos[n]; },
      async *entries() { for (const [n, h] of Object.entries(hijos)) yield [n, h]; },
    });
    const opfsFalso = () => carpetaFalsa("/", {
      sdk: carpetaFalsa("sdk", { "android.jar": ficheroFalso("android.jar", FECHA_JAR, "PK") }),
      proyecto: carpetaFalsa("proyecto", {
        "A.java": ficheroFalso("A.java", FECHA_JAR + 1000, "class A {}"),
        "sin-file.bin": ficheroFalso("sin-file.bin", null, "x"),
      }),
    });
    const statDe = (sistema, ruta) => new Promise((ok, falla) =>
      sistema.fs.stat(ruta, (e, s) => (e ? falla(e) : ok(s))));

    const primera = crearFs(opfsFalso());
    await primera.sincronizar();
    const jarUno = await statDe(primera, "/sdk/android.jar");
    const jarDos = await statDe(primera, "/sdk/android.jar");
    if (jarUno.mtimeMs !== FECHA_JAR || jarDos.mtimeMs !== FECHA_JAR) {
      mal(`el stat inventa el mtime del jar: ${jarUno.mtimeMs} y ${jarDos.mtimeMs}, el File dice ${FECHA_JAR}`);
    }
    // un worker nuevo (la recarga de la pestaña) barre OPFS otra vez: mismo File, mismo mtime
    const segunda = crearFs(opfsFalso());
    await segunda.sincronizar();
    const jarRecargado = await statDe(segunda, "/sdk/android.jar");
    if (jarRecargado.mtimeMs !== jarUno.mtimeMs) {
      mal(`tras recargar el jar cambia de mtime: ${jarUno.mtimeMs} -> ${jarRecargado.mtimeMs} (otra huella de I5)`);
    }
    // sin nodo en memoria (no se barrió) el stat tampoco puede inventarse la fecha
    const sinBarrer = crearFs(opfsFalso());
    const jarSinBarrer = await statDe(sinBarrer, "/sdk/android.jar");
    if (jarSinBarrer.mtimeMs !== FECHA_JAR) {
      mal("el stat de un fichero aún no descubierto inventa el mtime: " + jarSinBarrer.mtimeMs);
    }
    // un mango sin File legible cae a Date.now(), no a NaN ni a 0
    const antes = Date.now();
    const sinFile = await statDe(primera, "/proyecto/sin-file.bin");
    if (!Number.isFinite(sinFile.mtimeMs) || sinFile.mtimeMs < antes - 1000 || sinFile.mtimeMs > Date.now() + 1000) {
      mal("sin File el stat no deja una fecha válida de la sesión: " + sinFile.mtimeMs);
    }
    // y un fichero creado ahora mismo sigue teniendo una fecha válida
    await primera.montar("/proyecto/Nuevo.java", new TextEncoder().encode("class Nuevo {}"));
    const recienCreado = await statDe(primera, "/proyecto/Nuevo.java");
    if (!Number.isFinite(recienCreado.mtimeMs) || recienCreado.mtimeMs < antes - 1000) {
      mal("un fichero montado en la sesión no tiene mtime válido: " + recienCreado.mtimeMs);
    }
  }

  console.log(fallos ? `PRUEBA FALLA: ${fallos} problemas` : "prueba: todo en orden");
  process.exit(fallos ? 1 : 0);
})();
