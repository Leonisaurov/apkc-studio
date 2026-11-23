// Sección de dependencias de apkc-studio: importa a OPFS un paquete de artefactos Maven que ya
// está en el propio origen, guiándose por `./deps-index.json`.
//
// El índice y los ficheros NO se generan en la página: los produce un workflow de GitHub Actions
// (`.github/workflows/deps-maven.yml`) en el runner, que descarga de Maven Central/Google Maven,
// calcula el SHA-256 y publica un artefacto con `deps-index.json` y los `.jar`/`.aar`/`.pom`. Al
// sitio se suben como cualquier otro estático; esta sección solo los lee del mismo origen.
//
// Por eso la página sigue con la regla 4 intacta: ni Maven, ni un proxy, ni un CDN. La única
// petición que hace este módulo —y solo cuando la persona pulsa «Resolver»— va a
// `.<origen>/deps-index.json` y a `.<origen>/deps/...`, que son ficheros del propio sitio. Si el
// índice no existe, se dice tal cual: no se inventan coordenadas, tamaños ni hashes.

export const RUTA_INDICE = "./deps-index.json";
const VERSION_INDICE = 1;
const EXTENSIONES = new Set(["jar", "aar", "pom"]);
const PARTE_SEGURA = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

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

// Engancha el panel. No pide nada al cargar: solo el clic en `#deps-resolver` (o Enter en el
// campo) llama a `resolverDependencia`. `ocupado` evita que un doble clic haga dos importaciones.
export function crearPanelDeps({ hospedador, conBloqueo } = {}) {
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
  return { resolver, entrada, boton };
}
