// Datos del autocompletado: nombres de recursos del proyecto, R.java y el índice de un zip
// (el android.jar). Todo son funciones puras sobre texto y bytes: no tocan el DOM ni OPFS, y
// prueba.js las ejercita en node. Quien lee del proyecto y del jar es autocompletado.js.
//
// La regla 4 del AGENTS.md manda: nada de red. Los recursos salen de los ficheros del proyecto
// que ya están en OPFS y los nombres de API, del propio android.jar que la página guardó allí.

// Carpeta de `res/` -> tipo de R. Las carpetas pueden llevar calificadores (`drawable-hdpi`), así
// que se mira el primer tramo antes del guion. `values` no está aquí: sus nombres están dentro
// del XML, no en el nombre del fichero.
const TIPO_POR_CARPETA = {
  layout: "layout", drawable: "drawable", mipmap: "mipmap", menu: "menu", xml: "xml",
  raw: "raw", anim: "anim", animator: "animator", color: "color", font: "font",
  transition: "transition", interpolator: "interpolator",
};

// Etiqueta de res/values -> tipo de R. Los arreglos (`string-array`, `integer-array`) producen
// `R.array`, y los `<declare-styleable>` solo viven en R.java como clase `styleable`.
const TIPO_POR_ETIQUETA = {
  string: "string", color: "color", dimen: "dimen", integer: "integer", bool: "bool",
  style: "style", "string-array": "array", "integer-array": "array", array: "array",
  plurals: "plurals", fraction: "fraction", attr: "attr", "declare-styleable": "styleable",
};

// Tipo de una carpeta de recursos: `layout-land` es `layout`, `values-es` es `values`.
function tipoDeCarpeta(carpeta) {
  const base = String(carpeta || "").split("-")[0];
  return base === "values" ? "values" : (TIPO_POR_CARPETA[base] || null);
}

// Un recurso de fichero pierde su extensión: `main.xml` es `main`, y una nueve piezas
// `icono.9.png` también es `icono`.
function nombreDeFicheroDeRecurso(nombre) {
  return String(nombre || "")
    .replace(/\.9\.png$/i, "")
    .replace(/\.[^.]+$/, "");
}

// Añade al mapa `tipos` (tipo -> Set de nombres) los recursos que declaran las rutas de OPFS.
// Solo cuentan las que están bajo `res/` y en una carpeta de recursos con nombre de fichero.
function recursosDeRutas(rutas, tipos) {
  const destino = tipos || {};
  for (const ruta of rutas || []) {
    const m = /\/res\/([^/]+)\/([^/]+)$/.exec(String(ruta));
    if (!m) continue;
    const tipo = tipoDeCarpeta(m[1]);
    if (!tipo || tipo === "values") continue;
    const nombre = nombreDeFicheroDeRecurso(m[2]);
    if (!nombre) continue;
    if (!destino[tipo]) destino[tipo] = new Set();
    destino[tipo].add(nombre);
  }
  return destino;
}

// Añade los recursos declarados por un XML de `res/values*`. Se leen las etiquetas con `name`
// (string, color, dimen, integer, bool, style, arreglos, plurals, fraction, attr y
// declare-styleable) y los `<item name="x" type="id|string|…">`, que es como se declara un id
// suelto fuera de un layout. No es un parser de XML: un atributo `name` en un comentario no
// cuenta porque los comentarios no llegan aquí (el texto se lee entero y la etiqueta tiene que
// empezar por `<`).
function agregarValores(xml, tipos) {
  const destino = tipos || {};
  const texto = String(xml || "");
  for (const m of texto.matchAll(/<([\w-]+)\b([^>]*)>/g)) {
    const etiqueta = m[1];
    const atributos = m[2] || "";
    const nombre = /\bname="([^"]+)"/.exec(atributos);
    if (!nombre) continue;
    const declarado = /\btype="([^"]+)"/.exec(atributos);
    const tipo = TIPO_POR_ETIQUETA[etiqueta] ||
      (etiqueta === "item" && declarado ? declarado[1] : null);
    if (!tipo) continue;
    if (!destino[tipo]) destino[tipo] = new Set();
    destino[tipo].add(nombre[1]);
  }
  return destino;
}

// Los ids que declara un layout (o un drawable) con `@+id/nombre`. Sin esto `R.id.` estaría
// vacío: los ids no tienen fichero propio y solo existen dentro del XML que los usa.
function agregarIdsDeXml(xml, tipos) {
  const destino = tipos || {};
  const texto = String(xml || "");
  for (const m of texto.matchAll(/@\+id\/([A-Za-z_]\w*)/g)) {
    if (!destino.id) destino.id = new Set();
    destino.id.add(m[1]);
  }
  return destino;
}

// R.java que deja el build, del enlazador de apkc o de aapt2: una clase estática por tipo y
// dentro `public static final int nombre=…` (y en `styleable` también arreglos y offsets).
function recursosDeRJava(texto, tipos) {
  const destino = tipos || {};
  let actual = null;
  for (const linea of String(texto || "").split("\n")) {
    const clase = /^\s*public static final class (\w+)\s*\{/.exec(linea);
    if (clase) {
      actual = clase[1];
      if (!destino[actual]) destino[actual] = new Set();
      continue;
    }
    if (actual && /^\s*\}\s*$/.test(linea)) { actual = null; continue; }
    if (!actual) continue;
    const campo = /^\s*public static (?:final )?int(?:\[\])?\s+(\w+)\s*[=;]/.exec(linea);
    if (campo) destino[actual].add(campo[1]);
  }
  return destino;
}

// --- zip: solo lo que hace falta para leer un jar sin descargarlo -------------------------
// El android.jar tiene decenas de miles de entradas y 50 MB largos. La página no lo baja ni lo
// copia: pide el final del fichero (el directorio central), y después solo la entrada que el
// usuario está completando. Estas dos funciones trabajan sobre el trozo que les llega.

const FIRMA_EOCD = 0x06054b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;

function vistaDe(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function decodificar(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    let fuera = "";
    for (let i = 0; i < bytes.length; i++) fuera += String.fromCharCode(bytes[i]);
    return fuera;
  }
}

// Busca el fin del directorio central (EOCD) en el trozo final del fichero. Se comprueba que el
// comentario declarado llegue justo al final: así no se confunde una firma casual dentro de los
// datos con el registro de verdad.
function buscarFinDirectorio(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 22) return null;
  const vista = vistaDe(b);
  const minimo = Math.max(0, b.length - 65557);
  for (let i = b.length - 22; i >= minimo; i--) {
    if (vista.getUint32(i, true) !== FIRMA_EOCD) continue;
    const comentario = vista.getUint16(i + 20, true);
    if (i + 22 + comentario !== b.length) continue;
    const entradas = vista.getUint16(i + 10, true);
    const tamanoDirectorio = vista.getUint32(i + 12, true);
    const inicioDirectorio = vista.getUint32(i + 16, true);
    if (entradas === 0xffff || tamanoDirectorio === 0xffffffff || inicioDirectorio === 0xffffffff) {
      return { zip64: true };
    }
    return { entradas, tamanoDirectorio, inicioDirectorio };
  }
  return null;
}

// Entradas del directorio central: nombre, método de compresión, tamaños y offset de su cabecera
// local. El offset del registro central ya es **absoluto** en el fichero (se cuenta desde su primer
// byte), así que no se le suma el inicio del directorio: sumarlo mandaba a los métodos a leer más
// allá del final del jar y devolvía cero bytes (§200 y la prueba de `View.` en la pestaña).
function leerEntradasDirectorio(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const vista = vistaDe(b);
  const salida = [];
  let i = 0;
  while (i + 46 <= b.length && vista.getUint32(i, true) === FIRMA_CENTRAL) {
    const metodo = vista.getUint16(i + 10, true);
    const comprimido = vista.getUint32(i + 20, true);
    const descomprimido = vista.getUint32(i + 24, true);
    const largoNombre = vista.getUint16(i + 28, true);
    const largoExtra = vista.getUint16(i + 30, true);
    const largoComentario = vista.getUint16(i + 32, true);
    const local = vista.getUint32(i + 42, true);
    const nombre = decodificar(b.subarray(i + 46, i + 46 + largoNombre));
    salida.push({ nombre, metodo, comprimido, descomprimido, local });
    i += 46 + largoNombre + largoExtra + largoComentario;
  }
  return salida;
}

// Nombres de clase del jar, sin leer ni un byte de las clases: el nombre vive en el directorio
// central. Se saltan las internas (`$`), cuyos nombres simples se confunden con los de su clase
// exterior en la lista.
function clasesDelJar(entradas) {
  const salida = [];
  for (const entrada of entradas || []) {
    if (!entrada || !/\.class$/.test(entrada.nombre)) continue;
    if (entrada.nombre.startsWith("META-INF/")) continue;
    const ruta = entrada.nombre.slice(0, -".class".length);
    if (ruta.includes("$")) continue;
    const simple = ruta.slice(ruta.lastIndexOf("/") + 1);
    if (!simple) continue;
    salida.push({ simple, ruta: ruta.replace(/\//g, "."), entrada });
  }
  return salida;
}

// Cabecera local del zip: dice dónde empiezan los datos comprimidos de una entrada.
function offsetDeDatosLocales(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 30) return -1;
  const vista = vistaDe(b);
  if (vista.getUint32(0, true) !== FIRMA_LOCAL) return -1;
  return 30 + vista.getUint16(26, true) + vista.getUint16(28, true);
}

// Nombres de método de un .class, saltando el pool de constantes y los campos. Devuelve también
// el descriptor y si es público: la lista enseña el descriptor y no todas las sobrecargas
// repetidas. Un fichero raro devuelve [] en vez de reventar la pestaña.
function metodosDeClase(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 10) return [];
  const vista = vistaDe(b);
  if (vista.getUint32(0, false) !== 0xcafebabe) return [];

  let pos = 10;
  const total = vista.getUint16(8, false);
  const utf8 = new Map();
  for (let k = 1; k < total; k++) {
    const tag = vista.getUint8(pos);
    pos += 1;
    if (tag === 1) {
      const largo = vista.getUint16(pos, false);
      utf8.set(k, decodificar(b.subarray(pos + 2, pos + 2 + largo)));
      pos += 2 + largo;
    } else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12) {
      pos += 4;
    } else if (tag === 5 || tag === 6) {
      pos += 8;
      k++; // long y double ocupan dos casillas del pool
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      pos += 2;
    } else if (tag === 15) {
      pos += 3;
    } else if (tag === 17 || tag === 18) {
      pos += 4;
    } else {
      return [];
    }
  }

  // access_flags, this_class, super_class e interfaces: los 2 bytes de `interfaces_count` también
  // se saltan, que si no se leía como `fields_count` y la lista de métodos salía siempre vacía
  pos += 8 + 2 * vista.getUint16(pos + 6, false);
  const campos = vista.getUint16(pos, false);
  pos += 2;
  for (let i = 0; i < campos; i++) {
    pos += 6;
    const atributos = vista.getUint16(pos, false);
    pos += 2;
    for (let j = 0; j < atributos; j++) {
      pos += 2;
      pos += 4 + vista.getUint32(pos, false);
    }
  }
  if (pos + 2 > b.length) return [];
  const cuantos = vista.getUint16(pos, false);
  pos += 2;
  const salida = [];
  for (let i = 0; i < cuantos; i++) {
    if (pos + 6 > b.length) return salida;
    const acceso = vista.getUint16(pos, false);
    const nombre = utf8.get(vista.getUint16(pos + 2, false)) || "";
    const descriptor = utf8.get(vista.getUint16(pos + 4, false)) || "";
    pos += 6;
    const atributos = vista.getUint16(pos, false);
    pos += 2;
    for (let j = 0; j < atributos; j++) {
      if (pos + 6 > b.length) return salida;
      pos += 2;
      pos += 4 + vista.getUint32(pos, false);
    }
    if (!nombre) continue;
    salida.push({
      nombre, descriptor,
      publico: (acceso & 0x0001) !== 0,
      estatico: (acceso & 0x0008) !== 0,
    });
  }
  return salida;
}

// ¿El cursor está dentro de un comentario de línea o de una cadena? Se mira solo la línea: un
// bloque `/* … */` de varias líneas no se detecta y la lista puede salir dentro de él; es una
// frontera conocida, no un fallo silencioso.
function enComentarioOcadena(antes) {
  const linea = String(antes || "").slice(String(antes || "").lastIndexOf("\n") + 1);
  let cadena = false, caracter = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === "\\" && (cadena || caracter)) { i++; continue; }
    if (!caracter && c === "\"") cadena = !cadena;
    else if (!cadena && c === "'") caracter = !caracter;
    else if (!cadena && !caracter && c === "/" && linea[i + 1] === "/") return true;
  }
  return cadena || caracter;
}

// Qué se está completando y qué rango se sustituye. `desde`/`hasta` son índices del textarea
// (unidades UTF-16, como el resto del editor) y `prefijo` es lo ya escrito que hay que filtrar.
//
//   R.            -> tipos      (layout, id, string…)
//   R.layout.ma   -> valores    (layout=layout, prefijo="ma")
//   View.         -> metodos    (clase=View, prefijo="")
//   Acti          -> clases     (prefijo="Acti")
function contextoDeCompletado(texto, cursor) {
  const hasta = Math.max(0, Number(cursor) || 0);
  const antes = String(texto || "").slice(0, hasta);
  if (enComentarioOcadena(antes)) return null;

  let m = /(?:^|[^\w$.])R\.(\w*)$/.exec(antes);
  if (m) return { modo: "tipos", prefijo: m[1], desde: hasta - m[1].length, hasta };

  m = /(?:^|[^\w$.])R\.(\w+)\.(\w*)$/.exec(antes);
  if (m) return { modo: "valores", tipo: m[1], prefijo: m[2], desde: hasta - m[2].length, hasta };

  m = /(?:^|[^\w$.])([A-Z][\w$]*)\.(\w*)$/.exec(antes);
  if (m) return { modo: "metodos", clase: m[1], prefijo: m[2], desde: hasta - m[2].length, hasta };

  m = /(?:^|[^\w$.])([A-Z][\w$]*)$/.exec(antes);
  if (m && m[1].length >= 2) return { modo: "clases", prefijo: m[1], desde: hasta - m[1].length, hasta };

  return null;
}

export {
  TIPO_POR_CARPETA, TIPO_POR_ETIQUETA,
  tipoDeCarpeta, nombreDeFicheroDeRecurso,
  recursosDeRutas, agregarValores, agregarIdsDeXml, recursosDeRJava,
  buscarFinDirectorio, leerEntradasDirectorio, clasesDelJar, offsetDeDatosLocales,
  metodosDeClase, enComentarioOcadena, contextoDeCompletado,
};
