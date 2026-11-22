// Prueba de la pestaña en CHROMIUM REAL, no en node. La diferencia importa: el fs de Go exige OPFS,
// un worker de tipo module y crossOriginIsolated, y nada de eso existe en node. El shim de
// node ya demostró que apkc corre; aquí se demuestra que la página se lo cree.
//
// uso: sh -c 'APKC_WASM=$PREFIX/tmp/apkc-wasm.wasm APK_EJEMPLO=/ruta/app.apk KS_EJEMPLO=$HOME/.android/debug.keystore node prueba-pestana.js'
// levanta servidor.js, lanza chromium headless por CDP, conduce la página y apaga todo.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || "chromium-browser";

const TMP = process.env.PREFIX ? process.env.PREFIX + "/tmp" : "/tmp";
const WASM = process.env.APKC_WASM || "";
const APK = process.env.APK_EJEMPLO || "";
const KS = process.env.KS_EJEMPLO || "";
// el keystore de release de la prueba: contraseña y alias conocidos, generado por e2e.sh con
// keytool. Es de usar y tirar; no se versiona ninguna clave.
const KS_RELEASE = process.env.KS_RELEASE || "";
// el .aab mínimo de la prueba: un zip con BundleConfig.pb y un módulo, creado por e2e.sh
const AAB = process.env.AAB_EJEMPLO || "";
// el android.jar es opcional: sin él no se puede probar el build completo dentro de la pestaña, y
// la prueba lo dice en la salida en vez de pasar de largo en silencio
const JAR_SRC = process.env.ANDROID_JAR || "";
const PUERTO = Number(process.env.STUDIO_SERVIDOR_PORT || 8791);
const CDP = process.env.STUDIO_PORT || "9345";
const URL_PAGINA = "http://127.0.0.1:" + PUERTO + "/index.html";

let fallos = 0, hechos = 0;
function comprueba(nombre, cond, detalle) {
  if (cond) { hechos++; console.log("  ok   " + nombre + (detalle ? " — " + detalle : "")); }
  else { fallos++; console.log("  FALLA " + nombre + (detalle ? " — " + detalle : "")); }
}
function falta(que) {
  console.error("falta " + que + ": esta prueba no puede jurar nada sin él");
  process.exit(2);
}
if (!WASM || !fs.existsSync(WASM)) falta("APKC_WASM apuntando al binario wasm");
if (!APK || !fs.existsSync(APK)) falta("APK_EJEMPLO apuntando a una apk construida por apkc");
if (!KS || !fs.existsSync(KS)) falta("KS_EJEMPLO apuntando a un keystore");

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Un puerto ocupado por otro servidor (otro worktree, una sesión vieja) hace que la página hable con
// un extraño: los endpoints dinámicos responden «no existe» y la prueba falla por algo que no es el
// código. Se comprueba antes de arrancar y se dice con nombre.
function puertoOcupado(puerto) {
  return new Promise((res) => {
    const sonda = net.createServer();
    sonda.once("error", () => res(true));
    sonda.once("listening", () => sonda.close(() => res(false)));
    sonda.listen(puerto, "127.0.0.1");
  });
}
if (await puertoOcupado(PUERTO)) falta("el puerto " + PUERTO + " ya está ocupado: usa STUDIO_SERVIDOR_PORT");
if (await puertoOcupado(Number(CDP))) falta("el puerto CDP " + CDP + " ya está ocupado: usa STUDIO_PORT");

// --- el servidor y el navegador -----------------------------------------------------------
  // La sección de dependencias lee `./deps-index.json` del propio origen. Para probarla sin red
  // externa, se sirve una copia del árbol de studio con un índice y un artefacto falsos pero bien
  // formados; el árbol real no trae ese índice hasta que el workflow `deps-maven` publique uno.
  const SITIO_PRUEBA = path.join(TMP, "pestana-sitio");
  fs.rmSync(SITIO_PRUEBA, { recursive: true, force: true });
  fs.cpSync(__dirname, SITIO_PRUEBA, { recursive: true });
  const depFalso = Buffer.concat([Buffer.from("PK\u0003\u0004", "binary"), Buffer.alloc(2048, 0x41)]);
  depFalso.write("prueba de dependencias de apkc studio", 4, "utf8");
  const hashDepFalso = createHash("sha256").update(depFalso).digest("hex");
  const coordFalsa = "com.example:prueba:1.0";
  fs.mkdirSync(path.join(SITIO_PRUEBA, "deps/com.example/prueba/1.0"), { recursive: true });
  fs.writeFileSync(path.join(SITIO_PRUEBA, "deps/com.example/prueba/1.0/prueba-1.0.jar"), depFalso);
  fs.writeFileSync(path.join(SITIO_PRUEBA, "deps-index.json"), JSON.stringify({
    version: 1,
    generado: "2026-11-22T00:00:00Z",
    artefactos: [{
      coordenada: coordFalsa, grupo: "com.example", artefacto: "prueba", version: "1.0",
      extension: "jar", fichero: "deps/com.example/prueba/1.0/prueba-1.0.jar",
      bytes: depFalso.length, sha256: hashDepFalso,
    }],
  }, null, 2));
  const envServidor = { ...process.env, SITIO_DIR: SITIO_PRUEBA,
    APKC_WASM: path.resolve(WASM), APK_EJEMPLO: path.resolve(APK), KS_EJEMPLO: path.resolve(KS) };
  if (KS_RELEASE) envServidor.KS_RELEASE = path.resolve(KS_RELEASE);
  if (AAB) envServidor.AAB_EJEMPLO = path.resolve(AAB);
  if (JAR_SRC) envServidor.ANDROID_JAR = path.resolve(JAR_SRC);
  const servidor = spawn(process.execPath, [path.join(__dirname, "servidor.js"), String(PUERTO)], {
    cwd: __dirname,
    env: envServidor,
    stdio: ["ignore", "pipe", "pipe"],
  });
let salidaServidor = "";
servidor.stdout.on("data", (d) => { salidaServidor += d; });
servidor.stderr.on("data", (d) => { salidaServidor += d; });

const PERFIL = path.join(TMP, "pestana-chrome-perfil");
fs.rmSync(PERFIL, { recursive: true, force: true });
const navegador = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
  "--disable-dev-shm-usage", "--remote-allow-origins=*",
  "--no-first-run", "--disable-extensions", "--disable-sync",
  "--window-size=1440,900",
  "--user-data-dir=" + PERFIL, "--remote-debugging-port=" + CDP, URL_PAGINA,
], { stdio: ["ignore", "pipe", "pipe"] });
let salidaNavegador = "";
navegador.stderr.on("data", (d) => { salidaNavegador += d; });

function apagar() {
  try { navegador.kill("SIGKILL"); } catch (e) { /* */ }
  try { servidor.kill("SIGKILL"); } catch (e) { /* */ }
}
process.on("exit", apagar);

async function target() {
  for (let i = 0; i < 90; i++) {
    try {
      const lista = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
      const p = lista.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:" + PUERTO));
      if (p) return p;
    } catch (e) { /* aún no escucha */ }
    await esperar(500);
  }
  throw new Error("chromium no subio el debugger:\n" + salidaNavegador.slice(0, 500) + "\nservidor:\n" + salidaServidor.slice(0, 500));
}

async function conductor() {
  const t = await target();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket fallo")); });
  let id = 0;
  const colas = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && colas.has(m.id)) { colas.get(m.id)(m); colas.delete(m.id); }
  });
  const exec = (method, params) => new Promise((res) => {
    const n = ++id;
    colas.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const evaluarSinPlazo = async (expression) => {
    const r = await exec("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error(String((ex.exception && ex.exception.description) || ex.text).slice(0, 400));
    return r.result.result.value;
  };
  // un await que no resuelve no es un test lento, es un test mudo: con plazo propio se sabe
  // qué paso quedó colgado en lugar de tragarse el timeout general
  const conPlazo = (promesa, ms, de) => Promise.race([
    promesa,
    esperar(ms).then(() => { throw new Error("plazo de " + ms + " ms agotado en: " + de); }),
  ]);
  const evaluar = (expression) => conPlazo(evaluarSinPlazo(expression), 150000, expression.slice(0, 70).replace(/\s+/g, " "));
  const peticiones = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Network.requestWillBeSent") peticiones.push(m.params.request.url);
  });
  await exec("Network.enable");
  await exec("Runtime.enable");
  for (let i = 0; i < 60; i++) {
    try { if (await evaluar("!!document.getElementById('codigo') && typeof correr === 'function'")) break; } catch (e) { /* */ }
    await esperar(300);
  }
  return { exec, evaluar, ws, peticiones };
}

// --- la prueba ----------------------------------------------------------------------------
(async () => {
  const { evaluar, exec, ws, peticiones } = await conductor();
  const fuera = path.join(TMP, "pestana-apk");
  fs.mkdirSync(fuera, { recursive: true });
  const descargas = path.join(TMP, "pestana-descargas");
  fs.rmSync(descargas, { recursive: true, force: true });
  fs.mkdirSync(descargas, { recursive: true });
  await exec("Page.setDownloadBehavior", { behavior: "allow", downloadPath: descargas });

  // el jar del SDK entra por el propio origen; si el servidor no lo encuentra, la pestaña no puede
  // compilar nada y conviene saberlo antes de la primera sección que lo necesita
  const jarInfo = await evaluar(`fetch("/android-jar-info").then((r) => r.json()).catch((e) => ({ error: String(e) }))`);
  console.log("  --- entorno: ANDROID_JAR=" + (process.env.ANDROID_JAR || "<vacío>") +
    " ANDROID_HOME=" + (process.env.ANDROID_HOME || "<vacío>") + " jar=" + JSON.stringify(jarInfo));

  comprueba("la página está aislada (OPFS sincrónico disponible)",
    await evaluar("crossOriginIsolated === true"));
  if (process.env.SIN_CABECERAS) {
    // Modo Surge: el servidor NO pone COOP/COEP. La única forma de llegar aquí es que el service
    // worker los haya puesto y la página se haya recargado una vez por su cuenta.
    const aislamiento = await evaluar(`({
      recarga: sessionStorage.getItem("apkc-coi-reintento"),
      controlado: !!navigator.serviceWorker.controller,
      aislada: crossOriginIsolated
    })`);
    comprueba("sin cabeceras del servidor, la página se recargó sola y el SW la controla",
      aislamiento.recarga === "1" && aislamiento.controlado === true && aislamiento.aislada === true,
      JSON.stringify(aislamiento));
  }

  // 0b. la tercera vista, antes de compilar nada: se abre, marca `data-vista` y deja el canvas
  // vacío con un mensaje. Es lo que ve quien entra sin apk y no puede parecer un fallo. Puede
  // llegar antes de que el parser haya creado la sección (esta es la primera lectura del DOM de
  // la prueba), así que se reintenta en vez de asumir que la página ya está entera.
  let previaVacia = null;
  for (let i = 0; i < 40 && !previaVacia; i++) {
    previaVacia = await evaluar(`(() => {
      const boton = document.querySelector('nav.actividad [data-vista="vista"]');
      const seccion = document.getElementById("vista");
      const canvas = document.getElementById("vista-previa");
      if (!boton || !seccion || !canvas || document.readyState === "loading") return null;
      boton.click();
      return {
        botones: document.querySelectorAll("nav.actividad [data-vista]").length,
        activa: seccion.classList.contains("activa"),
        cuerpo: document.body.dataset.vista,
        estado: document.getElementById("vista-previa-estado").textContent,
        rol: canvas.getAttribute("role"),
        arrastrable: canvas.draggable === true || canvas.hasAttribute("contenteditable"),
      };
    })()`);
    if (!previaVacia) await esperar(250);
  }
  if (!previaVacia) throw new Error("la vista previa no llegó al DOM en 10 s");
  comprueba("la barra de actividad tiene tres vistas y la de Pantalla se abre",
    previaVacia.botones === 3 && previaVacia.activa === true && previaVacia.cuerpo === "vista",
    JSON.stringify(previaVacia));
  comprueba("sin apk la vista previa queda vacía con un mensaje y un canvas de solo lectura",
    /[Cc]ompila/.test(String(previaVacia.estado)) && previaVacia.rol === "img" && previaVacia.arrastrable === false,
    JSON.stringify(previaVacia));
  await evaluar(`document.querySelector('nav.actividad [data-vista="crear"]').click()`);

  // 1. crear el proyecto CON apkc dentro de la pestaña, desde cero: OPFS es por origen y una
  // sesión anterior puede haber dejado /proyecto, que entonces se traga el create
  await evaluar(`(async () => { await hospedador.limpiar("/proyecto"); return true; })()`);
  const creacion = await evaluar(`(async () => {
    const r = await correr(["create", "/proyecto"]);
    const arbol = await hospedador.arbol();
    const nodos = (arbol.nodos || []).filter(n => n.ruta.startsWith("/proyecto")).map(n => n.ruta + "|" + (n.dir ? "dir" : n.bytes));
    return { codigo: r.codigo, consola: r.consola, tipo: r.tipo, error: r.error, arbolTipo: arbol.tipo, arbolError: arbol.error, nodos };
  })()`);
  comprueba("apkc create sale 0 en wasm", creacion.codigo === 0,
    "tipo " + creacion.tipo + ", consola: " + JSON.stringify(String(creacion.consola === undefined ? "<ausente>" : creacion.consola).slice(-160)) +
    (creacion.error ? ", error del hospedador: " + creacion.error : "") + (creacion.arbolError ? ", error del arbol: " + creacion.arbolError : ""));
  const rutas = (creacion.nodos || []).filter((n) => !/\|dir$/.test(n)).map((n) => n.split("|")[0]);
  for (const esperado of ["/proyecto/AndroidManifest.xml", "/proyecto/src/com/myapp/MainActivity.java", "/proyecto/res/layout/main.xml"]) {
    comprueba("create escribió " + esperado, rutas.includes(esperado),
      rutas.length + " ficheros: " + rutas.slice(0, 6).join(", "));
  }
  comprueba("el explorador ofrece descargar cada fichero",
    await evaluar("!!document.querySelector('#arbol-pestana a.archivo .arbol-descargar')"));

  const ops = await evaluar(`(async () => {
    await hospedador.escribir("/proyecto/tmp-renombrar.txt", new TextEncoder().encode("hola"));
    const r = await hospedador.renombrar("/proyecto/tmp-renombrar.txt", "/proyecto/tmp-renombrado.txt");
    const texto = await hospedador.texto("/proyecto/tmp-renombrado.txt");
    const viejo = await hospedador.bytes("/proyecto/tmp-renombrar.txt");
    await hospedador.limpiar("/proyecto/tmp-renombrado.txt");
    const borrado = await hospedador.bytes("/proyecto/tmp-renombrado.txt");
    return { tipo: r.tipo, error: r.error, texto, viejo: !!viejo, borrado: !!borrado };
  })()`);
  comprueba("renombrar y borrar ficheros funciona en OPFS",
    ops.tipo === "renombrado" && ops.texto === "hola" && !ops.viejo && !ops.borrado,
    JSON.stringify(ops));

  const menu = await evaluar(`(() => {
    const fila = document.querySelector('#arbol-pestana a.archivo');
    fila.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    const m = document.getElementById("menu-archivo");
    const salida = { visible: !m.hidden, texto: m.textContent };
    cerrarMenuArchivo();
    return salida;
  })()`);
  comprueba("el menú del fichero ofrece abrir, descargar, renombrar y borrar",
    menu.visible && /Abrir/.test(menu.texto) && /Descargar/.test(menu.texto) &&
    /Renombrar/.test(menu.texto) && /Borrar/.test(menu.texto), JSON.stringify(menu));

  const carga = await evaluar(`(async () => {
    const p = conCarga("probando…", () => new Promise((r) => setTimeout(r, 300)));
    await new Promise((r) => setTimeout(r, 220));
    const visible = !document.getElementById("cargando").hidden;
    const texto = document.getElementById("cargando-texto").textContent;
    await p;
    return { visible, texto, oculto: document.getElementById("cargando").hidden };
  })()`);
  comprueba("la pantalla de carga aparece en las operaciones lentas",
    carga.visible === true && carga.texto === "probando…" && carga.oculto === true,
    JSON.stringify(carga));

  // 2. el manifiesto que escribe apkc es el de sus plantillas, no otro
  const manifiesto = await evaluar(`(async () => {
    return await hospedador.texto("/proyecto/AndroidManifest.xml");
  })()`);
  comprueba("el manifest menciona el package que genera apkc", /package="com\.myapp"/.test(manifiesto),
    manifiesto.split("\n").slice(0, 2).join(" "));

  // 3. el editor escribe en el mismo árbol (guardar -> OPFS -> releer)
  const editado = await evaluar(`(async () => {
    const ruta = "/proyecto/src/com/myapp/Editado.java";
    // la prueba crea el buffer como lo haría «Nuevo fichero»: una pestaña propia
    DOCUMENTOS.lista.push({ ruta, texto: "", sucio: false, cursor: null, scroll: null });
    DOCUMENTOS.activa = ruta;
    estadoPestana.ruta = ruta;
    revelarRuta(ruta);
    EDITOR.poner("package com.myapp;\\n// probado desde la prueba de pestaña\\npublic class Editado {}\\n");
    await guardar();
    const texto = await hospedador.texto("/proyecto/src/com/myapp/Editado.java");
    const resaltado = document.getElementById("resalto").innerHTML;
    return { texto, tienePalabra: /<span class="palabra">package<\\/span>/.test(resaltado), tieneComentario: /<span class="comentario">/.test(resaltado), lineas: document.getElementById("numeros").textContent.trim().split("\\n").length };
  })()`);
  const fuente = "package com.myapp;\n// probado desde la prueba de pestaña\npublic class Editado {}\n";
  comprueba("lo editado llega a OPFS idéntico", editado.texto === fuente,
    JSON.stringify(editado.texto.slice(0, 40)));
  comprueba("el resaltador pinta la palabra clave", editado.tienePalabra === true);
  comprueba("el resaltador pinta el comentario", editado.tieneComentario === true);
  comprueba("los números de línea siguen al contenido", editado.lineas === fuente.split("\n").length - 1 || editado.lineas >= 3,
    editado.lineas + " líneas");

  // 3b. el scroll del editor: las tres capas tienen que moverse juntas, también al pasar de la
  //     primera pantalla (con el transform viejo el <pre> recortaba el contenido y se veía vacío)
  const desplazado = await evaluar(`(async () => {
    document.querySelector('[data-vista="pestana"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const lineas = Array.from({ length: 120 }, (_, i) => "linea " + (i + 1) + " de la prueba de scroll").join("\\n");
    EDITOR.poner(lineas + "\\n" + "x".repeat(400));
    const area = document.getElementById("codigo");
    const resalto = document.getElementById("resalto");
    const numeros = document.getElementById("numeros");
    area.focus();
    area.scrollTop = 500;
    area.scrollLeft = 80;
    // la sincronización de capas corre en el evento scroll: se espera a que llegue (hasta 1 s)
    // en vez de a un plazo fijo, que con la máquina cargada se queda corto y acusa un fallo falso
    for (let i = 0; i < 40; i++) {
      if (resalto.scrollTop === area.scrollTop && numeros.scrollTop === area.scrollTop &&
          resalto.scrollLeft === area.scrollLeft) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return {
      alto: [area.clientHeight, area.scrollHeight],
      vertical: [area.scrollTop, resalto.scrollTop, numeros.scrollTop],
      horizontal: [area.scrollLeft, resalto.scrollLeft],
      numerosVisibles: numeros.textContent.trim().split("\\n").length,
    };
  })()`);
  comprueba("el editor tiene scroll vertical de verdad", desplazado.alto[1] > desplazado.alto[0] * 3,
    desplazado.alto[0] + " visibles de " + desplazado.alto[1]);
  comprueba("las tres capas del editor comparten el scroll vertical",
    desplazado.vertical[0] > 300 && desplazado.vertical[0] === desplazado.vertical[1] &&
    desplazado.vertical[0] === desplazado.vertical[2], JSON.stringify(desplazado.vertical));
  comprueba("el resaltado comparte también el scroll horizontal",
    desplazado.horizontal[0] > 0 && desplazado.horizontal[0] === desplazado.horizontal[1],
    JSON.stringify(desplazado.horizontal));
  comprueba("los números de línea llegan a la última línea", desplazado.numerosVisibles === 121,
    desplazado.numerosVisibles + " números");

  // 3c. teclado: Tab en el cursor y Shift+Tab sobre un bloque; Enter usa el mismo camino y
  //     entra en el deshacer nativo por EDITOR.cambiar()
  const teclado = await evaluar(`(async () => {
    document.querySelector('[data-vista="pestana"]').click();
    await new Promise((r) => setTimeout(r, 100));
    const area = document.getElementById("codigo");
    EDITOR.poner("abc");
    area.focus();
    area.setSelectionRange(3, 3);
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    const conTab = area.value;
    const deshacer = document.execCommand("undo");
    const trasDeshacer = area.value;
    EDITOR.poner("uno\\ndos");
    area.focus();
    area.setSelectionRange(0, 7);
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    const bloque = area.value;
    area.setSelectionRange(0, 15);
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    const sinSangria = area.value;
    marcarSucio(false);
    return { conTab, trasDeshacer, bloque, sinSangria, deshacer };
  })()`);
  comprueba("Tab sin selección inserta en el cursor y se puede deshacer",
    teclado.conTab === "abc    " && teclado.trasDeshacer === "abc" && teclado.deshacer === true,
    JSON.stringify(teclado));
  comprueba("Tab y Shift+Tab indenta y desindenta el bloque seleccionado",
    teclado.bloque === "    uno\n    dos" && teclado.sinSangria === "uno\ndos",
    JSON.stringify({ bloque: teclado.bloque, sin: teclado.sinSangria }));

  // 4. persistencia: recargar la página y volver a leer el árbol
  await exec("Page.enable");
  await exec("Page.navigate", { url: URL_PAGINA });
  for (let i = 0; i < 40; i++) {
    try { if (await evaluar("!!document.getElementById('codigo') && typeof correr === 'function'")) break; } catch (e) { /* */ }
    await esperar(300);
  }
  const trasRecargar = await evaluar(`(async () => {
    return await hospedador.texto("/proyecto/src/com/myapp/Editado.java");
  })()`);
  comprueba("el fuente editado sobrevive a recargar la página", trasRecargar === fuente,
    JSON.stringify(String(trasRecargar).slice(0, 40)));

  // 5. firmar una apk real dentro de la pestaña, con el keystore montado desde el disco
  const instalacion = await evaluar(`(async () => {
    const a = await (await fetch("/apk-ejemplo")).arrayBuffer();
    const k = await (await fetch("/keystore-ejemplo")).arrayBuffer();
    await hospedador.escribir("/in.apk", new Uint8Array(a));
    await hospedador.escribir("/keystore", new Uint8Array(k));
    const r = await correr(["sign", "--keystore", "/keystore", "--out", "/out.apk", "/in.apk"]);
    const u = await hospedador.bytes("/out.apk");
    let b = "";
    if (u) {
      const trozos = [];
      for (let i = 0; i < u.length; i += 8192) trozos.push(String.fromCharCode.apply(null, u.subarray(i, i + 8192)));
      b = btoa(trozos.join(""));
    }
    return { codigo: r.codigo, consola: r.consola, bytes: b, largo: b.length };
  })()`);
  comprueba("apkc sign sale 0 dentro de chromium", instalacion.codigo === 0,
    String(instalacion.consola).split("\n").filter(Boolean).slice(-1)[0]);
  const apk = Buffer.from(instalacion.bytes, "base64");
  const destino = path.join(fuera, "pestanera.apk");
  fs.writeFileSync(destino, apk);
  comprueba("la apk firmada pesa lo que dice el árbol", apk.length > 1000, apk.length + " bytes");
  comprueba("el magic de zip, por si fuera un texto", apk.slice(0, 2).toString("latin1") === "PK");
  console.log("  --- la apk firmada en la pestaña es " + destino);

  // 5b. un keystore de RELEASE entra por la página: contraseña, alias y certificado. El DN que
  //     se ve aquí es el que apksigner tiene que leer en el apk que sale de firmar.
  if (KS_RELEASE) {
    const ui = await evaluar(`(async () => {
      const k = await (await fetch("/keystore-release")).arrayBuffer();
      await hospedador.escribir("/keystore", new Uint8Array(k));
      document.getElementById("storepass-firmar").value = "saludo";
      await inspeccionarKeystore(KEYSTORES.firmar);
      return {
        estado: document.getElementById("estado-keystore-firmar").textContent,
        alias: document.getElementById("keyalias-firmar").value,
        opciones: [...document.getElementById("keyalias-firmar").options].map((o) => o.value),
      };
    })()`);
    comprueba("la pestaña lista el alias del keystore de release", ui.alias === "lanzable", JSON.stringify(ui));
    comprueba("la pestaña enseña el sujeto y la huella SHA-256 del certificado",
      String(ui.estado).includes("CN=Release de prueba") && /SHA-256 ([0-9A-F]{2}:){31}/.test(String(ui.estado)),
      String(ui.estado).slice(0, 140));

    const release = await evaluar(`(async () => {
      document.getElementById("apk-a-firmar").value = "/in.apk";
      await firmar();
      const u = await hospedador.bytes("/proyecto/build/firmado.apk");
      let b = "";
      if (u) {
        const trozos = [];
        for (let i = 0; i < u.length; i += 8192) trozos.push(String.fromCharCode.apply(null, u.subarray(i, i + 8192)));
        b = btoa(trozos.join(""));
      }
      const id = await hospedador.bytes("/proyecto/build/firmado.apk.idsig");
      let bi = "";
      if (id) {
        const trozos = [];
        for (let i = 0; i < id.length; i += 8192) trozos.push(String.fromCharCode.apply(null, id.subarray(i, i + 8192)));
        bi = btoa(trozos.join(""));
      }
      return { bytes: b, idsig: bi, pass: document.getElementById("storepass-firmar").value,
        estado: document.getElementById("estado-keystore-firmar").textContent,
        nota: document.getElementById("estado-pestana").textContent,
        consola: String(document.getElementById("consola-pestana").textContent).slice(-700),
        // M1: el buffer de la consola conserva lo escrito aunque el campo se limpie. Se mira el
        // texto completo, no el recorte que se enseña en el mensaje de fallo.
        sinPass: !String(document.getElementById("consola-pestana").textContent).includes("saludo"),
        conRedaccion: String(document.getElementById("consola-pestana").textContent).includes("***") };
    })()`);
    const apkRelease = Buffer.from(release.bytes, "base64");
    const idsigRelease = Buffer.from(release.idsig, "base64");
    fs.writeFileSync(path.join(fuera, "pestanera-release.apk"), apkRelease);
    fs.writeFileSync(path.join(fuera, "pestanera-release.apk.idsig"), idsigRelease);
    comprueba("la pestaña firma con el keystore de release", apkRelease.length > 1000,
      apkRelease.length + " bytes · " + JSON.stringify({ estado: release.estado, nota: release.nota, consola: release.consola }));
    comprueba("la pestaña escribe el .idsig de la v4", idsigRelease.length > 100, idsigRelease.length + " bytes");
    comprueba("la pestaña verifica la v4 de lo que firma", /v4 \(APK Signature Scheme v4\): ok/.test(String(release.consola)),
      String(release.consola).slice(-160));
    comprueba("la contraseña no se queda en el campo", release.pass === "", JSON.stringify(release.pass));
    comprueba("la contraseña de firma no aparece en la consola", release.sinPass === true,
      release.sinPass ? "" : String(release.consola).slice(-200));
    comprueba("la consola redacta la opción de contraseña con ***", release.conRedaccion === true,
      String(release.consola).slice(-200));
  }

  // 5c. un .aab entra por la misma sección: firma JAR v1, sin bloque v2/v3, y la pestaña lo verifica.
  if (AAB) {
    const bundle = await evaluar(`(async () => {
      const a = await (await fetch("/aab-ejemplo")).arrayBuffer();
      await hospedador.escribir("/in.aab", new Uint8Array(a));
      document.getElementById("storepass-firmar").value = "saludo";
      document.getElementById("apk-a-firmar").value = "/in.aab";
      await firmar();
      const u = await hospedador.bytes("/proyecto/build/firmado.aab");
      let b = "";
      if (u) {
        const trozos = [];
        for (let i = 0; i < u.length; i += 8192) trozos.push(String.fromCharCode.apply(null, u.subarray(i, i + 8192)));
        b = btoa(trozos.join(""));
      }
      return { bytes: b, consola: String(document.getElementById("consola-pestana").textContent).slice(-900) };
    })()`);
    const aab = Buffer.from(bundle.bytes, "base64");
    fs.writeFileSync(path.join(fuera, "pestanera.aab"), aab);
    comprueba("la pestaña firma un .aab con el keystore de release", aab.length > 500, aab.length + " bytes");
    comprueba("el .aab no lleva bloque de firmas de apk", !aab.includes(Buffer.from("APK Sig Block 42")));
    comprueba("la pestaña verifica la v1 del .aab", /v1 \(JAR signing\): ok/.test(String(bundle.consola)),
      String(bundle.consola).slice(-160));
  }

  // 5d. rotación desde la página: el linaje con la clave vieja (debug) y la nueva (release),
  //     y una firma en la que v1/v2 van con la vieja y v3/v3.1 con la nueva.
  if (KS_RELEASE) {
    const rotada = await evaluar(`(async () => {
      const k = await (await fetch("/keystore-ejemplo")).arrayBuffer();
      await hospedador.escribir("/keystore-viejo", new Uint8Array(k));
      document.getElementById("storepass-firmar").value = "saludo";
      document.getElementById("storepass-viejo").value = "android";
      document.getElementById("keyalias-viejo").value = "androiddebugkey";
      await crearLinaje();
      const linaje = await hospedador.bytes("/lineage.bin");
      document.getElementById("usar-rotacion").checked = true;
      document.getElementById("apk-a-firmar").value = "/in.apk";
      await firmar();
      const u = await hospedador.bytes("/proyecto/build/firmado.apk");
      const id = await hospedador.bytes("/proyecto/build/firmado.apk.idsig");
      const b64 = (buf) => {
        if (!buf) return "";
        const t = [];
        for (let i = 0; i < buf.length; i += 8192) t.push(String.fromCharCode.apply(null, buf.subarray(i, i + 8192)));
        return btoa(t.join(""));
      };
      return { apk: b64(u), idsig: b64(id), linaje: !!linaje,
        estado: document.getElementById("estado-linaje").textContent,
        consola: String(document.getElementById("consola-pestana").textContent).slice(-600) };
    })()`);
    const apkRotada = Buffer.from(rotada.apk, "base64");
    const idsigRotada = Buffer.from(rotada.idsig, "base64");
    fs.writeFileSync(path.join(fuera, "pestanera-rotada.apk"), apkRotada);
    fs.writeFileSync(path.join(fuera, "pestanera-rotada.apk.idsig"), idsigRotada);
    comprueba("la pestaña crea el linaje de rotación", rotada.linaje, String(rotada.estado));
    comprueba("la pestaña firma la rotación y escribe el .idsig", apkRotada.length > 1000 && idsigRotada.length > 100,
      apkRotada.length + " + " + idsigRotada.length + " bytes · " + String(rotada.consola).slice(-120));
    comprueba("la pestaña verifica la rotación (v4 de dos firmantes)",
      /v4 \(APK Signature Scheme v4\): ok/.test(String(rotada.consola)), String(rotada.consola).slice(-160));
  }

  // 6. el muro conocido, dicho tal cual
  const nodos = await evaluar(`(async () => {
    const a = await hospedador.arbol();
    const b = a.nodos.filter(n => n.ruta === "/proyecto" || n.ruta === "/proyecto/src" || n.ruta === "/proyecto/res/layout" || n.ruta === "/proyecto/AndroidManifest.xml");
    return JSON.stringify(b.map(n => n.ruta + ":" + (n.dir ? "dir" : n.bytes + "b")));
  })()`);
  console.log("  --- nodos tras recargar: " + nodos);
  const build = await evaluar(`(async () => {
    await hospedador.cwd("/proyecto");
    const r = await correr(["build"]);
    return { codigo: r.codigo, consola: r.consola, tipo: r.tipo, error: r.error };
  })()`);
  comprueba("apkc build en wasm dice el motivo, no se calla", build.codigo !== 0 &&
    /never started|not implemented on js/.test(String(build.consola)),
    JSON.stringify(build).slice(0, 320));

  // 6a. la consola enlaza ruta:línea, la salida llega por trozos y Detener reinicia el worker
  const salida = await evaluar(`(async () => {
    let trozos = 0, texto = "";
    hospedador.escucharSalida((t) => { trozos++; texto += t; });
    const r = await hospedador.ejecutar(["version"]);
    hospedador.escucharSalida(null);
    return { trozos, texto, consola: String(r.consola || ""), codigo: r.codigo };
  })()`);
  comprueba("la salida de apkc llega por trozos antes de terminar",
    salida.trozos > 0 && salida.texto.length > 0 &&
    salida.consola.includes(salida.texto.trim()) && salida.codigo === 0,
    JSON.stringify(salida).slice(0, 240));

  const saltar = await evaluar(`(async () => {
    const arbol = await hospedador.arbol();
    const nodo = (arbol.nodos || []).find((n) => /MainActivity\\.java$/.test(n.ruta));
    if (!nodo) return { error: "sin MainActivity.java" };
    await saltarALinea(nodo.ruta.slice("/proyecto/".length), 3);
    const area = document.getElementById("codigo");
    const antes = area.value.slice(0, area.selectionStart).split("\\n");
    return {
      activo: document.getElementById("fichero-abierto").textContent,
      linea: antes.length,
      seleccion: area.value.slice(area.selectionStart, area.selectionEnd),
      tercera: area.value.split("\\n")[2],
    };
  })()`);
  comprueba("un enlace ruta:línea de la consola abre el fichero en esa línea",
    saltar.linea === 3 && saltar.seleccion === saltar.tercera &&
    /MainActivity\.java$/.test(String(saltar.activo)),
    JSON.stringify(saltar).slice(0, 240));

  // 4b. diagnóstico en vivo y paleta, con la misma instancia de wasm de estas pruebas.
  const vivo = await evaluar(`(async () => {
    await hospedador.escribir("/proyecto/vivo.java",
      new TextEncoder().encode("package p;\\npublic class Vivo { void x() {} }\\n"));
    await abrir("/proyecto/vivo.java");
    const area = document.getElementById("codigo");
    area.value = "package p;\\n\\npublic class Vivo {\\n  void x() { int y = ; }\\n}\\n";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await esperar(3500);
  const vida = await evaluar(`({
    estado: document.getElementById("diagnostico-vivo-estado").textContent,
    lista: document.getElementById("diagnostico-vivo-lista").textContent,
    marcas: document.getElementById("diagnostico-marcas").children.length
  })`);
  comprueba("el diagnóstico en vivo marca el error de sintaxis y lo muestra",
    /error/i.test(String(vida.estado)) && /vivo\.java:(4|5)/.test(String(vida.lista)) && vida.marcas >= 1,
    JSON.stringify(vida).slice(0, 200));

  await evaluar(`document.dispatchEvent(new KeyboardEvent("keydown",
    { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true }))`);
  await esperar(200);
  const paletaAbierta = await evaluar(`!document.getElementById("paleta").hidden`);
  await evaluar(`(() => { const e = document.getElementById("paleta-buscar");
    e.value = "guardar"; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const filtro = await evaluar(`document.getElementById("paleta-lista").textContent`);
  await evaluar(`document.getElementById("paleta-buscar").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
  await esperar(600);
  const paletaCerrada = await evaluar(`document.getElementById("paleta").hidden`);
  comprueba("la paleta Ctrl+Mayús+P abre, filtra y ejecuta",
    paletaAbierta === true && /Guardar fichero/.test(String(filtro)) && paletaCerrada === true,
    JSON.stringify({ paletaAbierta, filtro: String(filtro).slice(0, 60), paletaCerrada }));

  // se deja un fuente válido y limpio: las compilaciones posteriores recorren /proyecto y abrir otro
  // fichero no se puede encontrar un documento sucio que dispare el confirm
  await evaluar(`(async () => {
    await hospedador.escribir("/proyecto/vivo.java", new TextEncoder().encode("package p;\\npublic class Vivo {}\\n"));
    EDITOR.poner("package p;\\npublic class Vivo {}\\n");
    marcarSucio(false);
    return true;
  })()`);

  // buscar y reemplazar dentro del editor, con el undo tree detrás; se hace en un fichero
  // aparte para no tocar el fuente que luego se compila
  const buscar = await evaluar(`(async () => {
    await hospedador.escribir("/proyecto/scratch.txt",
      new TextEncoder().encode("uno dos uno\\ndos uno\\n"));
    await abrir("/proyecto/scratch.txt");
    abrirBusqueda(false);
    const campo = document.getElementById("buscar-texto");
    campo.value = "uno";
    const primero = buscarSiguiente(false);
    const area = document.getElementById("codigo");
    const seleccion = area.value.slice(area.selectionStart, area.selectionEnd);
    abrirBusqueda(true);
    campo.value = "uno";
    document.getElementById("reemplazar-texto").value = "cero";
    reemplazarTodos();
    const texto = area.value;
    const aviso = document.getElementById("buscar-estado").textContent;
    cerrarBusqueda();
    const confirmar = window.confirm;
    window.confirm = () => true;
    try { await cerrarDocumento("/proyecto/scratch.txt"); }
    finally { window.confirm = confirmar; }
    await hospedador.limpiar("/proyecto/scratch.txt");
    return { primero, seleccion, texto, aviso };
  })()`);
  comprueba("buscar y reemplazar todo dentro del editor",
    buscar.primero === true && buscar.seleccion === "uno" &&
    buscar.texto === "cero dos cero\ndos cero\n" && /3 reemplazadas/.test(String(buscar.aviso)),
    JSON.stringify(buscar).slice(0, 240));

  const irA = await evaluar(`(async () => {
    await abrir("/proyecto/AndroidManifest.xml");
    const original = window.prompt;
    window.prompt = () => "5";
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "g", ctrlKey: true, bubbles: true,
    }));
    window.prompt = original;
    const area = document.getElementById("codigo");
    return { linea: area.value.slice(0, area.selectionStart).split("\\n").length };
  })()`);
  comprueba("Ctrl+G salta a la línea pedida", irA.linea === 5, JSON.stringify(irA));

  const cancelado = await evaluar(`(async () => {
    const primero = hospedador.cancelar();
    const r = await hospedador.ejecutar(["version"]);
    return { primero, codigo: r.codigo, consola: String(r.consola || "") };
  })()`);
  comprueba("Detener termina el worker y el siguiente comando arranca otro",
    cancelado.primero === true && cancelado.codigo === 0 && /apkc/.test(cancelado.consola),
    JSON.stringify(cancelado).slice(0, 240));

  // D4: la barra enseña la última línea que imprimió apkc mientras corre, sin porcentajes
  const fase = await evaluar(`(async () => {
    await correr(["version"]);
    return { texto: document.getElementById("ocupado").textContent,
      oculto: document.getElementById("ocupado").hidden };
  })()`);
  comprueba("la barra de trabajo enseña la fase que imprime apkc",
    /^apkc: /.test(String(fase.texto)) && fase.oculto === true,
    JSON.stringify(fase).slice(0, 200));

  // 7. el proyecto entero, compilado DENTRO de la pestaña: recursos, Java, dex y firma, sin que
  // el navegador arranque un solo proceso. El jar llega por fetch del propio origen y se guarda
  // en OPFS, que es lo que hace el botón de la página.
  if (JAR_SRC && fs.existsSync(JAR_SRC)) {
    const jarPuesto = await evaluar(`(async () => {
      const n = await ponerJarDeUrl("/android-jar");
      const leido = await hospedador.leer("/sdk/android.jar");
      const arbol = await hospedador.arbol();
      const nodo = (arbol.nodos || []).find(x => x.ruta === "/sdk/android.jar");
      const cabecera = leido.bytes ? Array.from(leido.bytes.slice(0, 4)) : null;
      return { escrito: n, leido: leido.bytes ? leido.bytes.length : null, nodo: nodo ? nodo.bytes : "fuera del arbol", cabecera };
    })()`);
    comprueba("el android.jar entra en OPFS desde el propio origen", jarPuesto.escrito > 1000000, jarPuesto.escrito + " bytes");
    comprueba("el android.jar vuelve a leerse por el fs de la pestaña", jarPuesto.leido === jarPuesto.escrito,
      "leido " + jarPuesto.leido + ", cabecera " + JSON.stringify(jarPuesto.cabecera) + ", arbol " + jarPuesto.nodo);

    // 4c. diagnóstico en vivo con el android.jar ya en OPFS. Es el caso del §200: `R.layout.main`
    // no puede ser un falso error y un id que no existe tiene que salir con `archivo:línea:columna`
    // y el token subrayado, no la línea entera. El diagnóstico corre por el hospedador, no por
    // `correr()`: no puede ensuciar la consola ni el último código.
    const antes4c = await evaluar(`({
      ultimo: document.getElementById("ultimo-codigo").textContent,
      consola: document.getElementById("consola-pestana").textContent.length,
      estado: document.getElementById("diagnostico-vivo-estado").textContent.trim()
    })`);
    const original = await evaluar(`(async () => {
      marcarSucio(false);
      const arbol = await hospedador.arbol();
      const nodo = (arbol.nodos || []).find((n) => /MainActivity\\.java$/.test(n.ruta));
      if (!nodo) return { error: "sin MainActivity.java" };
      await abrir(nodo.ruta);
      const area = document.getElementById("codigo");
      const texto = area.value;
      if (!/R\\.layout\\.main/.test(texto)) return { error: "el MainActivity no usa R.layout.main" };
      area.value = texto.replace("R.layout.main", "R.layout.noexiste");
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return { texto, linea: area.value.split("\\n").findIndex((l) => l.includes("R.layout.noexiste")) + 1 };
    })()`);
    // El diagnóstico corre en el worker y su debounce son 350 ms: se espera **dentro de la página**
    // al resumen («N error», «sin errores», «no se pudo»), que es lo que el usuario ve. La espera se
    // hace en una sola evaluación para no medir el ruido de los viajes por CDP.
    // `anterior` es el resumen que ya estaba en pantalla: sin él, la segunda espera se cerraría con el
    // resultado viejo antes de que el diagnóstico nuevo hubiera corrido.
    const esperarResumen = (ms, anterior) => evaluar(`(async () => {
      const t0 = Date.now();
      const visto = [];
      const antes = ${JSON.stringify(anterior || "")};
      let previo = "";
      let cambio = false;
      while (Date.now() - t0 < ${ms}) {
        const e = document.getElementById("diagnostico-vivo-estado").textContent.trim();
        if (e !== previo) { visto.push((Date.now() - t0) + "ms " + e.slice(0, 60)); previo = e; }
        if (e !== antes) cambio = true;
        if (cambio && /^([0-9]+ error|sin errores|no se pudo)/.test(e)) return { ms: Date.now() - t0, estado: e, visto };
        await new Promise((r) => setTimeout(r, 200));
      }
      return { ms: Date.now() - t0, estado: null, visto };
    })()`);
    const roto = await esperarResumen(30000, antes4c.estado);
    const pintado = await evaluar(`({
      estado: document.getElementById("diagnostico-vivo-estado").textContent,
      lista: document.getElementById("diagnostico-vivo-lista").textContent,
      posicion: (document.querySelector("#diagnostico-vivo-lista code") || {}).textContent || "",
      marcas: Array.from(document.getElementById("diagnostico-marcas").children).map((m) => Object.assign({}, m.dataset))
    })`);
    comprueba("el diagnóstico en vivo nombra archivo:línea:columna y el token",
      roto && new RegExp("MainActivity\\.java:" + original.linea + ":[0-9]+").test(pintado.posicion) &&
      /R\.layout\.noexiste/.test(String(pintado.lista)) && !/no esta medido/.test(String(pintado.lista)),
      JSON.stringify({ roto, pintado, original }).slice(0, 420));
    comprueba("el subrayado cae sobre el token y no sobre la línea entera",
      pintado.marcas.length >= 1 && Number(pintado.marcas[0].columna) > 0 &&
      Number(pintado.marcas[0].ancho) > 50,
      JSON.stringify(pintado.marcas).slice(0, 200));
    // y el fuente bueno, tal como lo genera la página, no da ni un error: `R.layout.main` se resuelve
    // porque check enlaza la R del proyecto. Se devuelve el buffer a su texto con `EDITOR.poner`, que
    // es la entrada única y marca el documento limpio, para no dejar el proyecto sucio al compilar.
    await evaluar(`(() => {
      EDITOR.poner(${JSON.stringify(original.texto)});
      document.getElementById("codigo").dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const sano = await esperarResumen(30000, roto && roto.estado);
    const sanoLista = await evaluar(`document.getElementById("diagnostico-vivo-lista").textContent`);
    comprueba("setContentView(R.layout.main) no da error en el diagnóstico en vivo",
      sano && /^sin errores/.test(sano.estado) && /Sin errores/.test(String(sanoLista)),
      JSON.stringify({ sano, sanoLista }).slice(0, 240));
    // 4d. Dos conversiones que el subrayado tiene que hacer bien, y que un ancho «columnas por
    // carácter» no hace: `apkc` cuenta la columna en caracteres (runes) y el editor corta en unidades
    // UTF-16 (un astral son dos), y un tabulador ocupa hasta su parada de `tab-size`. Se prueban las
    // dos formas sobre la misma línea, y la marca tiene que subrayar `R.layout.noexiste` entero.
    const geometria = await evaluar(`(async () => {
      const area = document.getElementById("codigo");
      const lineas = area.value.split("\\n");
      const i = lineas.findIndex((l) => /R\\.layout\\.main/.test(l));
      if (i < 0) return { error: "sin setContentView en el fuente" };
      const sangria = (lineas[i].match(/^[ \\t]*/) || [""])[0];
      const medir = (texto) => {
        const estilo = getComputedStyle(area);
        const sonda = document.createElement("span");
        sonda.textContent = texto;
        sonda.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
        sonda.style.fontFamily = estilo.fontFamily;
        sonda.style.fontSize = estilo.fontSize;
        sonda.style.fontWeight = estilo.fontWeight;
        sonda.style.letterSpacing = estilo.letterSpacing;
        sonda.style.tabSize = estilo.tabSize;
        document.body.appendChild(sonda);
        const ancho = sonda.getBoundingClientRect().width;
        sonda.remove();
        return ancho;
      };
      const caracter = medir("0");
      const casos = [
        { nombre: "astral", linea: sangria + "/* \\uD83D\\uDE00 */ setContentView(R.layout.noexiste);" },
        { nombre: "tabs", linea: "\\t\\tsetContentView(R.layout.noexiste);" }
      ];
      const salida = [];
      for (const caso of casos) {
        const copia = lineas.slice();
        copia[i] = caso.linea;
        const anterior = document.getElementById("diagnostico-vivo-estado").textContent.trim();
        EDITOR.poner(copia.join("\\n"));
        area.dispatchEvent(new Event("input", { bubbles: true }));
        const t0 = Date.now();
        let estado = null;
        let cambio = false;
        while (Date.now() - t0 < 30000) {
          const e = document.getElementById("diagnostico-vivo-estado").textContent.trim();
          if (e !== anterior) cambio = true;
          if (cambio && /^([0-9]+ error|sin errores|no se pudo)/.test(e)) { estado = e; break; }
          await new Promise((r) => setTimeout(r, 200));
        }
        const marca = document.querySelector("#diagnostico-marcas .marca-error");
        const columna = marca ? Number(marca.dataset.columna) : 0;
        // el índice UTF-16 del token, contado aparte del código que se prueba
        let utf16 = 0, runes = 1;
        while (utf16 < caso.linea.length && runes < columna) {
          const punto = caso.linea.codePointAt(utf16);
          utf16 += punto > 0xffff ? 2 : 1;
          runes++;
        }
        salida.push({
          nombre: caso.nombre, estado, columna,
          // el corte viejo (slice(columna-1), todo en unidades UTF-16) acertaba con tabuladores y
          // fallaba con el astral: se guarda para que la comprobación lo diga, no para usarlo
          ingenuo: /^[A-Za-z0-9_$.]/.test(caso.linea.slice(columna - 1)),
          posicion: (document.querySelector("#diagnostico-vivo-lista code") || {}).textContent || "",
          datos: marca ? Object.assign({}, marca.dataset) : null,
          esperado: { caracter, prefijo: medir(caso.linea.slice(0, utf16)), token: medir("R.layout.noexiste"), utf16 }
        });
      }
      EDITOR.poner(lineas.join("\\n"));
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return { salida, linea: lineas[i] };
    })()`);
    const cierre = await esperarResumen(30000, geometria && geometria.salida && geometria.salida.length
      ? geometria.salida[geometria.salida.length - 1].estado : undefined);
    const astral = geometria && geometria.salida ? geometria.salida.find((c) => c.nombre === "astral") : null;
    const tabs = geometria && geometria.salida ? geometria.salida.find((c) => c.nombre === "tabs") : null;
    comprueba("un astral delante del token no desplaza el subrayado (rune frente a UTF-16)",
      astral && astral.datos && astral.estado && /^[0-9]+ error/.test(astral.estado) &&
      // un astral antes del token: el índice UTF-16 es la columna (0-based = columna - 1 + 1 unidad
      // extra) y el corte viejo caía dentro del par subrogado
      Number(astral.datos.utf16) === astral.columna && astral.ingenuo === false &&
      new RegExp("MainActivity\\.java:" + original.linea + ":" + astral.columna + "$").test(astral.posicion) &&
      Math.abs(Number(astral.datos.ancho) - astral.esperado.token) < 2 &&
      Number(astral.datos.ancho) > 10 * astral.esperado.caracter &&
      Math.abs(Number(astral.datos.izquierda) - astral.esperado.prefijo) < 2,
      JSON.stringify(astral).slice(0, 420));
    comprueba("con tabuladores delante, la marca cae en la parada real y subraya el token entero",
      tabs && tabs.datos && tabs.estado && /^[0-9]+ error/.test(tabs.estado) &&
      // los tabuladores son una unidad cada uno: el índice es columna - 1, y el corte viejo acertaba
      Number(tabs.datos.utf16) === tabs.columna - 1 && tabs.ingenuo === true &&
      Math.abs(Number(tabs.datos.izquierda) - tabs.esperado.prefijo) < 2 &&
      Number(tabs.datos.izquierda) > (tabs.columna - 1) * tabs.esperado.caracter + 2 * tabs.esperado.caracter &&
      Math.abs(Number(tabs.datos.ancho) - tabs.esperado.token) < 2,
      JSON.stringify(tabs).slice(0, 420));
    comprueba("tras devolver el fuente, el diagnóstico vuelve a estar limpio",
      cierre && /^sin errores/.test(cierre.estado), JSON.stringify(cierre).slice(0, 200));

    const despues4c = await evaluar(`({
      ultimo: document.getElementById("ultimo-codigo").textContent,
      consola: document.getElementById("consola-pestana").textContent
    })`);
    comprueba("el diagnóstico en vivo no ensucia la consola ni el último código",
      despues4c.ultimo === antes4c.ultimo && !/apkc check|"tipo":"check"/.test(String(despues4c.consola)),
      JSON.stringify({ antes: antes4c, ultimo: despues4c.ultimo, consola: String(despues4c.consola).slice(-160) }));
    console.log("  --- 4c: roto en " + (roto ? roto.ms : "?") + " ms, sano en " + (sano ? sano.ms : "?") + " ms");

    const compilado = await evaluar(`(async () => {
      const ks = new Uint8Array(await (await fetch("/keystore-ejemplo")).arrayBuffer());
      await hospedador.escribir("/sdk/release.keystore", ks);
      document.getElementById("sdk-version").value = "34";
      document.getElementById("codename").value = "14";
      document.getElementById("storepass-compilar").value = "android";
      await compilarDelTodo();
      const datos = await hospedador.bytes("/proyecto/build/app.apk");
      return {
        codigo: document.getElementById("ultimo-codigo").textContent,
        bytes: datos ? Array.from(datos) : null,
        descarga: document.getElementById("descargar-apk-compilada").download || "",
        barra: !document.getElementById("panel-descargas").hidden,
        enlace: document.getElementById("descargar-apk-compilada").textContent,
        colores: /class="consola-fg-/.test(document.getElementById("consola-pestana").innerHTML),
        escape: /\\u001b/.test(document.getElementById("consola-pestana").textContent),
        consola: String(document.getElementById("consola-pestana").textContent).slice(-500),
      };
    })()`);
    const apkPestana = Buffer.from(compilado.bytes || [], "uint8");
    comprueba("apkc build sin procesos sale 0 dentro de chromium", compilado.codigo === "0",
      "codigo " + compilado.codigo + ", consola: " + JSON.stringify(compilado.consola.slice(-200)));
    comprueba("la pestaña produjo un apk", apkPestana.length > 5000, apkPestana.length + " bytes");
    comprueba("la descarga del apk queda lista en la página", compilado.descarga === "app.apk",
      JSON.stringify(compilado.descarga));
    comprueba("la descarga del apk se ve en la barra del panel",
      compilado.barra === true && /app\.apk/.test(compilado.enlace), JSON.stringify(compilado.enlace));
    comprueba("la consola pinta los colores ANSI y no enseña los códigos",
      compilado.colores === true && compilado.escape === false,
      JSON.stringify({ colores: compilado.colores, escape: compilado.escape }));
    const clicDescarga = await evaluar(`(() => {
      const a = document.getElementById("descargar-apk-compilada");
      let error = null;
      try { a.click(); } catch (e) { error = String(e); }
      return { href: a.href, download: a.download, error };
    })()`);
    for (let i = 0; i < 20 && !fs.existsSync(path.join(descargas, "app.apk")); i++) await esperar(250);
    const bajado = fs.existsSync(path.join(descargas, "app.apk"))
      ? fs.statSync(path.join(descargas, "app.apk")).size : 0;
    comprueba("el clic en el enlace descarga de verdad el app.apk",
      /^blob:/.test(clicDescarga.href) && clicDescarga.download === "app.apk" &&
      !clicDescarga.error && bajado > 5000,
      JSON.stringify({ ...clicDescarga, bajado }));
    const destinoPestana = path.join(fuera, "pestanera-completa.apk");
    fs.writeFileSync(destinoPestana, apkPestana);
    console.log("  --- el apk compilado dentro de la pestaña es " + destinoPestana);

    // 7b. sin jar en OPFS no hace falta elegir fichero: compilarDelTodo lo trae del SDK local que
    // sirve el mismo origen y lo guarda en OPFS antes de compilar.
    const auto = await evaluar(`(async () => {
      await hospedador.limpiar("/sdk/android.jar");
      await decirEstadoJar();
      const antes = document.getElementById("estado-jar").textContent;
      document.getElementById("storepass-compilar").value = "android";
      await compilarDelTodo();
      const jar = await hospedador.bytes("/sdk/android.jar");
      const apk = await hospedador.bytes("/proyecto/build/app.apk");
      return { antes, jar: jar ? jar.length : 0, apk: apk ? apk.length : 0,
        codigo: document.getElementById("ultimo-codigo").textContent,
        aviso: document.getElementById("estado-jar").textContent,
        cola: String(document.getElementById("consola-pestana").textContent)
          .replace(/\\u001b\\[[0-9;]*m/g, "").trim().split("\\n").slice(-10).join(" | ") };
    })()`);
    comprueba("sin jar en OPFS, compilar lo trae solo del SDK local",
      auto.jar > 1000000 && auto.apk > 5000 && auto.codigo === "0",
      "jar " + auto.jar + ", apk " + auto.apk + ", código " + auto.codigo + ": " + auto.cola);

    // 8. el proyecto que la PROPIA página genera (con la clase anónima del botón, el `@+id` y el
    // `style`), no la plantilla de create: es el que mide el §42 con javap y el que dexa 6 clases.
    const generado = await evaluar(`(async () => {
      const estado = { name: "Hola apkc", package: "com.hola.apkcstudio", minsdk: "21", targetsdk: "33",
        hello: "Hello World!", button: true, kotlin: false, libs: false, assets: false, native: false,
        buttonLabel: "Press me", toast: "Clicked!" };
      const p = buildProject(estado);
      await hospedador.limpiar("/estudio");
      for (const ruta of Object.keys(p.files)) {
        await hospedador.escribir("/estudio/" + ruta, new TextEncoder().encode(p.files[ruta]));
      }
      await hospedador.cwd("/estudio");
      const r = await correr(["build", "--linker", "go", "--compiler", "go",
        "--android-jar", "/sdk/android.jar", "--sdk-version", "34", "--codename", "14",
        "--keystore", "/sdk/release.keystore"]);
      const datos = await hospedador.bytes("/estudio/build/app.apk");
      return {
        codigo: r.codigo, ficheros: Object.keys(p.files).length,
        clases: /\\d+ fuentes de Java en Go -> (\\d+) clases/.exec(String(r.consola || "")),
        dexBytes: /-> (\\d+) bytes en build\\/classes\\.dex/.exec(String(r.consola || "")),
        bytes: datos ? Array.from(datos) : null,
        consola: String(r.consola || "").slice(-400),
      };
    })()`);
    const apkEstudio = Buffer.from(generado.bytes || [], "uint8");
    comprueba("la pestaña compila el proyecto que genera la página", generado.codigo === 0,
      "codigo " + generado.codigo + " sobre " + generado.ficheros + " ficheros, consola: " +
      JSON.stringify(generado.consola.slice(-220)));
    comprueba("con la clase anónima son seis clases dexadas", generado.clases && generado.clases[1] === "6",
      generado.clases ? generado.clases[0] : "sin la linea de clases en la consola");
    comprueba("el dex del proyecto generado sale en la pestaña", generado.dexBytes && Number(generado.dexBytes[1]) > 2000,
      generado.dexBytes ? generado.dexBytes[0] : "sin la linea del dex");
    comprueba("el apk del proyecto generado pesa lo de un apk real", apkEstudio.length > 9000, apkEstudio.length + " bytes");
    const destinoEstudio = path.join(fuera, "pestanera-estudio.apk");
    fs.writeFileSync(destinoEstudio, apkEstudio);
    console.log("  --- el apk del proyecto generado, compilado en la pestaña, es " + destinoEstudio);

    // 9. el jar también entra SIN red: el usuario lo elige de su disco y la página lo guarda en OPFS.
    //    Es el camino que reclama el "ni siquiera con conexión" del objetivo; hasta aquí estaba probado
    //    solo el fetch a /android-jar, que es lo que hace el servidor de pruebas.
    const antesDelPicker = peticiones.length;
    const avisoVacio = await evaluar(`(async () => {
      const r = await hospedador.limpiar("/sdk/android.jar");
      await decirEstadoJar();
      return { tipo: r.tipo, error: r.error, aviso: document.getElementById("estado-jar").textContent };
    })()`);
    comprueba("borrado el jar la pagina lo dice, no lo suppose", /sin android\.jar/.test(avisoVacio.aviso),
      JSON.stringify(avisoVacio));
    const doc = await exec("DOM.getDocument");
    const elegido = await exec("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#android-jar" });
    const puesto = await exec("DOM.setFileInputFiles", { files: [JAR_SRC], nodeId: elegido.result.nodeId });
    comprueba("chromium acepta el android.jar en el input de fichero", !puesto.error && !puesto.result.exceptionDetails,
      JSON.stringify(puesto).slice(0, 160));
    const desdeDisco = await evaluar(`(async () => {
      document.getElementById("usar-android-jar").click();
      const aviso = document.getElementById("estado-jar");
      for (let i = 0; i < 160; i++) {
        if (/26361808/.test(aviso.textContent)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const detalle = document.getElementById("detalle-sdk");
      return {
        aviso: aviso.textContent,
        guardado: !!(await hospedador.leer("/sdk/android.jar")).bytes,
        listo: detalle.classList.contains("jar-listo"),
        badge: !document.getElementById("sdk-badge").hidden,
        boton: document.getElementById("abrir-dialogo-sdk").textContent,
        cerrado: detalle.open === false,
      };
    })()`);
    const peticionesNuevo = peticiones.slice(antesDelPicker);
    comprueba("el jar elegido de disco queda en OPFS con su tamano", /26361808 bytes/.test(desdeDisco.aviso) && desdeDisco.guardado,
      JSON.stringify(desdeDisco.aviso));
    comprueba("con el jar cargado la sección se marca lista y no llama la atención",
      desdeDisco.listo === true && desdeDisco.badge === true &&
      /Cambiar android\.jar/.test(String(desdeDisco.boton)) && desdeDisco.cerrado === true,
      JSON.stringify({ listo: desdeDisco.listo, badge: desdeDisco.badge, boton: desdeDisco.boton, cerrado: desdeDisco.cerrado }));
    comprueba("entrar el jar desde el disco no hace ni una peticion",
      !peticionesNuevo.some((u) => new URL(u).pathname === "/android-jar"),
      peticionesNuevo.length + " peticiones en el tramo: " + peticionesNuevo.slice(0, 3).join(", "));
    const sinConexion = await evaluar(`(async () => {
      await hospedador.limpiar("/proyecto/build");
      document.getElementById("storepass-compilar").value = "android";
      await compilarDelTodo();
      const datos = await hospedador.bytes("/proyecto/build/app.apk");
      return { codigo: document.getElementById("ultimo-codigo").textContent, bytes: datos ? datos.length : 0 };
    })()`);
    comprueba("con el jar del disco la pestaña vuelve a compilar el apk", sinConexion.codigo === "0" && sinConexion.bytes > 5000,
      "codigo " + sinConexion.codigo + ", " + sinConexion.bytes + " bytes");

    // 9b. y el jar se eligió UNA VEZ: recargar la página no lo borra, y se puede volver a compilar
    const antesRecarga = peticiones.length;
    await exec("Page.navigate", { url: URL_PAGINA });
    for (let i = 0; i < 40; i++) {
      try { if (await evaluar("!!document.getElementById('codigo') && typeof correr === 'function'")) break; } catch (e) { /* */ }
      await esperar(300);
    }
    const recargada = await evaluar(`(async () => {
      const datos = await hospedador.bytes("/sdk/android.jar");
      await hospedador.limpiar("/proyecto/build");
      document.getElementById("storepass-compilar").value = "android";
      await compilarDelTodo();
      const apk = await hospedador.bytes("/proyecto/build/app.apk");
      return {
        aviso: document.getElementById("estado-jar").textContent, jar: datos ? datos.length : 0,
        codigo: document.getElementById("ultimo-codigo").textContent, bytes: apk ? apk.length : 0,
      };
    })()`);
    comprueba("tras recargar la página el jar sigue en OPFS sin pedirlo otra vez",
      /26361808 bytes/.test(recargada.aviso) && recargada.jar === 26361808 &&
      !peticiones.slice(antesRecarga).some((u) => new URL(u).pathname === "/android-jar"),
      "aviso " + JSON.stringify(recargada.aviso) + ", jar " + recargada.jar + ", peticiones del tramo " +
      peticiones.slice(antesRecarga).length);
    comprueba("la página recargada compila otra vez con el jar guardado",
      recargada.codigo === "0" && recargada.bytes > 5000,
      "codigo " + recargada.codigo + ", " + recargada.bytes + " bytes");

    // 10. la pestaña dictamina su propio apk: `apkc verify` vuelve a leer el fichero desde OPFS y
    //     comprueba las dos firmas sin apksigner, sin conexión y sin un solo proceso.
    const dictamen = await evaluar(`(async () => {
      await hospedador.cwd("/proyecto");
      const r = await correr(["verify", "build/app.apk"]);
      const texto = String(r.consola || "").replace(/\\u001b\\[[0-9]*m/g, "");
      await verificarLoCompilado();
      return {
        codigo: r.codigo,
        v1: texto.includes("v1 (JAR signing): ok"),
        v2: texto.includes("v2 (APK Signature Scheme v2): ok"),
        aviso: document.getElementById("estado-verificacion").textContent,
        detalle: texto.split("\\n").filter(Boolean).slice(-4).join(" | "),
      };
    })()`);
    comprueba("apkc verify sale 0 dentro de chromium sobre el apk de la pestaña", dictamen.codigo === 0,
      JSON.stringify(dictamen.detalle.slice(-200)));
    comprueba("la pestaña verifica su v1 y su v2 por sí misma", dictamen.v1 && dictamen.v2,
      JSON.stringify(dictamen.detalle.slice(-220)));
    comprueba("el veredicto se lee en la página, no solo en la consola",
      /v1 \(JAR signing\): ok/.test(dictamen.aviso) && /v2 \(APK Signature Scheme v2\): ok/.test(dictamen.aviso),
      JSON.stringify(dictamen.aviso.slice(0, 200)));

    // 10b. y el veredicto discrimina: un byte cambiado dentro de una entrada ALMACENADA (resources.arsc
    //      viaja sin comprimir y alineado) tiene que dar v1 mal y v2 mal, no un "ok" por inercia
    const alterado = await evaluar(`(async () => {
      const datos = await hospedador.bytes("/proyecto/build/app.apk");
      const a = new TextEncoder().encode("resources.arsc");
      const buscar = (aguja, desde) => {
        for (let i = desde; i < datos.length - aguja.length; i++) {
          let ok = true;
          for (let j = 0; j < aguja.length; j++) if (datos[i + j] !== aguja[j]) { ok = false; break; }
          if (ok) return i;
        }
        return -1;
      };
      const nombre = buscar(a, 0);
      if (nombre < 0) return { encontrado: false };
      const ver = nombre - 30;                                  // principio del header local
      const largoNombre = datos[ver + 26] | (datos[ver + 27] << 8);
      const largoExtra = datos[ver + 28] | (datos[ver + 29] << 8);
      const comprimido = datos[ver + 18] | (datos[ver + 19] << 8) | (datos[ver + 20] << 16) | (datos[ver + 21] << 24);
      const datosDe = ver + 30 + largoNombre + largoExtra;
      datos[datosDe + Math.floor(comprimido / 2)] ^= 0x08;
      await hospedador.escribir("/proyecto/build/mal.apk", new Uint8Array(datos));
      await hospedador.cwd("/proyecto");
      const r = await correr(["verify", "build/mal.apk"]);
      const texto = String(r.consola || "").replace(/\\u001b\\[[0-9]*m/g, "");
      return {
        encontrado: true, codigo: r.codigo, tamano: comprimido,
        v1mal: texto.includes("v1 (JAR signing): mal"),
        v2mal: texto.includes("v2 (APK Signature Scheme v2): mal"),
        detalle: texto.split("\\n").filter(Boolean).slice(-3).join(" | "),
      };
    })()`);
    comprueba("el apk alterado se puede preparar en la pestaña", alterado.encontrado === true,
      JSON.stringify(alterado).slice(0, 120));
    comprueba("apkc verify rechaza el apk con un byte cambiado dentro de chromium",
      alterado.codigo !== 0 && alterado.v1mal === true && alterado.v2mal === true,
      "codigo " + alterado.codigo + ", " + JSON.stringify(String(alterado.detalle).slice(-220)));

    // 11. y se puede ESCRIBIR un fuente propio, no solo el que genera la página: campos con
    // modificadores, una cadena de llamadas, cuentas enteras, las branquias del párrafo 52 y la
    // concatenación de cadenas del párrafo 53
    const fuenteEscrita = [
      "package com.myapp;",
      "",
      "import android.app.*;",
      "import android.os.*;",
      "import android.view.*;",
      "import android.widget.*;",
      "",
      "public class MainActivity extends Activity {",
      "    private int pulsos = 0;",
      "    static int total = 5;",
      "",
      "    @Override",
      "    public void onCreate(Bundle savedInstanceState) {",
      "        super.onCreate(savedInstanceState);",
      "        setContentView(R.layout.main);",
      "        View raiz = getWindow().getDecorView();",
      "        pulsos = pulsos + 1;",
      "        if (pulsos > 2) { total = total * 2; } else { total = total + 1; }",
      "        if (raiz != null) { raiz.setVisibility(0); }",
      "        Toast.makeText(this, \"cuenta \" + pulsos, Toast.LENGTH_SHORT).show();",
      "    }",
      "}",
      "",
    ].join("\n");
    const escrito = await evaluar(`(async () => {
      await hospedador.escribir("/proyecto/src/com/myapp/MainActivity.java",
        new TextEncoder().encode(${JSON.stringify(fuenteEscrita)}));
      await hospedador.limpiar("/proyecto/build");
      document.getElementById("storepass-compilar").value = "android";
      await compilarDelTodo();
      const r = await correr(["verify", "build/app.apk"]);
      const texto = String(r.consola || "").replace(/\\u001b\\[[0-9]*m/g, "");
      const datos = await hospedador.bytes("/proyecto/build/app.apk");
      return {
        codigo: document.getElementById("ultimo-codigo").textContent,
        bytes: datos ? Array.from(datos) : null,
        clases: /-> (\\d+) clases/.exec(String(r.consola || "")),
        v1: texto.includes("v1 (JAR signing): ok"), v2: texto.includes("v2 (APK Signature Scheme v2): ok"),
        detalle: texto.split("\\n").filter(Boolean).slice(0, 2).join(" | "),
      };
    })()`);
    const apkEscrita = Buffer.from(escrito.bytes || [], "uint8");
    comprueba("un fuente escrito a mano compila entero en la pestaña", escrito.codigo === "0" && apkEscrita.length > 5000,
      "codigo " + escrito.codigo + ", " + apkEscrita.length + " bytes, consola: " + JSON.stringify(String(escrito.detalle).slice(-180)));
    comprueba("y su apk verifica igual que el generado", escrito.v1 === true && escrito.v2 === true,
      JSON.stringify(String(escrito.detalle).slice(-180)));
    fs.writeFileSync(path.join(fuera, "pestanera-escrita.apk"), apkEscrita);
    console.log("  --- el apk del fuente escrito a mano, compilado en la pestaña, es " +
      path.join(fuera, "pestanera-escrita.apk"));

    // 12. y la app puede CONTAR: una anonima sobre una interfaz del framework que escribe el campo del
    // exterior, decide con `if` y arma el texto con concatenación (párrafo 54). Es el fuente que la
    // página no genera y que, instalado, hace algo.
    const fuenteContador = [
      "package com.myapp;",
      "",
      "import android.app.*;",
      "import android.os.*;",
      "import android.view.*;",
      "import android.widget.*;",
      "",
      "public class MainActivity extends Activity {",
      "    int pulsos = 0;",
      "    static int total = 5;",
      "",
      "    @Override",
      "    public void onCreate(Bundle savedInstanceState) {",
      "        super.onCreate(savedInstanceState);",
      "        setContentView(R.layout.main);",
      "        findViewById(R.id.pulsar).setOnClickListener(new View.OnClickListener() {",
      "            public void onClick(View v) {",
      "                pulsos = pulsos + 1;",
      "                total = total + pulsos;",
      "                if (pulsos > 3) { v.setContentDescription(\"muchos \" + pulsos); }",
      "                else { v.setContentDescription(\"pulsos \" + pulsos); }",
      "                Toast.makeText(MainActivity.this, \"llevas \" + pulsos, Toast.LENGTH_SHORT).show();",
      "            }",
      "        });",
      "    }",
      "}",
      "",
    ].join("\n");
    const contador = await evaluar(`(async () => {
      // se le anade un boton con id al layout que creo apkc: es lo que alguien escribiria en el
      // editor, y lo que exige R.id.pulsar para poder enlazar el listener
      const layout = (await hospedador.texto("/proyecto/res/layout/main.xml")) || "";
      const boton = '\\n    <Button\\n        android:id="@+id/pulsar"\\n        android:layout_width="wrap_content"\\n        android:layout_height="wrap_content"\\n        android:text="Press me"/>\\n';
      await hospedador.escribir("/proyecto/res/layout/main.xml",
        new TextEncoder().encode(layout.replace("</LinearLayout>", boton + "</LinearLayout>")));
      await hospedador.escribir("/proyecto/src/com/myapp/MainActivity.java",
        new TextEncoder().encode(${JSON.stringify(fuenteContador)}));
      await hospedador.limpiar("/proyecto/build");
      document.getElementById("storepass-compilar").value = "android";
      // la vista dividida, en modo Emulador, y el cursor del editor en una posición conocida: compilar
      // no puede cambiar ni una cosa ni la otra
      document.getElementById("previa-modo-render").click();
      const area = document.getElementById("codigo");
      area.focus();
      area.setSelectionRange(12, 12);
      const rutaAntes = estadoPestana.ruta;
      await compilarDelTodo();
      const r = await correr(["verify", "build/app.apk"]);
      const texto = String(r.consola || "").replace(/\\u001b\\[[0-9]*m/g, "");
      const datos = await hospedador.bytes("/proyecto/build/app.apk");
      const lateral = document.getElementById("previa-lateral-canvas");
      const ctxLateral = lateral.getContext("2d");
      const pixeles = ctxLateral.getImageData(0, 0, lateral.width, lateral.height).data;
      const colores = new Set();
      for (let i = 0; i < pixeles.length; i += 4) colores.add(pixeles[i] + "," + pixeles[i + 1] + "," + pixeles[i + 2] + "," + pixeles[i + 3]);
      const vacio = document.getElementById("previa-log-vacio");
      return {
        codigo: document.getElementById("ultimo-codigo").textContent,
        bytes: datos ? Array.from(datos) : null,
        v1: texto.includes("v1 (JAR signing): ok"), v2: texto.includes("v2 (APK Signature Scheme v2): ok"),
        detalle: texto.split("\\n").filter(Boolean).slice(0, 2).join(" | "),
        consola: String(r.consola || "").slice(-260),
        vista: document.body.dataset.vista,
        rutaAntes, rutaTras: estadoPestana.ruta,
        seleccion: [area.selectionStart, area.selectionEnd],
        lateralColores: colores.size,
        lateralAncho: lateral.width,
        lateralAlto: lateral.height,
        lateralVisible: lateral.clientWidth,
        renderEstado: document.getElementById("previa-render-estado").textContent,
        logCabecera: document.getElementById("previa-log-cabecera").textContent,
        logEntradas: document.getElementById("previa-log-lista").children.length,
        logTexto: document.getElementById("previa-log-lista").textContent,
        logVacio: vacio.hidden ? "" : vacio.textContent,
        consolaLimpia: !/Pulsos|Hello World|TextView\\.setText/.test(document.getElementById("consola-pestana").textContent),
      };
    })()`);
    const apkContador = Buffer.from(contador.bytes || [], "uint8");
    comprueba("la app del contador compila entera en la pestaña", contador.codigo === "0" && apkContador.length > 5000,
      "codigo " + contador.codigo + ", " + apkContador.length + " bytes, consola: " + JSON.stringify(String(contador.consola).slice(-180)));
    comprueba("y su apk verifica con la anonima, el if y la concatenación dentro",
      contador.v1 === true && contador.v2 === true,
      JSON.stringify(String(contador.detalle).slice(-180)));
    // la vista dividida ya está delante mientras compila: la pantalla se repinta sola, el cursor
    // del editor no se mueve y el modelo no se cuela en la consola de compilación
    comprueba("compilar con la vista dividida repinta el teléfono sin cambiar de pestaña ni mover el cursor",
      contador.vista === "pestana" && contador.lateralVisible > 0 &&
      contador.lateralColores > 3 && contador.lateralAncho > 0 &&
      contador.rutaAntes === contador.rutaTras &&
      contador.seleccion[0] === 12 && contador.seleccion[1] === 12 &&
      /Emulador/.test(String(contador.renderEstado)) && !/compilando/i.test(String(contador.renderEstado)),
      JSON.stringify({ vista: contador.vista, visible: contador.lateralVisible,
        colores: contador.lateralColores, ancho: contador.lateralAncho,
        seleccion: contador.seleccion, estado: contador.renderEstado }).slice(0, 320));
    comprueba("la consola de la ejecución se llena al compilar y no toca la consola de apkc",
      /pasos?/.test(String(contador.logCabecera)) &&
      (contador.logEntradas > 0) !== (String(contador.logVacio).length > 0) &&
      contador.consolaLimpia === true,
      JSON.stringify({ cabecera: contador.logCabecera, entradas: contador.logEntradas,
        vacio: String(contador.logVacio).slice(0, 120), limpia: contador.consolaLimpia }).slice(0, 320));

    // 12a-bis. la vista previa que se pintó al compilar: al entrar en la vista se repinta dentro
    // de la caja visible, con un color de fondo, el marco y cada rectángulo. El canvas es de solo
    // lectura y el comando no pasó por la consola ni pisó el último código del build.
    const previa = await evaluar(`(() => {
      document.querySelector('nav.actividad [data-vista="vista"]').click();
      const canvas = document.getElementById("vista-previa");
      const ctx = canvas.getContext("2d");
      const datos = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colores = new Set();
      for (let i = 0; i < datos.length; i += 4) {
        colores.add(datos[i] + "," + datos[i + 1] + "," + datos[i + 2] + "," + datos[i + 3]);
      }
      const r = {
        cuerpo: document.body.dataset.vista,
        activa: document.getElementById("vista").classList.contains("activa"),
        estado: document.getElementById("vista-previa-estado").textContent,
        colores: colores.size,
        pixel: canvas.width > 0 && canvas.height > 0,
        visible: canvas.clientWidth,
        ancho: canvas.width,
        alto: canvas.height,
        codigo: document.getElementById("ultimo-codigo").textContent,
        enConsola: /apkc preview/.test(document.getElementById("consola-pestana").textContent),
      };
      document.querySelector('nav.actividad [data-vista="pestana"]').click();
      return r;
    })()`);
    comprueba("la vista previa pinta el modelo del apk compilado en el canvas",
      /3 nodos/.test(String(previa.estado)) && previa.colores > 3 && previa.pixel === true,
      JSON.stringify(previa).slice(0, 260));
    comprueba("al entrar en Pantalla se repinta dentro de la caja visible y avisa de que el emulador es aproximado",
      previa.cuerpo === "vista" && previa.activa === true && previa.visible > 0 &&
      previa.ancho >= previa.visible && /aproximad[oa]/.test(String(previa.estado)),
      JSON.stringify({ cuerpo: previa.cuerpo, visible: previa.visible, ancho: previa.ancho, estado: previa.estado }).slice(0, 260));
    comprueba("la vista previa no ensucia la consola ni el último código del build",
      previa.codigo === "0" && previa.enConsola === false,
      JSON.stringify({ codigo: previa.codigo, enConsola: previa.enConsola }));

    // 12a-ter. un preview forzado a fallar: el apk se corrompe, se llama a la función a pelo y
    // ni la consola ni el último código del build pueden cambiar; el panel queda con su motivo.
    const previaRota = await evaluar(`(async () => {
      const sano = await hospedador.bytes("/proyecto/build/app.apk");
      const antesCodigo = document.getElementById("ultimo-codigo").textContent;
      const antesConsola = document.getElementById("consola-pestana").textContent;
      await hospedador.escribir("/proyecto/build/app.apk",
        new TextEncoder().encode("esto no es un zip, y preview tiene que decirlo"));
      const r = await previsualizarLoCompilado();
      const roto = {
        antesCodigo,
        codigo: document.getElementById("ultimo-codigo").textContent,
        consolaIgual: document.getElementById("consola-pestana").textContent === antesConsola,
        estado: document.getElementById("vista-previa-estado").textContent,
        devuelto: r === null,
        bytes: sano ? sano.length : 0,
        logLista: document.getElementById("previa-log-lista").children.length,
        logVacio: !document.getElementById("previa-log-vacio").hidden,
        logTexto: document.getElementById("previa-log-vacio").textContent,
      };
      await hospedador.escribir("/proyecto/build/app.apk", sano);
      return roto;
    })()`);
    comprueba("un apk corrupto deja el panel con un mensaje y no toca la consola ni el último código",
      previaRota.devuelto === true && previaRota.bytes > 5000 &&
      previaRota.codigo === previaRota.antesCodigo && previaRota.consolaIgual === true &&
      /no devolvió un modelo legible|no hay build/i.test(String(previaRota.estado)),
      JSON.stringify(previaRota).slice(0, 320));
    comprueba("un preview fallido deja la consola de la ejecución vacía y con su motivo",
      previaRota.logLista === 0 && previaRota.logVacio === true &&
      /no devolvió un modelo legible|no hay build/i.test(String(previaRota.logTexto)),
      JSON.stringify({ lista: previaRota.logLista, vacio: previaRota.logVacio,
        texto: String(previaRota.logTexto).slice(0, 160) }));

    // 12a-ter-bis. el registro del emulador y la consola de la app con el JSON del Contador: la
    // captura de `setText`, los `Log.d`/`println` que van a las dos partes, los avisos aparte, las
    // cuentas y el botón de pulsar. Se inyecta por `pintarVistaPrevia`, que es la misma entrada que
    // usa un build correcto, así la prueba no depende de lo que capture el fuente de este proyecto.
    const logContador = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const modelo = {
        paquete: "com.hola.contador", version: "0.1", actividad: ".MainActivity",
        layout: "res/layout/main.xml",
        pantalla: { x: 0, y: 0, ancho: 360, alto: 640 }, aproximado: true, nodos: 3,
        raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 360, alto: 640 }, hijos: [
          { tipo: "TextView", id: "id/total", texto: "Pulsos: 0", textoDinamico: "Pulsos: 1",
            rect: { x: 0, y: 0, ancho: 176, alto: 48 } },
          { tipo: "Button", id: "id/pulsar", idRef: "0x7f010000", texto: "Pulsar", oyente: true,
            rect: { x: 0, y: 48, ancho: 96, alto: 48 } },
        ] },
        ejecucion: { actividad: "com.hola.contador.MainActivity", metodo: "onCreate", pasos: 137,
          interacciones: 1,
          capturas: [
            { origen: "TextView.setText", id: "id/total", idRef: "0x7f010001", texto: "Pulsos: 1" },
            { origen: "Log.d", texto: "onClick" },
            { origen: "println", texto: "hola" },
          ],
          consola: [
            { origen: "Log.d", texto: "onClick", secuencia: 1 },
            { origen: "println", texto: "hola", secuencia: 2 },
          ],
          oyentes: [{ id: "id/pulsar", idRef: "0x7f010000" }],
          pulsaciones: ["id/pulsar"],
          avisos: ["stub sin resolver: android.widget.Toast"] },
      };
      vp.pintarVistaPrevia(modelo);
      const lista = document.getElementById("previa-log-lista");
      const consola = document.getElementById("previa-consola-lista");
      const canvas = document.getElementById("previa-lateral-canvas");
      const ctx = canvas.getContext("2d");
      const pixeles = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colores = new Set();
      for (let i = 0; i < pixeles.length; i += 4) colores.add(pixeles[i] + "," + pixeles[i + 1] + "," + pixeles[i + 2] + "," + pixeles[i + 3]);
      return {
        cabecera: document.getElementById("previa-log-cabecera").textContent,
        vacio: document.getElementById("previa-log-vacio").hidden,
        lineas: [...lista.children].map((li) => ({ clase: li.className, texto: li.textContent })),
        consola: [...consola.children].map((li) => li.textContent),
        consolaCabecera: document.getElementById("previa-consola-cabecera").textContent,
        consolaVacio: document.getElementById("previa-consola-vacio").hidden,
        botones: [...document.querySelectorAll("#previa-oyentes .previa-oyente")]
          .map((b) => ({ texto: b.textContent, idref: b.dataset.idref })),
        cuentaPulsos: document.getElementById("previa-pulsos-cuenta").textContent,
        estatusConsolaCompilacion: document.getElementById("consola-pestana").textContent.slice(-120),
        colores: colores.size,
        render: document.getElementById("previa-render-estado").textContent,
      };
    })()`);
    const lineasLog = logContador.lineas || [];
    comprueba("el registro del emulador pinta las capturas del Contador con su origen y su id",
      /onCreate/.test(String(logContador.cabecera)) && /137 pasos/.test(String(logContador.cabecera)) &&
      /1 clic/.test(String(logContador.cabecera)) &&
      lineasLog.length === 4 &&
      /TextView\.setText id\/total:.*Pulsos: 1/.test(String(lineasLog[0] && lineasLog[0].texto)) &&
      /Log\.d:.*onClick/.test(String(lineasLog[1] && lineasLog[1].texto)) &&
      /println:.*hola/.test(String(lineasLog[2] && lineasLog[2].texto)),
      JSON.stringify({ cabecera: logContador.cabecera, lineas: lineasLog }).slice(0, 400));
    comprueba("los avisos del intérprete van aparte y el vacío no tapa la lista",
      /aviso/.test(String(lineasLog[3] && lineasLog[3].clase)) &&
      /Toast/.test(String(lineasLog[3] && lineasLog[3].texto)) && logContador.vacio === true,
      JSON.stringify({ clase: lineasLog[3] && lineasLog[3].clase, texto: lineasLog[3] && lineasLog[3].texto }));
    comprueba("la consola de la app pinta la salida de Log y println, separada del registro",
      (logContador.consola || []).length === 2 &&
      /^1\s*Log\.d.*onClick$/.test(String(logContador.consola[0])) &&
      /^2\s*println.*hola$/.test(String(logContador.consola[1])) &&
      /2 líneas/.test(String(logContador.consolaCabecera)) && logContador.consolaVacio === true &&
      !/hola/.test(String(lineasLog[3] && lineasLog[3].texto)),
      JSON.stringify({ consola: logContador.consola, cabecera: logContador.consolaCabecera }).slice(0, 320));
    comprueba("el emulador ofrece el botón de la vista que responde a un clic y cuenta los clics",
      (logContador.botones || []).length === 1 &&
      String(logContador.botones[0].texto) === "id/pulsar · Pulsar" &&
      String(logContador.botones[0].idref) === "0x7f010000" &&
      String(logContador.cuentaPulsos) === "1 clic",
      JSON.stringify(logContador.botones) + " / " + logContador.cuentaPulsos);
    comprueba("el render del Contador pinta el texto dinámico y no solo la etiqueta",
      logContador.colores > 3 && /Emulador/.test(String(logContador.render)),
      JSON.stringify({ colores: logContador.colores, estado: logContador.render }).slice(0, 240));

    // 12a-ter-ies. el texto de un nodo bajo (24 px de layout, 18 px pintados) no se puede suprimir:
    // se cuenta tinta dentro del nodo con el texto y sin él. Antes el guard `alto >= 28` dejaba el
    // «Hello World!» del apk Hola y el «Pulsos: 1» del Contador sin pintar.
    const tinta = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const conNodo = (nodo) => ({ layout: "res/layout/main.xml",
        pantalla: { ancho: 360, alto: 640 }, aproximado: true,
        raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 360, alto: 640 }, hijos: [nodo] } });
      const medir = (modelo, texto) => {
        const canvas = document.createElement("canvas");
        vp.pintarModelo(canvas, modelo, { ancho: 270, alto: 480 });
        const ctx = canvas.getContext("2d");
        const dpr = canvas.width / 270;
        const nodo = vp.rectsEscalados(modelo, 270, 480)[1];
        // se recorta el borde del nodo: lo que se cuenta es tinta de texto, no el trazo de 1 px
        const margen = 2 * dpr;
        const x = Math.max(0, Math.round(nodo.x * dpr + margen));
        const y = Math.max(0, Math.round(nodo.y * dpr + margen));
        const ancho = Math.max(1, Math.round(nodo.ancho * dpr - 2 * margen));
        const alto = Math.max(1, Math.round(nodo.alto * dpr - 2 * margen));
        const datos = ctx.getImageData(x, y, ancho, alto).data;
        const cuenta = new Map();
        for (let i = 0; i < datos.length; i += 4) {
          const clave = datos[i] + "," + datos[i + 1] + "," + datos[i + 2];
          cuenta.set(clave, (cuenta.get(clave) || 0) + 1);
        }
        let fondo = [0, 0, 0], maximo = -1;
        for (const [clave, n] of cuenta) {
          if (n > maximo) { maximo = n; fondo = clave.split(",").map(Number); }
        }
        let tinta = 0;
        for (let i = 0; i < datos.length; i += 4) {
          const d = Math.abs(datos[i] - fondo[0]) + Math.abs(datos[i + 1] - fondo[1]) + Math.abs(datos[i + 2] - fondo[2]);
          if (d > 40) tinta++;
        }
        return { tinta, alto: Math.round(nodo.alto), ancho: Math.round(nodo.ancho), texto: nodo.texto };
      };
      const hola = { tipo: "TextView", texto: "Hello World!", rect: { x: 0, y: 0, ancho: 112, alto: 24 } };
      const contador = { tipo: "TextView", id: "id/total", texto: "Pulsos: 0", textoDinamico: "Pulsos: 1",
        rect: { x: 0, y: 0, ancho: 88, alto: 24 } };
      const conTexto = medir(conNodo(hola));
      const sinTexto = medir(conNodo({ ...hola, texto: "" }));
      const dinamico = medir(conNodo(contador));
      const sinDinamico = medir(conNodo({ ...contador, texto: "", textoDinamico: "" }));
      return { conTexto, sinTexto, dinamico, sinDinamico };
    })()`);
    comprueba("un nodo de 18 px pinta el texto: hay tinta con «Hello World!» y ninguna sin él",
      tinta.conTexto.alto <= 20 && tinta.conTexto.tinta > 20 && tinta.sinTexto.tinta === 0 &&
      tinta.conTexto.texto === "Hello World!",
      JSON.stringify(tinta.conTexto) + " / " + JSON.stringify(tinta.sinTexto));
    comprueba("y el texto dinámico del Contador también se pinta en el nodo bajo",
      tinta.dinamico.tinta > 20 && tinta.sinDinamico.tinta === 0 &&
      tinta.dinamico.texto === "Pulsos: 1",
      JSON.stringify(tinta.dinamico) + " / " + JSON.stringify(tinta.sinDinamico));

    // 12a-ter-septies. el clic del emulador medido con un puntero de verdad: se escribe el Contador
    // de la plantilla (el `setText` vive en el `onClick`, más un `Log.d` y un `println`), se compila y
    // se pulsa con `Input.dispatchMouseEvent` sobre el rectángulo del botón. La pantalla arranca en
    // «Pulsos: 0» sin ninguna pulsación simulada, el primer clic la deja en «Pulsos: 1» y el segundo
    // en «Pulsos: 2», porque la lista de clics se repite entera en cada `apkc preview --pulsar`.
    const layoutClic = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    android:orientation="vertical"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent"',
      '    android:gravity="center">',
      '    <TextView',
      '        android:id="@+id/total"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Pulsos: 0"/>',
      '    <Button',
      '        android:id="@+id/pulsar"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Pulsar"/>',
      '</LinearLayout>',
      "",
    ].join("\n");
    const fuenteClic = [
      "package com.myapp;",
      "",
      "import android.app.*;",
      "import android.os.*;",
      "import android.util.Log;",
      "import android.view.*;",
      "import android.widget.*;",
      "",
      "public class MainActivity extends Activity {",
      "    int pulsos = 0;",
      "    TextView total;",
      "",
      "    @Override",
      "    public void onCreate(Bundle savedInstanceState) {",
      "        super.onCreate(savedInstanceState);",
      "        setContentView(R.layout.main);",
      "        total = (TextView) findViewById(R.id.total);",
      "        findViewById(R.id.pulsar).setOnClickListener(new View.OnClickListener() {",
      "            public void onClick(View v) {",
      "                pulsos = pulsos + 1;",
      "                total.setText(\"Pulsos: \" + pulsos);",
      "                Log.d(\"Contador\", \"pulso \" + pulsos);",
      "                System.out.println(\"contador: pulso \" + pulsos);",
      "            }",
      "        });",
      "    }",
      "}",
      "",
    ].join("\n");
    const emulador = await evaluar(`(async () => {
      await hospedador.escribir("/proyecto/res/layout/main.xml", new TextEncoder().encode(${JSON.stringify(layoutClic)}));
      await hospedador.escribir("/proyecto/src/com/myapp/MainActivity.java", new TextEncoder().encode(${JSON.stringify(fuenteClic)}));
      await hospedador.limpiar("/proyecto/build");
      document.getElementById("storepass-compilar").value = "android";
      document.getElementById("previa-modo-render").click();
      await compilarDelTodo();
      const vp = await import("/vista-previa.js");
      const modelo = vp.modeloActual();
      const total = modelo && modelo.raiz ? (modelo.raiz.hijos || []).find((h) => h.id === "id/total") : null;
      const canvas = document.getElementById("previa-lateral-canvas");
      // el mismo espacio que usa el manejador del clic: el de la última pintura
      const espacio = canvas.__espacio || { ancho: canvas.clientWidth, alto: canvas.clientHeight };
      const ancho = espacio.ancho, alto = espacio.alto;
      const caja = canvas.getBoundingClientRect();
      const rect = modelo ? vp.rectsEscalados(modelo, ancho, alto).find((r) => r.id === "id/pulsar") : null;
      // qué elemento hay de verdad en ese punto de la ventana: si no es el canvas, el clic sintético
      // no llegará al manejador por mucho que la geometría sea correcta
      let encima = null;
      if (rect) {
        const px = caja.left + (rect.x + rect.ancho / 2) * (caja.width / ancho);
        const py = caja.top + (rect.y + rect.alto / 2) * (caja.height / alto);
        const el = typeof document.elementFromPoint === "function" ? document.elementFromPoint(px, py) : null;
        encima = el ? (el.id || String(el.className || el.tagName)) : null;
      }
      return {
        modelo: !!modelo,
        reposo: total ? (total.textoDinamico || "") : null,
        textoDeclarado: total ? (total.texto || "") : null,
        interacciones: modelo && modelo.ejecucion ? (modelo.ejecucion.interacciones || 0) : -1,
        oyentes: modelo && modelo.ejecucion ? (modelo.ejecucion.oyentes || []).map((o) => o.id) : [],
        rect: rect ? { x: rect.x, y: rect.y, ancho: rect.ancho, alto: rect.alto, oyente: rect.oyente } : null,
        encima,
        ancho, alto,
        cliente: { ancho: canvas.clientWidth, alto: canvas.clientHeight },
        caja: { left: caja.left, top: caja.top, width: caja.width, height: caja.height },
        caja: { left: caja.left, top: caja.top, width: caja.width, height: caja.height },
        registroEntradas: document.getElementById("previa-log-lista").children.length,
        consolaEntradas: document.getElementById("previa-consola-lista").children.length,
        botones: [...document.querySelectorAll("#previa-oyentes .previa-oyente")].map((b) => b.dataset.idref),
        estado: document.getElementById("previa-render-estado").textContent,
      };
    })()`);
    comprueba("el emulador arranca en el estado de onCreate, sin pulsar nada",
      emulador.modelo === true && emulador.reposo === "" && emulador.textoDeclarado === "Pulsos: 0" &&
      emulador.interacciones === 0 && (emulador.oyentes || []).includes("id/pulsar") &&
      emulador.rect && emulador.rect.oyente === true && /Pulsa/i.test(String(emulador.estado)),
      JSON.stringify({ reposo: emulador.reposo, interacciones: emulador.interacciones,
        oyentes: emulador.oyentes, rect: emulador.rect }).slice(0, 320));
    const puntoClic = (emulador.rect && emulador.caja && emulador.ancho > 0 && emulador.alto > 0)
      ? {
        x: emulador.caja.left + (emulador.rect.x + emulador.rect.ancho / 2) * (emulador.caja.width / emulador.ancho),
        y: emulador.caja.top + (emulador.rect.y + emulador.rect.alto / 2) * (emulador.caja.height / emulador.alto),
      } : null;
    // un puntero de verdad sobre el canvas: el mismo evento que produce un dedo o un ratón
    const pulsarCanvas = async (esperado) => {
      // sonda: cuenta los `pointerdown` que llegan al canvas, para distinguir «el clic no llegó»
      // de «llegó y el manejador no encontró vista que escuche»
      await evaluar(`(() => {
        const canvas = document.getElementById("previa-lateral-canvas");
        if (!canvas) return -1;
        canvas.__sonda = canvas.__sonda || 0;
        if (!canvas.__conectada) {
          canvas.__conectada = true;
          canvas.addEventListener("pointerdown", () => { canvas.__sonda++; });
        }
        return canvas.__sonda;
      })()`);
      await exec("Input.dispatchMouseEvent",
        { type: "mousePressed", x: puntoClic.x, y: puntoClic.y, button: "left", clickCount: 1 });
      await exec("Input.dispatchMouseEvent",
        { type: "mouseReleased", x: puntoClic.x, y: puntoClic.y, button: "left", clickCount: 1 });
      return evaluar(`(async () => {
        const vp = await import("/vista-previa.js");
        const leer = () => {
          const m = vp.modeloActual();
          const t = m && m.raiz ? (m.raiz.hijos || []).find((h) => h.id === "id/total") : null;
          return { texto: t ? (t.textoDinamico || "") : null, modelo: m };
        };
        let visto = leer();
        for (let i = 0; i < 150 && visto.texto !== ${JSON.stringify(esperado)}; i++) {
          await new Promise((ok) => setTimeout(ok, 100));
          visto = leer();
        }
        const m = visto.modelo;
        const canvas = document.getElementById("previa-lateral-canvas");
        return {
          texto: visto.texto,
          sonda: canvas ? (canvas.__sonda || 0) : -1,
          interacciones: m && m.ejecucion ? (m.ejecucion.interacciones || 0) : -1,
          pulsaciones: m && m.ejecucion ? (m.ejecucion.pulsaciones || []) : [],
          registro: [...document.getElementById("previa-log-lista").children].map((li) => li.textContent),
          consola: [...document.getElementById("previa-consola-lista").children].map((li) => li.textContent),
          consolaCabecera: document.getElementById("previa-consola-cabecera").textContent,
          cuentaPulsos: document.getElementById("previa-pulsos-cuenta").textContent,
          estado: document.getElementById("previa-render-estado").textContent,
          consolaCompilacion: document.getElementById("consola-pestana").textContent.slice(-400),
        };
      })()`);
    };
    if (!puntoClic) {
      comprueba("el canvas del render tiene un rectángulo pulsable para id/pulsar", false,
        JSON.stringify({ rect: emulador.rect, ancho: emulador.ancho, alto: emulador.alto }));
    } else {
      comprueba("el punto del clic cae sobre el canvas del render y no sobre otra capa",
        emulador.encima === "previa-lateral-canvas", String(emulador.encima));
      const primerClic = await pulsarCanvas("Pulsos: 1");
      comprueba("un clic real en el canvas sobre id/pulsar ejecuta su onClick: «Pulsos: 1»",
        primerClic.sonda === 1 && primerClic.texto === "Pulsos: 1" && primerClic.interacciones === 1 &&
        (primerClic.pulsaciones || []).length === 1 && /1 clic/.test(String(primerClic.cuentaPulsos)),
        JSON.stringify({ texto: primerClic.texto, interacciones: primerClic.interacciones,
          pulsaciones: primerClic.pulsaciones, cuenta: primerClic.cuentaPulsos, sonda: primerClic.sonda,
          encima: emulador.encima, espacio: { ancho: emulador.ancho, alto: emulador.alto },
          cliente: emulador.cliente, caja: emulador.caja, rect: emulador.rect,
          estado: primerClic.estado }).slice(0, 600));
      comprueba("el clic escribe en el registro del emulador: setText, Log.d y println",
        (primerClic.registro || []).some((l) => /TextView\.setText id\/total:.*Pulsos: 1/.test(l)) &&
        (primerClic.registro || []).some((l) => /Log\.d:.*pulso 1/.test(l)) &&
        (primerClic.registro || []).some((l) => /println:.*contador: pulso 1/.test(l)),
        JSON.stringify(primerClic.registro).slice(0, 400) + " | " + String(primerClic.estado).slice(0, 120));
      comprueba("el clic imprime en la consola de la app, separada de la del build",
        (primerClic.consola || []).length === 2 &&
        /Log\.d/.test(String(primerClic.consola[0])) &&
        /contador: pulso 1/.test(String(primerClic.consola[1])) &&
        /2 líneas · 1 clic/.test(String(primerClic.consolaCabecera)) &&
        !/Pulsos|pulso 1/.test(String(primerClic.consolaCompilacion)),
        JSON.stringify({ consola: primerClic.consola, cabecera: primerClic.consolaCabecera,
          build: String(primerClic.consolaCompilacion).slice(-80) }).slice(0, 400));
      const segundoClic = await pulsarCanvas("Pulsos: 2");
      comprueba("un segundo clic reproduce el estado con «Pulsos: 2» y dos líneas más de consola",
        segundoClic.texto === "Pulsos: 2" && segundoClic.interacciones === 2 &&
        (segundoClic.pulsaciones || []).length === 2 && (segundoClic.consola || []).length === 4 &&
        /pulso 2/.test(String(segundoClic.consola[3])) && /2 clics/.test(String(segundoClic.cuentaPulsos)),
        JSON.stringify({ texto: segundoClic.texto, interacciones: segundoClic.interacciones,
          consola: segundoClic.consola, cuenta: segundoClic.cuentaPulsos }).slice(0, 400));

      // 12a-ter-septies-bis. las tres secciones del emulador (Pulsar, Registro y Consola) alternan
      // como las del panel de compilación: una visible cada vez y el contenido de la que se oculta
      // sigue en el DOM, sin volver a compilar ni perder líneas.
      const secciones = await evaluar(`(() => {
        const visible = (id) => { const e = document.getElementById(id); return e ? !e.hidden : null; };
        const estado = () => ({
          pulsos: visible("previa-pulsos"), registro: visible("previa-log"),
          consola: visible("previa-consola"),
          activa: [...document.querySelectorAll(".previa-secciones [role=tab]")]
            .filter((b) => b.id.startsWith("previa-seccion-") && b.getAttribute("aria-selected") === "true")
            .map((b) => b.id),
          pulsosBotones: document.querySelectorAll("#previa-oyentes .previa-oyente").length,
          logLineas: document.getElementById("previa-log-lista").children.length,
          consolaLineas: document.getElementById("previa-consola-lista").children.length,
        });
        const antes = estado();
        document.getElementById("previa-seccion-registro").click();
        const registro = estado();
        document.getElementById("previa-seccion-consola").click();
        const consola = estado();
        document.getElementById("previa-seccion-pulsos").click();
        return { antes, registro, consola, vuelta: estado(),
          guardada: (() => { try { return localStorage.getItem("apkc-studio/previa-seccion"); } catch (e) { return null; } })() };
      })()`);
      comprueba("las secciones del emulador alternan sin perder lo que tenían dentro",
        secciones.antes.pulsos === true && secciones.antes.registro === false &&
        secciones.antes.consola === false && secciones.antes.activa.join() === "previa-seccion-pulsos" &&
        secciones.registro.pulsos === false && secciones.registro.registro === true &&
        secciones.registro.consola === false && secciones.registro.activa.join() === "previa-seccion-registro" &&
        secciones.consola.consola === true && secciones.consola.registro === false &&
        secciones.consola.activa.join() === "previa-seccion-consola" &&
        secciones.vuelta.pulsos === true && secciones.vuelta.activa.join() === "previa-seccion-pulsos" &&
        secciones.vuelta.pulsosBotones === secciones.antes.pulsosBotones &&
        secciones.vuelta.logLineas === secciones.antes.logLineas &&
        secciones.vuelta.consolaLineas === secciones.antes.consolaLineas &&
        secciones.guardada === "pulsos",
        JSON.stringify(secciones).slice(0, 600));

      // 12a-ter-septies-ter. la vista Pantalla tiene las mismas tres secciones y su canvas también
      // entrega el clic: el dedo sobre el teléfono grande ejecuta el mismo `--pulsar`.
      await evaluar(`(() => {
        document.querySelector('nav.actividad [data-vista="vista"]').click();
        document.getElementById("vista-modo-emulador").click();
      })()`);
      await esperar(500);
      const puntoVista = await evaluar(`(async () => {
        const vp = await import("/vista-previa.js");
        const modelo = vp.modeloActual();
        const canvas = document.getElementById("vista-previa");
        const espacio = canvas.__espacio || { ancho: canvas.clientWidth, alto: canvas.clientHeight };
        const rect = modelo ? vp.rectsEscalados(modelo, espacio.ancho, espacio.alto).find((r) => r.id === "id/pulsar") : null;
        const caja = canvas.getBoundingClientRect();
        if (!rect || !(espacio.ancho > 0) || !(caja.width > 0)) return { punto: null, espacio, caja: null };
        return { punto: {
          x: caja.left + (rect.x + rect.ancho / 2) * (caja.width / espacio.ancho),
          y: caja.top + (rect.y + rect.alto / 2) * (caja.height / espacio.alto),
        }, espacio, caja: { width: caja.width, height: caja.height },
        encima: (() => { const el = document.elementFromPoint(
          caja.left + (rect.x + rect.ancho / 2) * (caja.width / espacio.ancho),
          caja.top + (rect.y + rect.alto / 2) * (caja.height / espacio.alto));
          return el ? (el.id || el.tagName) : null; })(),
        secciones: ["vista-pulsos", "vista-log", "vista-consola"]
          .map((id) => (document.getElementById(id) ? !document.getElementById(id).hidden : null)) };
      })()`);
      const seccionesVista = await evaluar(`(() => {
        const visible = (id) => { const e = document.getElementById(id); return e ? !e.hidden : null; };
        const antes = { pulsos: visible("vista-pulsos"), registro: visible("vista-log"), consola: visible("vista-consola"),
          activa: [...document.querySelectorAll("#vista-lado .previa-secciones [role=tab]")]
            .filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.id) };
        document.getElementById("vista-seccion-registro").click();
        const registro = { pulsos: visible("vista-pulsos"), registro: visible("vista-log"),
          consola: visible("vista-consola"),
          lineas: document.getElementById("vista-log-lista").children.length };
        document.getElementById("vista-seccion-pulsos").click();
        return { antes, registro, vuelta: visible("vista-pulsos") };
      })()`);
      comprueba("la vista Pantalla tiene las mismas tres secciones y alterna igual",
        seccionesVista.antes.pulsos === true && seccionesVista.antes.registro === false &&
        seccionesVista.antes.consola === false &&
        seccionesVista.antes.activa.join() === "vista-seccion-pulsos" &&
        seccionesVista.registro.registro === true && seccionesVista.registro.pulsos === false &&
        seccionesVista.registro.lineas > 0 && seccionesVista.vuelta === true,
        JSON.stringify(seccionesVista).slice(0, 400));
      if (!puntoVista.punto) {
        comprueba("el canvas de Pantalla tiene un rectángulo pulsable para id/pulsar", false,
          JSON.stringify(puntoVista).slice(0, 300));
      } else {
        await exec("Input.dispatchMouseEvent",
          { type: "mousePressed", x: puntoVista.punto.x, y: puntoVista.punto.y, button: "left", clickCount: 1 });
        await exec("Input.dispatchMouseEvent",
          { type: "mouseReleased", x: puntoVista.punto.x, y: puntoVista.punto.y, button: "left", clickCount: 1 });
        const clicVista = await evaluar(`(async () => {
          const vp = await import("/vista-previa.js");
          const leer = () => {
            const m = vp.modeloActual();
            const t = m && m.raiz ? (m.raiz.hijos || []).find((h) => h.id === "id/total") : null;
            return t ? (t.textoDinamico || "") : null;
          };
          let texto = leer();
          for (let i = 0; i < 150 && texto !== "Pulsos: 1"; i++) {
            await new Promise((ok) => setTimeout(ok, 100));
            texto = leer();
          }
          const m = vp.modeloActual();
          return { texto, pulsaciones: m && m.ejecucion ? (m.ejecucion.pulsaciones || []).length : -1,
            cuenta: document.getElementById("vista-pulsos-cuenta").textContent,
            pares: document.querySelectorAll("#vista-oyentes .previa-oyente").length };
        })()`);
        // entrar en Pantalla repinta el último modelo, y un modelo que no viene de un clic reinicia
        // la lista de clics: este primer toque en el teléfono grande arranca de cero y deja el 1
        comprueba("un clic real en el canvas de Pantalla ejecuta su onClick y actualiza el texto",
          clicVista.texto === "Pulsos: 1" && clicVista.pulsaciones === 1 &&
          /1 clic/.test(String(clicVista.cuenta)) && clicVista.pares === 1,
          JSON.stringify({ texto: clicVista.texto, pulsaciones: clicVista.pulsaciones,
            cuenta: clicVista.cuenta, encima: puntoVista.encima }).slice(0, 400));
      }
      await evaluar(`document.querySelector('nav.actividad [data-vista="pestana"]').click()`);
      await esperar(300);
    }

    // 12a-ter-septies-quater. el caso del usuario, «Clicker» de tutorial: el clic se declara en el
    // layout con android:onClick y la actividad solo tiene el método. Sin esto, la ejecución no
    // registraba ningún oyente y la pestaña decía «Esta ejecución no registró ningún
    // OnClickListener sobre una vista con id» y no había nada que pulsar.
    const layoutDeclarativo = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
      '    android:orientation="vertical"',
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent"',
      '    android:gravity="center">',
      '    <TextView',
      '        android:id="@+id/total"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:text="Pulsos: 0"/>',
      '    <Button',
      '        android:id="@+id/pulsar"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:onClick="sumar"',
      '        android:text="Pulsar"/>',
      '</LinearLayout>',
      "",
    ].join("\n");
    const fuenteDeclarativa = [
      "package com.myapp;",
      "",
      "import android.app.*;",
      "import android.os.*;",
      "import android.view.*;",
      "import android.widget.*;",
      "",
      "public class MainActivity extends Activity {",
      "    int pulsos = 0;",
      "    TextView total;",
      "",
      "    @Override",
      "    public void onCreate(Bundle savedInstanceState) {",
      "        super.onCreate(savedInstanceState);",
      "        setContentView(R.layout.main);",
      "        total = (TextView) findViewById(R.id.total);",
      "    }",
      "",
      "    public void sumar(View v) {",
      "        pulsos = pulsos + 1;",
      "        total.setText(\"Pulsos: \" + pulsos);",
      "    }",
      "}",
      "",
    ].join("\n");
    const declarativo = await evaluar(`(async () => {
      await hospedador.escribir("/proyecto/res/layout/main.xml", new TextEncoder().encode(${JSON.stringify(layoutDeclarativo)}));
      await hospedador.escribir("/proyecto/src/com/myapp/MainActivity.java", new TextEncoder().encode(${JSON.stringify(fuenteDeclarativa)}));
      await hospedador.limpiar("/proyecto/build");
      document.getElementById("storepass-compilar").value = "android";
      document.getElementById("previa-modo-render").click();
      await compilarDelTodo();
      await new Promise((ok) => setTimeout(ok, 200));
      const vp = await import("/vista-previa.js");
      const m = vp.modeloActual();
      const canvas = document.getElementById("previa-lateral-canvas");
      const espacio = (canvas && canvas.__espacio) || { ancho: 0, alto: 0 };
      const rect = m ? vp.rectsEscalados(m, espacio.ancho, espacio.alto).find((r) => r.id === "id/pulsar") : null;
      const caja = canvas ? canvas.getBoundingClientRect() : null;
      const punto = rect && caja && caja.width > 0
        ? { x: caja.left + (rect.x + rect.ancho / 2) * (caja.width / espacio.ancho),
          y: caja.top + (rect.y + rect.alto / 2) * (caja.height / espacio.alto) }
        : null;
      return {
        modelo: !!m,
        oyentes: m && m.ejecucion ? (m.ejecucion.oyentes || []).map((o) => o.id) : [],
        avisos: m && m.ejecucion ? (m.ejecucion.avisos || []) : null,
        botones: [...document.querySelectorAll("#previa-oyentes .previa-oyente")].map((b) => b.dataset.idref),
        nota: document.getElementById("previa-pulsos-nota").hidden,
        texto: m && m.raiz ? ((m.raiz.hijos || []).find((h) => h.id === "id/total") || {}).textoDinamico || "" : null,
        punto,
        encima: punto ? (() => {
          const el = document.elementFromPoint(punto.x, punto.y);
          return el ? (el.id || el.tagName) : null;
        })() : null,
      };
    })()`);
    comprueba("apkc preview publica el oyente de android:onClick de la app del Clicker",
      declarativo.modelo === true && declarativo.oyentes.length === 1 &&
      declarativo.oyentes[0] === "id/pulsar" && declarativo.botones.length === 1 &&
      declarativo.botones[0] === "0x7f010000" && declarativo.nota === true &&
      declarativo.texto === "" && (declarativo.avisos || []).length === 0 &&
      declarativo.punto !== null && declarativo.encima === "previa-lateral-canvas",
      JSON.stringify(declarativo).slice(0, 400));
    if (declarativo.punto) {
      await exec("Input.dispatchMouseEvent",
        { type: "mousePressed", x: declarativo.punto.x, y: declarativo.punto.y, button: "left", clickCount: 1 });
      await exec("Input.dispatchMouseEvent",
        { type: "mouseReleased", x: declarativo.punto.x, y: declarativo.punto.y, button: "left", clickCount: 1 });
      const clicDeclarativo = await evaluar(`(async () => {
        const vp = await import("/vista-previa.js");
        const leer = () => {
          const m = vp.modeloActual();
          const t = m && m.raiz ? (m.raiz.hijos || []).find((h) => h.id === "id/total") : null;
          return t ? (t.textoDinamico || "") : null;
        };
        let texto = leer();
        for (let i = 0; i < 150 && texto !== "Pulsos: 1"; i++) {
          await new Promise((ok) => setTimeout(ok, 100));
          texto = leer();
        }
        const m = vp.modeloActual();
        return { texto, interacciones: m && m.ejecucion ? (m.ejecucion.interacciones || 0) : -1,
          cuenta: document.getElementById("previa-pulsos-cuenta").textContent };
      })()`);
      comprueba("un clic real por CDP en el oyente declarativo deja «Pulsos: 1»",
        clicDeclarativo.texto === "Pulsos: 1" && clicDeclarativo.interacciones === 1 &&
        /1 clic/.test(String(clicDeclarativo.cuenta)),
        JSON.stringify(clicDeclarativo).slice(0, 300));
    } else {
      comprueba("el botón del oyente declarativo se puede pulsar por CDP", false, "sin botón en #previa-oyentes");
    }

    // 12a-ter-septies-quinquies. la sección elegida sobrevive a recargar la página. Leer
    // localStorage en el mismo evaluate no lo prueba: hay que navegar de verdad y comprobar que
    // `conectarSecciones()` restaura las dos superficies al arrancar.
    const antesRecargaSeccion = await evaluar(`(() => {
      document.getElementById("previa-seccion-registro").click();
      document.querySelector('nav.actividad [data-vista="vista"]').click();
      document.getElementById("vista-seccion-consola").click();
      document.querySelector('nav.actividad [data-vista="pestana"]').click();
      return {
        panel: (() => { try { return localStorage.getItem("apkc-studio/previa-seccion"); } catch (e) { return null; } })(),
        vista: (() => { try { return localStorage.getItem("apkc-studio/vista-seccion"); } catch (e) { return null; } })(),
        activa: [...document.querySelectorAll(".previa-secciones [role=tab]")]
          .filter((b) => b.id.startsWith("previa-seccion-") && b.getAttribute("aria-selected") === "true")
          .map((b) => b.id),
      };
    })()`);
    await exec("Page.navigate", { url: URL_PAGINA });
    let listaTrasNavegar = false;
    for (let i = 0; i < 60; i++) {
      try {
        listaTrasNavegar = await evaluar("typeof PREVIA_PANEL !== 'undefined' && !!document.getElementById('previa-seccion-registro') && !!document.getElementById('codigo')");
      } catch (e) { listaTrasNavegar = false; }
      if (listaTrasNavegar) break;
      await esperar(300);
    }
    const trasRecargaSeccion = await evaluar(`(async () => {
      document.getElementById("previa-modo-render").click();
      document.querySelector('nav.actividad [data-vista="vista"]').click();
      document.getElementById("vista-modo-emulador").click();
      await new Promise((ok) => setTimeout(ok, 150));
      const visible = (id) => { const e = document.getElementById(id); return e ? !e.hidden : null; };
      return {
        panel: { registro: visible("previa-log"), pulsos: visible("previa-pulsos"),
          consola: visible("previa-consola"),
          activa: [...document.querySelectorAll(".previa-secciones [role=tab]")]
            .filter((b) => b.id.startsWith("previa-seccion-") && b.getAttribute("aria-selected") === "true")
            .map((b) => b.id) },
        vista: { consola: visible("vista-consola"), pulsos: visible("vista-pulsos"),
          registro: visible("vista-log"),
          activa: [...document.querySelectorAll("#vista-lado .previa-secciones [role=tab]")]
            .filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.id) },
        guardadas: { panel: (() => { try { return localStorage.getItem("apkc-studio/previa-seccion"); } catch (e) { return null; } })(),
          vista: (() => { try { return localStorage.getItem("apkc-studio/vista-seccion"); } catch (e) { return null; } })() },
      };
    })()`);
    comprueba("la sección elegida del emulador sobrevive a recargar la página",
      antesRecargaSeccion.panel === "registro" && antesRecargaSeccion.vista === "consola" &&
      antesRecargaSeccion.activa.join() === "previa-seccion-registro" &&
      listaTrasNavegar === true &&
      trasRecargaSeccion.guardadas.panel === "registro" && trasRecargaSeccion.guardadas.vista === "consola" &&
      trasRecargaSeccion.panel.registro === true && trasRecargaSeccion.panel.pulsos === false &&
      trasRecargaSeccion.panel.consola === false &&
      trasRecargaSeccion.panel.activa.join() === "previa-seccion-registro" &&
      trasRecargaSeccion.vista.consola === true && trasRecargaSeccion.vista.pulsos === false &&
      trasRecargaSeccion.vista.registro === false &&
      trasRecargaSeccion.vista.activa.join() === "vista-seccion-consola",
      JSON.stringify({ antes: antesRecargaSeccion, lista: listaTrasNavegar,
        despues: trasRecargaSeccion }).slice(0, 600));
    // recargar no borra OPFS, pero sí el modelo en memoria: se compila otra vez para que las
    // pruebas que vienen detrás vuelvan a tener apk y modelo (es lo que hace el tramo 9b)
    const trasRecargaEmulador = await evaluar(`(async () => {
      document.querySelector('nav.actividad [data-vista="pestana"]').click();
      document.getElementById("storepass-compilar").value = "android";
      await compilarDelTodo();
      const vp = await import("/vista-previa.js");
      const m = vp.modeloActual();
      return { modelo: !!m, codigo: document.getElementById("ultimo-codigo").textContent,
        oyentes: m && m.ejecucion ? (m.ejecucion.oyentes || []).map((o) => o.id) : [] };
    })()`);
    comprueba("tras recargar, compilar vuelve a poblar el emulador desde el apk de OPFS",
      trasRecargaEmulador.modelo === true && trasRecargaEmulador.codigo === "0" &&
      trasRecargaEmulador.oyentes.join() === "id/pulsar",
      JSON.stringify(trasRecargaEmulador).slice(0, 300));

    // 12a-ter-sexies. el texto del intérprete es dato: un `<script>` en un `texto` sale escapado y
    // nunca se convierte en marcado. Y el fallo del preview limpia la consola, sin tocar la de apkc.
    const escapado = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      vp.pintarVistaPrevia({ layout: "res/layout/main.xml", pantalla: { ancho: 100, alto: 100 },
        raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 100, alto: 100 } },
        ejecucion: { metodo: "onCreate", pasos: 3,
          capturas: [
            { origen: "Log.d", texto: "<script>alert(1)</script>" },
            { origen: "TextView.setText id/total", texto: "<img src=x onerror=alert(2)>" },
          ],
          avisos: ["<b>aviso con marcado</b>"] } });
      const lista = document.getElementById("previa-log-lista");
      const r = {
        scripts: lista.querySelectorAll("script").length,
        imgs: lista.querySelectorAll("img").length,
        negritas: lista.querySelectorAll("b").length,
        html: lista.innerHTML,
        texto: lista.textContent,
        consola: document.getElementById("consola-pestana").textContent,
      };
      const antesCodigo = document.getElementById("ultimo-codigo").textContent;
      vp.mensajeVistaPrevia("no hay nada que previsualizar");
      r.trasMensaje = { lista: lista.children.length,
        vacio: !document.getElementById("previa-log-vacio").hidden,
        texto: document.getElementById("previa-log-vacio").textContent,
        cabecera: document.getElementById("previa-log-cabecera").textContent,
        ultimo: document.getElementById("ultimo-codigo").textContent === antesCodigo };
      const restaurado = await previsualizarLoCompilado();
      r.restaurado = restaurado !== null;
      r.trasRestaurar = { lista: lista.children.length,
        cabecera: document.getElementById("previa-log-cabecera").textContent };
      return r;
    })()`);
    comprueba("un texto con <script> del intérprete se pinta escapado",
      escapado.scripts === 0 && escapado.imgs === 0 && escapado.negritas === 0 &&
      /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(String(escapado.html)) &&
      /<script>alert\(1\)<\/script>/.test(String(escapado.texto)) &&
      /&lt;img src=x onerror=alert\(2\)&gt;/.test(String(escapado.html)),
      JSON.stringify({ scripts: escapado.scripts, imgs: escapado.imgs, negritas: escapado.negritas,
        html: String(escapado.html).slice(0, 240) }).slice(0, 400));
    comprueba("el mensaje de fallo limpia la consola de la ejecución y no toca consola ni último código",
      escapado.trasMensaje.lista === 0 && escapado.trasMensaje.vacio === true &&
      /no hay nada que previsualizar/.test(String(escapado.trasMensaje.texto)) &&
      escapado.trasMensaje.cabecera === "sin ejecución" && escapado.trasMensaje.ultimo === true &&
      escapado.restaurado === true,
      JSON.stringify(escapado.trasMensaje).slice(0, 300));

    // 12a-septies. el modo «En vivo» dibuja el layout: no hay ni un `<pre>` con el XML. Se abre el
    // layout, se cambia su `android:text` en el editor y el canvas cambia sin compilar; un XML a
    // medias conserva el último render bueno.
    const vivo = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const firma = (cv) => {
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 13) h = (h * 31 + d[i]) | 0;
        return h;
      };
      const textos = (m) => {
        const salida = [];
        const recorrer = (n) => {
          if (!n) return;
          if (n.texto) salida.push(n.texto);
          for (const h of n.hijos || []) recorrer(h);
        };
        if (m) recorrer(m.raiz);
        return salida;
      };
      marcarSucio(false);
      await abrir("/proyecto/res/layout/main.xml");
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 900));
      const panel = document.getElementById("previa-lateral");
      const canvas = document.getElementById("previa-vivo-canvas");
      const estado = document.getElementById("previa-vivo-estado");
      const area = document.getElementById("codigo");
      const original = area.value;
      const consolaAntes = document.getElementById("consola-pestana").textContent;
      const inicial = {
        textos: textos(PREVIA_PANEL.modeloVivo()),
        nodos: PREVIA_PANEL.modeloVivo() ? PREVIA_PANEL.modeloVivo().nodos : 0,
        firma: firma(canvas),
        estado: estado.textContent,
        pre: !!panel.querySelector("pre"),
        codigo: document.getElementById("ultimo-codigo").textContent,
      };
      const ponerTexto = (valor) => {
        const patron = new RegExp('android:text="[^"]*"');
        area.value = area.value.replace(patron, 'android:text="' + valor + '"');
        area.dispatchEvent(new Event("input", { bubbles: true }));
      };
      area.value = original;
      ponerTexto("Hola");
      await new Promise((ok) => setTimeout(ok, 800));
      const hola = {
        textos: textos(PREVIA_PANEL.modeloVivo()),
        firma: firma(canvas),
        estado: estado.textContent,
        codigo: document.getElementById("ultimo-codigo").textContent,
        consolaIgual: document.getElementById("consola-pestana").textContent === consolaAntes,
      };
      ponerTexto("Adiós");
      await new Promise((ok) => setTimeout(ok, 800));
      const adios = {
        textos: textos(PREVIA_PANEL.modeloVivo()),
        firma: firma(canvas),
        estado: estado.textContent,
        codigo: document.getElementById("ultimo-codigo").textContent,
      };
      // XML a medias: ni un error de texto en el canvas, ni el dibujo anterior borrado
      const corte = original.indexOf("</LinearLayout>");
      area.value = corte > 0 ? original.slice(0, corte) : "<LinearLayout>";
      area.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 800));
      const invalido = {
        textos: textos(PREVIA_PANEL.modeloVivo()),
        firma: firma(canvas),
        estado: estado.textContent,
        aviso: estado.classList.contains("con-aviso"),
      };
      // tinta del texto dentro de su nodo, con el modelo bueno: con texto hay, sin él no
      const modelo = PREVIA_PANEL.modeloVivo();
      let objetivo = null;
      const buscar = (n) => {
        if (!objetivo && n.texto) objetivo = n;
        for (const h of n.hijos || []) buscar(h);
      };
      if (modelo) buscar(modelo.raiz);
      const medirTinta = (conTexto) => {
        const copia = JSON.parse(JSON.stringify(modelo));
        let nodo = null;
        const buscarCopia = (n) => {
          if (!nodo && n.texto) nodo = n;
          for (const h of n.hijos || []) buscarCopia(h);
        };
        buscarCopia(copia.raiz);
        if (nodo && !conTexto) nodo.texto = "";
        const cv = document.createElement("canvas");
        vp.pintarModelo(cv, copia, { ancho: 270, alto: 480 });
        const ctx = cv.getContext("2d");
        const dpr = cv.width / 270;
        const caja = vp.escalaPara(copia, 270, 480);
        const r = nodo ? nodo.rect : { x: 0, y: 0, ancho: 1, alto: 1 };
        const margen = 2 * dpr;
        const x = Math.max(0, Math.round((caja.x + r.x * caja.escala) * dpr + margen));
        const y = Math.max(0, Math.round((caja.y + r.y * caja.escala) * dpr + margen));
        const ancho = Math.max(1, Math.round(r.ancho * caja.escala * dpr - 2 * margen));
        const alto = Math.max(1, Math.round(r.alto * caja.escala * dpr - 2 * margen));
        const datos = ctx.getImageData(x, y, ancho, alto).data;
        const cuenta = new Map();
        for (let i = 0; i < datos.length; i += 4) {
          const clave = datos[i] + "," + datos[i + 1] + "," + datos[i + 2];
          cuenta.set(clave, (cuenta.get(clave) || 0) + 1);
        }
        let fondo = [0, 0, 0], maximo = -1;
        for (const [clave, n] of cuenta) {
          if (n > maximo) { maximo = n; fondo = clave.split(",").map(Number); }
        }
        let tinta = 0;
        for (let i = 0; i < datos.length; i += 4) {
          const d = Math.abs(datos[i] - fondo[0]) + Math.abs(datos[i + 1] - fondo[1]) + Math.abs(datos[i + 2] - fondo[2]);
          if (d > 40) tinta++;
        }
        return tinta;
      };
      const tinta = {
        conTexto: medirTinta(true),
        sinTexto: medirTinta(false),
        alto: objetivo ? Math.round(objetivo.rect.alto) : 0,
        texto: objetivo ? objetivo.texto : "",
      };
      // alternar no pierde el estado de ninguno de los dos: el registro es el que era (con el
      // Contador en reposo puede estar vacío, porque ya no se pulsa solo) y la consola también
      const logAntes = document.getElementById("previa-log-lista").children.length;
      const consolaAppAntes = document.getElementById("previa-consola-lista").children.length;
      document.getElementById("previa-modo-render").click();
      await new Promise((ok) => setTimeout(ok, 300));
      const enRender = {
        vivo: document.getElementById("previa-vivo").hidden,
        render: document.getElementById("previa-render").hidden,
        log: document.getElementById("previa-log-lista").children.length,
        logAntes,
        consolaAppAntes,
        consola: document.getElementById("previa-consola-lista").children.length,
        seleccion: [document.getElementById("previa-modo-vivo").getAttribute("aria-selected"),
          document.getElementById("previa-modo-render").getAttribute("aria-selected")],
      };
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 300));
      const deVuelta = {
        textos: textos(PREVIA_PANEL.modeloVivo()),
        firma: firma(canvas),
        estado: estado.textContent,
      };
      area.value = original;
      area.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 800));
      marcarSucio(false);
      return { inicial, hola, adios, invalido, tinta, enRender, deVuelta,
        restaurado: textos(PREVIA_PANEL.modeloVivo()).join("|") === inicial.textos.join("|") };
    })()`);
    comprueba("el modo «En vivo» dibuja el layout del proyecto y no enseña ni una línea de XML",
      vivo.inicial.pre === false && vivo.inicial.nodos >= 2 && vivo.inicial.firma !== 0 &&
      /res\/layout\/main\.xml/.test(String(vivo.inicial.estado)) &&
      /en vivo \(sin compilar\)/.test(String(vivo.inicial.estado)) &&
      vivo.inicial.textos.length >= 1,
      JSON.stringify(vivo.inicial).slice(0, 320));
    comprueba("cambiar android:text a «Hola» cambia el dibujo sin compilar ni ensuciar la consola",
      vivo.hola.textos.includes("Hola") && vivo.hola.firma !== vivo.inicial.firma &&
      vivo.hola.codigo === vivo.inicial.codigo && vivo.hola.consolaIgual === true,
      JSON.stringify({ textos: vivo.hola.textos, firma: vivo.hola.firma, antes: vivo.inicial.firma,
        codigo: vivo.hola.codigo, consolaIgual: vivo.hola.consolaIgual }).slice(0, 320));
    comprueba("y a «Adiós» el canvas vuelve a cambiar, con el último código intacto",
      vivo.adios.textos.includes("Adiós") && vivo.adios.firma !== vivo.hola.firma &&
      vivo.adios.codigo === vivo.inicial.codigo,
      JSON.stringify({ textos: vivo.adios.textos, firma: vivo.adios.firma,
        antes: vivo.hola.firma, codigo: vivo.adios.codigo }).slice(0, 320));
    comprueba("un XML a medias conserva el último render bueno y lo avisa, sin pintar el error",
      /XML inválido/.test(String(vivo.invalido.estado)) && vivo.invalido.aviso === true &&
      vivo.invalido.textos.includes("Adiós") &&
      vivo.invalido.firma === vivo.adios.firma,
      JSON.stringify(vivo.invalido).slice(0, 320));
    comprueba("el texto del layout se dibuja dentro de su nodo, no solo su etiqueta",
      vivo.tinta.conTexto > 20 && vivo.tinta.sinTexto === 0 && vivo.tinta.texto === "Adiós",
      JSON.stringify(vivo.tinta).slice(0, 240));
    comprueba("alternar a Emulador conserva registro y consola, y volver a Vista previa conserva su dibujo",
      vivo.enRender.vivo === true && vivo.enRender.render === false &&
      vivo.enRender.log === vivo.enRender.logAntes &&
      vivo.enRender.consola === vivo.enRender.consolaAppAntes &&
      vivo.enRender.seleccion.join(",") === "false,true" &&
      vivo.deVuelta.textos.includes("Adiós") && vivo.deVuelta.firma === vivo.adios.firma &&
      vivo.restaurado === true,
      JSON.stringify({ enRender: vivo.enRender, deVuelta: vivo.deVuelta, restaurado: vivo.restaurado }).slice(0, 360));

    // con otro fichero abierto el panel dibuja el layout del proyecto leído de OPFS
    const vivoFuera = await evaluar(`(async () => {
      marcarSucio(false);
      await abrir("/proyecto/src/com/myapp/MainActivity.java");
      document.getElementById("previa-modo-render").click();
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 900));
      const m = PREVIA_PANEL.modeloVivo();
      const salida = [];
      const recorrer = (n) => { if (n.texto) salida.push(n.texto); for (const h of n.hijos || []) recorrer(h); };
      if (m) recorrer(m.raiz);
      return {
        abierto: estadoPestana.ruta,
        estado: document.getElementById("previa-vivo-estado").textContent,
        textos: salida,
        nodos: m ? m.nodos : 0,
      };
    })()`);
    comprueba("sin el layout abierto, el modo En vivo dibuja el layout del proyecto de OPFS",
      /MainActivity\.java$/.test(String(vivoFuera.abierto)) &&
      /res\/layout\/main\.xml/.test(String(vivoFuera.estado)) &&
      vivoFuera.nodos >= 2 && vivoFuera.textos.length >= 1,
      JSON.stringify(vivoFuera).slice(0, 280));

    const vivoVacio = await evaluar(`(async () => {
      const sano = await hospedador.texto("/proyecto/res/layout/main.xml");
      await hospedador.limpiar("/proyecto/res/layout/main.xml");
      document.getElementById("previa-modo-render").click();
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 900));
      const canvas = document.getElementById("previa-vivo-canvas");
      const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let tinta = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) tinta++;
      const r = {
        estado: document.getElementById("previa-vivo-estado").textContent,
        tinta,
        modelo: PREVIA_PANEL.modeloVivo() === null,
      };
      await hospedador.escribir("/proyecto/res/layout/main.xml", new TextEncoder().encode(sano));
      document.getElementById("previa-modo-render").click();
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 900));
      r.restaurado = PREVIA_PANEL.modeloVivo() !== null;
      return r;
    })()`);
    comprueba("sin ningún res/layout/*.xml el panel lo dice, deja el canvas vacío y no inventa un dibujo",
      /no tiene ningún res\/layout/.test(String(vivoVacio.estado)) &&
      vivoVacio.tinta === 0 && vivoVacio.modelo === true && vivoVacio.restaurado === true,
      JSON.stringify(vivoVacio).slice(0, 280));

    // 12a-septies. el modo editar del layout: el lápiz, la paleta, el arrastre, el borrado y el
    // undo tree. Nada de esto abre otra pestaña ni toca el Emulador (Render con eventos).
    const editorLayout = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      marcarSucio(false);
      await abrir("/proyecto/res/layout/main.xml");
      if (!PREVIA_PANEL.estado().visible) document.getElementById("previa-alternar").click();
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 900));
      const area = document.getElementById("codigo");
      const original = area.value;
      const boton = document.getElementById("previa-modo-editar");
      const paleta = document.getElementById("previa-paleta");
      const estadoEditar = document.getElementById("previa-editar-estado");
      const canvas = document.getElementById("previa-vivo-canvas");
      const apagado = {
        pressed: boton.getAttribute("aria-pressed"),
        paleta: paleta.hidden,
        estado: estadoEditar.hidden,
        modo: PREVIA_PANEL.estado().modo,
        editando: PREVIA_PANEL.estado().editando,
      };
      boton.click();
      await new Promise((ok) => setTimeout(ok, 500));
      const encendido = {
        pressed: boton.getAttribute("aria-pressed"),
        clase: boton.classList.contains("activo"),
        paleta: paleta.hidden,
        estado: estadoEditar.hidden,
        texto: estadoEditar.textContent,
        editando: PREVIA_PANEL.estado().editando,
        modo: PREVIA_PANEL.estado().modo,
        paletaHabilitada: !document.getElementById("previa-anadir-button").disabled,
      };
      // añadir un Button: tiene que aparecer en el XML del editor y en el dibujo
      const botonesXmlAntes = (area.value.match(/<Button\\b/g) || []).length;
      const antesDeAnadir = { xml: area.value, nodos: PREVIA_PANEL.modeloVivo().nodos };
      document.getElementById("previa-anadir-button").click();
      await new Promise((ok) => setTimeout(ok, 700));
      const modeloBoton = PREVIA_PANEL.modeloVivo();
      const buscar = (nodo, salida) => {
        if (nodo.tipo === "Button") salida.push({ id: nodo.id, texto: nodo.texto, rect: nodo.rect });
        for (const h of nodo.hijos || []) buscar(h, salida);
      };
      const botones = [];
      if (modeloBoton) buscar(modeloBoton.raiz, botones);
      const annadido = {
        xml: /<Button\\b/.test(area.value) && /@\\+id\\/boton\\b/.test(area.value),
        botonesXmlAntes,
        botonesXml: (area.value.match(/<Button\\b/g) || []).length,
        nodos: modeloBoton ? modeloBoton.nodos : 0,
        botones,
        nuevo: botones.some((b) => b.id === "id/boton" && b.texto === "Boton"),
        sucio: !document.getElementById("marca-sucio").hidden,
        nota: estadoEditar.textContent,
        seleccion: PREVIA_PANEL.estado().seleccion,
      };
      // la ficha de propiedades: se selecciona el TextView del layout y se le cambian texto, id y
      // fondo. El XML, el modelo que pinta el canvas y el undo tree tienen que verlo.
      const modeloMain = PREVIA_PANEL.modeloVivo();
      const nodoTexto = modeloMain ? modeloMain.raiz.hijos.find((h) => h.tipo === "TextView") : null;
      const indiceTexto = modeloMain ? modeloMain.raiz.hijos.indexOf(nodoTexto) : -1;
      const cajaMain = vp.escalaPara(modeloMain, canvas.clientWidth, canvas.clientHeight);
      const cajaCanvasMain = canvas.getBoundingClientRect();
      const factorMain = cajaCanvasMain.width > 0 && canvas.clientWidth
        ? canvas.clientWidth / cajaCanvasMain.width : 1;
      const puntoNodo = (rect) => ({
        x: cajaCanvasMain.left + (cajaMain.x + (rect.x + rect.ancho / 2) * cajaMain.escala) / factorMain,
        y: cajaCanvasMain.top + (cajaMain.y + (rect.y + rect.alto / 2) * cajaMain.escala) / factorMain,
      });
      const pTexto = puntoNodo(nodoTexto.rect);
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 21,
        clientX: pTexto.x, clientY: pTexto.y }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 21,
        clientX: pTexto.x, clientY: pTexto.y }));
      await new Promise((ok) => setTimeout(ok, 220));
      const propSection = document.getElementById("previa-propiedades");
      const campoTexto = document.querySelector('[data-propiedad="android:text"]');
      const campoId = document.querySelector('[data-propiedad="android:id"]');
      const campoFondo = document.querySelector('[data-propiedad="android:background"]');
      const ficha = {
        visible: !propSection.hidden,
        seleccion: PREVIA_PANEL.estado().seleccion,
        titulo: document.getElementById("previa-propiedades-titulo").textContent,
        texto: campoTexto ? campoTexto.value : "",
        id: campoId ? campoId.value : "",
        fondo: campoFondo ? campoFondo.value : "",
      };
      const ultimoAntes = document.getElementById("ultimo-codigo").textContent;
      campoTexto.value = "Hola & adiós";
      campoTexto.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 750));
      const modeloTexto = PREVIA_PANEL.modeloVivo();
      const nodoTextoTras = modeloTexto && indiceTexto >= 0
        ? modeloTexto.raiz.hijos[indiceTexto] : null;
      const cambioTexto = {
        xml: /android:text="Hola &amp; adiós"/.test(area.value),
        modelo: nodoTextoTras ? nodoTextoTras.texto : "",
        ultimo: document.getElementById("ultimo-codigo").textContent === ultimoAntes,
        sucio: !document.getElementById("marca-sucio").hidden,
        campo: (document.querySelector('[data-propiedad="android:text"]') || {}).value,
      };
      // el texto del layout es dato: un <script> en android:text no se convierte en marcado, el
      // XML lo escapa y el undo tree devuelve el texto anterior
      const campoHostil = document.querySelector('[data-propiedad="android:text"]');
      const antesHostil = area.value;
      campoHostil.value = "A & B <script>alert(1)</script>";
      campoHostil.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 750));
      const inyectados = document.querySelectorAll("#previa-propiedades script").length;
      const xmlHostil = /A &amp; B &lt;script&gt;alert\\(1\\)&lt;\\/script&gt;/.test(area.value) &&
        !/<script>/i.test(area.value);
      const deshechoHostil = deshacer();
      await new Promise((ok) => setTimeout(ok, 300));
      const hostil = {
        campo: !!campoHostil && campoHostil.value === "A & B <script>alert(1)</script>",
        inyectados,
        xml: xmlHostil,
        deshecho: deshechoHostil,
        vuelta: area.value === antesHostil,
      };
      const campoId2 = document.querySelector('[data-propiedad="android:id"]');
      campoId2.value = "saludo";
      campoId2.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 550));
      const modeloId = PREVIA_PANEL.modeloVivo();
      const cambioId = {
        xml: /android:id="@\\+id\\/saludo"/.test(area.value),
        id: modeloId ? (modeloId.raiz.hijos.find((h) => h.tipo === "TextView") || {}).id : "",
        seleccion: PREVIA_PANEL.estado().seleccion,
      };
      const campoFondo2 = document.querySelector('[data-propiedad="android:background"]');
      campoFondo2.value = "#ff0000";
      campoFondo2.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 550));
      const modeloFondo = PREVIA_PANEL.modeloVivo();
      const nodoFondo = modeloFondo
        ? modeloFondo.raiz.hijos.find((h) => h.id === "id/saludo") : null;
      const rectFondo = modeloFondo
        ? vp.rectsEscalados(modeloFondo, canvas.clientWidth, canvas.clientHeight)
          .find((r) => r.id === "id/saludo") : null;
      const cambioFondo = {
        xml: /android:background="#ff0000"/.test(area.value),
        fondo: nodoFondo ? nodoFondo.fondo : "",
        rect: rectFondo ? rectFondo.fondo : "",
      };
      // el hueco del layout (fuera de los hijos) selecciona la raíz; su orientación se escribe
      const modeloRaiz = PREVIA_PANEL.modeloVivo();
      const cajaRaiz = vp.escalaPara(modeloRaiz, canvas.clientWidth, canvas.clientHeight);
      const cajaCanvasRaiz = canvas.getBoundingClientRect();
      const factorRaiz = cajaCanvasRaiz.width > 0 && canvas.clientWidth
        ? canvas.clientWidth / cajaCanvasRaiz.width : 1;
      const pRaiz = {
        x: cajaCanvasRaiz.left + (cajaRaiz.x + 8 * cajaRaiz.escala) / factorRaiz,
        y: cajaCanvasRaiz.top +
          (cajaRaiz.y + (modeloRaiz.pantalla.alto - 8) * cajaRaiz.escala) / factorRaiz,
      };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 22,
        clientX: pRaiz.x, clientY: pRaiz.y }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 22,
        clientX: pRaiz.x, clientY: pRaiz.y }));
      await new Promise((ok) => setTimeout(ok, 220));
      const selectTipo = document.querySelector("[data-raiz-tipo]");
      const campoOrientacion = document.querySelector('[data-propiedad="android:orientation"]');
      const seleccionRaiz = {
        seleccion: PREVIA_PANEL.estado().seleccion,
        tipo: selectTipo ? selectTipo.value : "",
        orientacion: campoOrientacion ? campoOrientacion.value : "",
        titulo: document.getElementById("previa-propiedades-titulo").textContent,
      };
      campoOrientacion.value = "horizontal";
      campoOrientacion.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 550));
      const modeloOrientacion = PREVIA_PANEL.modeloVivo();
      const cambioOrientacion = {
        xml: /android:orientation="horizontal"/.test(area.value),
        orientacion: modeloOrientacion
          ? modeloOrientacion.raiz.atributos["android:orientation"] : "",
      };
      // cambiar el tipo conserva los hijos; RelativeLayout se rechaza con su nombre
      const selectTipo2 = document.querySelector("[data-raiz-tipo]");
      selectTipo2.value = "FrameLayout";
      selectTipo2.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 550));
      const modeloMarco = PREVIA_PANEL.modeloVivo();
      const cambioTipo = {
        xml: /<FrameLayout\\b/.test(area.value) && /<\\/FrameLayout>/.test(area.value) &&
          !/<LinearLayout\\b/.test(area.value),
        raiz: modeloMarco ? modeloMarco.raiz.tipo : "",
        hijos: modeloMarco ? modeloMarco.raiz.hijos.length : 0,
      };
      const xmlAntesRel = area.value;
      const selectTipo3 = document.querySelector("[data-raiz-tipo]");
      selectTipo3.value = "RelativeLayout";
      selectTipo3.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 320));
      const rechazoRel = {
        xml: area.value === xmlAntesRel,
        nota: estadoEditar.textContent,
        tipo: (document.querySelector("[data-raiz-tipo]") || {}).value,
      };
      // la paleta ampliada: un EditText entra con sus atributos y se dibuja
      const editAntes = (area.value.match(/<EditText\\b/g) || []).length;
      document.getElementById("previa-anadir-edittext").click();
      await new Promise((ok) => setTimeout(ok, 750));
      const modeloEdit = PREVIA_PANEL.modeloVivo();
      const nodoEdit = modeloEdit
        ? modeloEdit.raiz.hijos.find((h) => h.tipo === "EditText") : null;
      const annadidoEdit = {
        xml: (area.value.match(/<EditText\\b/g) || []).length === editAntes + 1 &&
          /android:id="@\\+id\\/entrada"/.test(area.value),
        tipo: nodoEdit ? nodoEdit.tipo : "",
        texto: nodoEdit ? nodoEdit.texto : "",
      };
      // un marco con dos vistas separadas: arrastrar una cambia su margen en el XML
      const marcoXml = '<?xml version="1.0" encoding="utf-8"?>\\n' +
        '<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"\\n' +
        '    android:layout_width="match_parent"\\n' +
        '    android:layout_height="match_parent"\\n' +
        '    android:padding="8dp">\\n\\n' +
        '    <TextView\\n' +
        '        android:id="@+id/uno"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"\\n' +
        '        android:layout_gravity="top|left"\\n' +
        '        android:text="Uno"/>\\n\\n' +
        '    <TextView\\n' +
        '        android:id="@+id/dos"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"\\n' +
        '        android:layout_gravity="bottom|right"\\n' +
        '        android:text="Dos"/>\\n' +
        '</FrameLayout>\\n';
      EDITOR.cambiar(0, area.value.length, marcoXml, [0, 0]);
      await new Promise((ok) => setTimeout(ok, 800));
      const modelo = PREVIA_PANEL.modeloVivo();
      const dos = modelo ? modelo.raiz.hijos.find((h) => h.id === "id/dos") : null;
      const caja = vp.escalaPara(modelo, canvas.clientWidth, canvas.clientHeight);
      const cajaCanvas = canvas.getBoundingClientRect();
      const factor = cajaCanvas.width > 0 && canvas.clientWidth ? canvas.clientWidth / cajaCanvas.width : 1;
      const enCliente = (rect) => ({
        x: cajaCanvas.left + (caja.x + (rect.x + rect.ancho / 2) * caja.escala) / factor,
        y: cajaCanvas.top + (caja.y + (rect.y + rect.alto / 2) * caja.escala) / factor,
      });
      const p = enCliente(dos.rect);
      const antesArrastre = { rect: { ...dos.rect }, xml: area.value };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 11,
        clientX: p.x, clientY: p.y }));
      await new Promise((ok) => setTimeout(ok, 60));
      const seleccionado = PREVIA_PANEL.estado().seleccion;
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 11,
        clientX: p.x - 40, clientY: p.y - 60 }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 11,
        clientX: p.x - 40, clientY: p.y - 60 }));
      await new Promise((ok) => setTimeout(ok, 700));
      const trasModelo = PREVIA_PANEL.modeloVivo();
      const dosTras = trasModelo ? trasModelo.raiz.hijos.find((h) => h.id === "id/dos") : null;
      const arrastrado = {
        seleccionado,
        margen: /android:layout_marginLeft="\\d+dp"/.test(area.value) &&
          /android:layout_marginTop="\\d+dp"/.test(area.value),
        // la gravedad tiene que desaparecer SOLO del nodo movido: los demás la conservan
        gravedad: /android:layout_gravity/.test(
          (area.value.match(/<TextView\\s+android:id="@\\+id\\/dos"[^>]*>/) || [""])[0]),
        rect: dosTras ? { ...dosTras.rect } : null,
        xml: area.value,
      };
      // Supr borra el nodo seleccionado y Esc suelta la selección
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 700));
      const modeloTrasBorrar = PREVIA_PANEL.modeloVivo();
      const borrado = {
        xml: !/id\\/dos/.test(area.value),
        hijos: modeloTrasBorrar ? modeloTrasBorrar.raiz.hijos.map((h) => h.id) : [],
        valido: !!modeloTrasBorrar,
        seleccion: PREVIA_PANEL.estado().seleccion,
        nota: estadoEditar.textContent,
      };
      // el undo tree devuelve el nodo: lo que se borró fue un cambio del editor, no un atajo
      const deshecho = deshacer();
      await new Promise((ok) => setTimeout(ok, 200));
      await PREVIA_PANEL.refrescarVivo();
      const trasDeshacer = PREVIA_PANEL.modeloVivo();
      const vuelta = {
        deshecho,
        xml: /id\\/dos/.test(area.value),
        margen: /android:layout_marginLeft="\\d+dp"/.test(area.value),
        hijos: trasDeshacer ? trasDeshacer.raiz.hijos.map((h) => h.id) : [],
      };
      // clic sin arrastre selecciona; Esc lo suelta
      const uno = modeloTrasBorrar ? modeloTrasBorrar.raiz.hijos.find((h) => h.id === "id/uno") : null;
      const q = uno ? enCliente(uno.rect) : { x: 0, y: 0 };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 12,
        clientX: q.x, clientY: q.y }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 12,
        clientX: q.x, clientY: q.y }));
      await new Promise((ok) => setTimeout(ok, 120));
      const conSeleccion = PREVIA_PANEL.estado().seleccion;
      const textoSeleccion = estadoEditar.textContent;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 120));
      const suelto = {
        seleccion: PREVIA_PANEL.estado().seleccion,
        texto: estadoEditar.textContent,
        textoSeleccion,
      };
      // salir del lápiz deja la vista como estaba y el Emulador sigue siendo suyo
      document.getElementById("previa-modo-render").click();
      await new Promise((ok) => setTimeout(ok, 120));
      const enRender = {
        editando: PREVIA_PANEL.estado().editando,
        pressed: boton.getAttribute("aria-pressed"),
        paleta: paleta.hidden,
      };
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 300));
      marcarSucio(false);
      EDITOR.cambiar(0, area.value.length, original, [0, 0]);
      await new Promise((ok) => setTimeout(ok, 800));
      marcarSucio(false);
      return { apagado, encendido, annadido, ficha, cambioTexto, hostil, cambioId, cambioFondo, seleccionRaiz,
        cambioOrientacion, cambioTipo, rechazoRel, annadidoEdit, antesArrastre, arrastrado, borrado,
        vuelta, conSeleccion, suelto, enRender, restaurado: area.value === original };
    })()`);
    comprueba("el lápiz enciende el modo editar (paleta y estado) y apagado deja la vista de solo lectura",
      editorLayout.apagado.pressed === "false" && editorLayout.apagado.paleta === true &&
      editorLayout.apagado.estado === true && editorLayout.apagado.editando === false &&
      editorLayout.encendido.pressed === "true" && editorLayout.encendido.clase === true &&
      editorLayout.encendido.paleta === false && editorLayout.encendido.estado === false &&
      editorLayout.encendido.editando === true && editorLayout.encendido.paletaHabilitada === true &&
      editorLayout.encendido.modo === "vivo",
      JSON.stringify({ apagado: editorLayout.apagado, encendido: editorLayout.encendido }).slice(0, 400));
    comprueba("añadir un Button lo escribe en el XML del editor y aparece en el layout dibujado",
      editorLayout.annadido.xml === true &&
      editorLayout.annadido.botonesXml === editorLayout.annadido.botonesXmlAntes + 1 &&
      editorLayout.annadido.botones.length === editorLayout.annadido.botonesXml &&
      editorLayout.annadido.nuevo === true &&
      editorLayout.annadido.nodos >= 3 && editorLayout.annadido.sucio === true &&
      JSON.stringify(editorLayout.annadido.seleccion) !== "null",
      JSON.stringify(editorLayout.annadido).slice(0, 400));
    comprueba("la ficha de propiedades muestra el TextView seleccionado con su texto, id y fondo",
      editorLayout.ficha.visible === true &&
      JSON.stringify(editorLayout.ficha.seleccion) !== "null" &&
      /Propiedades de/.test(editorLayout.ficha.titulo) &&
      /^@\+id\//.test(editorLayout.ficha.id) && editorLayout.ficha.fondo === "" &&
      editorLayout.ficha.texto !== "",
      JSON.stringify(editorLayout.ficha).slice(0, 360));
    comprueba("cambiar android:text escribe el XML escapado, repinta el modelo y no toca #ultimo-codigo",
      editorLayout.cambioTexto.xml === true && editorLayout.cambioTexto.modelo === "Hola & adiós" &&
      editorLayout.cambioTexto.ultimo === true && editorLayout.cambioTexto.sucio === true &&
      editorLayout.cambioTexto.campo === "Hola & adiós",
      JSON.stringify(editorLayout.cambioTexto).slice(0, 360));
    // el texto del layout es dato: un `<script>` en android:text se escapa en el XML, no se
    // convierte en marcado y el undo tree devuelve el texto anterior
    comprueba("un <script> en android:text se escapa, no se inyecta y el cambio se deshace",
      editorLayout.hostil.campo === true && editorLayout.hostil.inyectados === 0 &&
      editorLayout.hostil.xml === true && editorLayout.hostil.deshecho === true &&
      editorLayout.hostil.vuelta === true,
      JSON.stringify(editorLayout.hostil).slice(0, 320));

    comprueba("cambiar android:id normaliza a @+id y el modelo conserva el nodo seleccionado",
      editorLayout.cambioId.xml === true && editorLayout.cambioId.id === "id/saludo" &&
      JSON.stringify(editorLayout.cambioId.seleccion) !== "null",
      JSON.stringify(editorLayout.cambioId).slice(0, 280));
    comprueba("cambiar android:background llega al modelo y a los rectángulos que pinta el canvas",
      editorLayout.cambioFondo.xml === true && editorLayout.cambioFondo.fondo === "#ff0000" &&
      editorLayout.cambioFondo.rect === "#ff0000",
      JSON.stringify(editorLayout.cambioFondo).slice(0, 280));
    comprueba("el hueco del layout selecciona la raíz y su orientación se escribe en el XML y el modelo",
      JSON.stringify(editorLayout.seleccionRaiz.seleccion) === "[]" &&
      editorLayout.seleccionRaiz.tipo === "LinearLayout" &&
      editorLayout.seleccionRaiz.orientacion === "vertical" &&
      /layout raíz/.test(editorLayout.seleccionRaiz.titulo) &&
      editorLayout.cambioOrientacion.xml === true &&
      editorLayout.cambioOrientacion.orientacion === "horizontal",
      JSON.stringify({ raiz: editorLayout.seleccionRaiz,
        orientacion: editorLayout.cambioOrientacion }).slice(0, 400));
    comprueba("cambiar el tipo del layout raíz conserva los hijos y rechaza RelativeLayout por su nombre",
      editorLayout.cambioTipo.xml === true && editorLayout.cambioTipo.raiz === "FrameLayout" &&
      editorLayout.cambioTipo.hijos >= 2 &&
      editorLayout.rechazoRel.xml === true &&
      /RelativeLayout/.test(editorLayout.rechazoRel.nota) &&
      editorLayout.rechazoRel.tipo === "FrameLayout",
      JSON.stringify({ tipo: editorLayout.cambioTipo, rechazo: editorLayout.rechazoRel }).slice(0, 400));
    comprueba("la paleta ampliada añade un EditText con su id y su texto al XML y al dibujo",
      editorLayout.annadidoEdit.xml === true && editorLayout.annadidoEdit.tipo === "EditText" &&
      editorLayout.annadidoEdit.texto === "Texto",
      JSON.stringify(editorLayout.annadidoEdit).slice(0, 240));
    comprueba("arrastrar una vista dentro de un FrameLayout escribe su margen y mueve el dibujo",
      JSON.stringify(editorLayout.arrastrado.seleccionado) !== "null" &&
      editorLayout.arrastrado.margen === true && editorLayout.arrastrado.gravedad === false &&
      !!editorLayout.arrastrado.rect &&
      editorLayout.arrastrado.rect.x < editorLayout.antesArrastre.rect.x - 10 &&
      editorLayout.arrastrado.rect.y < editorLayout.antesArrastre.rect.y - 10,
      JSON.stringify({ antes: editorLayout.antesArrastre.rect, tras: editorLayout.arrastrado.rect,
        margen: editorLayout.arrastrado.margen, gravedad: editorLayout.arrastrado.gravedad }).slice(0, 360));
    comprueba("Supr borra el nodo seleccionado del XML y del dibujo, y el undo tree lo devuelve",
      editorLayout.borrado.xml === true && editorLayout.borrado.valido === true &&
      editorLayout.borrado.hijos.join(",") === "id/uno" &&
      editorLayout.borrado.seleccion === null &&
      editorLayout.vuelta.deshecho === true && editorLayout.vuelta.xml === true &&
      editorLayout.vuelta.margen === true &&
      editorLayout.vuelta.hijos.join(",") === "id/uno,id/dos",
      JSON.stringify({ borrado: editorLayout.borrado, vuelta: editorLayout.vuelta }).slice(0, 400));
    comprueba("clic selecciona con contorno y Esc lo suelta sin tocar el texto",
      JSON.stringify(editorLayout.conSeleccion) !== "null" &&
      editorLayout.suelto.seleccion === null &&
      /Seleccionado/.test(String(editorLayout.suelto.textoSeleccion)) &&
      /Clic en un elemento/.test(String(editorLayout.suelto.texto)) &&
      editorLayout.restaurado === true,
      JSON.stringify({ conSeleccion: editorLayout.conSeleccion, suelto: editorLayout.suelto,
        restaurado: editorLayout.restaurado }).slice(0, 320));
    comprueba("cambiar a Emulador apaga el modo editar y no deja la paleta abierta",
      editorLayout.enRender.editando === false && editorLayout.enRender.pressed === "false" &&
      editorLayout.enRender.paleta === true,
      JSON.stringify(editorLayout.enRender).slice(0, 240));

    // 12a-septies-quinquies. El modo editar es una CAPA, no una columna: la paleta y la ficha de
    // propiedades flotan sobre el dibujo y el canvas conserva el ancho y el alto de «Vista previa».
    // Además, un tipo se arrastra desde la paleta y se suelta donde se quiere colocarlo.
    // Se estrecha la ventana a propósito: así la paleta tiene que desplazarse de verdad y las
    // medidas se toman en una caja pequeña, que es donde antes se veía el fallo.
    await exec("Emulation.setDeviceMetricsOverride",
      { width: 1000, height: 520, deviceScaleFactor: 1, mobile: false });
    await esperar(500);
    const editorFlotante = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      marcarSucio(false);
      await abrir("/proyecto/res/layout/main.xml");
      if (!PREVIA_PANEL.estado().visible) document.getElementById("previa-alternar").click();
      document.getElementById("previa-modo-vivo").click();
      await new Promise((ok) => setTimeout(ok, 900));
      const area = document.getElementById("codigo");
      const original = area.value;
      const nav = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const canvas = document.getElementById("previa-vivo-canvas");
      const marco = document.querySelector("#previa-vivo .previa-marco-lateral");
      const paleta = document.getElementById("previa-paleta");
      const lista = document.getElementById("previa-paleta-scroll");
      const ficha = document.getElementById("previa-propiedades");
      const editar = document.getElementById("previa-modo-editar");
      const medidas = () => ({ ancho: canvas.clientWidth, alto: canvas.clientHeight,
        marco: marco.clientWidth + "x" + marco.clientHeight });
      // 1. la referencia es «Vista previa» sin editar
      if (PREVIA_PANEL.estado().editando) { editar.click(); await nav(350); }
      const antes = { ...medidas(), paleta: paleta.hidden, ficha: ficha.hidden };
      // 2. encender el lápiz no mueve ni un píxel el canvas
      editar.click();
      await nav(400);
      const trasEncender = { ...medidas(), paleta: paleta.hidden, ficha: ficha.hidden,
        editando: PREVIA_PANEL.estado().editando };
      const capas = {
        paleta: getComputedStyle(paleta).position,
        ficha: getComputedStyle(ficha).position,
        paletaEnPanel: paleta.getBoundingClientRect().top >= marco.getBoundingClientRect().top - 1 &&
          paleta.getBoundingClientRect().bottom <= marco.getBoundingClientRect().bottom + 1,
      };
      // 3. la paleta tiene scroll propio y se puede plegar sin tocar el canvas
      const scroll = { contenido: lista.scrollHeight, visible: lista.clientHeight,
        desborda: lista.scrollHeight > lista.clientHeight + 4 };
      lista.scrollTop = lista.scrollHeight;
      const desplazado = lista.scrollTop;
      const cajaAntesPlegar = medidas();
      document.getElementById("previa-paleta-plegar").click();
      await nav(120);
      const plegada = {
        dato: paleta.dataset.plegada,
        lista: getComputedStyle(lista).display,
        aria: document.getElementById("previa-paleta-plegar").getAttribute("aria-expanded"),
        canvas: medidas(),
      };
      document.getElementById("previa-paleta-plegar").click();
      await nav(120);
      const desplegada = { dato: paleta.dataset.plegada, lista: getComputedStyle(lista).display };
      // 4. arrastrar un Button desde la paleta al dibujo: entra donde se suelta y queda seleccionado
      const botonPaleta = document.getElementById("previa-anadir-button");
      const cajaBoton = botonPaleta.getBoundingClientRect();
      const cajaCanvas = canvas.getBoundingClientRect();
      const destino = {
        x: cajaCanvas.left + cajaCanvas.width * 0.72,
        y: cajaCanvas.top + cajaCanvas.height * 0.62,
      };
      const antesXml = area.value;
      const buscarBoton = (nodo, salida) => {
        if (nodo.tipo === "Button") salida.push(nodo);
        for (const h of nodo.hijos || []) buscarBoton(h, salida);
      };
      const contarBotones = (m) => {
        const salida = [];
        if (m) buscarBoton(m.raiz, salida);
        return salida.length;
      };
      const botonesModeloAntes = contarBotones(PREVIA_PANEL.modeloVivo());
      botonPaleta.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0,
        pointerId: 41, clientX: cajaBoton.left + 10, clientY: cajaBoton.top + 10 }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 41,
        clientX: (cajaBoton.left + destino.x) / 2, clientY: (cajaBoton.top + destino.y) / 2 }));
      const realimentacion = {
        fantasma: !!document.querySelector(".previa-arrastre-fantasma"),
        boton: botonPaleta.classList.contains("arrastrando"),
      };
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 41,
        clientX: destino.x, clientY: destino.y }));
      realimentacion.canvas = canvas.classList.contains("previa-canvas-recibiendo");
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 41,
        clientX: destino.x, clientY: destino.y }));
      await nav(900);
      const modelo = PREVIA_PANEL.modeloVivo();
      const seleccion = PREVIA_PANEL.estado().seleccion;
      const enRuta = (raiz, ruta) => {
        let n = raiz;
        for (const i of ruta || []) n = n && (n.hijos || [])[i];
        return n || null;
      };
      const nuevo = modelo && seleccion ? enRuta(modelo.raiz, seleccion) : null;
      // el punto de un lineal decide entre qué hermanos entra: el nodo nuevo tiene que quedar
      // después del centro del anterior y antes del siguiente (o al final)
      const padreRuta = seleccion ? seleccion.slice(0, -1) : null;
      const padre = modelo && padreRuta ? enRuta(modelo.raiz, padreRuta) : null;
      const hermanos = padre && Array.isArray(padre.hijos) ? padre.hijos : [];
      const indice = seleccion && seleccion.length ? seleccion[seleccion.length - 1] : -1;
      const vertical = !padre ||
        ((padre.atributos || {})["android:orientation"] || "vertical") !== "horizontal";
      const centro = (n) => n && n.rect
        ? (vertical ? n.rect.y + n.rect.alto / 2 : n.rect.x + n.rect.ancho / 2) : null;
      const orden = {
        indice,
        hermanos: hermanos.length,
        raiz: !!padreRuta && padreRuta.length === 0,
        trasAnterior: indice <= 0 || (!!nuevo && centro(nuevo) >= centro(hermanos[indice - 1])),
        antesSiguiente: indice < 0 || indice >= hermanos.length - 1 ||
          (!!nuevo && centro(nuevo) <= centro(hermanos[indice + 1])),
      };
      const soltado = {
        xml: (area.value.match(/<Button\\b/g) || []).length > 0,
        cambio: area.value !== antesXml,
        botones: contarBotones(modelo),
        botonesAntes: botonesModeloAntes,
        seleccion,
        nuevo: nuevo ? { tipo: nuevo.tipo, id: nuevo.id, rect: { ...nuevo.rect } } : null,
        orden,
        nota: document.getElementById("previa-editar-estado").textContent,
        sucio: !document.getElementById("marca-sucio").hidden,
      };
      // 5. la ficha aparece con la selección y es otra capa: no encoge el canvas
      const trasSoltar = { ...medidas(), ficha: ficha.hidden,
        absoluta: getComputedStyle(ficha).position,
        seleccion: PREVIA_PANEL.estado().seleccion };
      const camposVisibles = document.querySelectorAll("#previa-propiedades-campos [data-propiedad]").length;
      const cajaFicha = ficha.getBoundingClientRect();
      const cajaMarco = marco.getBoundingClientRect();
      const fichaDentro = cajaFicha.right <= cajaMarco.right + 1 && cajaFicha.left >= cajaMarco.left - 1;
      document.getElementById("previa-propiedades-plegar").click();
      await nav(120);
      const fichaPlegada = {
        dato: ficha.dataset.plegada,
        campos: getComputedStyle(document.getElementById("previa-propiedades-campos")).display,
        aria: document.getElementById("previa-propiedades-plegar").getAttribute("aria-expanded"),
      };
      document.getElementById("previa-propiedades-plegar").click();
      await nav(120);
      // 6. Esc desde un campo cierra la ficha y suelta el nodo
      const campo = document.querySelector("#previa-propiedades-campos [data-propiedad]");
      if (campo) campo.focus();
      const conFoco = campo === document.activeElement;
      if (campo) campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await nav(220);
      const trasEsc = { seleccion: PREVIA_PANEL.estado().seleccion, ficha: ficha.hidden,
        conFoco, foco: document.activeElement === canvas };
      // 7. el botón de cerrar también, y el tamaño del canvas no se ha movido en todo el gesto
      PREVIA_PANEL.seleccionar([0]);
      await nav(180);
      const fichaAlSeleccionar = ficha.hidden;
      document.getElementById("previa-propiedades-cerrar").click();
      await nav(180);
      const trasCerrar = { seleccion: PREVIA_PANEL.estado().seleccion, ficha: ficha.hidden };
      // 7b. el deshacer REAL del editor (la misma función que el botón Historial, no un Ctrl+Z
      // sintético) quita el nodo que soltó la paleta: XML y modelo vuelven al estado anterior
      const botonesAntesDeshacer = contarBotones(PREVIA_PANEL.modeloVivo());
      const deshecho = deshacer();
      await nav(400);
      await PREVIA_PANEL.refrescarVivo();
      const modeloDeshecho = PREVIA_PANEL.modeloVivo();
      const undo = {
        hecho: deshecho === true,
        botonesAntes: botonesAntesDeshacer,
        botones: contarBotones(modeloDeshecho),
        botonesInicial: botonesModeloAntes,
        xmlIgual: area.value === antesXml,
        idFuera: !/@\\+id\\/boton\\b/.test(area.value),
        nodoFuera: !modeloDeshecho || !seleccion ||
          enRuta(modeloDeshecho.raiz, seleccion) === null,
        modeloValido: !!modeloDeshecho,
        sucio: !document.getElementById("marca-sucio").hidden,
      };
      // 8. Vista previa y Emulador siguen midiendo lo mismo; el lápiz no los toca
      document.getElementById("previa-modo-render").click();
      await nav(200);
      const enRender = { editando: PREVIA_PANEL.estado().editando, paleta: paleta.hidden };
      document.getElementById("previa-modo-vivo").click();
      await nav(400);
      const final = { ...medidas(), editando: PREVIA_PANEL.estado().editando,
        paleta: paleta.hidden, ficha: ficha.hidden };
      // limpieza: la paleta vuelve desplegada y el layout a su texto
      paleta.dataset.plegada = "0";
      lista.scrollTop = 0;
      if (PREVIA_PANEL.estado().editando) { editar.click(); await nav(200); }
      marcarSucio(false);
      EDITOR.cambiar(0, area.value.length, original, [0, 0]);
      await nav(900);
      marcarSucio(false);
      return { antes, trasEncender, capas, scroll: { ...scroll, desplazado },
        plegada, desplegada, cajaAntesPlegar, realimentacion, soltado, trasSoltar,
        camposVisibles, fichaDentro, fichaPlegada, trasEsc, fichaAlSeleccionar, trasCerrar,
        undo, enRender, final, restaurado: area.value === original };
    })()`);
    await exec("Emulation.clearDeviceMetricsOverride");
    await esperar(400);
    comprueba("encender el modo editar no encoge el canvas: paleta y ficha son capas absolutas",
      editorFlotante.antes.ancho === editorFlotante.trasEncender.ancho &&
      editorFlotante.antes.alto === editorFlotante.trasEncender.alto &&
      editorFlotante.trasEncender.paleta === false && editorFlotante.trasEncender.ficha === true &&
      editorFlotante.capas.paleta === "absolute" && editorFlotante.capas.ficha === "absolute" &&
      editorFlotante.capas.paletaEnPanel === true,
      JSON.stringify({ antes: editorFlotante.antes, tras: editorFlotante.trasEncender,
        capas: editorFlotante.capas }).slice(0, 400));
    comprueba("la paleta se desplaza por categorías y se pliega sin mover el canvas",
      editorFlotante.scroll.desborda === true && editorFlotante.scroll.desplazado > 0 &&
      editorFlotante.plegada.lista === "none" && editorFlotante.plegada.aria === "false" &&
      editorFlotante.plegada.canvas.ancho === editorFlotante.cajaAntesPlegar.ancho &&
      editorFlotante.plegada.canvas.alto === editorFlotante.cajaAntesPlegar.alto &&
      editorFlotante.desplegada.dato === "0" &&
      editorFlotante.desplegada.lista !== "none",
      JSON.stringify({ scroll: editorFlotante.scroll, plegada: editorFlotante.plegada,
        desplegada: editorFlotante.desplegada }).slice(0, 420));
    comprueba("arrastrar un Button de la paleta al dibujo lo añade donde se suelta y lo selecciona",
      editorFlotante.realimentacion.fantasma === true &&
      editorFlotante.realimentacion.boton === true &&
      editorFlotante.realimentacion.canvas === true &&
      editorFlotante.soltado.xml === true && editorFlotante.soltado.cambio === true &&
      editorFlotante.soltado.botones === editorFlotante.soltado.botonesAntes + 1 &&
      JSON.stringify(editorFlotante.soltado.seleccion) !== "null" &&
      !!editorFlotante.soltado.nuevo && editorFlotante.soltado.nuevo.tipo === "Button" &&
      editorFlotante.soltado.orden.raiz === true &&
      editorFlotante.soltado.orden.trasAnterior === true &&
      editorFlotante.soltado.orden.antesSiguiente === true &&
      /Añadido Button/.test(String(editorFlotante.soltado.nota)) &&
      editorFlotante.soltado.sucio === true,
      JSON.stringify({ realimentacion: editorFlotante.realimentacion,
        soltado: editorFlotante.soltado }).slice(0, 520));
    comprueba("la ficha aparece con la selección, no encoge el canvas, se pliega y Esc la cierra",
      editorFlotante.trasSoltar.ficha === false && editorFlotante.trasSoltar.absoluta === "absolute" &&
      editorFlotante.trasSoltar.ancho === editorFlotante.antes.ancho &&
      editorFlotante.trasSoltar.alto === editorFlotante.antes.alto &&
      editorFlotante.camposVisibles > 3 && editorFlotante.fichaDentro === true &&
      editorFlotante.fichaPlegada.dato === "1" &&
      editorFlotante.fichaPlegada.campos === "none" &&
      editorFlotante.fichaPlegada.aria === "false" &&
      editorFlotante.trasEsc.conFoco === true &&
      editorFlotante.trasEsc.seleccion === null && editorFlotante.trasEsc.ficha === true &&
      editorFlotante.fichaAlSeleccionar === false &&
      editorFlotante.trasCerrar.seleccion === null && editorFlotante.trasCerrar.ficha === true,
      JSON.stringify({ trasSoltar: editorFlotante.trasSoltar,
        plegada: editorFlotante.fichaPlegada, trasEsc: editorFlotante.trasEsc,
        trasCerrar: editorFlotante.trasCerrar }).slice(0, 420));
    comprueba("Vista previa y Emulador quedan como estaban y el canvas conserva su medida",
      editorFlotante.enRender.editando === false && editorFlotante.enRender.paleta === true &&
      editorFlotante.final.editando === false && editorFlotante.final.paleta === true &&
      editorFlotante.final.ficha === true &&
      editorFlotante.final.ancho === editorFlotante.antes.ancho &&
      editorFlotante.final.alto === editorFlotante.antes.alto &&
      editorFlotante.restaurado === true,
      JSON.stringify({ enRender: editorFlotante.enRender, final: editorFlotante.final,
        antes: editorFlotante.antes, restaurado: editorFlotante.restaurado }).slice(0, 360));
    comprueba("deshacer() del editor quita el nodo soltado del XML y del modelo y deja el número de botones inicial",
      editorFlotante.undo.hecho === true &&
      editorFlotante.undo.xmlIgual === true &&
      editorFlotante.undo.idFuera === true &&
      editorFlotante.undo.nodoFuera === true &&
      editorFlotante.undo.modeloValido === true &&
      editorFlotante.undo.botonesAntes === editorFlotante.undo.botonesInicial + 1 &&
      editorFlotante.undo.botones === editorFlotante.undo.botonesInicial,
      JSON.stringify(editorFlotante.undo).slice(0, 360));

    // 12a-septies-sexies. El destino de un tipo soltado es el CONTENEDOR bajo el puntero, no
    // siempre la raíz: sobre un LinearLayout interno entra como hijo suyo (la ruta del padre no
    // está vacía), con XML válido y el nodo nuevo seleccionado.
    // De la ficha, el id, el texto con `&amp;` y el color ya están medidos en «la ficha de
    // propiedades muestra el TextView…», «cambiar android:text escribe el XML escapado…»,
    // «un <script> en android:text…» y «cambiar android:background llega al modelo…» del bloque
    // 12a-septies; aquí solo falta el diff mínimo, que no se repite. El `#ultimo-codigo` intacto
    // también se mide allí («cambiar android:text … no toca #ultimo-codigo»).
    const editorAnidado = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const vx = await import("/vista-xml.js");
      const nav = (ms) => new Promise((ok) => setTimeout(ok, ms));
      marcarSucio(false);
      await abrir("/proyecto/res/layout/main.xml");
      if (!PREVIA_PANEL.estado().visible) document.getElementById("previa-alternar").click();
      document.getElementById("previa-modo-vivo").click();
      await nav(900);
      const area = document.getElementById("codigo");
      const original = area.value;
      const anidado = '<?xml version="1.0" encoding="utf-8"?>\\n' +
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"\\n' +
        '    android:orientation="vertical"\\n' +
        '    android:layout_width="match_parent"\\n' +
        '    android:layout_height="match_parent">\\n\\n' +
        '    <LinearLayout\\n' +
        '        android:id="@+id/interno"\\n' +
        '        android:orientation="vertical"\\n' +
        '        android:layout_width="match_parent"\\n' +
        '        android:layout_height="wrap_content">\\n\\n' +
        '        <TextView\\n' +
        '            android:id="@+id/dentro"\\n' +
        '            android:layout_width="wrap_content"\\n' +
        '            android:layout_height="wrap_content"\\n' +
        '            android:text="Dentro"/>\\n' +
        '    </LinearLayout>\\n\\n' +
        '    <TextView\\n' +
        '        android:id="@+id/fuera"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"\\n' +
        '        android:text="Fuera"/>\\n' +
        '</LinearLayout>\\n';
      EDITOR.cambiar(0, area.value.length, anidado, [0, 0]);
      await nav(900);
      const editar = document.getElementById("previa-modo-editar");
      if (!PREVIA_PANEL.estado().editando) { editar.click(); await nav(400); }
      const canvas = document.getElementById("previa-vivo-canvas");
      const modelo = PREVIA_PANEL.modeloVivo();
      const interno = modelo ? modelo.raiz.hijos.find((h) => h.id === "id/interno") : null;
      const listo = !!(modelo && interno && interno.rect &&
        interno.rect.ancho > 0 && interno.rect.alto > 0);
      const caja = listo ? vp.escalaPara(modelo, canvas.clientWidth, canvas.clientHeight) : null;
      const cajaCanvas = canvas.getBoundingClientRect();
      const factor = cajaCanvas.width > 0 && canvas.clientWidth
        ? canvas.clientWidth / cajaCanvas.width : 1;
      const punto = listo ? {
        x: cajaCanvas.left +
          (caja.x + (interno.rect.x + interno.rect.ancho / 2) * caja.escala) / factor,
        y: cajaCanvas.top +
          (caja.y + (interno.rect.y + interno.rect.alto / 2) * caja.escala) / factor,
      } : null;
      const boton = document.getElementById("previa-anadir-button");
      const cajaBoton = boton.getBoundingClientRect();
      if (punto) {
        boton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0,
          pointerId: 51, clientX: cajaBoton.left + 10, clientY: cajaBoton.top + 10 }));
        document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 51,
          clientX: punto.x - 20, clientY: punto.y + 12 }));
        document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 51,
          clientX: punto.x, clientY: punto.y }));
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 51,
          clientX: punto.x, clientY: punto.y }));
        await nav(900);
      }
      const modeloTras = PREVIA_PANEL.modeloVivo();
      const seleccion = PREVIA_PANEL.estado().seleccion;
      const enRuta = (raiz, ruta) => {
        let n = raiz;
        for (const i of ruta || []) n = n && (n.hijos || [])[i];
        return n || null;
      };
      const padreRuta = seleccion ? seleccion.slice(0, -1) : null;
      const padre = modeloTras && padreRuta ? enRuta(modeloTras.raiz, padreRuta) : null;
      const nuevo = modeloTras && seleccion ? enRuta(modeloTras.raiz, seleccion) : null;
      const validado = vx.modeloDeLayout(area.value);
      const raizValidada = validado.ok ? validado.modelo.raiz : null;
      const internoValidado = raizValidada
        ? raizValidada.hijos.find((h) => h.id === "id/interno") : null;
      const dentro = nuevo && padre && nuevo.rect && padre.rect
        ? nuevo.rect.x >= padre.rect.x - 0.5 && nuevo.rect.y >= padre.rect.y - 0.5 &&
          nuevo.rect.x + nuevo.rect.ancho <= padre.rect.x + padre.rect.ancho + 0.5 &&
          nuevo.rect.y + nuevo.rect.alto <= padre.rect.y + padre.rect.alto + 0.5
        : false;
      const anidadoOk = {
        listo,
        punto: !!punto,
        seleccion,
        padreId: padre ? padre.id : "",
        padreTipo: padre ? padre.tipo : "",
        nuevoTipo: nuevo ? nuevo.tipo : "",
        rutaHonda: !!seleccion && seleccion.length >= 2,
        dentro,
        xmlValido: !!validado.ok,
        enElPadre: !!(internoValidado &&
          (internoValidado.hijos || []).some((h) => h.tipo === "Button")),
        fueraIntacto: !!(raizValidada &&
          (raizValidada.hijos || []).some((h) => h.id === "id/fuera")),
      };
      // el fondo que escribe la ficha tiene que ser un solo trozo insertado: el resto del fichero
      // queda igual, así que el undo tree guarda un cambio pequeño y no se relanza ninguna pasada
      const diferencia = (a, b) => {
        const max = Math.min(a.length, b.length);
        let ini = 0;
        while (ini < max && a[ini] === b[ini]) ini++;
        let fa = a.length, fb = b.length;
        while (fa > ini && fb > ini && a[fa - 1] === b[fb - 1]) { fa--; fb--; }
        return { ini, fin: fa, medio: b.slice(ini, fb) };
      };
      const antesColor = area.value;
      const campoFondo = document.querySelector(
        '#previa-propiedades-campos [data-propiedad="android:background"]');
      let dif = null;
      if (campoFondo && !document.getElementById("previa-propiedades").hidden) {
        campoFondo.value = "#123456";
        campoFondo.dispatchEvent(new Event("change", { bubbles: true }));
        await nav(800);
        dif = diferencia(antesColor, area.value);
      }
      const fondo = {
        campo: !!campoFondo,
        escrito: /android:background="#123456"/.test(area.value),
        medio: dif ? dif.medio : "",
        largo: dif ? dif.medio.length : -1,
        unico: !!dif && dif.fin === dif.ini && dif.medio.length > 0 && dif.medio.length < 64,
        campoValor: (document.querySelector(
          '#previa-propiedades-campos [data-propiedad="android:background"]') || {}).value || "",
      };
      if (PREVIA_PANEL.estado().editando) { editar.click(); await nav(200); }
      marcarSucio(false);
      EDITOR.cambiar(0, area.value.length, original, [0, 0]);
      await nav(900);
      marcarSucio(false);
      return { anidadoOk, fondo, restaurado: area.value === original };
    })()`);
    comprueba("soltar un tipo sobre un LinearLayout interno lo deja como hijo suyo, con XML válido y seleccionado",
      editorAnidado.anidadoOk.listo === true && editorAnidado.anidadoOk.punto === true &&
      editorAnidado.anidadoOk.rutaHonda === true &&
      editorAnidado.anidadoOk.padreId === "id/interno" &&
      editorAnidado.anidadoOk.padreTipo === "LinearLayout" &&
      editorAnidado.anidadoOk.nuevoTipo === "Button" &&
      editorAnidado.anidadoOk.dentro === true &&
      editorAnidado.anidadoOk.xmlValido === true &&
      editorAnidado.anidadoOk.enElPadre === true &&
      editorAnidado.anidadoOk.fueraIntacto === true,
      JSON.stringify(editorAnidado.anidadoOk).slice(0, 420));
    comprueba("la ficha escribe el fondo con un solo trozo y no reescribe el fichero",
      editorAnidado.fondo.campo === true && editorAnidado.fondo.escrito === true &&
      editorAnidado.fondo.unico === true && editorAnidado.fondo.campoValor === "#123456" &&
      editorAnidado.restaurado === true,
      JSON.stringify(editorAnidado.fondo).slice(0, 320));

    // 12a-septies-septies. El historial del DISEÑADOR, el indicador de destino y la basura. Los
    // tres son gestos del modo editar: Ctrl+Z con el foco en el canvas deshace el diseño (no el
    // texto), el arrastre enseña la línea o el hueco donde va a caer y la basura/Supr borran.
    const editorNuevo = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const nav = (ms) => new Promise((ok) => setTimeout(ok, ms));
      marcarSucio(false);
      await abrir("/proyecto/res/layout/main.xml");
      if (!PREVIA_PANEL.estado().visible) document.getElementById("previa-alternar").click();
      document.getElementById("previa-modo-vivo").click();
      await nav(900);
      const area = document.getElementById("codigo");
      const original = area.value;
      const canvas = document.getElementById("previa-vivo-canvas");
      const paleta = document.getElementById("previa-paleta");
      if (paleta) paleta.dataset.plegada = "0";
      const editar = document.getElementById("previa-modo-editar");
      if (!PREVIA_PANEL.estado().editando) { editar.click(); await nav(400); }
      const ultimoAntes = document.getElementById("ultimo-codigo").textContent;
      const contar = (m, tipo) => {
        let n = 0;
        const buscar = (nodo) => {
          if (nodo.tipo === tipo) n++;
          for (const h of nodo.hijos || []) buscar(h);
        };
        if (m && m.raiz) buscar(m.raiz);
        return n;
      };
      const pulsar = (tecla, opciones) => {
        canvas.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: tecla,
          bubbles: true, cancelable: true }, opciones || {})));
      };
      // 1. añadir un TextView, Ctrl+Z con el foco en el canvas lo quita y Ctrl+Mayús+Z lo devuelve
      const textosAntes = contar(PREVIA_PANEL.modeloVivo(), "TextView");
      document.getElementById("previa-anadir-textview").click();
      await nav(800);
      const trasAnadir = { textos: contar(PREVIA_PANEL.modeloVivo(), "TextView"),
        editando: PREVIA_PANEL.estado().editando,
        foco: document.activeElement === canvas,
        deshacer: !document.getElementById("previa-editar-deshacer").disabled,
        rehacer: !document.getElementById("previa-editar-rehacer").disabled };
      canvas.focus();
      pulsar("z", { ctrlKey: true });
      await nav(700);
      await PREVIA_PANEL.refrescarVivo();
      const trasDeshacer = { textos: contar(PREVIA_PANEL.modeloVivo(), "TextView"),
        xml: area.value === original,
        ultimo: document.getElementById("ultimo-codigo").textContent,
        deshacer: !document.getElementById("previa-editar-deshacer").disabled,
        rehacer: !document.getElementById("previa-editar-rehacer").disabled };
      pulsar("z", { ctrlKey: true, shiftKey: true });
      await nav(700);
      await PREVIA_PANEL.refrescarVivo();
      const trasRehacer = { textos: contar(PREVIA_PANEL.modeloVivo(), "TextView"),
        xml: /<TextView\\b/.test(area.value) && area.value !== original,
        ultimo: document.getElementById("ultimo-codigo").textContent };
      // se deshace otra vez para dejar el layout como estaba
      pulsar("z", { ctrlKey: true });
      await nav(700);
      await PREVIA_PANEL.refrescarVivo();
      const limpio = { textos: contar(PREVIA_PANEL.modeloVivo(), "TextView"),
        xml: area.value === original };
      // 2. el indicador de destino: hueco en un marco, línea en un lineal, y se apaga al soltar
      const marcoXml = '<?xml version="1.0" encoding="utf-8"?>\\n' +
        '<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"\\n' +
        '    android:layout_width="match_parent"\\n' +
        '    android:layout_height="match_parent">\\n\\n' +
        '    <TextView\\n' +
        '        android:id="@+id/uno"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"\\n' +
        '        android:text="Uno"/>\\n' +
        '</FrameLayout>\\n';
      EDITOR.cambiar(0, area.value.length, marcoXml, [0, 0]);
      await nav(900);
      const modeloMarco = PREVIA_PANEL.modeloVivo();
      const cajaMarco = modeloMarco ? vp.escalaPara(modeloMarco, canvas.clientWidth, canvas.clientHeight) : null;
      const cajaCanvas = canvas.getBoundingClientRect();
      const factor = cajaCanvas.width > 0 && canvas.clientWidth ? canvas.clientWidth / cajaCanvas.width : 1;
      const enCliente = (mx, my) => ({
        x: cajaCanvas.left + (cajaMarco.x + mx * cajaMarco.escala) / factor,
        y: cajaCanvas.top + (cajaMarco.y + my * cajaMarco.escala) / factor,
      });
      const p1 = enCliente(80, 120);
      const p2 = enCliente(220, 360);
      const botonPaleta = document.getElementById("previa-anadir-button");
      const cajaBoton = botonPaleta.getBoundingClientRect();
      const arrastrar = (destino, idPuntero) => {
        botonPaleta.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0,
          pointerId: idPuntero, clientX: cajaBoton.left + 10, clientY: cajaBoton.top + 10 }));
        document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: idPuntero,
          clientX: (cajaBoton.left + destino.x) / 2, clientY: (cajaBoton.top + destino.y) / 2 }));
        document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: idPuntero,
          clientX: destino.x, clientY: destino.y }));
      };
      const linea = document.getElementById("previa-destino-linea");
      const hueco = document.getElementById("previa-destino-hueco");
      arrastrar(p1, 61);
      const huecoUno = { visible: !hueco.hidden, lineaOculta: linea.hidden,
        x: hueco.style.left, y: hueco.style.top, ancho: hueco.style.width };
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 61,
        clientX: p2.x, clientY: p2.y }));
      const huecoDos = { visible: !hueco.hidden, x: hueco.style.left, y: hueco.style.top };
      // se suelta fuera del canvas: no se añade nada y el indicador se apaga
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 61,
        clientX: cajaCanvas.right + 40, clientY: cajaCanvas.top + 20 }));
      await nav(500);
      const marcoTrasSoltar = { xml: area.value === marcoXml, indicadores: linea.hidden && hueco.hidden };
      const linealXml = '<?xml version="1.0" encoding="utf-8"?>\\n' +
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"\\n' +
        '    android:orientation="vertical"\\n' +
        '    android:layout_width="match_parent"\\n' +
        '    android:layout_height="match_parent">\\n\\n' +
        '    <TextView\\n' +
        '        android:id="@+id/arriba"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"\\n' +
        '        android:text="Arriba"/>\\n\\n' +
        '    <TextView\\n' +
        '        android:id="@+id/abajo"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"\\n' +
        '        android:text="Abajo"/>\\n' +
        '</LinearLayout>\\n';
      EDITOR.cambiar(0, area.value.length, linealXml, [0, 0]);
      await nav(900);
      const modeloLineal = PREVIA_PANEL.modeloVivo();
      const cajaLineal = modeloLineal ? vp.escalaPara(modeloLineal, canvas.clientWidth, canvas.clientHeight) : null;
      const enClienteLineal = (mx, my) => ({
        x: cajaCanvas.left + (cajaLineal.x + mx * cajaLineal.escala) / factor,
        y: cajaCanvas.top + (cajaLineal.y + my * cajaLineal.escala) / factor,
      });
      arrastrar(enClienteLineal(180, 10), 62);
      const lineaUno = { visible: !linea.hidden, huecoOculto: hueco.hidden,
        top: linea.style.top, alto: linea.style.height };
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 62,
        clientX: enClienteLineal(180, 40).x, clientY: enClienteLineal(180, 40).y }));
      const lineaDos = { visible: !linea.hidden, top: linea.style.top };
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 62,
        clientX: cajaCanvas.right + 40, clientY: cajaCanvas.top + 20 }));
      await nav(500);
      const linealTrasSoltar = { xml: area.value === linealXml, indicadores: linea.hidden && hueco.hidden };
      // 3. basura y Supr: borran el nodo, la raíz se rechaza y Ctrl+Z lo devuelve
      PREVIA_PANEL.seleccionar([1]);
      await nav(250);
      const borrarBoton = document.getElementById("previa-propiedades-eliminar");
      borrarBoton.click();
      await nav(800);
      const trasBasura = { xml: !/id\\/abajo/.test(area.value),
        nodos: PREVIA_PANEL.modeloVivo().raiz.hijos.map((h) => h.id),
        nota: document.getElementById("previa-editar-estado").textContent };
      canvas.focus();
      pulsar("z", { ctrlKey: true });
      await nav(700);
      await PREVIA_PANEL.refrescarVivo();
      const trasDeshacerBorrado = { xml: /id\\/abajo/.test(area.value),
        nodos: PREVIA_PANEL.modeloVivo().raiz.hijos.map((h) => h.id) };
      PREVIA_PANEL.seleccionar([]);
      await nav(200);
      const xmlAntesRaiz = area.value;
      document.getElementById("previa-editar-eliminar").click();
      await nav(300);
      const raizRechazada = { xml: area.value === xmlAntesRaiz,
        nota: document.getElementById("previa-editar-estado").textContent };
      PREVIA_PANEL.seleccionar([0]);
      await nav(200);
      canvas.focus();
      pulsar("Delete");
      await nav(800);
      const trasSupr = { xml: !/id\\/arriba/.test(area.value),
        nodos: PREVIA_PANEL.modeloVivo().raiz.hijos.map((h) => h.id) };
      pulsar("z", { ctrlKey: true });
      await nav(700);
      await PREVIA_PANEL.refrescarVivo();
      const trasDeshacerSupr = { xml: /id\\/arriba/.test(area.value),
        nodos: PREVIA_PANEL.modeloVivo().raiz.hijos.map((h) => h.id) };
      // limpieza
      if (PREVIA_PANEL.estado().editando) { editar.click(); await nav(200); }
      marcarSucio(false);
      EDITOR.cambiar(0, area.value.length, original, [0, 0]);
      await nav(900);
      marcarSucio(false);
      return { textosAntes, trasAnadir, trasDeshacer, trasRehacer, limpio, ultimoAntes,
        huecoUno, huecoDos, marcoTrasSoltar, lineaUno, lineaDos, linealTrasSoltar,
        trasBasura, trasDeshacerBorrado, raizRechazada, trasSupr, trasDeshacerSupr,
        restaurado: area.value === original };
    })()`);
    comprueba("Ctrl+Z con el foco en el canvas deshace el diseño y Ctrl+Mayús+Z lo rehace, sin tocar #ultimo-codigo",
      editorNuevo.trasAnadir.textos === editorNuevo.textosAntes + 1 &&
      editorNuevo.trasAnadir.editando === true && editorNuevo.trasAnadir.foco === true &&
      editorNuevo.trasAnadir.deshacer === true &&
      editorNuevo.trasDeshacer.textos === editorNuevo.textosAntes &&
      editorNuevo.trasDeshacer.xml === true &&
      editorNuevo.trasDeshacer.ultimo === editorNuevo.ultimoAntes &&
      editorNuevo.trasDeshacer.rehacer === true &&
      editorNuevo.trasRehacer.textos === editorNuevo.textosAntes + 1 &&
      editorNuevo.trasRehacer.xml === true &&
      editorNuevo.trasRehacer.ultimo === editorNuevo.ultimoAntes &&
      editorNuevo.limpio.textos === editorNuevo.textosAntes && editorNuevo.limpio.xml === true,
      JSON.stringify(editorNuevo).slice(0, 520));
    comprueba("el indicador de destino aparece y cambia con el puntero: hueco en un marco, línea en un lineal",
      editorNuevo.huecoUno.visible === true && editorNuevo.huecoUno.lineaOculta === true &&
      editorNuevo.huecoDos.visible === true &&
      (editorNuevo.huecoUno.x !== editorNuevo.huecoDos.x ||
        editorNuevo.huecoUno.y !== editorNuevo.huecoDos.y) &&
      editorNuevo.marcoTrasSoltar.xml === true && editorNuevo.marcoTrasSoltar.indicadores === true &&
      editorNuevo.lineaUno.visible === true && editorNuevo.lineaUno.huecoOculto === true &&
      editorNuevo.lineaDos.visible === true && editorNuevo.lineaUno.top !== editorNuevo.lineaDos.top &&
      editorNuevo.linealTrasSoltar.xml === true &&
      editorNuevo.linealTrasSoltar.indicadores === true,
      JSON.stringify({ huecoUno: editorNuevo.huecoUno, huecoDos: editorNuevo.huecoDos,
        lineaUno: editorNuevo.lineaUno, lineaDos: editorNuevo.lineaDos,
        marco: editorNuevo.marcoTrasSoltar }).slice(0, 460));
    comprueba("la basura y Supr borran el nodo seleccionado, la raíz se rechaza y Ctrl+Z lo devuelve",
      editorNuevo.trasBasura.xml === true &&
      editorNuevo.trasBasura.nodos.join(",") === "id/arriba" &&
      editorNuevo.trasDeshacerBorrado.xml === true &&
      editorNuevo.trasDeshacerBorrado.nodos.join(",") === "id/arriba,id/abajo" &&
      editorNuevo.raizRechazada.xml === true && /raíz/.test(editorNuevo.raizRechazada.nota) &&
      editorNuevo.trasSupr.xml === true &&
      editorNuevo.trasSupr.nodos.join(",") === "id/abajo" &&
      editorNuevo.trasDeshacerSupr.xml === true &&
      editorNuevo.trasDeshacerSupr.nodos.join(",") === "id/arriba,id/abajo",
      JSON.stringify({ basura: editorNuevo.trasBasura, raiz: editorNuevo.raizRechazada,
        supr: editorNuevo.trasSupr, deshacer: editorNuevo.trasDeshacerSupr }).slice(0, 460));

    // 12a-septies-octies. El visor de jerarquía (sin botón «Layout raíz»), el «↑ Padre» y la
    // configuración de la raíz al seleccionar el hueco; y el campo de imagen de un ImageView con
    // su fichero importado a OPFS, el icono del sistema y el contentDescription.
    const editorCapas = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const nav = (ms) => new Promise((ok) => setTimeout(ok, ms));
      marcarSucio(false);
      await abrir("/proyecto/res/layout/main.xml");
      if (!PREVIA_PANEL.estado().visible) document.getElementById("previa-alternar").click();
      document.getElementById("previa-modo-vivo").click();
      await nav(900);
      const area = document.getElementById("codigo");
      const original = area.value;
      const canvas = document.getElementById("previa-vivo-canvas");
      const editar = document.getElementById("previa-modo-editar");
      const paleta = document.getElementById("previa-paleta");
      if (paleta) paleta.dataset.plegada = "0";
      const anidado = '<?xml version="1.0" encoding="utf-8"?>\\n' +
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"\\n' +
        '    android:orientation="vertical"\\n' +
        '    android:layout_width="match_parent"\\n' +
        '    android:layout_height="match_parent">\\n\\n' +
        '    <LinearLayout\\n' +
        '        android:id="@+id/interno"\\n' +
        '        android:orientation="vertical"\\n' +
        '        android:layout_width="match_parent"\\n' +
        '        android:layout_height="wrap_content">\\n\\n' +
        '        <TextView\\n' +
        '            android:id="@+id/dentro"\\n' +
        '            android:layout_width="wrap_content"\\n' +
        '            android:layout_height="wrap_content"\\n' +
        '            android:text="Dentro"/>\\n' +
        '    </LinearLayout>\\n\\n' +
        '    <TextView\\n' +
        '        android:id="@+id/fuera"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"\\n' +
        '        android:text="Fuera"/>\\n' +
        '</LinearLayout>\\n';
      EDITOR.cambiar(0, area.value.length, anidado, [0, 0]);
      await nav(900);
      if (!PREVIA_PANEL.estado().editando) { editar.click(); await nav(400); }
      const medidasAntes = { ancho: canvas.clientWidth, alto: canvas.clientHeight };
      document.getElementById("previa-jerarquia-alternar").click();
      await nav(400);
      const filas = Array.from(document.querySelectorAll("#previa-jerarquia-lista button[data-ruta]"))
        .map((b) => ({ ruta: b.dataset.ruta, texto: b.textContent, activa: b.classList.contains("activa") }));
      const jerarquia = {
        visible: !document.getElementById("previa-jerarquia").hidden,
        filas,
        canvas: { ancho: canvas.clientWidth, alto: canvas.clientHeight },
        boton: document.getElementById("previa-jerarquia-alternar").getAttribute("aria-pressed"),
      };
      document.querySelector('#previa-jerarquia-lista button[data-ruta="1"]').click();
      await nav(400);
      const seleccionFila = { seleccion: PREVIA_PANEL.estado().seleccion,
        titulo: document.getElementById("previa-propiedades-titulo").textContent,
        activa: (document.querySelector('#previa-jerarquia-lista button[data-ruta="1"]') || {})
          .classList.contains("activa") };
      document.getElementById("previa-propiedades-padre").click();
      await nav(300);
      const padre = { seleccion: PREVIA_PANEL.estado().seleccion,
        titulo: document.getElementById("previa-propiedades-titulo").textContent,
        tipo: (document.querySelector("[data-raiz-tipo]") || { value: "" }).value,
        orientacion: (document.querySelector('[data-propiedad="android:orientation"]') || { value: "" }).value,
        padding: !!document.querySelector('[data-propiedad="android:padding"]'),
        fondo: !!document.querySelector('[data-propiedad="android:background"]'),
        padreDeshabilitado: document.getElementById("previa-propiedades-padre").disabled };
      // clic en el hueco del canvas: la raíz se selecciona sin botón
      PREVIA_PANEL.seleccionar([1]);
      await nav(250);
      const modelo = PREVIA_PANEL.modeloVivo();
      const caja = vp.escalaPara(modelo, canvas.clientWidth, canvas.clientHeight);
      const cajaCanvas = canvas.getBoundingClientRect();
      const factor = cajaCanvas.width > 0 && canvas.clientWidth ? canvas.clientWidth / cajaCanvas.width : 1;
      const hueco = {
        x: cajaCanvas.left + (caja.x + 180 * caja.escala) / factor,
        y: cajaCanvas.top + (caja.y + 600 * caja.escala) / factor,
      };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 71,
        clientX: hueco.x, clientY: hueco.y }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 71,
        clientX: hueco.x, clientY: hueco.y }));
      await nav(300);
      const raizPorHueco = { seleccion: PREVIA_PANEL.estado().seleccion,
        botonViejo: document.getElementById("previa-seleccionar-raiz") };
      // cambiar el id de un nodo se ve en la jerarquía sin compilar
      PREVIA_PANEL.seleccionar([0, 0]);
      await nav(300);
      const campoId = document.querySelector('#previa-propiedades-campos [data-propiedad="android:id"]');
      if (campoId) {
        campoId.value = "renombrado";
        campoId.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await nav(900);
      const jerarquiaViva = {
        xml: /android:id="@\\+id\\/renombrado"/.test(area.value),
        filas: Array.from(document.querySelectorAll("#previa-jerarquia-lista button[data-ruta]"))
          .map((b) => b.textContent),
      };
      // la imagen de un ImageView: campo, fichero a OPFS, contentDescription e icono del sistema
      const conImagen = '<?xml version="1.0" encoding="utf-8"?>\\n' +
        '<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"\\n' +
        '    android:layout_width="match_parent"\\n' +
        '    android:layout_height="match_parent">\\n\\n' +
        '    <ImageView\\n' +
        '        android:id="@+id/foto"\\n' +
        '        android:layout_width="wrap_content"\\n' +
        '        android:layout_height="wrap_content"/>\\n' +
        '</FrameLayout>\\n';
      EDITOR.cambiar(0, area.value.length, conImagen, [0, 0]);
      await nav(900);
      PREVIA_PANEL.seleccionar([0]);
      await nav(300);
      const medidasImagen = { ancho: canvas.clientWidth, alto: canvas.clientHeight };
      const campo = document.querySelector('#previa-propiedades-campos [data-propiedad="android:src"]');
      const elegir = Array.from(document.querySelectorAll("#previa-propiedades-campos button"))
        .find((b) => /Elegir fichero/.test(b.textContent));
      const iconos = document.querySelector("[data-icono-sistema]");
      const campoImagen = {
        campo: !!campo,
        aria: campo ? campo.getAttribute("aria-label") : "",
        elegir: !!elegir,
        elegirRol: elegir ? (elegir.getAttribute("role") || "") : "",
        elegirAria: elegir ? elegir.getAttribute("aria-label") : "",
        iconos: iconos ? iconos.options.length : 0,
        iconoDelete: iconos ? Array.from(iconos.options).some((o) => o.value === "@android:drawable/ic_delete") : false,
        canvasAria: canvas.getAttribute("aria-label"),
        canvasRol: canvas.getAttribute("role"),
        archivo: !!document.getElementById("previa-imagen-archivo"),
      };
      // un PNG 1x1 de verdad, sin red: bytes locales -> File -> input type=file
      const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const archivo = new File([bytes], "foto de prueba.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(archivo);
      const entrada = document.getElementById("previa-imagen-archivo");
      entrada.files = dt.files;
      entrada.dispatchEvent(new Event("change", { bubbles: true }));
      await nav(2200);
      const nodoImagen = PREVIA_PANEL.modeloVivo().raiz.hijos[0];
      const bytesOpfs = await hospedador.bytes("/proyecto/res/drawable/foto_de_prueba.png");
      const importada = {
        xml: /android:src="@drawable\\/foto_de_prueba"/.test(area.value),
        recurso: nodoImagen ? nodoImagen.recurso : "",
        bytes: bytesOpfs ? bytesOpfs.length : 0,
        esperados: bytes.length,
        bitmap: !!(nodoImagen && nodoImagen.imagen),
        anchoBitmap: nodoImagen && nodoImagen.imagen ? nodoImagen.imagen.width : 0,
        canvas: { ancho: canvas.clientWidth, alto: canvas.clientHeight },
      };
      // contentDescription editable, escapado
      PREVIA_PANEL.seleccionar([0]);
      await nav(300);
      const campoDesc = document.querySelector(
        '#previa-propiedades-campos [data-propiedad="android:contentDescription"]');
      if (campoDesc) {
        campoDesc.value = "Retrato & fondo";
        campoDesc.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await nav(800);
      const descripcion = { existe: !!campoDesc,
        xml: /android:contentDescription="Retrato &amp; fondo"/.test(area.value) };
      // icono del sistema: se escribe y el modelo lo conserva (se dibuja como marcador)
      PREVIA_PANEL.seleccionar([0]);
      await nav(300);
      const selIconos = document.querySelector("[data-icono-sistema]");
      let icono = { escrito: false, recurso: "", bitmap: true };
      if (selIconos) {
        selIconos.value = "@android:drawable/ic_delete";
        selIconos.dispatchEvent(new Event("change", { bubbles: true }));
        await nav(900);
        const nodoIcono = PREVIA_PANEL.modeloVivo().raiz.hijos[0];
        icono = { escrito: /android:src="@android:drawable\\/ic_delete"/.test(area.value),
          recurso: nodoIcono ? nodoIcono.recurso : "",
          bitmap: !!(nodoIcono && nodoIcono.imagen) };
      }
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true,
        bubbles: true, cancelable: true }));
      await nav(900);
      const iconoDeshecho = /android:src="@drawable\\/foto_de_prueba"/.test(area.value);
      // limpieza: fuera el fichero importado, el layout original y el modo editar
      try { await hospedador.limpiar("/proyecto/res/drawable/foto_de_prueba.png"); } catch (e) { /* nada */ }
      if (PREVIA_PANEL.estado().editando) { editar.click(); await nav(200); }
      marcarSucio(false);
      EDITOR.cambiar(0, area.value.length, original, [0, 0]);
      await nav(900);
      marcarSucio(false);
      return { medidasAntes, jerarquia, seleccionFila, padre, raizPorHueco, jerarquiaViva,
        medidasImagen, campoImagen, importada, descripcion, icono, iconoDeshecho,
        restaurado: area.value === original };
    })()`);
    comprueba("el visor de jerarquía lista los nodos, selecciona una fila, sube al padre y no mueve el canvas",
      editorCapas.jerarquia.visible === true && editorCapas.jerarquia.boton === "true" &&
      editorCapas.jerarquia.filas.length === 4 &&
      editorCapas.jerarquia.filas.some((f) => /LinearLayout · id\/interno/.test(f.texto)) &&
      editorCapas.jerarquia.filas.some((f) => /TextView · id\/fuera/.test(f.texto)) &&
      editorCapas.jerarquia.canvas.ancho === editorCapas.medidasAntes.ancho &&
      editorCapas.jerarquia.canvas.alto === editorCapas.medidasAntes.alto &&
      JSON.stringify(editorCapas.seleccionFila.seleccion) === "[1]" &&
      /id\/fuera/.test(editorCapas.seleccionFila.titulo) &&
      editorCapas.seleccionFila.activa === true &&
      JSON.stringify(editorCapas.padre.seleccion) === "[]" &&
      /layout raíz/.test(editorCapas.padre.titulo) &&
      editorCapas.padre.tipo === "LinearLayout" && editorCapas.padre.orientacion === "vertical" &&
      editorCapas.padre.padding === true && editorCapas.padre.fondo === true &&
      editorCapas.padre.padreDeshabilitado === true &&
      JSON.stringify(editorCapas.raizPorHueco.seleccion) === "[]" &&
      editorCapas.raizPorHueco.botonViejo === null &&
      editorCapas.jerarquiaViva.xml === true &&
      editorCapas.jerarquiaViva.filas.some((t) => /id\/renombrado/.test(t)),
      JSON.stringify(editorCapas).slice(0, 520));
    comprueba("el ImageView tiene campo de imagen, guarda el fichero en OPFS, dibuja el PNG y edita contentDescription",
      editorCapas.campoImagen.campo === true &&
      /Arrastra una imagen o pulsa Elegir fichero/.test(editorCapas.campoImagen.aria) &&
      editorCapas.campoImagen.elegir === true && editorCapas.campoImagen.elegirRol === "button" &&
      /Arrastra una imagen o pulsa Elegir fichero/.test(editorCapas.campoImagen.elegirAria) &&
      editorCapas.campoImagen.iconos === 11 && editorCapas.campoImagen.iconoDelete === true &&
      /Arrastra una imagen o pulsa Elegir fichero/.test(editorCapas.campoImagen.canvasAria) &&
      editorCapas.campoImagen.canvasRol === "button" && editorCapas.campoImagen.archivo === true &&
      editorCapas.importada.xml === true &&
      editorCapas.importada.recurso === "@drawable/foto_de_prueba" &&
      editorCapas.importada.bytes === editorCapas.importada.esperados &&
      editorCapas.importada.bitmap === true && editorCapas.importada.anchoBitmap === 1 &&
      editorCapas.importada.canvas.ancho === editorCapas.medidasImagen.ancho &&
      editorCapas.importada.canvas.alto === editorCapas.medidasImagen.alto &&
      editorCapas.descripcion.existe === true && editorCapas.descripcion.xml === true &&
      editorCapas.icono.escrito === true &&
      editorCapas.icono.recurso === "@android:drawable/ic_delete" &&
      editorCapas.icono.bitmap === false && editorCapas.iconoDeshecho === true &&
      editorCapas.restaurado === true,
      JSON.stringify({ campo: editorCapas.campoImagen, importada: editorCapas.importada,
        medidasImagen: editorCapas.medidasImagen, descripcion: editorCapas.descripcion,
        icono: editorCapas.icono, iconoDeshecho: editorCapas.iconoDeshecho,
        restaurado: editorCapas.restaurado }).slice(0, 1400));


    // 12a-octies. el separador: se arrastra con puntero, se mueve con el teclado y guarda el ancho
    // sin tocar el modelo, el texto ni el cursor del editor.
    const separadorPrueba = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const sep = document.getElementById("separador-previa");
      const panel = document.getElementById("previa-lateral");
      const fila = document.getElementById("editor-fila");
      const area = document.getElementById("codigo");
      const modelo = await vp.modeloActual();
      const antes = {
        ancho: Math.round(panel.getBoundingClientRect().width),
        codigo: document.getElementById("ultimo-codigo").textContent,
        valor: area.value.length,
        seleccion: area.selectionStart,
        modelo: modelo ? JSON.stringify(modelo).length : 0,
      };
      const caja = fila.getBoundingClientRect();
      const destino = Math.round(caja.right - 420);
      sep.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7,
        clientX: Math.round(caja.right - antes.ancho) }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: destino }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientX: destino }));
      await new Promise((ok) => setTimeout(ok, 60));
      const modeloTras = await vp.modeloActual();
      const tras = {
        ancho: Math.round(panel.getBoundingClientRect().width),
        aria: Number(sep.getAttribute("aria-valuenow")),
        guardado: Number(localStorage.getItem("apkc-studio/previa-ancho")),
        codigo: document.getElementById("ultimo-codigo").textContent,
        valor: area.value.length,
        seleccion: area.selectionStart,
        modelo: modeloTras ? JSON.stringify(modeloTras).length : 0,
      };
      sep.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      const minimo = Number(sep.getAttribute("aria-valuenow"));
      sep.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      const desdeMinimo = Number(sep.getAttribute("aria-valuenow"));
      for (let i = 0; i < 6; i++) sep.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      return {
        antes, tras, minimo, desdeMinimo,
        editor: Math.round(document.querySelector(".editor").getBoundingClientRect().width),
        modeloIgual: antes.modelo === tras.modelo && antes.modelo > 0,
      };
    })()`);
    comprueba("el separador se arrastra, actualiza aria-valuenow y guarda el ancho en localStorage",
      Math.abs(separadorPrueba.tras.ancho - 420) <= 6 &&
      separadorPrueba.tras.aria === separadorPrueba.tras.guardado &&
      separadorPrueba.tras.aria === separadorPrueba.tras.ancho,
      JSON.stringify(separadorPrueba.tras).slice(0, 240));
    comprueba("arrastrar el separador no muta el modelo, el texto ni el cursor del editor",
      separadorPrueba.modeloIgual === true &&
      separadorPrueba.tras.codigo === separadorPrueba.antes.codigo &&
      separadorPrueba.tras.valor === separadorPrueba.antes.valor &&
      separadorPrueba.tras.seleccion === separadorPrueba.antes.seleccion &&
      separadorPrueba.editor >= 280,
      JSON.stringify({ antes: separadorPrueba.antes, tras: separadorPrueba.tras,
        editor: separadorPrueba.editor }).slice(0, 320));
    comprueba("el teclado del separador respeta el mínimo y el foco del editor sigue intacto",
      separadorPrueba.minimo === 240 && separadorPrueba.desdeMinimo === 256,
      JSON.stringify({ minimo: separadorPrueba.minimo, siguiente: separadorPrueba.desdeMinimo }).slice(0, 240));

    // 12a-octies-bis. las cuatro aristas y las cuatro esquinas: el alto también se reparte, las
    // medidas se guardan y el marco no deja hueco fuera de la fila.
    const marcos = await evaluar(`(async () => {
      const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const arrastrar = (id, dx, dy) => {
        const el = document.getElementById(id);
        const caja = el.getBoundingClientRect();
        const x = Math.round(caja.left + Math.max(2, caja.width / 2));
        const y = Math.round(caja.top + Math.max(2, caja.height / 2));
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 21,
          clientX: x, clientY: y }));
        document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 21,
          clientX: x + dx, clientY: y + dy }));
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 21,
          clientX: x + dx, clientY: y + dy }));
      };
      const doble = (id) => document.getElementById(id)
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const fila = document.getElementById("editor-fila").getBoundingClientRect();
      const techo = Math.round(fila.height);
      const minimo = 320;
      // los recortes se calculan sobre la fila de verdad: la ventana del gate no siempre mide 800
      const mueve = Math.max(10, Math.min(80, techo - minimo - 20));
      const mueveNorte = Math.max(5, Math.min(20, (techo - mueve) - minimo - 10));
      doble("separador-previa");
      await dormir(60);
      const cero = PREVIA_PANEL.estado();
      arrastrar("tirador-previa-sur", 0, -mueve);
      await dormir(60);
      const conSur = { ...PREVIA_PANEL.estado(),
        caja: Math.round(document.getElementById("previa-lateral").getBoundingClientRect().height) };
      arrastrar("tirador-previa-norte", 0, mueveNorte);
      await dormir(60);
      const conNorte = { ...PREVIA_PANEL.estado(),
        caja: Math.round(document.getElementById("previa-lateral").getBoundingClientRect().top - fila.top) };
      arrastrar("tirador-previa-noroeste", -50, -mueveNorte);
      await dormir(60);
      const conEsquina = { ...PREVIA_PANEL.estado(),
        caja: Math.round(document.getElementById("previa-lateral").getBoundingClientRect().width) };
      // las medidas tal como las guardó el arrastre, antes de que el teclado las cambie otra vez
      const guardado = {
        ancho: localStorage.getItem("apkc-studio/previa-ancho"),
        alto: localStorage.getItem("apkc-studio/previa-alto"),
        arriba: localStorage.getItem("apkc-studio/previa-arriba"),
      };
      const sur = document.getElementById("tirador-previa-sur");
      sur.focus();
      sur.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      const altoMinimo = PREVIA_PANEL.estado();
      sur.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      const altoEntero = PREVIA_PANEL.estado();
      const guardadoEntero = localStorage.getItem("apkc-studio/previa-alto");
      return {
        cero, conSur, conNorte, conEsquina, altoMinimo, altoEntero,
        techo, mueve, mueveNorte,
        esperado: {
          sur: Math.max(minimo, techo - mueve),
          norteArriba: Math.min(mueveNorte, Math.max(0, Math.max(minimo, techo - mueve) - minimo)),
        },
        fila: Math.round(fila.height),
        guardado, guardadoEntero,
        tiradores: document.querySelectorAll("#marco-previa .tirador-previa").length,
      };
    })()`);
    comprueba("la arista inferior cambia el alto del panel y deja el ancho quieto",
      marcos.conSur.alto === marcos.esperado.sur && marcos.conSur.caja === marcos.conSur.alto &&
      marcos.conSur.ancho === marcos.cero.ancho && marcos.cero.alto === null,
      JSON.stringify({ cero: marcos.cero, conSur: marcos.conSur, esperado: marcos.esperado }).slice(0, 320));
    comprueba("la arista superior mueve el borde de arriba y la de abajo no se mueve",
      marcos.conNorte.arriba === marcos.esperado.norteArriba &&
      marcos.conNorte.caja === marcos.esperado.norteArriba &&
      marcos.conNorte.alto === marcos.conSur.alto - marcos.esperado.norteArriba &&
      marcos.conNorte.alto + marcos.conNorte.arriba === marcos.conSur.alto,
      JSON.stringify({ conNorte: marcos.conNorte, conSur: marcos.conSur,
        esperado: marcos.esperado }).slice(0, 280));
    comprueba("la esquina noroeste cambia ancho y alto a la vez y guarda las tres medidas",
      marcos.conEsquina.ancho === marcos.cero.ancho + 50 && marcos.conEsquina.caja === marcos.conEsquina.ancho &&
      marcos.conEsquina.arriba === Math.max(0, marcos.conNorte.arriba - marcos.mueveNorte) &&
      marcos.conEsquina.alto + marcos.conEsquina.arriba === marcos.conNorte.alto + marcos.conNorte.arriba &&
      Number(marcos.guardado.ancho) === marcos.conEsquina.ancho &&
      Number(marcos.guardado.alto) === marcos.conEsquina.alto &&
      Number(marcos.guardado.arriba) === marcos.conEsquina.arriba && marcos.tiradores === 8,
      JSON.stringify({ conEsquina: marcos.conEsquina, conNorte: marcos.conNorte,
        guardado: marcos.guardado, tiradores: marcos.tiradores }).slice(0, 340));
    comprueba("el teclado de la arista inferior respeta el alto mínimo y el alto entero",
      marcos.altoMinimo.alto === 320 &&
      marcos.altoMinimo.alto + marcos.altoMinimo.arriba ===
        marcos.conEsquina.alto + marcos.conEsquina.arriba &&
      marcos.altoEntero.alto === marcos.techo && marcos.altoEntero.arriba === 0 &&
      Number(marcos.guardadoEntero) === marcos.techo,
      JSON.stringify({ minimo: marcos.altoMinimo, entero: marcos.altoEntero,
        techo: marcos.techo, guardado: marcos.guardadoEntero }).slice(0, 240));

    // 12a-nonies. la vista Pantalla no se queda atrás: los dos modos, la consola con el mismo
    // contenido y sus propios tiradores, con las medidas guardadas aparte.
    const pantalla = await evaluar(`(async () => {
      const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const arrastrar = (id, dx, dy) => {
        const el = document.getElementById(id);
        const caja = el.getBoundingClientRect();
        const x = Math.round(caja.left + Math.max(2, caja.width / 2));
        const y = Math.round(caja.top + Math.max(2, caja.height / 2));
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 41,
          clientX: x, clientY: y }));
        document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 41,
          clientX: x + dx, clientY: y + dy }));
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 41,
          clientX: x + dx, clientY: y + dy }));
      };
      document.querySelector('nav.actividad [data-vista="vista"]').click();
      await dormir(120);
      const antes = PREVIA_PANEL.estado();
      arrastrar("vista-tirador-oeste", -40, 0);
      await dormir(60);
      arrastrar("vista-tirador-sur", 0, -60);
      await dormir(60);
      const tras = PREVIA_PANEL.estado();
      return {
        antes, tras,
        anchoCaja: Math.round(document.getElementById("vista-lado").getBoundingClientRect().width),
        guardado: localStorage.getItem("apkc-studio/previa-lado"),
        guardadoAlto: localStorage.getItem("apkc-studio/previa-lado-alto"),
        modos: [document.getElementById("vista-modo-previa").textContent.trim(),
          document.getElementById("vista-modo-emulador").textContent.trim()],
        tiradores: document.querySelectorAll("#marco-vista-lado .tirador-previa").length,
        activa: document.getElementById("vista").classList.contains("activa"),
        cuerpo: document.body.dataset.vista,
        titulo: document.getElementById("vista").querySelector("h1").textContent.trim(),
      };
    })()`);
    comprueba("la vista Pantalla se abre con los dos modos, la consola y ocho tiradores",
      pantalla.activa === true && pantalla.cuerpo === "vista" && pantalla.titulo === "Pantalla de la app" &&
      pantalla.modos.join(",") === "Vista previa,Emulador" && pantalla.tiradores === 8,
      JSON.stringify({ activa: pantalla.activa, modos: pantalla.modos, tiradores: pantalla.tiradores }).slice(0, 240));
    comprueba("los tiradores de Pantalla cambian el ancho y el alto de su columna y se guardan",
      pantalla.tras.lado === pantalla.antes.lado + 40 && pantalla.anchoCaja === pantalla.tras.lado &&
      Number.isFinite(pantalla.tras.ladoAlto) && Number(pantalla.guardado) === pantalla.tras.lado &&
      Number(pantalla.guardadoAlto) === pantalla.tras.ladoAlto,
      JSON.stringify({ antes: pantalla.antes, tras: pantalla.tras, caja: pantalla.anchoCaja,
        guardado: pantalla.guardado }).slice(0, 320));
    await evaluar(`document.querySelector('nav.actividad [data-vista="pestana"]').click()`);

    // 12a-decies. el rótulo de tipo/id no puede tapar el texto del botón en ninguno de los dos
    // paneles. Se compara el mismo nodo con `id` y sin él: si el pintor dibuja el rótulo, los
    // píxeles cambian; si no, son idénticos. El texto se comprueba aparte, con «Press me» y sin él.
    // La lógica del rótulo es del pintor compartido: aquí solo se verifica desde el panel.
    const rotulo = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const boton = (conId) => ({ tipo: "Button", ...(conId ? { id: "id/pulsar" } : {}),
        texto: "Press me", rect: { x: 0, y: 0, ancho: 200, alto: 48 } });
      const modelo = (nodos) => ({
        layout: "res/layout/main.xml", pantalla: { x: 0, y: 0, ancho: 360, alto: 640 },
        aproximado: true,
        raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 360, alto: 640 }, hijos: nodos },
        ejecucion: { metodo: "onCreate", pasos: 1,
          capturas: [{ origen: "TextView.setText", id: "id/pulsar", texto: "Press me" }] },
      });
      const pintar = (nodos) => {
        const cv = document.createElement("canvas");
        vp.pintarModelo(cv, modelo(nodos), { ancho: 270, alto: 480 });
        return cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      };
      const distintos = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
        }
        return n;
      };
      const conId = pintar([boton(true)]);
      const sinId = pintar([boton(false)]);
      const conTexto = conId;
      const sinTexto = pintar([{ ...boton(true), texto: "" }]);
      // el modelo del emulador, por la misma entrada que un build correcto: el panel y la vista
      vp.pintarVistaPrevia(modelo([boton(true)]));
      document.getElementById("previa-modo-render").click();
      document.getElementById("vista-modo-emulador").click();
      await new Promise((ok) => setTimeout(ok, 80));
      return {
        rotulo: distintos(conId, sinId),
        texto: distintos(conTexto, sinTexto),
        cuerpo: document.body.dataset.vista,
        logPanel: [...document.getElementById("previa-log-lista").children].map((li) => li.textContent),
        logVista: [...document.getElementById("vista-log-lista").children].map((li) => li.textContent),
      };
    })()`);
    comprueba("el canvas del Emulador no pinta el rótulo Button id/pulsar sobre el nodo",
      rotulo.rotulo === 0,
      JSON.stringify({ pixelesQueCambian: rotulo.rotulo, texto: rotulo.texto }).slice(0, 200));
    comprueba("y el texto «Press me» del botón sigue visible en el canvas",
      rotulo.texto > 20, JSON.stringify(rotulo).slice(0, 200));
    comprueba("la consola de Pantalla enseña las mismas capturas que la del panel",
      rotulo.logPanel.length === 1 && rotulo.logVista.length === 1 &&
      rotulo.logVista[0] === rotulo.logPanel[0] && /Press me/.test(String(rotulo.logVista[0])),
      JSON.stringify({ panel: rotulo.logPanel, vista: rotulo.logVista }).slice(0, 240));

    // 12a-undecies. en pantalla estrecha la fila se apila, los tiradores se ocultan y hay aviso;
    // el gesto no puede cambiar nada porque no hay nada que arrastrar.
    await exec("Emulation.setDeviceMetricsOverride",
      { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
    await esperar(400);
    const estrecho = await evaluar(`(() => {
      const tirador = document.getElementById("tirador-previa-sur");
      const antes = PREVIA_PANEL.estado().ancho;
      const caja = tirador.getBoundingClientRect();
      tirador.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 51,
        clientX: Math.round(caja.left + 3), clientY: Math.round(caja.top + 3) }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 51,
        clientX: 10, clientY: Math.round(caja.top + 3) }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 51,
        clientX: 10, clientY: Math.round(caja.top + 3) }));
      return {
        display: getComputedStyle(tirador).display,
        aviso: getComputedStyle(document.getElementById("previa-aviso-estrecho")).display,
        antes, despues: PREVIA_PANEL.estado().ancho,
        direccion: getComputedStyle(document.getElementById("editor-fila")).flexDirection,
      };
    })()`);
    await exec("Emulation.clearDeviceMetricsOverride");
    await esperar(300);
    comprueba("en pantalla estrecha la fila se apila, los tiradores se ocultan y el aviso aparece",
      estrecho.display === "none" && estrecho.aviso !== "none" &&
      estrecho.direccion === "column" && estrecho.antes === estrecho.despues,
      JSON.stringify(estrecho).slice(0, 260));

    // 12a-quater. con la vista previa delante, el diagnóstico en vivo y la paleta siguen vivos:
    // los dos son document-wide y la tercera vista no puede taparlos ni romper su estado.
    const conVista = await evaluar(`(async () => {
      await abrir("/proyecto/vivo.java");
      const area = document.getElementById("codigo");
      area.value = "package p;\\n\\npublic class Vivo {\\n  void x() { int y = ; }\\n}\\n";
      area.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('nav.actividad [data-vista="vista"]').click();
      return { cuerpo: document.body.dataset.vista,
        activa: document.getElementById("vista").classList.contains("activa") };
    })()`);
    await esperar(3500);
    const vivoVista = await evaluar(`({
      estado: document.getElementById("diagnostico-vivo-estado").textContent,
      lista: document.getElementById("diagnostico-vivo-lista").textContent,
      marcas: document.getElementById("diagnostico-marcas").children.length,
    })`);
    comprueba("el diagnóstico en vivo marca el error con la vista previa abierta",
      conVista.cuerpo === "vista" && conVista.activa === true &&
      /error/i.test(String(vivoVista.estado)) && /linea [45]|vivo\.java:[45]/.test(String(vivoVista.lista)) &&
      vivoVista.marcas >= 1,
      JSON.stringify({ conVista, vivoVista }).slice(0, 280));
    await evaluar(`document.dispatchEvent(new KeyboardEvent("keydown",
      { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true }))`);
    await esperar(200);
    const paletaVista = await evaluar(`(() => {
      const abierta = !document.getElementById("paleta").hidden;
      const e = document.getElementById("paleta-buscar");
      e.value = "guardar"; e.dispatchEvent(new Event("input", { bubbles: true }));
      return { abierta, filtro: document.getElementById("paleta-lista").textContent,
        cuerpo: document.body.dataset.vista };
    })()`);
    await evaluar(`document.getElementById("paleta").click()`);
    const paletaVistaCerrada = await evaluar(`document.getElementById("paleta").hidden`);
    comprueba("la paleta Ctrl+Mayús+P abre, filtra y cierra con la vista previa abierta",
      paletaVista.abierta === true && /Guardar fichero/.test(String(paletaVista.filtro)) &&
      paletaVistaCerrada === true,
      JSON.stringify({ ...paletaVista, paletaVistaCerrada }).slice(0, 280));
    await evaluar(`(async () => {
      await hospedador.escribir("/proyecto/vivo.java",
        new TextEncoder().encode("package p;\\npublic class Vivo {}\\n"));
      document.querySelector('nav.actividad [data-vista="pestana"]').click();
    })()`);
    fs.writeFileSync(path.join(fuera, "pestanera-contador.apk"), apkContador);
    console.log("  --- el apk de la app del contador, compilado en la pestaña, es " +
      path.join(fuera, "pestanera-contador.apk"));

    // 12a-quinquies (D3). autocompletado: recursos del proyecto y APIs del android.jar, sin red.
    // La lista se abre al teclear `R.`, Tab acepta, Esc cierra y las flechas recorren; el jar se
    // lee por trozos de OPFS (su directorio central) y no se pide nada a la red. Primero se
    // aparta el jar para probar el aviso: los recursos tienen que seguir funcionando sin él.
    const autoSinJar = await evaluar(`(async () => {
      if (!window.AUTOCOMPLETADO) return { error: "sin AUTOCOMPLETADO" };
      await hospedador.escribir("/proyecto/res/values/auto.xml", new TextEncoder().encode(
        '<resources><string name="auto_titulo">Auto</string>' +
        '<color name="auto_color">#fff</color><item type="id" name="auto_suelto"/></resources>'));
      await hospedador.escribir("/proyecto/res/layout/auto.xml", new TextEncoder().encode(
        '<LinearLayout><Button android:id="@+id/auto_boton"/></LinearLayout>'));
      await hospedador.escribir("/proyecto/Auto.java",
        new TextEncoder().encode("package p;\\nclass Auto { int x = 0; }\\n"));
      await hospedador.renombrar("/sdk/android.jar", "/sdk/android.jar.prueba");
      AUTOCOMPLETADO.olvidarJar();
      marcarSucio(false);
      await abrir("/proyecto/Auto.java");
      document.querySelector('[data-vista="pestana"]').click();
      const area = document.getElementById("codigo");
      EDITOR.poner("class Auto { void f() { View. } }");
      area.focus();
      const at = area.value.indexOf("View.") + "View.".length;
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return { apartado: true };
    })()`);
    await esperar(900);
    const avisoSinJar = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      estado: document.getElementById("autocompletado-estado").textContent
    })`);
    comprueba("sin android.jar la lista de APIs lo dice y no inventa clases",
      autoSinJar.apartado === true && avisoSinJar.visible === true &&
      /android\.jar/.test(String(avisoSinJar.estado)) && /OPFS/.test(String(avisoSinJar.estado)),
      JSON.stringify(avisoSinJar).slice(0, 260));

    const autoPrep = await evaluar(`(async () => {
      await AUTOCOMPLETADO.refrescar();
      const recursos = AUTOCOMPLETADO.recursos();
      const area = document.getElementById("codigo");
      EDITOR.poner("class Auto { int x = R.; }");
      area.focus();
      const at = area.value.indexOf("R.") + 2;
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return { recursos };
    })()`);
    await esperar(900);
    const listaR = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      opciones: [...document.querySelectorAll("#autocompletado-lista .autocompletado-opcion")]
        .map((b) => b.firstChild ? b.firstChild.textContent : b.textContent),
      activa: (document.querySelector("#autocompletado-lista .autocompletado-opcion.activa") || {}).id || "",
      estado: document.getElementById("autocompletado-estado").textContent
    })`);
    comprueba("sin jar, R. sigue abriendo los tipos declarados y la primera opción resaltada",
      !!(autoPrep.recursos && autoPrep.recursos.nombres >= 5) && listaR.visible === true &&
      listaR.opciones.includes("R.layout") && listaR.opciones.includes("R.string") &&
      listaR.opciones.includes("R.id") && listaR.opciones.includes("R.color") &&
      listaR.activa === "autocompletado-opcion-0",
      JSON.stringify({ recursos: autoPrep.recursos, lista: listaR.opciones.slice(0, 8),
        activa: listaR.activa }).slice(0, 320));

    // se devuelve el jar y se olvida el fallo: el resto de la prueba sí lo necesita
    await evaluar(`(async () => {
      await hospedador.renombrar("/sdk/android.jar.prueba", "/sdk/android.jar");
      AUTOCOMPLETADO.olvidarJar();
      return true;
    })()`);

    // El jar no se descarga ni se copia entero: se piden el final del fichero (EOCD) y su
    // directorio central. Aquí se mide cuánto se leyó de verdad y se comprueba que no hubo ni una
    // petición en ese tramo.
    const antesJar = peticiones.length;
    const jarAuto = await evaluar(`(async () => {
      const t = performance.now();
      const r = await AUTOCOMPLETADO.cargarJar();
      return { ...r, msTotal: Math.round(performance.now() - t), sinJar: AUTOCOMPLETADO.textoSinJar() };
    })()`);
    await esperar(200);
    const peticionesJar = peticiones.slice(antesJar);
    const medidaJar = jarAuto.medida || {};
    comprueba("el índice del android.jar se lee de OPFS por trozos y sin una sola petición",
      medidaJar.clases > 1000 && medidaJar.bytes > 0 &&
      medidaJar.bytes < medidaJar.tamanoArchivo / 4 && jarAuto.leidos === medidaJar.bytes &&
      peticionesJar.length === 0 && /android\.jar/.test(String(jarAuto.sinJar)) &&
      /OPFS/.test(String(jarAuto.sinJar)) && /recursos/.test(String(jarAuto.sinJar)),
      JSON.stringify({ clases: medidaJar.clases, bytes: medidaJar.bytes,
        archivo: medidaJar.tamanoArchivo, ms: medidaJar.ms,
        peticiones: peticionesJar.length }).slice(0, 300));

    await evaluar(`(() => {
      const area = document.getElementById("codigo");
      EDITOR.poner("class Auto { int x = R.la; }");
      area.focus();
      const at = area.value.indexOf("R.la") + 4;
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await esperar(800);
    const antesTab = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      primera: (document.querySelector("#autocompletado-lista .autocompletado-opcion") || {}).textContent || ""
    })`);
    await evaluar(`document.getElementById("codigo").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))`);
    const trasTab = await evaluar(`(() => {
      const area = document.getElementById("codigo");
      const texto = area.value;
      const deshacer = document.execCommand("undo");
      return { texto, deshacer, trasDeshacer: area.value,
        popup: document.getElementById("autocompletado").hidden };
    })()`);
    comprueba("Tab acepta la sugerencia resaltada, entra en el deshacer y cierra la lista",
      antesTab.visible === true && /^R\.layout/.test(antesTab.primera) &&
      trasTab.texto === "class Auto { int x = R.layout; }" && trasTab.deshacer === true &&
      trasTab.trasDeshacer === "class Auto { int x = R.la; }" && trasTab.popup === true,
      JSON.stringify(trasTab).slice(0, 240));

    await evaluar(`(() => {
      const area = document.getElementById("codigo");
      EDITOR.poner("class Auto { int x = R.; }");
      area.focus();
      const at = area.value.indexOf("R.") + 2;
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await esperar(800);
    const antesEsc = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      valor: document.getElementById("codigo").value
    })`);
    await evaluar(`document.getElementById("codigo").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
    const trasEsc = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      valor: document.getElementById("codigo").value
    })`);
    comprueba("Esc cierra la lista sin tocar el texto",
      antesEsc.visible === true && trasEsc.visible === false && trasEsc.valor === antesEsc.valor,
      JSON.stringify({ antes: antesEsc.visible, despues: trasEsc.visible }).slice(0, 160));

    // flechas + Tab: la resaltada se acepta. Se espera a que el diagnóstico en vivo termine su
    // pasada para demostrar que mover la lista no dispara otro check.
    await evaluar(`(() => {
      const area = document.getElementById("codigo");
      EDITOR.poner("class Auto { int x = R.layout.; }");
      area.focus();
      const at = area.value.indexOf("R.layout.") + "R.layout.".length;
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      marcarSucio(false);
      return true;
    })()`);
    // El input que acaba de irrumpir programa un check a 350 ms (diagnostico-vivo.js:26) y el
    // estado pasa por un valor transitorio, «comprobando…» (diagnostico-vivo.js:226), antes del
    // resumen. Esperar a que dos lecturas coincidan no es esperar a que la pasada pare: durante la
    // pasada «comprobando…» se repite, así que la base podía ser ese transitorio y el resumen
    // llegaba dentro de la ventana de las flechas. La prueba fallaba entonces sin que las flechas
    // escribieran nada —solo mueven `activo` (autocompletado.js:326-334 y 373-380) y no disparan
    // ningún `input`—: era una carrera contra el reloj de la pasada. Se espera, de una vez y desde
    // dentro de la página (sin ruido de CDP), al resumen y a 1 s de silencio, que cubre el debounce
    // y la segunda pasada que deja `pendiente` (diagnostico-vivo.js:284-292).
    const quiescente = await evaluar(`(async () => {
      const estado = document.getElementById("diagnostico-vivo-estado");
      const resumen = /^([0-9]+ error|sin errores|no se pudo)/;
      const t0 = Date.now();
      let previo = estado.textContent;
      let desde = Date.now();
      while (Date.now() - t0 < 20000) {
        const ahora = estado.textContent;
        if (ahora !== previo) { previo = ahora; desde = Date.now(); }
        if (resumen.test(ahora) && Date.now() - desde >= 1000) return { ms: Date.now() - t0, estado: ahora };
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ms: Date.now() - t0, estado: null };
    })()`);
    const antesFlecha = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      valor: document.getElementById("codigo").value,
      estadoDx: document.getElementById("diagnostico-vivo-estado").textContent,
      opciones: [...document.querySelectorAll("#autocompletado-lista .autocompletado-opcion")]
        .map((b) => b.firstChild ? b.firstChild.textContent : b.textContent)
    })`);
    // Un cambio del texto no es la única huella de una pasada: si el fichero no cambió, el resumen
    // es el mismo y una igualdad de texto no ve la pasada nueva. Con la base ya quiescente, se
    // cuentan las mutaciones de `#diagnostico-vivo-estado` en la ventana de las flechas: una pasada
    // escribe «comprobando…» y luego el resumen, así que deja al menos dos.
    await evaluar(`(() => {
      const estado = document.getElementById("diagnostico-vivo-estado");
      window.__dx = { cambios: 0, textos: [] };
      if (window.__dxObs) window.__dxObs.disconnect();
      window.__dxObs = new MutationObserver(() => {
        window.__dx.cambios++;
        window.__dx.textos.push(String(estado.textContent).slice(0, 40));
      });
      window.__dxObs.observe(estado, { childList: true, characterData: true, subtree: true });
      return true;
    })()`);
    const trasFlecha = await evaluar(`(() => {
      const area = document.getElementById("codigo");
      const tecla = (key) => area.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      tecla("ArrowDown");
      const segunda = (document.querySelector("#autocompletado-lista .autocompletado-opcion.activa") || {}).id || "";
      tecla("ArrowUp");
      tecla("ArrowDown");
      return { segunda,
        activaFinal: (document.querySelector("#autocompletado-lista .autocompletado-opcion.activa") || {}).id || "" };
    })()`);
    await esperar(700);
    const despuesFlecha = await evaluar(`(() => {
      if (window.__dxObs) window.__dxObs.disconnect();
      return {
        estadoDx: document.getElementById("diagnostico-vivo-estado").textContent,
        valor: document.getElementById("codigo").value,
        visible: !document.getElementById("autocompletado").hidden,
        cambios: window.__dx ? window.__dx.cambios : -1,
        textos: window.__dx ? window.__dx.textos : []
      };
    })()`);
    const segundaOpcion = antesFlecha.opciones[1] || "";
    await evaluar(`document.getElementById("codigo").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))`);
    const insertada = await evaluar(`({
      texto: document.getElementById("codigo").value,
      popup: document.getElementById("autocompletado").hidden
    })`);
    comprueba("las flechas recorren la lista sin escribir ni lanzar otro check",
      quiescente.estado !== null && antesFlecha.visible === true && antesFlecha.opciones.length >= 2 &&
      trasFlecha.segunda === "autocompletado-opcion-1" &&
      trasFlecha.activaFinal === "autocompletado-opcion-1" &&
      despuesFlecha.valor === antesFlecha.valor && despuesFlecha.cambios === 0 &&
      despuesFlecha.estadoDx === antesFlecha.estadoDx && despuesFlecha.visible === true,
      JSON.stringify({ segunda: trasFlecha.segunda, igual: despuesFlecha.valor === antesFlecha.valor,
        dx: despuesFlecha.estadoDx === antesFlecha.estadoDx, base: quiescente,
        cambios: despuesFlecha.cambios, textos: despuesFlecha.textos }).slice(0, 300));
    comprueba("Tab acepta la opción resaltada por las flechas",
      segundaOpcion !== "" && insertada.texto === "class Auto { int x = R.layout." + segundaOpcion + "; }" &&
      insertada.popup === true,
      JSON.stringify({ segundaOpcion, texto: insertada.texto }).slice(0, 200));

    // clases y métodos del jar: el nombre se completa y `View.` abre sus métodos públicos, leídos
    // del propio .class (el descriptor viaja en la pista de cada opción).
    await evaluar(`(() => {
      const area = document.getElementById("codigo");
      EDITOR.poner("class Auto { Acti }");
      area.focus();
      const at = area.value.indexOf("Acti") + 4;
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await esperar(1200);
    const clasesAuto = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      opciones: [...document.querySelectorAll("#autocompletado-lista .autocompletado-opcion")]
        .map((b) => b.firstChild ? b.firstChild.textContent : b.textContent),
      estado: document.getElementById("autocompletado-estado").textContent
    })`);
    comprueba("las clases del android.jar completan en el editor",
      clasesAuto.visible === true && clasesAuto.opciones.includes("Activity") &&
      /clases del android\.jar/.test(String(clasesAuto.estado)),
      JSON.stringify({ primeras: clasesAuto.opciones.slice(0, 4), estado: clasesAuto.estado }).slice(0, 220));

    await evaluar(`(() => {
      const area = document.getElementById("codigo");
      EDITOR.poner("class Auto { void f() { View. } }");
      area.focus();
      const at = area.value.indexOf("View.") + "View.".length;
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await esperar(1200);
    const metodosView = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      opciones: [...document.querySelectorAll("#autocompletado-lista .autocompletado-opcion")]
        .map((b) => b.firstChild ? b.firstChild.textContent : b.textContent),
      estado: document.getElementById("autocompletado-estado").textContent
    })`);
    comprueba("los método públicos de una clase del jar se leen de su .class",
      metodosView.visible === true && metodosView.opciones.includes("animate") &&
      /métodos de android\.view\.View/.test(String(metodosView.estado)),
      JSON.stringify({ opciones: metodosView.opciones.slice(0, 5), estado: metodosView.estado }).slice(0, 240));

    // la lista abierta no roba los atajos de la página: Ctrl+Mayús+P abre la paleta y Ctrl+G pide
    // la línea; después Escape cierra solo la lista.
    await evaluar(`document.dispatchEvent(new KeyboardEvent("keydown",
      { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true }))`);
    await esperar(250);
    const paletaConAuto = await evaluar(`({
      abierta: !document.getElementById("paleta").hidden,
      foco: document.activeElement.id
    })`);
    await evaluar(`document.getElementById("paleta").click()`);
    const irConAuto = await evaluar(`(() => {
      const original = window.prompt;
      window.prompt = () => "1";
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true }));
      window.prompt = original;
      const area = document.getElementById("codigo");
      return { linea: area.value.slice(0, area.selectionStart).split("\\n").length };
    })()`);
    await evaluar(`document.getElementById("codigo").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
    const escapeFinal = await evaluar(`document.getElementById("autocompletado").hidden`);
    comprueba("el autocompletado no roba Ctrl+Mayús+P ni Ctrl+G",
      paletaConAuto.abierta === true && paletaConAuto.foco === "paleta-buscar" &&
      irConAuto.linea === 1 && escapeFinal === true,
      JSON.stringify({ paletaConAuto, irConAuto, escapeFinal }).slice(0, 240));

    // 12a-sexies (D4). autocompletado y linter de XML. El fichero activo elige el lenguaje: en un
    // `.xml` del proyecto la lista sugiere etiquetas y el estado dice `xml`; en un `.java` no
    // aparece ni una etiqueta XML; y un `@string` que no existe se marca con el linter local, sin
    // pasar por `apkc check` (se cuenta la llamada) ni por el fichero temporal.
    const xmlPrep = await evaluar(`(async () => {
      if (!window.AUTOCOMPLETADO) return { error: "sin AUTOCOMPLETADO" };
      await hospedador.escribir("/proyecto/res/values/xmlauto.xml", new TextEncoder().encode(
        '<resources><string name="xmlauto_hola">Hola</string></resources>'));
      await hospedador.escribir("/proyecto/res/layout/xmlauto.xml", new TextEncoder().encode(
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"' +
        ' android:orientation="vertical">\\n  <TextView android:text="@string/xmlauto_hola"/>\\n</LinearLayout>\\n'));
      await hospedador.escribir("/proyecto/xmlundo.java", new TextEncoder().encode(
        "package p;\\npublic class XmlUndo { int x = 1; }\\n"));
      await AUTOCOMPLETADO.refrescar();
      marcarSucio(false);
      await abrir("/proyecto/res/layout/xmlauto.xml");
      document.querySelector('[data-vista="pestana"]').click();
      const area = document.getElementById("codigo");
      EDITOR.poner('<LinearLayout>\\n  <TextVie');
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return { ruta: estadoPestana.ruta };
    })()`);
    await esperar(900);
    const listaXml = await evaluar(`({
      visible: !document.getElementById("autocompletado").hidden,
      opciones: [...document.querySelectorAll("#autocompletado-lista .autocompletado-opcion")]
        .map((b) => b.firstChild ? b.firstChild.textContent : b.textContent),
      estado: document.getElementById("autocompletado-estado").textContent
    })`);
    comprueba("en un .xml la lista sugiere etiquetas Android y el estado dice xml",
      xmlPrep.ruta === "/proyecto/res/layout/xmlauto.xml" && listaXml.visible === true &&
      listaXml.opciones.includes("TextView") && /^xml ·/.test(String(listaXml.estado)) &&
      !/android\\.jar|R\\./.test(String(listaXml.estado)),
      JSON.stringify({ ruta: xmlPrep.ruta, estado: listaXml.estado,
        primeras: listaXml.opciones.slice(0, 4) }).slice(0, 300));

    // Tab acepta la sugerencia en el XML, entra en el deshacer de ese documento y no toca el
    // historial del Java que estaba abierto antes.
    const trasTabXml = await evaluar(`(async () => {
      const area = document.getElementById("codigo");
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      const texto = area.value;
      const deshacer = document.execCommand("undo");
      const trasDeshacer = area.value;
      const javaAntes = DOCUMENTOS.lista
        .filter((d) => /\\.java$/.test(d.ruta)).map((d) => d.ruta);
      marcarSucio(false);
      await abrir("/proyecto/xmlundo.java");
      const areaJava = document.getElementById("codigo");
      const javaTexto = areaJava.value;
      areaJava.focus();
      const javaDeshacer = document.execCommand("undo");
      return { texto, deshacer, trasDeshacer, javaAntes, javaTexto, javaDeshacer,
        popup: document.getElementById("autocompletado").hidden,
        javaTras: areaJava.value };
    })()`);
    comprueba("Tab inserta TextView en el XML sin tocar el deshacer del Java",
      /<TextView$/.test(String(trasTabXml.texto)) && trasTabXml.popup === true &&
      !/ +$/.test(String(trasTabXml.texto)) &&
      trasTabXml.javaTexto === "package p;\npublic class XmlUndo { int x = 1; }\n" &&
      trasTabXml.javaTras === trasTabXml.javaTexto,
      JSON.stringify({ texto: String(trasTabXml.texto).slice(-40),
        popup: trasTabXml.popup, trasDeshacer: String(trasTabXml.trasDeshacer).slice(-20),
        javaIgual: trasTabXml.javaTras === trasTabXml.javaTexto }).slice(0, 320));

    // en un .java no aparece ni una etiqueta XML, y en un .xml no aparece `R.`
    const javaSinXml = await evaluar(`(async () => {
      const area = document.getElementById("codigo");
      EDITOR.poner("class XmlUndo { <TextVie");
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 500));
      const enJava = { ruta: estadoPestana.ruta,
        visible: !document.getElementById("autocompletado").hidden,
        estado: document.getElementById("autocompletado-estado").textContent,
        opciones: [...document.querySelectorAll("#autocompletado-lista .autocompletado-opcion")]
          .map((b) => b.firstChild ? b.firstChild.textContent : b.textContent) };
      marcarSucio(false);
      await abrir("/proyecto/res/layout/xmlauto.xml");
      const areaXml = document.getElementById("codigo");
      // R.layout. dentro de un valor de atributo: la rama XML tiene que seguir siendo la suya
      EDITOR.poner('<LinearLayout android:text="R.layout.');
      areaXml.focus();
      areaXml.setSelectionRange(areaXml.value.length, areaXml.value.length);
      areaXml.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((ok) => setTimeout(ok, 500));
      const enXml = { ruta: estadoPestana.ruta,
        visible: !document.getElementById("autocompletado").hidden,
        estado: document.getElementById("autocompletado-estado").textContent,
        opciones: [...document.querySelectorAll("#autocompletado-lista .autocompletado-opcion")]
          .map((b) => b.firstChild ? b.firstChild.textContent : b.textContent) };
      return { enJava, enXml };
    })()`);
    // `TextView` es también una clase del android.jar: en un .java la lista sale por el jar
    // (`clases del android.jar`), no por el catálogo de etiquetas, y su estado no dice `xml`.
    // En el .xml, `R.layout.` dentro de un valor sigue en la rama XML: ni `R.` ni clases.
    comprueba("el contexto no se cruza: ni etiquetas XML en .java ni R. en .xml",
      javaSinXml.enJava.visible === true && /^clases del android\.jar/.test(String(javaSinXml.enJava.estado)) &&
      !/^xml/.test(String(javaSinXml.enJava.estado)) &&
      javaSinXml.enXml.visible === true && /^xml ·/.test(String(javaSinXml.enXml.estado)) &&
      !/android\.jar/.test(String(javaSinXml.enXml.estado)) &&
      !javaSinXml.enXml.opciones.some((o) => /^R\./.test(String(o))),
      JSON.stringify({ java: javaSinXml.enJava, xml: javaSinXml.enXml }).slice(0, 300));

    // linter en vivo: `@string/noexiste` con línea y columna, subrayado propio y sin `apkc check`.
    // Se parte de un XML sano para que el resultado nuevo no se confunda con el de la prueba
    // anterior (los dos dirían «1 error · XML»).
    const lintXml = await evaluar(`(async () => {
      const area = document.getElementById("codigo");
      const original = hospedador.ejecutar;
      window.__checksDeXml = 0;
      const ultimoAntes = document.getElementById("ultimo-codigo").textContent;
      hospedador.ejecutar = (argv, ...resto) => {
        if (argv && argv[0] === "check") window.__checksDeXml++;
        return original.call(hospedador, argv, ...resto);
      };
      const estadoActual = () => document.getElementById("diagnostico-vivo-estado").textContent.trim();
      const esperarHasta = async (prueba, ms) => {
        const t0 = Date.now();
        let ultimo = "";
        while (Date.now() - t0 < ms) {
          ultimo = estadoActual();
          if (prueba(ultimo)) return ultimo;
          await new Promise((ok) => setTimeout(ok, 150));
        }
        return ultimo;
      };
      EDITOR.poner("<LinearLayout>\\n  <TextView/>\\n</LinearLayout>");
      area.focus();
      area.dispatchEvent(new Event("input", { bubbles: true }));
      const sano = await esperarHasta((e) => /^sin errores/.test(e) && /XML/.test(e), 8000);
      EDITOR.poner('<LinearLayout>\\n  <TextView android:text="@string/noexiste"/>\\n</LinearLayout>\\n');
      area.dispatchEvent(new Event("input", { bubbles: true }));
      const t0 = Date.now();
      const antes = sano;
      let estado = "";
      while (Date.now() - t0 < 20000) {
        const e = estadoActual();
        if (e !== antes && /^[0-9]+ error/.test(e) && /XML/.test(e)) { estado = e; break; }
        await new Promise((ok) => setTimeout(ok, 150));
      }
      const marca = document.querySelector('#diagnostico-marcas .marca-error[data-origen="XML"]');
      const salida = {
        sano,
        estado,
        ms: Date.now() - t0,
        ultimoAntes,
        lista: document.getElementById("diagnostico-vivo-lista").textContent,
        origen: (document.querySelector("#diagnostico-vivo-lista .origen-error") || {}).textContent || "",
        posicion: (document.querySelector("#diagnostico-vivo-lista code") || {}).textContent || "",
        marca: marca ? Object.assign({}, marca.dataset) : null,
        checks: window.__checksDeXml,
        ultimo: document.getElementById("ultimo-codigo").textContent,
        consola: String(document.getElementById("consola-pestana").textContent).slice(-200)
      };
      hospedador.ejecutar = original;
      return salida;
    })()`);
    comprueba("el linter de XML marca @string/noexiste con archivo:línea:columna y origen XML",
      /^sin errores/.test(String(lintXml.sano)) &&
      /^[0-9]+ error/.test(String(lintXml.estado)) && /XML/.test(String(lintXml.estado)) &&
      /no existe @string\/noexiste/.test(String(lintXml.lista)) &&
      lintXml.origen === "XML" && /^xmlauto\.xml:2:[0-9]+$/.test(String(lintXml.posicion)) &&
      lintXml.marca && Number(lintXml.marca.columna) > 0 && Number(lintXml.marca.ancho) > 40,
      JSON.stringify({ sano: lintXml.sano, estado: lintXml.estado, posicion: lintXml.posicion,
        marca: lintXml.marca }).slice(0, 320));
    comprueba("el linter de XML no lanza apkc check y responde en el debounce, no en 1,6 s",
      lintXml.checks === 0 && lintXml.ms < 6000 &&
      lintXml.ultimo === lintXml.ultimoAntes,
      JSON.stringify({ checks: lintXml.checks, ms: lintXml.ms,
        ultimo: lintXml.ultimo, antes: lintXml.ultimoAntes }).slice(0, 240));

    // volver al .java devuelve el diagnóstico de Java y retira las filas del XML
    const antesJava = await evaluar(`document.getElementById("diagnostico-vivo-estado").textContent.trim()`);
    await evaluar(`(async () => { marcarSucio(false); await abrir("/proyecto/xmlundo.java"); return true; })()`);
    // …y las filas del XML se van en cuanto corre el diagnóstico del `.java`, sin esperar al check
    // (~1,6 s): se mira el primer instante en que el estado deja de decir XML (hallazgo H2).
    const enVuelo = await evaluar(`(async () => {
      const t0 = Date.now();
      const leer = () => ({
        estado: document.getElementById("diagnostico-vivo-estado").textContent.trim(),
        xml: document.querySelectorAll('#diagnostico-vivo-lista .origen-error[data-origen="XML"]').length,
        marcas: document.querySelectorAll('#diagnostico-marcas .marca-error').length
      });
      let visto = null;
      while (Date.now() - t0 < 15000) {
        const ahora = leer();
        if (!/XML/.test(ahora.estado)) return Object.assign(ahora, { ms: Date.now() - t0 });
        visto = ahora;
        await new Promise((ok) => setTimeout(ok, 30));
      }
      return Object.assign(visto || leer(), { ms: Date.now() - t0, sinCambio: true });
    })()`);
    comprueba("al cambiar a .java las filas XML desaparecen sin esperar al check",
      enVuelo.xml === 0 && enVuelo.marcas === 0 && !/XML/.test(String(enVuelo.estado)) &&
      enVuelo.ms < 2000,
      JSON.stringify(enVuelo).slice(0, 260));
    const estadoJava = await esperarResumen(30000, antesJava);
    const trasJava = await evaluar(`({
      estado: document.getElementById("diagnostico-vivo-estado").textContent,
      xml: document.querySelectorAll('#diagnostico-vivo-lista .origen-error[data-origen="XML"]').length,
      java: document.querySelectorAll('#diagnostico-vivo-lista .origen-error[data-origen="Java"]').length,
      marcas: document.querySelectorAll('#diagnostico-marcas .marca-error').length
    })`);
    comprueba("al pasar a .java el error XML desaparece y vuelve el diagnóstico de Java",
      estadoJava && /\bJava\b/.test(String(estadoJava.estado)) && trasJava.xml === 0 &&
      /\bJava\b/.test(String(trasJava.estado)) && trasJava.marcas === 0,
      JSON.stringify({ estadoJava, trasJava }).slice(0, 300));

    // y al volver al .xml, los errores XML vuelven con su etiqueta. El fichero estaba limpio en
    // OPFS (el buffer roto no se guardó), así que se vuelve a escribir el `@string` que falta.
    const antesXml = await evaluar(`document.getElementById("diagnostico-vivo-estado").textContent.trim()`);
    await evaluar(`(async () => {
      marcarSucio(false);
      await abrir("/proyecto/res/layout/xmlauto.xml");
      const area = document.getElementById("codigo");
      EDITOR.poner('<LinearLayout>\\n  <TextView android:text="@string/noexiste"/>\\n</LinearLayout>\\n');
      area.focus();
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const estadoXml = await esperarResumen(30000, antesXml);
    const trasXml = await evaluar(`({
      estado: document.getElementById("diagnostico-vivo-estado").textContent,
      xml: document.querySelectorAll('#diagnostico-vivo-lista .origen-error[data-origen="XML"]').length
    })`);
    comprueba("al volver al .xml el error del linter reaparece etiquetado XML",
      estadoXml && /XML/.test(String(estadoXml.estado)) && trasXml.xml >= 1 &&
      !/Java/.test(String(trasXml.estado)),
      JSON.stringify({ estadoXml, trasXml }).slice(0, 240));

    // 12a-septies-bis. el canvas no rotula los nodos: sobre el Button no se pinta `Button` ni
    // `id/pulsar`, solo su texto. Se mide la tinta del nodo con texto y sin él; el rótulo viejo
    // dejaba tinta aun sin texto. El tipo y el id siguen accesibles en `data-nodos` y en el modelo.
    const rotuloSegundo = await evaluar(`(async () => {
      const vp = await import("/vista-previa.js");
      const modelo = (texto) => ({ layout: "res/layout/main.xml",
        pantalla: { ancho: 360, alto: 640 }, aproximado: true,
        raiz: { tipo: "LinearLayout", rect: { x: 0, y: 0, ancho: 360, alto: 640 }, hijos: [
          { tipo: "Button", id: "id/pulsar", texto, rect: { x: 0, y: 0, ancho: 200, alto: 48 } }] } });
      const medir = (texto) => {
        const canvas = document.createElement("canvas");
        const pintado = vp.pintarModelo(canvas, modelo(texto), { ancho: 270, alto: 480 });
        const ctx = canvas.getContext("2d");
        const nodo = vp.rectsEscalados(modelo(texto), 270, 480)[1];
        const dpr = canvas.width / 270;
        const margen = 3 * dpr;
        const x = Math.max(0, Math.round(nodo.x * dpr + margen));
        const y = Math.max(0, Math.round(nodo.y * dpr + margen));
        const ancho = Math.max(1, Math.round(nodo.ancho * dpr - 2 * margen));
        const alto = Math.max(1, Math.round(nodo.alto * dpr - 2 * margen));
        const datos = ctx.getImageData(x, y, ancho, alto).data;
        const cuenta = new Map();
        for (let i = 0; i < datos.length; i += 4) {
          const clave = datos[i] + "," + datos[i + 1] + "," + datos[i + 2];
          cuenta.set(clave, (cuenta.get(clave) || 0) + 1);
        }
        let fondo = [0, 0, 0], maximo = -1;
        for (const [clave, n] of cuenta) {
          if (n > maximo) { maximo = n; fondo = clave.split(",").map(Number); }
        }
        let tinta = 0;
        for (let i = 0; i < datos.length; i += 4) {
          const d = Math.abs(datos[i] - fondo[0]) + Math.abs(datos[i + 1] - fondo[1]) + Math.abs(datos[i + 2] - fondo[2]);
          if (d > 40) tinta++;
        }
        return { tinta, resumen: pintado.resumen, dato: canvas.dataset.nodos || "", texto: nodo.texto,
          alto: Math.round(nodo.alto) };
      };
      return { conTexto: medir("Press me"), sinTexto: medir("") };
    })()`);
    comprueba("sobre el Button no se pinta el rótulo «Button · id/pulsar» y sí su texto",
      rotuloSegundo.sinTexto.tinta === 0 && rotuloSegundo.conTexto.tinta > 20 &&
      rotuloSegundo.conTexto.alto >= 30 && rotuloSegundo.conTexto.texto === "Press me" &&
      /Button · id\/pulsar/.test(String(rotuloSegundo.conTexto.dato)) &&
      /Button · id\/pulsar/.test(String(rotuloSegundo.conTexto.resumen)),
      JSON.stringify({ sinTexto: rotuloSegundo.sinTexto.tinta, conTexto: rotuloSegundo.conTexto.tinta,
        dato: rotuloSegundo.conTexto.dato }).slice(0, 260));

    // limpieza: los recursos y el fuente de la prueba no se quedan en el proyecto que compilan
    await evaluar(`(async () => {
      marcarSucio(false);
      await hospedador.limpiar("/proyecto/xmlundo.java");
      await hospedador.limpiar("/proyecto/res/layout/xmlauto.xml");
      await hospedador.limpiar("/proyecto/res/values/xmlauto.xml");
      return true;
    })()`);

    // limpieza: los recursos y el fuente de la prueba no se quedan en el proyecto que compilan
    await evaluar(`(async () => {
      marcarSucio(false);
      await hospedador.limpiar("/proyecto/Auto.java");
      await hospedador.limpiar("/proyecto/res/layout/auto.xml");
      await hospedador.limpiar("/proyecto/res/values/auto.xml");
      await abrir("/proyecto/vivo.java");
      EDITOR.poner("package p;\\npublic class Vivo {}\\n");
      marcarSucio(false);
      return true;
    })()`);

    // 12b. compilar debug no pide keystore: genera la clave típica en OPFS y firma con ella.
    const debug = await evaluar(`(async () => {
      await hospedador.limpiar("/sdk/debug.keystore");
      await hospedador.limpiar("/sdk/release.keystore");
      document.getElementById("storepass-compilar").value = "";
      await compilarDebug();
      const ks = await hospedador.bytes("/sdk/debug.keystore");
      const apk = await hospedador.bytes("/proyecto/build/app.apk");
      return { ks: ks ? ks.length : 0, apk: apk ? apk.length : 0,
        codigo: document.getElementById("ultimo-codigo").textContent,
        consola: String(document.getElementById("consola-pestana").textContent).slice(-1400),
        veredicto: document.getElementById("estado-verificacion").textContent };
    })()`);
    comprueba("compilar debug crea la clave típica y firma sin keystore de release",
      debug.ks > 1000 && debug.apk > 5000 && debug.codigo === "0" &&
      /certificado Android Debug/.test(debug.consola),
      JSON.stringify({ ks: debug.ks, apk: debug.apk, codigo: debug.codigo, veredicto: debug.veredicto }).slice(0, 300));

    // 12c. `--inc` en la pestaña (I1 de docs/plan-incremental-web.md): la compilación que pide la
    // página lo lleva, la segunda pasada de la misma pestaña no vuelve a enlazar recursos y el apk
    // sale igual entrada por entrada que un build completo del mismo árbol. Las dos compilaciones
    // seguidas se miden con el reloj de la página y con el `total` que imprime apkc.
    const incremento = await evaluar(`(async () => {
      const foto = async () => {
        const bytes = await hospedador.bytes("/proyecto/build/app.apk");
        const entradas = await leerZip(bytes);
        const salida = [];
        for (const e of entradas) {
          if (e.dir) { salida.push([e.ruta, "dir"]); continue; }
          const d = new Uint8Array(await crypto.subtle.digest("SHA-256", e.datos));
          salida.push([e.ruta, Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")]);
        }
        return salida;
      };
      const distintas = (a, b) => {
        const malas = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const x = a[i], y = b[i];
          if (!x || !y || x[0] !== y[0] || x[1] !== y[1]) malas.push(x ? x[0] : (y ? y[0] : "?"));
        }
        return malas;
      };
      const totalApkc = (consola) => {
        const m = String(consola || "").match(/\\[timing\\][^\\n]*?\\btotal\\s+([0-9.]+)(ms|s)/);
        if (!m) return null;
        return m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
      };
      const enlaza = (consola) => /linking resources with the Go linker/.test(String(consola || ""));
      const etapa = (consola, nombre) => {
        const m = String(consola || "").match(new RegExp("\\\\[timing\\\\][^\\\\n]*?" + nombre + "\\\\s+([0-9.]+)(ms|s)"));
        if (!m) return 0;
        return m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
      };
      const k = await asegurarDebugKeystore();
      await hospedador.cwd("/proyecto");
      const marca = String(document.getElementById("consola-pestana").textContent).length;

      // a) el apk de referencia: build completo, sin --inc, sobre el árbol limpio
      await correr(["clean"]);
      const completo = await compilarCon(k, "debug", { incremental: false });
      const eCompleto = await foto();

      // b) el mismo árbol limpio, con --inc: tiene que dar las mismas entradas
      await correr(["clean"]);
      const reloj1 = performance.now();
      const frio = await compilarCon(k, "debug");
      const frioReloj = performance.now() - reloj1;
      const eFrio = await foto();

      // c) dos compilaciones seguidas en la misma pestaña: la segunda no tiene nada que enlazar
      const reloj2 = performance.now();
      const caliente = await compilarCon(k, "debug");
      const calienteReloj = performance.now() - reloj2;
      const eCaliente = await foto();

      // d) con un fuente editado el enlace sigue sin correr y el dex cambia; el apk resultante se
      //    compara con el de un build completo del mismo árbol editado
      const arbol = await hospedador.arbol();
      const ruta = (arbol.nodos || []).map((n) => n.ruta || "").find((r) => /^\\/proyecto\\/src\\/.+\\.java$/.test(r));
      const antes = await hospedador.texto(ruta);
      await hospedador.escribir(ruta, new TextEncoder().encode(antes +
        "\\nclass IncrementalProbe { static int n() { return 41; } }\\n"));
      const editado = await compilarCon(k, "debug");
      const eEditado = await foto();
      await correr(["clean"]);
      const completoEditado = await compilarCon(k, "debug", { incremental: false });
      const eCompletoEditado = await foto();
      await hospedador.escribir(ruta, new TextEncoder().encode(antes));

      // f) y un recurso NUEVO con estado previo: el caso que se colaba. Con el enlazador de Go no
      // hay flats que compilar y el incremental solo miraba los borrados, así que una cadena nueva
      // dejaba el apk anterior tal cual y sin la cadena en resources.arsc. Se prueba al final
      // porque borrar el fichero después sí es un cambio que tiene que reenlazar, y ensuciaría la
      // comprobación de que un fuente editado no relinka.
      const valorRecurso = "CRITICO_RECURSO_7391";
      const tibio = await compilarCon(k, "debug");
      const eTibio = await foto();
      await hospedador.escribir("/proyecto/res/values/critico.xml", new TextEncoder().encode(
        "<resources>\\n    <string name=\\"critico\\">" + valorRecurso + "</string>\\n</resources>\\n"));
      const conRecurso = await compilarCon(k, "debug");
      const eRecurso = await foto();
      const arsc = await hospedador.bytes("/proyecto/build/resources.arsc");
      const buscaBytes = (bytes, aguja) => {
        if (!bytes) return false;
        for (let i = 0; i + aguja.length <= bytes.length; i++) {
          let j = 0;
          while (j < aguja.length && bytes[i + j] === aguja[j]) j++;
          if (j === aguja.length) return true;
        }
        return false;
      };
      const arscTieneRecurso = buscaBytes(arsc, new TextEncoder().encode(valorRecurso));
      await hospedador.limpiar("/proyecto/res/values/critico.xml");
      await correr(["clean"]);

      const nuevas = String(document.getElementById("consola-pestana").textContent).slice(marca)
        .split("\\n").map((l) => l.trim()).filter((l) => l.startsWith("$ apkc build"));
      const dex = (e) => (e.find((x) => x[0] === "classes.dex") || [])[1];
      return {
        ruta, entradasCompleto: eCompleto.length, entradasFrio: eFrio.length,
        entradasCaliente: eCaliente.length, entradasEditado: eEditado.length,
        entradasCompletoEditado: eCompletoEditado.length,
        distintasCompleto: distintas(eCompleto, eFrio),
        distintasCaliente: distintas(eFrio, eCaliente),
        distintasEditado: distintas(eCompletoEditado, eEditado),
        dexCambia: dex(eFrio) !== dex(eEditado),
        enlazaCompleto: enlaza(completo.consola), enlazaFrio: enlaza(frio.consola),
        enlazaCaliente: enlaza(caliente.consola), enlazaEditado: enlaza(editado.consola),
        enlazaTibio: enlaza(tibio.consola), enlazaRecurso: enlaza(conRecurso.consola), arscTieneRecurso,
        distintasRecurso: distintas(eTibio, eRecurso), entradasRecurso: eRecurso.length,
        codigos: [completo, frio, caliente, editado, completoEditado].map((r) => r && r.codigo),
        totalFrio: totalApkc(frio.consola), totalCaliente: totalApkc(caliente.consola),
        totalCompleto: totalApkc(completo.consola),
        compileFrio: etapa(frio.consola, "compile go"), dexFrio: etapa(frio.consola, "dex go"),
        compileCaliente: etapa(caliente.consola, "compile go"),
        dexCaliente: etapa(caliente.consola, "dex go"),
        compileCompleto: etapa(completo.consola, "compile go"),
        dexCompleto: etapa(completo.consola, "dex go"),
        compileEditado: etapa(editado.consola, "compile go"),
        frioReloj, calienteReloj, ordenes: nuevas,
      };
    })()`);

    const conInc = incremento.ordenes.filter((o) => o.includes("--inc")).length;
    const sinInc = incremento.ordenes.filter((o) => !o.includes("--inc")).length;
    comprueba("la pestaña compila con --inc y la prueba sigue pudiendo pedir el build completo",
      conInc === 5 && sinInc === 2 && incremento.codigos.every((c) => c === 0),
      JSON.stringify({ ordenes: incremento.ordenes, codigos: incremento.codigos }).slice(0, 320));
    comprueba("el apk con --inc es igual entrada por entrada al de un build completo",
      incremento.entradasFrio > 5 && incremento.entradasFrio === incremento.entradasCompleto &&
      incremento.distintasCompleto.length === 0,
      JSON.stringify({ entradas: incremento.entradasFrio, distintas: incremento.distintasCompleto }).slice(0, 240));
    comprueba("la segunda compilación en la misma pestaña no vuelve a enlazar recursos",
      incremento.enlazaFrio && !incremento.enlazaCaliente &&
      incremento.entradasCaliente === incremento.entradasFrio &&
      incremento.distintasCaliente.length === 0,
      JSON.stringify({ enlazaFrio: incremento.enlazaFrio, enlazaCaliente: incremento.enlazaCaliente,
        distintas: incremento.distintasCaliente }).slice(0, 240));
    comprueba("un recurso nuevo con --inc reenlaza y su cadena llega a resources.arsc",
      incremento.enlazaRecurso && incremento.arscTieneRecurso &&
      incremento.distintasRecurso.length > 0 &&
      incremento.entradasRecurso === incremento.entradasFrio,
      JSON.stringify({ enlazaTibio: incremento.enlazaTibio, enlazaRecurso: incremento.enlazaRecurso,
        arscTiene: incremento.arscTieneRecurso,
        entradasDistintas: incremento.distintasRecurso }).slice(0, 260));
    const porApkc = incremento.totalFrio && incremento.totalCaliente
      ? Math.round((1 - incremento.totalCaliente / incremento.totalFrio) * 100) : null;
    const porCompleto = incremento.totalCompleto && incremento.totalCaliente
      ? Math.round((1 - incremento.totalCaliente / incremento.totalCompleto) * 100) : null;
    const porReloj = Math.round((1 - incremento.calienteReloj / incremento.frioReloj) * 100);
    comprueba("la segunda pasada no es más lenta que la primera en la misma pestaña",
      incremento.calienteReloj <= incremento.frioReloj * 1.1,
      JSON.stringify({ totalApkcFrio: incremento.totalFrio, totalApkcCaliente: incremento.totalCaliente,
        ahorroPorApkc: porApkc === null ? "sin total" : porApkc + " %",
        totalApkcCompleto: incremento.totalCompleto,
        ahorroFrenteAlCompleto: porCompleto === null ? "sin total" : porCompleto + " %",
        compileGoFrio: incremento.compileFrio, compileGoCaliente: incremento.compileCaliente,
        compileGoCompleto: incremento.compileCompleto,
        dexGoFrio: incremento.dexFrio, dexGoCaliente: incremento.dexCaliente,
        dexGoCompleto: incremento.dexCompleto,
        relojFrio: Math.round(incremento.frioReloj), relojCaliente: Math.round(incremento.calienteReloj),
        ahorroPorReloj: porReloj + " %" }).slice(0, 500));
    comprueba("con un fuente editado el build con --inc no reenlaza y el dex cambia",
      incremento.enlazaFrio && !incremento.enlazaEditado && incremento.dexCambia,
      JSON.stringify({ enlazaEditado: incremento.enlazaEditado, dexCambia: incremento.dexCambia }).slice(0, 200));
    comprueba("el apk incremental tras editar un fuente es igual entrada por entrada al completo",
      incremento.entradasEditado === incremento.entradasCompletoEditado &&
      incremento.distintasEditado.length === 0,
      JSON.stringify({ entradas: incremento.entradasEditado, distintas: incremento.distintasEditado }).slice(0, 240));
  } else {
    console.log("  --- sin ANDROID_JAR en el entorno: no se prueba el build completo en la pestaña");
  }


  // 13. la página servida de forma estática: el paquete oficial de Google es un .zip con
  // android-34/android.jar dentro; el editor lo extrae al elegirlo, sin unzip externo.
  const paquete = await evaluar(`(async () => {
    const interior = "PK" + "x".repeat(2048);
    const zip = makeZip([["android-34/android.jar", interior]]);
    const dt = new DataTransfer();
    dt.items.add(new File([zip], "platform-34.zip", { type: "application/zip" }));
    document.getElementById("android-jar").files = dt.files;
    await usarJarElegido();
    const jar = await hospedador.bytes("/sdk/android.jar");
    return { largo: jar ? jar.length : 0, cabecera: jar ? String.fromCharCode(jar[0], jar[1]) : "",
      aviso: document.getElementById("estado-jar").textContent };
  })()`);
  comprueba("el .zip oficial se descomprime y deja el android.jar",
    paquete.largo === 2050 && paquete.cabecera === "PK", JSON.stringify(paquete));

  const terminos = await evaluar(`(() => {
    document.getElementById("abrir-dialogo-sdk").click();
    const dialogo = document.getElementById("dialogo-sdk");
    const enlace = document.getElementById("sdk-terminos");
    const acuse = document.getElementById("sdk-entiendo");
    const abierto = dialogo.open === true;
    const bloqueado = enlace.getAttribute("aria-disabled") === "true";
    acuse.checked = true; acuse.dispatchEvent(new Event("change", { bubbles: true }));
    const habilitado = enlace.getAttribute("aria-disabled") === "false";
    acuse.checked = false; acuse.dispatchEvent(new Event("change", { bubbles: true }));
    const otraVez = enlace.getAttribute("aria-disabled") === "true";
    document.getElementById("sdk-cerrar").click();
    return {
      abierto, bloqueado, habilitado, otraVez,
      terminos: enlace.href,
      descarga: document.getElementById("sdk-descarga").href,
    };
  })()`);
  comprueba("el diálogo del SDK exige acuse y enlaza a Google",
    terminos.abierto === true && terminos.bloqueado === true &&
    terminos.habilitado === true && terminos.otraVez === true &&
    /^https:\/\/developer\.android\.com\/studio\/terms/.test(terminos.terminos) &&
    /^https:\/\/dl\.google\.com\//.test(terminos.descarga), JSON.stringify(terminos));

  // 14. crear una clave de release en la pestaña, descargarla y marcarla como lista
  const clave = await evaluar(`(async () => {
    await hospedador.limpiar("/sdk/release.keystore");
    await decirEstadoClave();
    document.getElementById("crear-clave-release").click();
    const poner = (id, valor) => {
      const campo = document.getElementById(id);
      campo.value = valor;
      campo.dispatchEvent(new Event("input", { bubbles: true }));
    };
    poner("clave-alias", "clave-navegador");
    poner("clave-cn", "Clave de navegador");
    poner("clave-org", "apkc studio");
    poner("clave-pais", "ES");
    poner("clave-pass", "clave-segura-123");
    poner("clave-pass2", "clave-segura-123");
    const aviso = document.getElementById("clave-aviso");
    aviso.checked = true;
    aviso.dispatchEvent(new Event("change", { bubbles: true }));
    const generar = document.getElementById("clave-generar");
    const habilitado = generar.disabled === false;
    generar.click();
    for (let i = 0; i < 240; i++) {
      if (!document.getElementById("clave-paso-listo").hidden) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    const bytes = await hospedador.bytes("/sdk/release.keystore");
    const listo = document.getElementById("clave-paso-listo");
    const detalle = document.getElementById("detalle-release");
    const cerrar = document.getElementById("clave-terminar");
    const resultado = {
      habilitado,
      creada: !listo.hidden,
      bytes: bytes ? bytes.length : 0,
      descarga: document.getElementById("clave-descargar").download,
      blob: /^blob:/.test(document.getElementById("clave-descargar").href),
      seccionLista: detalle.classList.contains("jar-listo"),
      badge: !document.getElementById("clave-badge").hidden,
      boton: document.getElementById("crear-clave-release").textContent,
      cerrarDeshabilitado: cerrar.disabled,
      pass: document.getElementById("storepass-compilar").value,
    };
    const guardada = document.getElementById("clave-guardada");
    guardada.checked = true;
    guardada.dispatchEvent(new Event("change", { bubbles: true }));
    resultado.cerrarHabilitado = cerrar.disabled === false;
    cerrar.click();
    resultado.cerrado = document.getElementById("dialogo-clave").open === false;
    return resultado;
  })()`);
  comprueba("se crea una clave de release y se ofrece para descargar",
    clave.habilitado === true && clave.creada === true && clave.bytes > 1000 &&
    clave.descarga === "clave-navegador.jks" && clave.blob === true && clave.pass === "clave-segura-123",
    JSON.stringify(clave));
  comprueba("la clave creada deja la sección lista y exige confirmar que se guardó",
    clave.seccionLista === true && clave.badge === true &&
    /Cambiar clave de release/.test(clave.boton) &&
    clave.cerrarDeshabilitado === true && clave.cerrarHabilitado === true && clave.cerrado === true,
    JSON.stringify({ seccion: clave.seccionLista, badge: clave.badge, boton: clave.boton,
      antes: clave.cerrarDeshabilitado, despues: clave.cerrarHabilitado, cerrado: clave.cerrado }));
  const claveValida = await evaluar(`(async () => {
    const r = await correr(["keystore", "--keystore", "/sdk/release.keystore",
      "--storepass", "clave-segura-123"]);
    return { codigo: r.codigo, consola: String(r.consola || "") };
  })()`);
  comprueba("la clave generada se puede inspeccionar con apkc",
    claveValida.codigo === 0 && /clave-navegador/.test(claveValida.consola),
    JSON.stringify(claveValida).slice(0, 240));

  // 15. recarga sin red: el service worker sirve el shell y conserva el aislamiento
  const sw = await evaluar(`(async () => {
    if (!("serviceWorker" in navigator)) return { ok: false, motivo: "sin serviceWorker" };
    const listo = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((ok) => setTimeout(() => ok(false), 5000)),
    ]);
    return { ok: listo, controlado: !!navigator.serviceWorker.controller };
  })()`);
  comprueba("el service worker queda listo", sw.ok === true, JSON.stringify(sw));
  if (sw.ok) {
    await exec("Network.emulateNetworkConditions", {
      offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    // con la red cortada pero la página viva: el módulo de la vista previa tiene que salir de la
    // caché del SW y el último modelo (en memoria) tiene que repintarse al entrar en la vista.
    const sinRed = await evaluar(`(async () => {
      const r = await fetch("/vista-previa.js");
      const texto = await r.text();
      document.querySelector('nav.actividad [data-vista="vista"]').click();
      const canvas = document.getElementById("vista-previa");
      const ctx = canvas.getContext("2d");
      const datos = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colores = new Set();
      for (let i = 0; i < datos.length; i += 4) colores.add(datos[i] + "," + datos[i + 1] + "," + datos[i + 2]);
      return {
        ok: r.ok, bytes: texto.length, modulo: texto.includes("modeloDeSalida"),
        cuerpo: document.body.dataset.vista,
        estado: document.getElementById("vista-previa-estado").textContent,
        colores: colores.size, ancho: canvas.width,
      };
    })()`);
    comprueba("sin red, vista-previa.js se sirve de la caché del service worker",
      sinRed.ok === true && sinRed.bytes > 1000 && sinRed.modulo === true,
      JSON.stringify(sinRed).slice(0, 240));
    comprueba("sin red, entrar en Vista repinta el último modelo en el canvas",
      sinRed.cuerpo === "vista" && sinRed.ancho > 0 && sinRed.colores > 3 &&
      /nodos/.test(String(sinRed.estado)),
      JSON.stringify(sinRed).slice(0, 240));
    await exec("Page.navigate", { url: URL_PAGINA });
    let offline = null;
    for (let i = 0; i < 50; i++) {
      try {
        offline = await evaluar(`({
          listo: typeof abrir === "function" && !!document.getElementById("codigo"),
          aislada: crossOriginIsolated,
          controlado: !!navigator.serviceWorker.controller,
        })`);
        if (offline.listo) break;
      } catch (e) { /* aún carga */ }
      await esperar(300);
    }
    comprueba("la página recarga sin red con el service worker",
      offline && offline.listo === true, JSON.stringify(offline));
    comprueba("la recarga offline conserva crossOriginIsolated",
      offline && offline.aislada === true, JSON.stringify(offline));
    // sin red y tras recargar, la cadena main.js → vistas.js → vista-previa.js tiene que cargar
    // entera desde el SW: si faltara el módulo, vistas.js no evaluaría y la vista no abriría.
    const trasOffline = await evaluar(`(() => {
      document.querySelector('nav.actividad [data-vista="vista"]').click();
      return {
        cuerpo: document.body.dataset.vista,
        activa: document.getElementById("vista").classList.contains("activa"),
        estado: document.getElementById("vista-previa-estado").textContent,
        canvas: !!document.getElementById("vista-previa"),
        logLista: document.getElementById("previa-log-lista").children.length,
        logVacio: !document.getElementById("previa-log-vacio").hidden,
        logTexto: document.getElementById("previa-log-vacio").textContent,
      };
    })()`);
    comprueba("sin red, la página recargada carga vista-previa.js y la vista responde",
      trasOffline.cuerpo === "vista" && trasOffline.activa === true && trasOffline.canvas === true &&
      /[Cc]ompila/.test(String(trasOffline.estado)),
      JSON.stringify(trasOffline).slice(0, 240));
    comprueba("al recargar, la consola de la ejecución arranca vacía y con su motivo",
      trasOffline.logLista === 0 && trasOffline.logVacio === true &&
      /[Cc]ompila/.test(String(trasOffline.logTexto)),
      JSON.stringify({ lista: trasOffline.logLista, vacio: trasOffline.logVacio,
        texto: String(trasOffline.logTexto).slice(0, 140) }));
    await exec("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
  }

  // 30. dependencias: importa un paquete estático del propio origen. `peticiones` es lo que ve el
  //     navegador: aquí no puede aparecer ni Maven, ni un proxy, ni un CDN. El índice y el
  //     artefacto falsos los sirve `servidor.js` desde una copia de studio (ver el arranque).
  {
    const esDeDeps = (u) => {
      try {
        const x = new URL(u);
        return x.pathname === "/deps-index.json" || x.pathname.startsWith("/deps/");
      } catch (e) { return false; }
    };
    const cuantasDeps = () => peticiones.filter(esDeDeps).length;
    const antesDeps = cuantasDeps();
    comprueba("la carga y las compilaciones no leen el paquete de dependencias",
      antesDeps === 0, antesDeps + " peticiones al índice o a /deps/ antes de esta sección");

    // abrir la pestaña tampoco pide nada: el panel solo engancha el botón
    const antesAbrir = peticiones.length;
    const abierta = await evaluar(`(() => {
      mostrarPanel("deps");
      return {
        activa: document.getElementById("panel-deps").classList.contains("activa"),
        estado: document.getElementById("deps-estado").textContent,
        plegado: document.getElementById("deps-resultado").hidden,
        coordenada: document.getElementById("deps-coordenada").value,
      };
    })()`);
    comprueba("la pestaña Dependencias se abre vacía y sin pedir nada",
      abierta.activa === true && abierta.plegado === true &&
      /sin resolver/.test(String(abierta.estado)) &&
      abierta.coordenada === "com.google.code.gson:gson:2.10.1" &&
      peticiones.length === antesAbrir,
      JSON.stringify(abierta) + " | " + (peticiones.length - antesAbrir) + " peticiones al abrir");

    // un clic importa el artefacto del índice falso y lo deja en OPFS bajo /deps/
    const antesResolver = peticiones.length;
    await evaluar(`(() => {
      document.getElementById("deps-coordenada").value = ${JSON.stringify(coordFalsa)};
      document.getElementById("deps-resolver").click();
      return true;
    })()`);
    let resuelto = null;
    for (let i = 0; i < 120; i++) {
      resuelto = await evaluar(`(() => ({
        estado: document.getElementById("deps-estado").textContent,
        nombre: document.getElementById("deps-nombre").textContent,
        bytes: document.getElementById("deps-bytes").textContent,
        hash: document.getElementById("deps-hash").textContent,
        ruta: document.getElementById("deps-ruta").textContent,
        indice: document.getElementById("deps-indice").textContent,
        visible: !document.getElementById("deps-resultado").hidden,
      }))()`);
      if (/^(listo|error)/.test(String(resuelto.estado))) break;
      await esperar(500);
    }
    const delResolver = peticiones.slice(antesResolver);
    const rutasResolver = delResolver.map((u) => { try { return new URL(u).pathname; } catch (e) { return u; } });
    comprueba("Resolver lee solo el índice y su fichero, los dos del mismo origen",
      delResolver.length === 2 &&
      rutasResolver[0] === "/deps-index.json" &&
      rutasResolver[1] === "/deps/com.example/prueba/1.0/prueba-1.0.jar" &&
      delResolver.every((u) => u.startsWith("http://127.0.0.1:" + PUERTO)),
      rutasResolver.join(", ") || "sin peticiones");
    comprueba("el artefacto importado muestra nombre, tamaño y hash del índice",
      resuelto && resuelto.visible === true && resuelto.nombre === "prueba-1.0.jar" &&
      /2052 bytes/.test(String(resuelto.bytes)) && resuelto.hash === hashDepFalso &&
      resuelto.ruta === "/deps/com.example/prueba/1.0/prueba-1.0.jar" &&
      /2026-11-22/.test(String(resuelto.indice)),
      JSON.stringify(resuelto).slice(0, 360));

    // no basta con lo que pinta la página: los bytes de OPFS tienen que ser el artefacto
    const enOpfs = await evaluar(`(async () => {
      const b = await hospedador.bytes("/deps/com.example/prueba/1.0/prueba-1.0.jar");
      if (!b) return { bytes: 0 };
      const h = await crypto.subtle.digest("SHA-256", b);
      const descriptor = await hospedador.texto("/deps/com.example/prueba/1.0/deps.json");
      return {
        bytes: b.length,
        firma: String.fromCharCode(b[0], b[1], b[2], b[3]),
        hash: [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join(""),
        descriptor,
      };
    })()`);
    let descriptor = null;
    try { descriptor = JSON.parse(enOpfs.descriptor || "null"); } catch (e) { descriptor = null; }
    comprueba("los bytes guardados en OPFS son el artefacto con su descriptor",
      enOpfs.bytes === depFalso.length && enOpfs.firma === "PK\u0003\u0004" &&
      enOpfs.hash === hashDepFalso && descriptor && descriptor.sha256 === hashDepFalso &&
      descriptor.bytes === depFalso.length && descriptor.fichero === "deps/com.example/prueba/1.0/prueba-1.0.jar",
      JSON.stringify({ bytes: enOpfs.bytes, firma: enOpfs.firma, hash: enOpfs.hash,
        descriptor: descriptor && descriptor.coordenada }).slice(0, 360));

    // una coordenada que no está en el índice se dice, no se inventa
    await evaluar(`(() => {
      document.getElementById("deps-coordenada").value = "com.google.code.gson:gson:2.10.1";
      document.getElementById("deps-resolver").click();
      return true;
    })()`);
    let ausente = null;
    for (let i = 0; i < 60; i++) {
      ausente = await evaluar(`(() => ({
        estado: document.getElementById("deps-estado").textContent,
        visible: !document.getElementById("deps-resultado").hidden,
      }))()`);
      if (/^error/.test(String(ausente.estado))) break;
      await esperar(300);
    }
    comprueba("una coordenada ausente del índice se rechaza con el motivo, sin datos inventados",
      /^error/.test(String(ausente.estado)) && /no está en deps-index\.json/.test(String(ausente.estado)) &&
      ausente.visible === false, JSON.stringify(ausente).slice(0, 300));

    // y nada de esto ha sacado una petición del origen (el gate global lo repite al final)
    const ajenasDeps = peticiones.slice(antesDeps).filter((u) =>
      !u.startsWith("http://127.0.0.1:" + PUERTO) && !/^(?:data|blob):/.test(u));
    comprueba("la sección de dependencias no pide nada fuera del origen",
      ajenasDeps.length === 0, ajenasDeps.slice(0, 3).join(", ") || "cero peticiones ajenas");
  }

  // requisito del proyecto, escrito como comprobación: la pestaña no puede pedir nada fuera de
  // su origen. Ni un CDN de un runtime de terceros, ni telemetría, ni una fuente.
  const ajenas = peticiones.filter((u) => !u.startsWith("http://127.0.0.1:" + PUERTO) && !u.startsWith("data:") && !u.startsWith("blob:"));
  comprueba("la pestaña no pide nada fuera de su origen (" + peticiones.length + " peticiones)",
    ajenas.length === 0, ajenas.length ? "fuera del origen: " + ajenas.slice(0, 4).join(", ") : peticiones.length + " peticiones, todas locales");

  ws.close();
  console.log("\n" + hechos + " comprobaciones bien, " + fallos + " mal");
  apagar();
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error("FALLO la prueba de pestaña:", e && e.message || e);
  console.error(salidaNavegador.slice(-600));
  apagar();
  process.exit(1);
});
