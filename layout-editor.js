// El modo editar de la vista previa: operaciones sobre el TEXTO del layout, no sobre su modelo.
//
// El panel dibuja el layout con `vista-xml.js`; aquí se cambia el XML del `res/layout/*.xml` para
// que el dibujo cambie. Todo es texto y todo es puro (sin DOM, sin OPFS y sin `apkc`): recibe el
// XML del buffer del editor y devuelve el XML nuevo, que el panel aplica con `EDITOR.cambiar()`
// (así el cambio entra en el undo tree y el documento queda sucio una sola vez).
//
// Lo que sabe hacer, y nada más:
//   - añadir un elemento de la paleta: como último hijo de la raíz o, si se suelta sobre un
//     contenedor, dentro de él, en una posición y con los márgenes del punto donde se soltó; un
//     tipo propio totalmente cualificado (`com.ejemplo.lienzo.Lienzo`) cuenta como contenedor por
//     declaración: el editor no resuelve la herencia de Java y el paquete es la única señal de que
//     es una clase del proyecto;
//   - mover un hijo de un marco (`FrameLayout` y cualquier contenedor que no sea lineal) con
//     `layout_marginLeft`/`layout_marginTop` —la gravedad se quita para que el margen mande—;
//   - reordenar un hijo de un `LinearLayout` (un layout lineal no tiene posición libre: mover es
//     cambiar el orden de los hijos);
//   - leer y escribir las propiedades de un nodo (incluida la raíz) atributo a atributo;
//   - cambiar el tipo del layout raíz entre `LinearLayout` y `FrameLayout`;
//   - borrar un elemento.
//
// La raíz no se borra: el `setContentView` de la actividad necesita una vista. Un XML a medias no
// se toca: cada operación vuelve a leer el buffer y, si no se puede analizar, devuelve el error en
// vez de escribir a ciegas.
//
// Frontera declarada: no hay `ConstraintLayout` (ni constraints ni `bias`), ni estilos, ni temas,
// ni reparentado (arrastrar un nodo dentro de otro contenedor), ni deshacer propio (lo pone el
// editor). Tampoco se cambia la raíz a `RelativeLayout`: sus reglas (`layout_toRightOf`,
// `layout_alignParent…`) no las escribe este editor y la gravedad que sí escribe no la aplica
// Android, así que el dibujo mentiría. Se rechaza por nombre en `cambiarTipoRaiz`.
import { analizarXml, atributoLocal, tipoDeContenedor } from "./vista-xml.js";

// Las propiedades que el panel sabe leer y escribir. El orden es el de la ficha: identidad, texto,
// colores, medidas, gravedad y el resto. `tipo` decide el control y la validación.
const PROPIEDADES = [
  { nombre: "android:id", etiqueta: "id", tipo: "id", ayuda: "nombre del recurso: nuevo → @+id/nuevo" },
  { nombre: "android:text", etiqueta: "Texto", tipo: "texto", ayuda: "texto literal o @string/nombre", soloTexto: true },
  { nombre: "android:textColor", etiqueta: "Color del texto", tipo: "color", ayuda: "#RRGGBB o @color/nombre", soloTexto: true },
  { nombre: "android:src", etiqueta: "Imagen", tipo: "imagen", ayuda: "@drawable/nombre o @android:drawable/ic_delete", soloImagen: true },
  { nombre: "android:contentDescription", etiqueta: "Descripción", tipo: "texto", ayuda: "texto para lectores de pantalla (alt)", soloImagen: true },
  { nombre: "android:background", etiqueta: "Fondo", tipo: "color", ayuda: "#RRGGBB, #AARRGGBB o @color/nombre" },
  { nombre: "android:layout_width", etiqueta: "Ancho", tipo: "dimension", ayuda: "match_parent, wrap_content o 120dp" },
  { nombre: "android:layout_height", etiqueta: "Alto", tipo: "dimension", ayuda: "match_parent, wrap_content o 48dp" },
  { nombre: "android:gravity", etiqueta: "Gravedad", tipo: "gravedad", ayuda: "center, top|left, center_horizontal…" },
  { nombre: "android:layout_gravity", etiqueta: "Gravedad en el padre", tipo: "gravedad", ayuda: "center, bottom|right…", soloHijo: true },
  { nombre: "android:padding", etiqueta: "Padding", tipo: "medida", ayuda: "8dp, 12dp…" },
  { nombre: "android:layout_margin", etiqueta: "Margen", tipo: "medida", ayuda: "8dp, 12dp…", soloHijo: true },
  { nombre: "android:layout_weight", etiqueta: "Peso", tipo: "numero", ayuda: "0, 1, 2…", soloHijo: true },
  { nombre: "android:orientation", etiqueta: "Orientación", tipo: "orientacion", ayuda: "vertical u horizontal", soloLineal: true },
  { nombre: "android:enabled", etiqueta: "Activa", tipo: "booleano", ayuda: "true o false" },
];

// El orden de la paleta: primero las vistas de texto y de acción, después los campos, los
// indicadores y al final los contenedores. Es el orden en que se pintan los botones.
const ORDEN_PALETA = [
  "TextView", "EditText", "Button", "ImageButton", "ImageView",
  "CheckBox", "RadioButton", "Switch",
  "ProgressBar", "SeekBar", "View", "Space",
  "LinearLayout", "FrameLayout", "RelativeLayout", "ScrollView", "TableLayout", "GridLayout",
];

// La paleta agrupada por categorías, en el orden en que se pintan. Un grupo por necesidad (dónde
// metes la vista, qué escribes, qué pulsas…): con 18 tipos, una lista corrida no se recorre.
// Cada tipo de `TIPOS` aparece exactamente una vez; `prueba.js` lo comprueba.
const GRUPOS_PALETA = [
  {
    titulo: "Contenedores",
    tipos: ["LinearLayout", "FrameLayout", "RelativeLayout", "ScrollView", "TableLayout", "GridLayout"],
  },
  { titulo: "Texto", tipos: ["TextView"] },
  { titulo: "Botones", tipos: ["Button", "ImageButton"] },
  { titulo: "Entradas", tipos: ["EditText", "CheckBox", "RadioButton", "Switch"] },
  { titulo: "Imágenes", tipos: ["ImageView"] },
  { titulo: "Indicadores", tipos: ["ProgressBar", "SeekBar"] },
  { titulo: "Espaciadores", tipos: ["View", "Space"] },
];

// Iconos del framework con nombre PÚBLICO en API 34, comprobados con
// `aapt2 dump resources android.jar | grep " resource .* drawable/… PUBLIC"`. No hay variantes
// `*_white`/`*_black`/`*_gray` de `ic_*` como recurso público en 34 (sí `_holo_dark`/`_holo_light`,
// pero no son públicas): la ficha lo dice y no se ofrecen nombres que no existan.
const ICONOS_SISTEMA = [
  "ic_delete", "ic_info", "ic_menu_add", "ic_menu_camera", "ic_menu_delete", "ic_menu_edit",
  "ic_menu_gallery", "ic_menu_help", "ic_menu_search", "ic_menu_share",
];

// Cada tipo entra con atributos válidos para el render en vivo. `id` es la base del
// `android:id="@+id/…"` que se genera. `aviso` documenta lo que el dibujo no reproduce: la paleta
// lo enseña y el tipo no se pinta como si funcionara.
const TIPOS = {
  TextView: { etiqueta: "TextView", id: "texto", texto: "Texto" },
  EditText: { etiqueta: "EditText", id: "entrada", texto: "Texto" },
  Button: { etiqueta: "Button", id: "boton", texto: "Boton" },
  ImageButton: {
    etiqueta: "ImageButton", id: "boton_imagen", descripcion: "Imagen",
    aviso: "se dibuja como bloque, sin imagen",
  },
  ImageView: { etiqueta: "ImageView", id: "imagen", descripcion: "Imagen" },
  CheckBox: {
    etiqueta: "CheckBox", id: "casilla", texto: "Opcion",
    aviso: "se dibuja como bloque, sin la casilla",
  },
  RadioButton: {
    etiqueta: "RadioButton", id: "opcion", texto: "Opcion",
    aviso: "se dibuja como bloque, sin el círculo",
  },
  Switch: {
    etiqueta: "Switch", id: "interruptor", texto: "Ajuste",
    aviso: "se dibuja como bloque, sin el interruptor",
  },
  ProgressBar: {
    etiqueta: "ProgressBar", id: "progreso",
    aviso: "se dibuja como bloque, sin progreso",
  },
  SeekBar: {
    etiqueta: "SeekBar", id: "deslizador",
    aviso: "se dibuja como bloque, sin el deslizador",
  },
  View: { etiqueta: "View", id: "vista", aviso: "espaciador: se dibuja como bloque" },
  Space: { etiqueta: "Space", id: "espacio", aviso: "se dibuja como bloque" },
  LinearLayout: { etiqueta: "LinearLayout", id: "lineal", contenedor: true },
  FrameLayout: { etiqueta: "FrameLayout", id: "marco", contenedor: true },
  RelativeLayout: {
    etiqueta: "RelativeLayout", id: "relativo", contenedor: true,
    aviso: "se dibuja como marco; sus reglas no se editan",
  },
  ScrollView: {
    etiqueta: "ScrollView", id: "scroll", contenedor: true,
    aviso: "se dibuja como marco; no desplaza",
  },
  TableLayout: {
    etiqueta: "TableLayout", id: "tabla", contenedor: true,
    aviso: "se dibuja como lineal; sin columnas",
  },
  GridLayout: {
    etiqueta: "GridLayout", id: "rejilla", contenedor: true,
    aviso: "se dibuja como marco; sin cuadrícula",
  },
};

// Los tipos que llevan texto visible (para ofrecer `android:text` y `textColor` en la ficha).
const CON_TEXTO = /^(TextView|EditText|AutoCompleteTextView|CheckedTextView|TextInputEditText|Button|ImageButton|MaterialButton|AppCompatButton|CheckBox|RadioButton|Switch)$/;
// Las vistas que admiten una imagen: `android:src` y su `contentDescription`.
const CON_IMAGEN = /^(ImageView|ImageButton|MaterialImageView|AppCompatImageView)$/;

// Los tipos entre los que se puede cambiar la raíz. `RelativeLayout` se nombra aparte porque es el
// que se rechaza con un motivo, no porque falte una rama.
const RAIZ_PERMITIDA = ["LinearLayout", "FrameLayout"];
const RAIZ_RECHAZADA = "RelativeLayout";
const MOTIVO_RELATIVE = "RelativeLayout usa reglas (layout_toRightOf, layout_alignParent…) que este " +
  "editor no escribe y la gravedad que sí escribe no la aplica Android: el dibujo no coincidiría " +
  "con el aparato. La raíz solo cambia entre LinearLayout y FrameLayout.";

export function tiposDisponibles() {
  return ORDEN_PALETA.slice();
}

// La paleta por grupos, para pintarla en columnas con encabezado. Devuelve copias: el panel no
// puede cambiar el orden de la herramienta por accidente.
export function gruposPaleta() {
  return GRUPOS_PALETA.map((grupo) => ({ titulo: grupo.titulo, tipos: grupo.tipos.slice() }));
}

// Los iconos del sistema que la ficha puede escribir, con el nombre público de API 34. Son datos
// puros: `prueba.js` comprueba la lista y la ficha no inventa ninguno.
export function iconosSistema() {
  return ICONOS_SISTEMA.slice();
}

export function infoTipo(tipo) {
  const t = TIPOS[tipo];
  if (!t) return null;
  return {
    tipo,
    etiqueta: t.etiqueta,
    id: t.id,
    contenedor: !!t.contenedor,
    texto: t.texto || "",
    descripcion: t.descripcion || "",
    aviso: t.aviso || "",
  };
}

// El tamaño por defecto con el que entra cada tipo en el editor (dp). Es el mismo que pinta el
// indicador de destino: contenedores 160×96; vistas, el intrínseco que mide `vista-xml.js` con su
// texto por defecto (7 px por carácter, 16/32 de padding y 24/48 de alto: las mismas constantes,
// `prueba.js` comprueba que el modelo del nodo insertado coincide con esto).
export function tamanoDeTipo(tipo) {
  const t = TIPOS[tipo];
  if (!t) return null;
  if (t.contenedor) return { ancho: 160, alto: 96 };
  const texto = t.texto || "";
  if (/^(Button|ImageButton)$/.test(tipo)) {
    return { ancho: Math.max(48, Math.ceil(texto.length * 7) + 32), alto: 48 };
  }
  if (/^(TextView|EditText)$/.test(tipo)) {
    return { ancho: Math.max(24, Math.ceil(texto.length * 7) + 16), alto: 24 };
  }
  if (/^Image/.test(tipo)) return { ancho: 48, alto: 48 };
  return { ancho: 48, alto: 24 };
}

export function tiposRaizDisponibles() {
  return [
    { tipo: "LinearLayout", disponible: true, motivo: "" },
    { tipo: "FrameLayout", disponible: true, motivo: "" },
    { tipo: "RelativeLayout", disponible: false, motivo: MOTIVO_RELATIVE },
  ];
}

// Las propiedades que tienen sentido para un nodo: `texto` solo en las vistas de texto, `layout_*`
// solo en los hijos (la raíz no tiene padre) y `orientation` solo en un lineal.
export function propiedadesDisponibles(opciones) {
  const tipo = String((opciones && opciones.tipo) || "").replace(/^.*\./, "");
  const raiz = !!(opciones && opciones.raiz);
  return PROPIEDADES.filter((p) => {
    if (p.soloTexto && !CON_TEXTO.test(tipo)) return false;
    if (p.soloImagen && !CON_IMAGEN.test(tipo)) return false;
    if (p.soloHijo && raiz) return false;
    if (p.soloLineal && !/LinearLayout$/.test(tipo)) return false;
    return true;
  }).map((p) => ({ ...p }));
}

function definicionPropiedad(nombre) {
  return PROPIEDADES.find((p) => p.nombre === nombre) || null;
}

function hijosElemento(nodo) {
  return (nodo && Array.isArray(nodo.hijos) ? nodo.hijos : []).filter((h) => h.nombre !== "#texto");
}

function nodoEnRuta(raiz, ruta) {
  let nodo = raiz;
  for (const i of Array.isArray(ruta) ? ruta : []) {
    const hijos = hijosElemento(nodo);
    if (!hijos[i]) return null;
    nodo = hijos[i];
  }
  return nodo;
}

// Los ids ya usados en el fichero (`@+id/x` y `@id/x`), para que el nuevo no choque con ninguno.
function idLibre(xml, base) {
  const usados = new Set(
    [...String(xml).matchAll(/@\+?id\/([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  );
  if (!usados.has(base)) return base;
  let n = 2;
  while (usados.has(base + n)) n++;
  return base + n;
}

function conSangria(texto, sangria) {
  return String(texto).split("\n").map((linea) => (linea ? sangria + linea : linea)).join("\n");
}

// El XML del elemento nuevo, con las medidas que el render en vivo dibuja: `wrap_content` y un
// texto para las vistas de texto. Los espaciadores llevan una medida fija para que se vean. Los
// contenedores entran VACÍOS y con una caja fija de 160×96 dp: el hijo «Texto» que metían antes se
// veía primero y parecía que se había insertado un TextView. La caja se cambia en la ficha.
function elementoDe(tipo, id, extras) {
  const t = TIPOS[tipo];
  const medida = t.contenedor
    ? ["    android:layout_width=\"160dp\"", "    android:layout_height=\"96dp\""]
    : (tipo === "View" || tipo === "Space"
      ? ["    android:layout_width=\"48dp\"", "    android:layout_height=\"24dp\""]
      : ["    android:layout_width=\"wrap_content\"", "    android:layout_height=\"wrap_content\""]);
  const comun = ["    android:id=\"@+id/" + id + "\"", ...medida, ...(extras || [])];
  if (!t.contenedor) {
    const lineas = ["<" + tipo, ...comun];
    if (t.texto) lineas.push("    android:text=\"" + t.texto + "\"");
    if (t.descripcion) lineas.push("    android:contentDescription=\"" + t.descripcion + "\"");
    lineas[lineas.length - 1] += "/>";
    return lineas.join("\n");
  }
  const lineas = ["<" + tipo, ...comun];
  if (tipo === "LinearLayout") lineas.push("    android:orientation=\"vertical\"");
  lineas[lineas.length - 1] += ">";
  lineas.push("</" + tipo + ">");
  return lineas.join("\n");
}

function sangriaDe(fuente, pos) {
  const ini = fuente.lastIndexOf("\n", pos - 1) + 1;
  const tramo = fuente.slice(ini, pos);
  return /^[ \t]*$/.test(tramo) ? tramo : "";
}

// El trozo de fuente que ocupa un nodo, con su línea entera: la sangría de delante y el salto de
// línea de detrás, si solo hay espacios. Quitarlo deja el XML sin un hueco raro.
function bloqueDe(fuente, nodo) {
  let desde = nodo.desde;
  const ini = fuente.lastIndexOf("\n", desde - 1) + 1;
  if (/^[ \t]*$/.test(fuente.slice(ini, desde))) desde = ini;
  let hasta = nodo.fin === undefined ? nodo.hasta : nodo.fin;
  const fin = fuente.indexOf("\n", hasta);
  if (fin !== -1 && /^[ \t]*$/.test(fuente.slice(hasta, fin))) hasta = fin + 1;
  return { desde, hasta, texto: fuente.slice(desde, hasta) };
}

// El inicio de la línea de cierre de un elemento, si la etiqueta de cierre está sola en su línea.
function inicioCierre(fuente, nodo) {
  const cierre = fuente.lastIndexOf("</", nodo.fin === undefined ? nodo.hasta : nodo.fin);
  if (cierre < 0) return { pos: -1, sangria: "", suLinea: false };
  const ini = fuente.lastIndexOf("\n", cierre - 1) + 1;
  const tramo = fuente.slice(ini, cierre);
  const suLinea = /^[ \t]*$/.test(tramo);
  return { pos: suLinea ? ini : cierre, sangria: suLinea ? tramo : "", suLinea };
}

function conAtributo(tag, nombre, valor) {
  const escapado = nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patron = new RegExp("\\s+" + escapado + "\\s*=\\s*(\"[^\"]*\"|'[^']*')", "g");
  const limpio = tag.replace(patron, "");
  if (valor === null) return limpio;
  const cierre = /\/>\s*$/.test(limpio) ? limpio.lastIndexOf("/>") : limpio.lastIndexOf(">");
  if (cierre < 0) return limpio;
  return limpio.slice(0, cierre).replace(/\s+$/, "") + " " + nombre + "=\"" + valor + "\"" +
    limpio.slice(cierre);
}

// Las entidades que un valor de atributo puede necesitar. El texto que llega de un campo se escribe
// tal cual solo después de esto: `A & B` no puede romper el XML.
function escaparAtributo(valor) {
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function analizar(fuente) {
  try {
    return { ok: true, raiz: analizarXml(fuente) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Añade un elemento. Sin `padre` entra como último hijo de la raíz; con `padre` (ruta de índices,
// `[]` es la raíz) entra en ese contenedor, en la posición `indice` entre sus hijos. `margen`
// escribe `layout_marginLeft`/`layout_marginTop`: es como un marco coloca un hijo donde se soltó.
// Devuelve la ruta del nodo nuevo (`[n]`, o `[...padre, n]`) para que el panel lo deje seleccionado.
export function insertarElemento(xml, opciones) {
  const fuente = String(xml == null ? "" : xml);
  const tipo = opciones && opciones.tipo;
  if (!TIPOS[tipo]) return { ok: false, error: "tipo desconocido: " + tipo };
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  const raiz = leido.raiz;
  const rutaPadre = Array.isArray(opciones && opciones.padre) ? opciones.padre.slice() : [];
  const padre = rutaPadre.length ? nodoEnRuta(raiz, rutaPadre) : raiz;
  if (!padre) return { ok: false, error: "el contenedor de destino no está en el layout" };
  const tipoPadre = String(padre.nombre || "").replace(/^.*\./, "");
  if (!tipoDeContenedor(padre.nombre)) {
    return { ok: false, error: tipoPadre + " no es un contenedor: no admite hijos" };
  }
  const id = idLibre(fuente, TIPOS[tipo].id);
  const extras = [];
  const margen = opciones && opciones.margen;
  if (margen) {
    const izquierda = Math.max(0, Math.round(Number(margen.izquierda) || 0));
    const arriba = Math.max(0, Math.round(Number(margen.arriba) || 0));
    if (izquierda > 0) extras.push("    android:layout_marginLeft=\"" + izquierda + "dp\"");
    if (arriba > 0) extras.push("    android:layout_marginTop=\"" + arriba + "dp\"");
  }
  const elemento = elementoDe(tipo, id, extras);
  const hijos = hijosElemento(padre);
  const pedido = Number(opciones && opciones.indice);
  const indice = Math.max(0, Math.min(hijos.length, Number.isFinite(pedido) ? Math.round(pedido) : hijos.length));

  // Un contenedor autocerrado (`<FrameLayout .../>`) no tiene dónde meter un hijo: se abre y se
  // cierra alrededor del nuevo.
  if (/\/>\s*$/.test(fuente.slice(padre.desde, padre.hasta))) {
    const cierre = padre.hasta - 2;
    const sangria = sangriaDe(fuente, padre.desde) + "    ";
    const bloque = "\n" + conSangria(elemento, sangria) + "\n" + sangriaDe(fuente, padre.desde);
    const nuevo = fuente.slice(0, cierre) + ">" + bloque + "</" + tipoPadre + ">" +
      fuente.slice(padre.hasta);
    return { ok: true, xml: nuevo, ruta: rutaPadre.concat([0]), id, cambio: true };
  }

  const cierre = inicioCierre(fuente, padre);
  if (cierre.pos < 0) return { ok: false, error: "el contenedor no cierra con una etiqueta" };
  // Al final del contenedor se conserva el hueco de la raíz: después del último hijo y antes de su
  // cierre. En medio, se copia la sangría del hermano que queda detrás.
  let pos = cierre.pos;
  let sangriaHijo = "";
  if (indice >= hijos.length) {
    const primero = hijos[0];
    sangriaHijo = primero ? sangriaDe(fuente, primero.desde) : cierre.sangria + "    ";
  } else {
    const destino = hijos[indice];
    const bloqueDestino = bloqueDe(fuente, destino);
    pos = bloqueDestino.desde;
    sangriaHijo = sangriaDe(fuente, destino.desde);
  }
  const bloque = conSangria(elemento, sangriaHijo);
  const insertar = indice >= hijos.length && !cierre.suLinea
    ? "\n" + bloque + "\n" + cierre.sangria
    : bloque + "\n";
  const nuevo = fuente.slice(0, pos) + insertar + fuente.slice(pos);
  return { ok: true, xml: nuevo, ruta: rutaPadre.concat([indice]), id, cambio: true };
}

// Mueve un nodo dentro de un contenedor de marco: fija su margen izquierdo y superior respecto al
// contenido del padre y quita `layout_gravity`, porque con gravedad el margen no se aplica y el
// arrastre no se vería.
export function moverEnMarco(xml, ruta, posicion) {
  const fuente = String(xml == null ? "" : xml);
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  const nodo = nodoEnRuta(leido.raiz, ruta);
  if (!nodo) return { ok: false, error: "el nodo no está en el layout" };
  const izquierda = Math.max(0, Math.round(Number(posicion && posicion.izquierda) || 0));
  const arriba = Math.max(0, Math.round(Number(posicion && posicion.arriba) || 0));
  let tag = fuente.slice(nodo.desde, nodo.hasta);
  tag = conAtributo(tag, "android:layout_gravity", null);
  tag = conAtributo(tag, "android:layout_marginLeft", izquierda + "dp");
  tag = conAtributo(tag, "android:layout_marginTop", arriba + "dp");
  const nuevo = fuente.slice(0, nodo.desde) + tag + fuente.slice(nodo.hasta);
  return { ok: true, xml: nuevo, ruta, cambio: nuevo !== fuente };
}

// Reordena un hijo dentro de su `LinearLayout`: `indice` es la posición entre los hermanos, sin
// contar el que se mueve. Mover es cambiar el orden del XML, que es lo que hace el layout lineal.
export function reordenarHijo(xml, ruta, indice) {
  const fuente = String(xml == null ? "" : xml);
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  if (!Array.isArray(ruta) || !ruta.length) return { ok: false, error: "la raíz no se mueve" };
  const rutaPadre = ruta.slice(0, -1);
  const padre = nodoEnRuta(leido.raiz, rutaPadre);
  if (!padre) return { ok: false, error: "el padre del nodo no está en el layout" };
  const hijos = hijosElemento(padre);
  const actual = ruta[ruta.length - 1];
  const nodo = hijos[actual];
  if (!nodo) return { ok: false, error: "el nodo no está en el layout" };
  const otros = hijos.filter((_, i) => i !== actual);
  const destino = Math.max(0, Math.min(otros.length, Math.round(Number(indice) || 0)));
  if (destino === actual) return { ok: true, xml: fuente, ruta, cambio: false };

  const bloque = bloqueDe(fuente, nodo);
  const sin = fuente.slice(0, bloque.desde) + fuente.slice(bloque.hasta);
  const cierre = inicioCierre(fuente, padre);
  let pos = destino >= otros.length ? cierre.pos : bloqueDe(fuente, otros[destino]).desde;
  if (pos < 0) return { ok: false, error: "el padre no cierra con una etiqueta" };
  if (pos >= bloque.hasta) pos -= bloque.hasta - bloque.desde;
  else if (pos > bloque.desde) pos = bloque.desde;
  const sangria = sangriaDe(fuente, nodo.desde);
  const texto = bloque.texto.replace(/^[ \t]+/, "");
  const insertar = /\n$/.test(texto) ? texto : texto + "\n";
  const nuevo = sin.slice(0, pos) + sangria + insertar + sin.slice(pos);
  return { ok: true, xml: nuevo, ruta: [...rutaPadre, destino], cambio: true };
}

// Quita el nodo con su línea entera. La raíz no se borra: `setContentView` necesita una vista.
export function borrarElemento(xml, ruta) {
  const fuente = String(xml == null ? "" : xml);
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  if (!Array.isArray(ruta) || !ruta.length) return { ok: false, error: "la raíz no se borra" };
  const nodo = nodoEnRuta(leido.raiz, ruta);
  if (!nodo) return { ok: false, error: "el nodo no está en el layout" };
  const bloque = bloqueDe(fuente, nodo);
  return {
    ok: true,
    xml: fuente.slice(0, bloque.desde) + fuente.slice(bloque.hasta),
    ruta: ruta.slice(0, -1),
    cambio: true,
  };
}

// --- propiedades ---------------------------------------------------------------------------

// El id se escribe siempre como `@+id/nombre`: si el campo llega con `@id/x`, `@+id/x` o solo `x`,
// las tres formas acaban igual. Un nombre que no sea un identificador de Java se rechaza.
function normalizarId(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  const m = /^@\+?id\/(.+)$/.exec(v);
  const nombre = (m ? m[1] : v).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nombre)) return null;
  return "@+id/" + nombre;
}

function normalizarColor(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  if (/^#[0-9a-fA-F]{3}$/.test(v) || /^#[0-9a-fA-F]{4}$/.test(v) ||
      /^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{8}$/.test(v)) {
    return v;
  }
  if (/^@(\+)?color\/[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  return null;
}

function normalizarDimension(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  if (/^(match_parent|fill_parent|wrap_content)$/.test(v)) return v;
  if (/^\d+(?:\.\d+)?\s*(dp|dip|sp|px)$/.test(v)) return v.replace(/\s+/g, "");
  return null;
}

function normalizarMedida(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  if (/^\d+(?:\.\d+)?\s*(dp|dip|sp|px)$/.test(v)) return v.replace(/\s+/g, "");
  return null;
}

const GRAVEDADES = new Set([
  "top", "bottom", "left", "right", "start", "end", "center", "center_vertical",
  "center_horizontal", "fill", "fill_vertical", "fill_horizontal", "clip_vertical",
  "clip_horizontal",
]);

function normalizarGravedad(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  const partes = v.split("|").map((p) => p.trim());
  if (!partes.length || partes.some((p) => !GRAVEDADES.has(p))) return null;
  return partes.join("|");
}

function normalizarNumero(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(n);
}

// Un `android:src`: el recurso del proyecto (`@drawable/x`, `@mipmap/x`) o uno del framework
// (`@android:drawable/ic_delete`). Un nombre suelto se rechaza para no adivinar dónde vive.
function normalizarImagen(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  if (/^@(\+)?(drawable|mipmap)\/[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  if (/^@android:drawable\/[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  return null;
}

function normalizarOrientacion(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  if (v === "vertical" || v === "horizontal") return v;
  return null;
}

function normalizarBooleano(valor) {
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return "";
  if (v === "true" || v === "false") return v;
  return null;
}

function normalizarPropiedad(def, valor) {
  switch (def.tipo) {
    case "id": return normalizarId(valor);
    case "texto": return String(valor == null ? "" : valor);
    case "color": return normalizarColor(valor);
    case "imagen": return normalizarImagen(valor);
    case "dimension": return normalizarDimension(valor);
    case "medida": return normalizarMedida(valor);
    case "gravedad": return normalizarGravedad(valor);
    case "numero": return normalizarNumero(valor);
    case "orientacion": return normalizarOrientacion(valor);
    case "booleano": return normalizarBooleano(valor);
    default: return null;
  }
}

// Lee las propiedades de un nodo (la raíz es la ruta `[]`). Los valores salen tal como los decodifica
// el parser: `&amp;` llega como `&` y el panel lo pinta con `value`, nunca con `innerHTML`.
export function leerPropiedades(xml, ruta) {
  const fuente = String(xml == null ? "" : xml);
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  const nodo = nodoEnRuta(leido.raiz, ruta);
  if (!nodo) return { ok: false, error: "el nodo no está en el layout" };
  const raiz = !Array.isArray(ruta) || ruta.length === 0;
  const valores = {};
  for (const def of PROPIEDADES) {
    const attr = nodo.atributos && Object.prototype.hasOwnProperty.call(nodo.atributos, def.nombre)
      ? nodo.atributos[def.nombre] : "";
    valores[def.nombre] = attr === undefined || attr === null ? "" : String(attr);
  }
  return {
    ok: true,
    tipo: String(nodo.nombre || "").replace(/^.*\./, ""),
    id: valores["android:id"],
    raiz,
    valores,
    propiedades: propiedadesDisponibles({ tipo: nodo.nombre, raiz }),
  };
}

// Escribe una propiedad en el nodo. Devuelve el XML nuevo con el cambio mínimo (solo el atributo) y
// el valor normalizado. Un valor vacío quita el atributo en vez de dejarlo con `""`.
export function escribirPropiedad(xml, ruta, nombre, valor) {
  const fuente = String(xml == null ? "" : xml);
  const def = definicionPropiedad(String(nombre || ""));
  if (!def) return { ok: false, error: "propiedad desconocida: " + nombre };
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  const nodo = nodoEnRuta(leido.raiz, ruta);
  if (!nodo) return { ok: false, error: "el nodo no está en el layout" };
  const normalizado = normalizarPropiedad(def, valor);
  if (normalizado === null) {
    return {
      ok: false,
      propiedad: def.nombre,
      error: def.nombre + ": «" + String(valor == null ? "" : valor) + "» no es un valor válido (" +
        def.ayuda + ")",
    };
  }
  if (normalizado === "") {
    // quitar: se compara con el valor ya escrito para no gastar un cambio del undo tree en balde
    const actual = nodo.atributos ? nodo.atributos[def.nombre] : "";
    if (!actual) return { ok: true, xml: fuente, cambio: false, valor: "" };
  }
  const tag = fuente.slice(nodo.desde, nodo.hasta);
  const nuevoTag = conAtributo(tag, def.nombre, normalizado === "" ? null : escaparAtributo(normalizado));
  const nuevo = fuente.slice(0, nodo.desde) + nuevoTag + fuente.slice(nodo.hasta);
  return { ok: true, xml: nuevo, cambio: nuevo !== fuente, valor: normalizado };
}

// --- tipo del layout raíz --------------------------------------------------------------------

// Cambia la etiqueta de la raíz conservando sus atributos y sus hijos. Solo entre los tipos que este
// editor coloca igual; el resto se rechaza por su nombre.
export function cambiarTipoRaiz(xml, tipo) {
  const fuente = String(xml == null ? "" : xml);
  const nuevoTipo = String(tipo || "").replace(/^.*\./, "");
  if (nuevoTipo === RAIZ_RECHAZADA) {
    return { ok: false, rechazado: RAIZ_RECHAZADA, error: MOTIVO_RELATIVE };
  }
  if (!RAIZ_PERMITIDA.includes(nuevoTipo)) {
    return { ok: false, error: "tipo de raíz desconocido: " + tipo };
  }
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  const raiz = leido.raiz;
  const actual = String(raiz.nombre || "").replace(/^.*\./, "");
  if (actual === nuevoTipo) {
    return { ok: true, xml: fuente, cambio: false, tipo: nuevoTipo };
  }
  if (!RAIZ_PERMITIDA.includes(actual)) {
    return {
      ok: false,
      rechazado: actual,
      error: "no se cambia una raíz " + actual + ": solo entre LinearLayout y FrameLayout",
    };
  }
  let tag = fuente.slice(raiz.desde, raiz.hasta).replace(/^<([A-Za-z_][\w.]*)/, "<" + nuevoTipo);
  const autocierre = /\/>\s*$/.test(tag);
  if (autocierre) {
    if (nuevoTipo === "LinearLayout" && !atributoLocal(raiz.atributos, "orientation")) {
      tag = conAtributo(tag, "android:orientation", "vertical");
    }
    const nuevo = fuente.slice(0, raiz.desde) + tag + fuente.slice(raiz.hasta);
    const revisado = analizar(nuevo);
    if (!revisado.ok) return revisado;
    return { ok: true, xml: nuevo, cambio: true, tipo: nuevoTipo };
  }
  // la orientación solo tiene sentido en un lineal: al pasar a marco se quita y al revés se pone
  if (nuevoTipo === "LinearLayout") {
    tag = conAtributo(tag, "android:orientation",
      atributoLocal(raiz.atributos, "orientation") || "vertical");
  } else {
    tag = conAtributo(tag, "android:orientation", null);
  }
  const cierre = fuente.lastIndexOf("</", raiz.fin - 1);
  if (cierre < 0) return { ok: false, error: "la raíz no cierra con una etiqueta" };
  const nuevo = fuente.slice(0, raiz.desde) + tag + fuente.slice(raiz.hasta, cierre) +
    "</" + nuevoTipo + ">" + fuente.slice(raiz.fin);
  const revisado = analizar(nuevo);
  if (!revisado.ok) return revisado;
  if (String(revisado.raiz.nombre).replace(/^.*\./, "") !== nuevoTipo) {
    return { ok: false, error: "el cambio de raíz no dejó un " + nuevoTipo };
  }
  return { ok: true, xml: nuevo, cambio: true, tipo: nuevoTipo };
}
