// Sección de dependencias de apkc-studio. Tiene dos vías, y ninguna habla con Maven:
//
// 1. `deps-index.json` del propio origen (abajo, `resolverDependencia`): el workflow de GitHub
//    Actions (`.github/workflows/deps-maven.yml`) descarga los artefactos en el runner, calcula su
//    SHA-256 y publica el índice y los `.jar`/`.aar`/`.pom` como estáticos del sitio.
// 2. Importación local, sin red (más abajo): la persona elige `.jar`/`.aar` o suelta un `.zip` con
//    `jar/`, `lib/<abi>/` y `res/__deps/`, y los bytes van del disco a OPFS por las rutas que
//    `apkc` lee. Un `.aar` se abre aquí mismo y se reparte en esas tres carpetas.
//
// Por eso la página sigue con la regla 4 intacta: ni Maven, ni un proxy, ni un CDN. La única
// petición que hace este módulo —y solo cuando la persona pulsa «Resolver»— va a
// `.<origen>/deps-index.json` y a `.<origen>/deps/...`, que son ficheros del propio sitio. Si el
// índice no existe, se dice tal cual: no se inventan coordenadas, tamaños ni hashes.

import { leerZip } from "./proyecto.js";

export const RUTA_INDICE = "./deps-index.json";
const VERSION_INDICE = 1;
const EXTENSIONES = new Set(["jar", "aar", "pom"]);
const PARTE_SEGURA = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

// --- importación local (sin red) --------------------------------------------------------------
// La otra vía del panel: lo que la persona ya tiene en disco entra en el proyecto por las rutas
// que `apkc` lee —`jar/*.jar`, `lib/<abi>/*.so` y `res/__deps/<isla>/<tipo>/<archivo>`—, que son
// las mismas que deja `apkc-deps`. No hay fetch ni Maven: los bytes salen del selector de ficheros
// o de un arrastre y se escriben en OPFS. Un `.aar` se abre aquí mismo con `leerZip` (CRC y rutas
// seguras) y se reparte en esas tres carpetas.
export const RUTA_IMPORTADO = "/proyecto/deps.importado.json";
export const DESTINO_IMPORTADO = "/proyecto/";
// Las mismas cotas que `leerZip` aplica al zip del proyecto: un artefacto no puede traer un
// fichero de más de 64 MiB ni pasar de 256 MiB en total.
const MAX_ARTEFACTO = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const ABIS = new Set(["armeabi", "armeabi-v7a", "arm64-v8a", "x86", "x86_64", "mips", "mips64", "riscv64"]);
const ISLA = /^[0-9a-f]{8,40}$/;

// Una parte de la coordenada acaba en la ruta del índice y en la de OPFS: no puede llevar
// separadores, `..` ni nada que normalice fuera de `/deps/`.
function parteValida(parte) {
  return typeof parte === "string" && PARTE_SEGURA.test(parte) && !parte.includes("..");
}

// El `fichero` del índice es una ruta relativa al origen. Se exige que viva bajo `deps/` y que no
// pueda salirse de ahí (ni `..`, ni absolutas, ni `\`, ni query/fragmento que cambien el destino).
export function ficheroDelOrigenSeguro(fichero) {
  if (typeof fichero !== "string" || !fichero.startsWith("deps/")) return false;
  if (fichero.includes("\\") || /[?#]/.test(fichero) || fichero.includes("//")) return false;
  const partes = fichero.split("/");
  return partes.every((p) => p !== "" && p !== "." && p !== ".." && PARTE_SEGURA.test(p));
}

export function sha256Hex(bytes) {
  const datos = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return globalThis.crypto.subtle.digest("SHA-256", datos)
    .then((resumen) => [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

export function textoDeBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

// Valida una entrada del índice sin arreglarla: si falta un dato o está mal, se devuelve el
// motivo y el índice entero se rechaza. Un índice a medias no se completa a ojo.
export function validarEntrada(entrada) {
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) return "entrada vacía";
  for (const campo of ["coordenada", "grupo", "artefacto", "version", "extension"]) {
    if (typeof entrada[campo] !== "string" || !entrada[campo].trim()) return "falta " + campo;
  }
  if (!parteValida(entrada.grupo)) return "grupo no válido: " + JSON.stringify(entrada.grupo);
  if (!parteValida(entrada.artefacto)) return "artefacto no válido: " + JSON.stringify(entrada.artefacto);
  if (!parteValida(entrada.version)) return "versión no válida: " + JSON.stringify(entrada.version);
  if (!EXTENSIONES.has(entrada.extension)) return "extensión no admitida: " + entrada.extension;
  if (!ficheroDelOrigenSeguro(entrada.fichero)) return "fichero fuera de deps/: " + JSON.stringify(entrada.fichero);
  if (!Number.isInteger(entrada.bytes) || entrada.bytes <= 0) return "bytes no válidos: " + entrada.bytes;
  if (typeof entrada.sha256 !== "string" || !SHA256.test(entrada.sha256)) return "sha256 no válido";
  return "";
}

// Lee y valida `./deps-index.json`. Un 404 no es un fallo de red: es que el workflow todavía no
// publicó nada, y el mensaje lo dice con el comando que hay que ejecutar en GitHub.
export async function leerIndice({ fetchImpl, ruta } = {}) {
  const pedir = fetchImpl || globalThis.fetch;
  const destino = ruta || RUTA_INDICE;
  const respuesta = await pedir(destino, { cache: "no-store", credentials: "same-origin" });
  if (respuesta.status === 404) {
    throw new Error("no hay deps-index.json en este origen: ejecuta el workflow de dependencias " +
      "(Actions → deps-maven) con tus coordenadas y publica su artefacto; esta página no descarga de Maven");
  }
  if (!respuesta.ok) throw new Error("el índice respondió " + respuesta.status);
  const tipo = String(respuesta.headers.get("content-type") || "");
  if (/text\/html/i.test(tipo)) throw new Error("el origen devolvió HTML en vez del índice");
  let datos;
  try { datos = JSON.parse(await respuesta.text()); }
  catch (e) { throw new Error("deps-index.json no es JSON válido"); }
  if (!datos || datos.version !== VERSION_INDICE || !Array.isArray(datos.artefactos)) {
    throw new Error("deps-index.json no tiene version " + VERSION_INDICE + " y una lista de artefactos");
  }
  const artefactos = [];
  for (const entrada of datos.artefactos) {
    const problema = validarEntrada(entrada);
    if (problema) throw new Error("deps-index.json no válido: " + problema);
    artefactos.push(entrada);
  }
  return { version: datos.version, generado: String(datos.generado || ""), artefactos };
}

export function buscarArtefacto(indice, coordenada) {
  const buscada = String(coordenada == null ? "" : coordenada).trim();
  if (!buscada || !indice || !Array.isArray(indice.artefactos)) return null;
  return indice.artefactos.find((a) => a.coordenada === buscada) || null;
}

function nombreDeFichero(fichero) {
  return fichero.slice(fichero.lastIndexOf("/") + 1);
}

// Importa el artefacto pedido: lee el índice, lo busca, descarga el fichero del propio origen,
// comprueba tamaño y SHA-256 contra el índice y solo entonces escribe en OPFS bajo `/deps/`.
export async function resolverDependencia({ coord, hospedador, fetchImpl, rutaIndice, conBloqueo } = {}) {
  if (!hospedador || typeof hospedador.escribir !== "function") {
    throw new Error("no hay OPFS donde guardar el artefacto");
  }
  const pedir = fetchImpl || globalThis.fetch;
  const indice = await leerIndice({ fetchImpl: pedir, ruta: rutaIndice });
  const entrada = buscarArtefacto(indice, coord);
  if (!entrada) {
    const hay = indice.artefactos.slice(0, 6).map((a) => a.coordenada).join(", ");
    throw new Error("«" + String(coord || "").trim() + "» no está en deps-index.json" +
      (hay ? " (el índice tiene: " + hay + (indice.artefactos.length > 6 ? ", …" : "") + ")" : " (el índice está vacío)"));
  }
  const respuesta = await pedir("./" + entrada.fichero, { cache: "no-store", credentials: "same-origin" });
  if (!respuesta.ok) throw new Error("el artefacto respondió " + respuesta.status + ": " + entrada.fichero);
  const tipo = String(respuesta.headers.get("content-type") || "application/octet-stream");
  if (/text\/html/i.test(tipo)) throw new Error("el origen devolvió HTML, no el artefacto");
  const bytes = new Uint8Array(await respuesta.arrayBuffer());
  if (bytes.length !== entrada.bytes) {
    throw new Error("el tamaño no coincide con el índice: " + bytes.length + " y " + entrada.bytes);
  }
  const hash = await sha256Hex(bytes);
  if (hash !== entrada.sha256) {
    throw new Error("el sha256 no coincide con el índice: " + hash + " y " + entrada.sha256);
  }
  const nombre = nombreDeFichero(entrada.fichero);
  const ruta = "/deps/" + entrada.grupo + "/" + entrada.artefacto + "/" + entrada.version + "/" + nombre;
  const descriptor = {
    coordenada: entrada.coordenada, fichero: entrada.fichero, bytes: bytes.length,
    sha256: hash, tipo, indice: indice.generado || "sin fecha en el índice",
    fecha: new Date().toISOString(),
  };
  // El artefacto y su descriptor entran en OPFS con el mismo bloqueo que usan las ventanas del
  // editor: dos pestañas que resuelvan a la vez no pueden dejar un deps.json con los bytes de
  // otro artefacto, y la escritura no se cruza con un guardado del editor. Sin `conBloqueo`
  // (la prueba de node) se ejecuta igual, como en el resto del módulo.
  const bloquear = typeof conBloqueo === "function" ? conBloqueo : (tarea) => tarea();
  const escrito = await bloquear(async () => {
    const r = await hospedador.escribir(ruta, bytes);
    if (!r || r.tipo === "error") return r;
    await hospedador.escribir("/deps/" + entrada.grupo + "/" + entrada.artefacto + "/" +
      entrada.version + "/deps.json", new TextEncoder().encode(JSON.stringify(descriptor, null, 2)));
    return r;
  });
  if (!escrito || escrito.tipo === "error") {
    throw new Error("no se pudo guardar en OPFS: " + ((escrito && escrito.error) || "sin detalle"));
  }
  return {
    coordenada: entrada.coordenada, nombre, bytes: bytes.length, textoBytes: textoDeBytes(bytes.length),
    hash, ruta, fichero: entrada.fichero, indice: indice.generado || "", descriptor,
  };
}

// --- vía local: decidir qué escribe cada fichero, antes de tocar OPFS --------------------------

function fnv32(texto, semilla) {
  let h = semilla >>> 0;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Doce hex, como el `sha1(coord)[:12]` con el que `apkc-deps` nombra la isla de `res/__deps/`.
// Es síncrono y no verifica nada: solo da un nombre estable a la carpeta de recursos de un .aar.
export function hashCorto(texto) {
  const t = String(texto || "");
  const a = fnv32(t, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv32(t, 0x9e3779b9).toString(16).padStart(8, "0");
  return (a + b).slice(0, 12);
}

function tramosSeguros(ruta) {
  if (typeof ruta !== "string" || !ruta || ruta.startsWith("/") || ruta.includes("\\")) return null;
  const tramos = ruta.split("/");
  // `__deps` es la única carpeta que empieza por guion bajo: es el nombre fijo de la isla de
  // recursos que entiende `apkc-deps`, y no puede quedar fuera por la regla general.
  return tramos.every((t) => t === "__deps" || PARTE_SEGURA.test(t)) ? tramos : null;
}

// La ruta que un paquete (el .zip que exporta `apkc-deps`, o el proyecto que ya la tiene) puede
// aportar al proyecto. Todo lo demás se ignora: `src/`, `AndroidManifest.xml` o el `res/` propio
// no se pisan desde una importación de dependencias.
export function destinoDeRutaDePaquete(ruta) {
  const t = tramosSeguros(ruta);
  if (!t) return "";
  if (t.length === 2 && t[0] === "jar" && /\.jar$/.test(t[1])) return ruta;
  if (t.length === 3 && t[0] === "lib" && ABIS.has(t[1]) && /\.so$/.test(t[2])) return ruta;
  if (t.length === 5 && t[0] === "res" && t[1] === "__deps" && ISLA.test(t[2])) return ruta;
  return "";
}

export function tipoDeFichero(nombre) {
  const n = String(nombre || "").toLowerCase();
  if (n.endsWith(".zip")) return "zip";
  if (n.endsWith(".aar")) return "aar";
  if (n.endsWith(".jar")) return "jar";
  return "";
}

function nombreBase(nombre, extension) {
  const limpio = String(nombre || "").replace(new RegExp("\\" + extension + "$", "i"), "")
    .replace(/[^A-Za-z0-9._+-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return PARTE_SEGURA.test(limpio) ? limpio : "";
}

// Acumula el plan con las cotas de `leerZip`: ni un fichero de más de 64 MiB ni 256 MiB en total.
function acumulador() {
  const ficheros = [];
  let total = 0;
  return {
    ficheros,
    meter(ruta, datos, origen) {
      const bytes = datos instanceof Uint8Array ? datos : new Uint8Array(datos || []);
      if (bytes.length > MAX_ARTEFACTO) {
        throw new Error("el fichero " + (origen || ruta) + " pasa de 64 MB: no se importa");
      }
      total += bytes.length;
      if (total > MAX_TOTAL) throw new Error("la importación pasa la cota total de 256 MB");
      ficheros.push({ ruta, bytes, origen: origen || ruta });
    },
  };
}

// Un .zip con la forma que deja `apkc-deps`: `jar/*.jar`, `lib/<abi>/*.so` y
// `res/__deps/<isla>/<tipo>/<archivo>`. Las rutas ya vienen validadas y con CRC por `leerZip`.
export function planDePaquete(entradas) {
  if (!Array.isArray(entradas) || !entradas.length) throw new Error("el paquete está vacío");
  const acc = acumulador();
  let ignorados = 0;
  for (const entrada of entradas) {
    if (!entrada || entrada.dir || !entrada.datos) { ignorados++; continue; }
    const destino = destinoDeRutaDePaquete(entrada.ruta);
    if (!destino) { ignorados++; continue; }
    acc.meter(destino, entrada.datos, entrada.ruta);
  }
  if (!acc.ficheros.length) {
    throw new Error("el .zip no trae jar/*.jar, lib/<abi>/*.so ni " +
      "res/__deps/<isla>/<tipo>/<archivo>: nada que importar");
  }
  return { ficheros: acc.ficheros, ignorados };
}

// Un .aar se abre como zip y se reparte: `classes.jar` y `libs/*.jar` a `jar/`, `jni/<abi>/*.so`
// a `lib/<abi>/` y `res/**` a `res/__deps/<isla>/…`. El manifiesto, el R.txt y los META-INF se
// ignoran a propósito: su fusión no está en esta vía y no se inventa.
export function planDeAar(nombre, entradas) {
  const base = nombreBase(nombre, ".aar");
  if (!base) throw new Error("el nombre del .aar no sirve para nombrar el jar: " + JSON.stringify(nombre));
  if (!Array.isArray(entradas) || !entradas.length) throw new Error("el .aar " + nombre + " está vacío");
  const isla = hashCorto(base);
  const acc = acumulador();
  let ignorados = 0;
  for (const entrada of entradas) {
    if (!entrada || entrada.dir || !entrada.datos) { ignorados++; continue; }
    const ruta = String(entrada.ruta || "");
    if (ruta === "classes.jar") { acc.meter("jar/" + base + ".jar", entrada.datos, ruta); continue; }
    if (ruta.startsWith("libs/") && ruta.endsWith(".jar")) {
      const t = tramosSeguros(ruta);
      if (t && t.length === 2) {
        acc.meter("jar/" + base + "-" + t[1].slice(0, -4) + ".jar", entrada.datos, ruta);
        continue;
      }
    }
    if (ruta.startsWith("jni/") && ruta.endsWith(".so")) {
      const t = tramosSeguros(ruta);
      if (t && t.length === 3 && ABIS.has(t[1])) { acc.meter("lib/" + t[1] + "/" + t[2], entrada.datos, ruta); continue; }
    }
    if (ruta.startsWith("res/")) {
      const t = tramosSeguros(ruta);
      if (t && t.length >= 3) {
        acc.meter("res/__deps/" + isla + "/" + t.slice(1).join("/"), entrada.datos, ruta);
        continue;
      }
    }
    ignorados++;
  }
  if (!acc.ficheros.length) throw new Error("el .aar " + nombre + " no trae classes.jar, libs/*.jar, jni/ ni res/");
  return { ficheros: acc.ficheros, ignorados };
}

export function planDeJar(nombre, bytes) {
  const base = nombreBase(nombre, ".jar");
  if (!base) throw new Error("el nombre del .jar no sirve: " + JSON.stringify(nombre));
  const datos = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!datos.length) throw new Error("el .jar " + nombre + " está vacío");
  const acc = acumulador();
  acc.meter("jar/" + base + ".jar", datos, nombre);
  return { ficheros: acc.ficheros, ignorados: 0 };
}

// Une los planes de una selección: sin rutas repetidas (dos artefactos que se pisan es un error
// visible, no el último que gana) y en orden de ruta, que es el orden en el que se escribe.
export function unirPlanes(planes) {
  const ficheros = [];
  const vistas = new Set();
  let ignorados = 0;
  for (const plan of planes || []) {
    if (!plan) continue;
    ignorados += plan.ignorados || 0;
    for (const f of plan.ficheros || []) {
      if (vistas.has(f.ruta)) throw new Error("dos artefactos escribirían la misma ruta: " + f.ruta);
      vistas.add(f.ruta);
      ficheros.push(f);
    }
  }
  if (!ficheros.length) {
    throw new Error("no hay nada que importar: elige .jar/.aar o un .zip con jar/, lib/<abi>/ y res/__deps/");
  }
  let total = 0;
  for (const f of ficheros) {
    total += f.bytes.length;
    if (total > MAX_TOTAL) throw new Error("la importación pasa la cota total de 256 MB");
  }
  ficheros.sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0));
  return { ficheros, ignorados };
}

export function esFalloDeCuota(e) {
  const nombre = String((e && (e.name || e.code)) || "");
  const texto = String((e && e.message) || e || "");
  return /quota|QuotaExceeded|NS_ERROR_DOM_QUOTA_REACHED/i.test(nombre + " " + texto) ||
    (e && (e.code === 22 || e.code === 1014));
}

export function mensajeDeImportacion(e) {
  const base = String((e && e.message) || e || "fallo sin detalle");
  if (esFalloDeCuota(e)) {
    return "no cabe en la cuota de OPFS (" + base + "): libera espacio en el navegador o borra " +
      "dependencias que ya no uses y vuelve a importar; no se descarga nada";
  }
  return base;
}

// Escribe el plan en OPFS bajo `/proyecto/`. Los bytes ya están validados: aquí solo se comprueba
// si se pisan ficheros existentes (se pregunta), se calcula el sha256 de cada uno y se deja el
// registro en `deps.importado.json`. Todo dentro de `conBloqueo`, como el resto de escrituras.
export async function importarDependencias({ plan, hospedador, conBloqueo, alProgreso, confirmar } = {}) {
  if (!hospedador || typeof hospedador.escribir !== "function") {
    throw new Error("no hay OPFS donde guardar las dependencias");
  }
  const ficheros = Array.isArray(plan) ? plan : (plan && plan.ficheros);
  if (!Array.isArray(ficheros) || !ficheros.length) throw new Error("no hay nada que importar");
  const bloquear = typeof conBloqueo === "function" ? conBloqueo : (tarea) => tarea();
  const existentes = [];
  if (typeof hospedador.leer === "function") {
    for (const f of ficheros) {
      const leido = await hospedador.leer(DESTINO_IMPORTADO + f.ruta);
      if (leido && leido.bytes) existentes.push(DESTINO_IMPORTADO + f.ruta);
    }
  }
  if (existentes.length && typeof confirmar === "function" && !(await confirmar(existentes))) {
    throw new Error("importación cancelada: no se reemplazó nada");
  }
  const avisar = typeof alProgreso === "function" ? alProgreso : () => {};
  const rutas = [];
  const registro = [];
  let bytesTotales = 0;
  await bloquear(async () => {
    avisar({ hechos: 0, total: ficheros.length, ruta: "" });
    for (let i = 0; i < ficheros.length; i++) {
      const f = ficheros[i];
      const escrito = await hospedador.escribir(DESTINO_IMPORTADO + f.ruta, f.bytes);
      if (!escrito || escrito.tipo === "error") {
        throw new Error("no se pudo escribir " + f.ruta + ": " + ((escrito && escrito.error) || "sin detalle"));
      }
      const sha256 = await sha256Hex(f.bytes);
      registro.push({ ruta: f.ruta, bytes: f.bytes.length, sha256, origen: f.origen || "" });
      rutas.push(DESTINO_IMPORTADO + f.ruta);
      bytesTotales += f.bytes.length;
      avisar({ hechos: i + 1, total: ficheros.length, ruta: f.ruta });
    }
    const descriptor = new TextEncoder().encode(JSON.stringify({
      version: 1, generado: new Date().toISOString(), origen: "importación local, sin red",
      artefactos: registro,
    }, null, 2));
    const escrito = await hospedador.escribir(RUTA_IMPORTADO, descriptor);
    if (!escrito || escrito.tipo === "error") {
      throw new Error("no se pudo escribir " + RUTA_IMPORTADO + ": " + ((escrito && escrito.error) || "sin detalle"));
    }
  });
  return {
    rutas, bytes: bytesTotales, textoBytes: textoDeBytes(bytesTotales), ficheros: ficheros.length,
    descriptor: RUTA_IMPORTADO, existentes,
  };
}

// Engancha el panel. No pide nada al cargar: solo el clic en `#deps-resolver` (o Enter en el
// campo) llama a `resolverDependencia`. `ocupado` evita que un doble clic haga dos importaciones.
export function crearPanelDeps({ hospedador, conBloqueo, alImportar } = {}) {
  if (typeof document === "undefined") return null;
  const entrada = document.getElementById("deps-coordenada");
  const boton = document.getElementById("deps-resolver");
  const estado = document.getElementById("deps-estado");
  const caja = document.getElementById("deps-resultado");
  const nombre = document.getElementById("deps-nombre");
  const bytes = document.getElementById("deps-bytes");
  const hash = document.getElementById("deps-hash");
  const ruta = document.getElementById("deps-ruta");
  const origen = document.getElementById("deps-indice");
  const seleccion = document.getElementById("deps-ficheros");
  const zonaSoltar = document.getElementById("deps-soltar");
  const progreso = document.getElementById("deps-progreso");
  const estadoImportar = document.getElementById("deps-importar-estado");
  const importado = document.getElementById("deps-importado");
  const importadoFicheros = document.getElementById("deps-importado-ficheros");
  const importadoBytes = document.getElementById("deps-importado-bytes");
  const importadoDestino = document.getElementById("deps-importado-destino");
  const importadoDescriptor = document.getElementById("deps-importado-descriptor");
  if (!entrada || !boton || !estado || !caja) return null;

  let ocupado = false;
  const decir = (texto, clase) => {
    estado.textContent = texto;
    estado.classList.toggle("mal", clase === "mal");
    estado.classList.toggle("bien", clase === "bien");
  };
  const pintar = (r) => {
    if (nombre) nombre.textContent = r.nombre;
    if (bytes) bytes.textContent = r.textoBytes + " (" + r.bytes + " bytes)";
    if (hash) hash.textContent = r.hash;
    if (ruta) ruta.textContent = r.ruta;
    if (origen) origen.textContent = "índice: " + (r.indice || "sin fecha");
    caja.hidden = false;
  };
  const resolver = async () => {
    if (ocupado) return;
    ocupado = true;
    boton.disabled = true;
    entrada.disabled = true;
    caja.hidden = true;
    decir("buscando «" + entrada.value.trim() + "» en el índice…");
    try {
      const r = await resolverDependencia({ coord: entrada.value, hospedador, conBloqueo });
      pintar(r);
      decir("listo: importado desde el propio origen a " + r.ruta, "bien");
    } catch (e) {
      decir("error: " + (e && e.message ? e.message : e), "mal");
    } finally {
      ocupado = false;
      boton.disabled = false;
      entrada.disabled = false;
    }
  };
  boton.addEventListener("click", (evento) => {
    if (evento) evento.preventDefault();
    resolver();
  });
  entrada.addEventListener("keydown", (evento) => {
    if (evento.key !== "Enter" || evento.isComposing) return;
    evento.preventDefault();
    resolver();
  });

  // Vía local: los bytes salen del disco. Si el navegador no trae `DecompressionStream` o el
  // .zip está roto, el aviso lo dice y no se escribe nada.
  let importando = false;
  const decirImportar = (texto, clase) => {
    if (!estadoImportar) return;
    estadoImportar.textContent = texto;
    estadoImportar.classList.toggle("mal", clase === "mal");
    estadoImportar.classList.toggle("bien", clase === "bien");
  };
  const importar = async (archivos) => {
    if (importando) return;
    const lista = [...(archivos || [])];
    if (!lista.length) return;
    importando = true;
    if (seleccion) seleccion.disabled = true;
    if (importado) importado.hidden = true;
    if (progreso) { progreso.hidden = false; progreso.max = lista.length; progreso.value = 0; }
    decirImportar("leyendo " + lista.length + " fichero(s)…");
    try {
      const planes = [];
      for (const archivo of lista) {
        const tipo = tipoDeFichero(archivo.name);
        if (!tipo) throw new Error("no sé qué hacer con " + archivo.name + ": elige .jar, .aar o .zip");
        const datos = new Uint8Array(await archivo.arrayBuffer());
        if (tipo === "jar") planes.push(planDeJar(archivo.name, datos));
        else if (tipo === "aar") planes.push(planDeAar(archivo.name, await leerZip(datos)));
        else planes.push(planDePaquete(await leerZip(datos)));
      }
      const plan = unirPlanes(planes);
      const r = await importarDependencias({
        plan, hospedador, conBloqueo,
        confirmar: (rutas) => (typeof window === "undefined" || typeof window.confirm !== "function")
          ? true
          : window.confirm("Ya existen " + rutas.length + " fichero(s) en /proyecto. ¿Reemplazarlos?"),
        alProgreso: ({ hechos, total }) => {
          if (!progreso) return;
          progreso.max = total || 1;
          progreso.value = hechos;
        },
      });
      if (importadoFicheros) {
        importadoFicheros.textContent = r.ficheros + " fichero(s)" +
          (plan.ignorados ? ", " + plan.ignorados + " ignorado(s)" : ", sin ignorados");
      }
      if (importadoBytes) importadoBytes.textContent = r.textoBytes + " (" + r.bytes + " bytes)";
      if (importadoDestino) {
        const muestra = r.rutas.slice(0, 4).join("\n") +
          (r.rutas.length > 4 ? "\n… " + (r.rutas.length - 4) + " más" : "");
        importadoDestino.textContent = muestra;
      }
      if (importadoDescriptor) importadoDescriptor.textContent = r.descriptor;
      if (importado) importado.hidden = false;
      // la página refresca el árbol y avisa a las demás ventanas; si no hay enganche (prueba de
      // node o panel suelto) el importe ya está en OPFS y no se pierde nada
      if (typeof alImportar === "function") {
        try { await alImportar(r.rutas); } catch (e) { /* el aviso no invalida lo escrito */ }
      }
      decirImportar("listo: " + r.ficheros + " fichero(s), " + r.textoBytes +
        " en /proyecto/jar/, /proyecto/lib/<abi>/ y /proyecto/res/__deps/", "bien");
    } catch (e) {
      decirImportar("error: " + mensajeDeImportacion(e), "mal");
    } finally {
      importando = false;
      if (seleccion) { seleccion.disabled = false; seleccion.value = ""; }
    }
  };
  if (seleccion) seleccion.addEventListener("change", () => importar([...(seleccion.files || [])]));
  if (zonaSoltar) {
    const frenar = (evento) => { evento.preventDefault(); evento.stopPropagation(); };
    zonaSoltar.addEventListener("dragover", (evento) => {
      frenar(evento);
      zonaSoltar.classList.add("activa");
    });
    zonaSoltar.addEventListener("dragleave", () => zonaSoltar.classList.remove("activa"));
    zonaSoltar.addEventListener("drop", (evento) => {
      frenar(evento);
      zonaSoltar.classList.remove("activa");
      const datos = evento.dataTransfer;
      if (datos && datos.files) importar([...datos.files]);
    });
  }
  return { resolver, importar, entrada, boton };
}
