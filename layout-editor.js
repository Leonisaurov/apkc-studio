// El modo editar de la vista previa: operaciones sobre el TEXTO del layout, no sobre su modelo.
//
// El panel dibuja el layout con `vista-xml.js`; aquí se cambia el XML del `res/layout/*.xml` para
// que el dibujo cambie. Todo es texto y todo es puro (sin DOM, sin OPFS y sin `apkc`): recibe el
// XML del buffer del editor y devuelve el XML nuevo, que el panel aplica con `EDITOR.cambiar()`
// (así el cambio entra en el undo tree y el documento queda sucio una sola vez).
//
// Lo que sabe hacer, y nada más:
//   - añadir un elemento de la paleta como último hijo de la raíz;
//   - mover un hijo de un marco (`FrameLayout` y cualquier contenedor que no sea lineal) con
//     `layout_marginLeft`/`layout_marginTop` —la gravedad se quita para que el margen mande—;
//   - reordenar un hijo de un `LinearLayout` (un layout lineal no tiene posición libre: mover es
//     cambiar el orden de los hijos);
//   - borrar un elemento.
//
// La raíz no se borra: el `setContentView` de la actividad necesita una vista. Un XML a medias no
// se toca: cada operación vuelve a leer el buffer y, si no se puede analizar, devuelve el error en
// vez de escribir a ciegas.
//
// Frontera declarada: no hay `ConstraintLayout` (ni constraints ni `bias`), ni estilos, ni temas,
// ni reparentado (arrastrar un nodo dentro de otro contenedor), ni deshacer propio (lo pone el
// editor). Se mueve lo que el render en vivo ya dibuja.
import { analizarXml } from "./vista-xml.js";

// Los tipos que la paleta ofrece y el render en vivo entiende. `id` es la base del
// `android:id="@+id/…"` que se genera.
const TIPOS = {
  TextView: { etiqueta: "TextView", id: "texto", texto: "Texto" },
  Button: { etiqueta: "Button", id: "boton", texto: "Boton" },
  ImageView: { etiqueta: "ImageView", id: "imagen", descripcion: "Imagen" },
  LinearLayout: { etiqueta: "LinearLayout", id: "lineal", contenedor: true },
  FrameLayout: { etiqueta: "FrameLayout", id: "marco", contenedor: true },
};

export function tiposDisponibles() {
  return Object.keys(TIPOS);
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
// texto para las vistas de texto. Los contenedores llevan dentro un `TextView` para que se puedan
// arrastrar en cuanto se añaden (un contenedor vacío no da nada que mover).
function elementoDe(tipo, id, hijoId) {
  const t = TIPOS[tipo];
  const comun = [
    "    android:id=\"@+id/" + id + "\"",
    "    android:layout_width=\"wrap_content\"",
    "    android:layout_height=\"wrap_content\"",
  ];
  if (!t.contenedor) {
    const lineas = ["<" + t.etiqueta, ...comun];
    if (t.texto) lineas.push("    android:text=\"" + t.texto + "\"");
    if (t.descripcion) lineas.push("    android:contentDescription=\"" + t.descripcion + "\"");
    lineas[lineas.length - 1] += "/>";
    return lineas.join("\n");
  }
  const lineas = ["<" + t.etiqueta, ...comun];
  if (tipo === "LinearLayout") lineas.push("    android:orientation=\"vertical\"");
  lineas[lineas.length - 1] += ">";
  const hijo = [
    "<TextView",
    "    android:id=\"@+id/" + hijoId + "\"",
    "    android:layout_width=\"wrap_content\"",
    "    android:layout_height=\"wrap_content\"",
    "    android:text=\"Texto\"/>",
  ].join("\n");
  lineas.push(conSangria(hijo, "    "));
  lineas.push("</" + t.etiqueta + ">");
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

function analizar(fuente) {
  try {
    return { ok: true, raiz: analizarXml(fuente) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Añade un elemento como último hijo de la raíz. Devuelve la ruta del nodo nuevo (`[n]`) para que
// el panel pueda dejarlo seleccionado.
export function insertarElemento(xml, opciones) {
  const fuente = String(xml == null ? "" : xml);
  const tipo = opciones && opciones.tipo;
  if (!TIPOS[tipo]) return { ok: false, error: "tipo desconocido: " + tipo };
  const leido = analizar(fuente);
  if (!leido.ok) return leido;
  const raiz = leido.raiz;
  const id = idLibre(fuente, TIPOS[tipo].id);
  const hijoId = TIPOS[tipo].contenedor ? idLibre(fuente, "texto") : "";
  const elemento = elementoDe(tipo, id, hijoId);
  const ruta = [hijosElemento(raiz).length];

  // `<FrameLayout .../>` no tiene dónde meter un hijo: se abre y se cierra alrededor del nuevo.
  if (/\/>\s*$/.test(fuente.slice(raiz.desde, raiz.hasta))) {
    const cierre = raiz.hasta - 2;
    const sangria = sangriaDe(fuente, raiz.desde) + "    ";
    const bloque = "\n" + conSangria(elemento, sangria) + "\n" + sangriaDe(fuente, raiz.desde);
    const nuevo = fuente.slice(0, cierre) + ">" + bloque + "</" + raiz.nombre + ">" +
      fuente.slice(raiz.hasta);
    return { ok: true, xml: nuevo, ruta, id, cambio: true };
  }

  const cierre = inicioCierre(fuente, raiz);
  if (cierre.pos < 0) return { ok: false, error: "la raíz no cierra con una etiqueta" };
  const primero = hijosElemento(raiz)[0];
  const sangriaHijo = primero ? sangriaDe(fuente, primero.desde) : cierre.sangria + "    ";
  const bloque = conSangria(elemento, sangriaHijo);
  const insertar = cierre.suLinea ? bloque + "\n" : "\n" + bloque + "\n" + cierre.sangria;
  const nuevo = fuente.slice(0, cierre.pos) + insertar + fuente.slice(cierre.pos);
  return { ok: true, xml: nuevo, ruta, id, cambio: true };
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
