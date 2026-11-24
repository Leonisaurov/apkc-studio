// El modelo en vivo del layout: toma el `res/layout/*.xml` tal como está en el editor y lo convierte
// en el mismo modelo que entiende `vista-previa.js` (pantalla + árbol de nodos con `rect`), sin
// compilar, sin `apkc` y sin tocar el dex. Es una aproximación declarada: mide con la misma
// convención que el pintor (dp≈px) y no pretende ser un medidor de Android.
//
// Lo que sí entiende del subconjunto que usan las plantillas y el editor:
//   - jerarquía de vistas y los contenedores `LinearLayout` (vertical/horizontal, pesos) y los de
//     marco (`FrameLayout`, `RelativeLayout`, `ScrollView`, `ConstraintLayout`… como marco);
//   - un tipo propio totalmente cualificado (`com.ejemplo.lienzo.Lienzo`) cuenta como contenedor
//     por declaración: el editor no resuelve la herencia de Java, así que se dibuja como lineal
//     (vertical u horizontal según `android:orientation`) para que sus hijos se repartan y no se
//     apilen en (0,0). Frontera: un tipo propio que en realidad herede de `View` también se dibuja
//     como contenedor, y un tipo desconocido SIN cualificar sigue tratándose como hoja;
//   - `android:text` literal y `@string/nombre` con el mapa que se le pase (OPFS lo lee el panel);
//   - `android:background` y `android:textColor` (`#RGB`, `#ARGB`, `#RRGGBB`, `#AARRGGBB` o
//     `@color/nombre` con el mapa de colores que también lee el panel), que el canvas usa al pintar;
//   - `layout_width`/`layout_height` con `match_parent`, `wrap_content` y `Ndp`;
//   - `layout_weight`, `gravity`, `layout_gravity`, `padding` y `layout_margin` (y sus lados).
//
// El parser es propio y mínimo (no hay DOMParser en node): etiquetas, atributos, comentarios y
// cabecera. Un XML a medias no inventa un árbol: devuelve `{ok:false, error, linea}` y el panel
// conserva el último render bueno. Todo esto es puro y se prueba en `prueba.js`.

const PANTALLA_POR_DEFECTO = { ancho: 360, alto: 640 };
const ALTO_TEXTO = 24;
const ALTO_BOTON = 48;
// Widget.Material.Button (android.jar 34) impone minWidth=88dp y minHeight=48dp. El ancho
// intrínseco del texto más el relleno de 16dp a cada lado no llega a 88dp con «Pulsar».
const ANCHO_BOTON = 88;
const ANCHO_CARACTER = 7;
const PADDING_TEXTO = 16;
const PADDING_BOTON = 32;

function decodificar(texto) {
  return String(texto)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// El panel lee `strings.xml` de OPFS y necesita las mismas entidades que el parser del layout.
export function decodificarEntidades(texto) {
  return decodificar(texto);
}

function lineaDe(fuente, posicion) {
  return fuente.slice(0, Math.max(0, posicion)).split("\n").length;
}

// El `>` de dentro de un valor entre comillas no cierra la etiqueta.
function finDeEtiqueta(fuente, desde) {
  let comilla = null;
  for (let i = desde; i < fuente.length; i++) {
    const c = fuente[i];
    if (comilla) {
      if (c === comilla) comilla = null;
    } else if (c === '"' || c === "'") {
      comilla = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function leerAtributos(texto) {
  const atributos = {};
  if (!texto) return atributos;
  const patron = /([A-Za-z_][\w.:-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'))?/g;
  let m;
  while ((m = patron.exec(texto))) {
    const nombre = m[1];
    const valor = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : "");
    atributos[nombre] = decodificar(valor);
  }
  return atributos;
}

// Un árbol de elementos. `#texto` no entra: el layout no aporta texto suelto, solo atributos.
export function analizarXml(texto) {
  const fuente = String(texto == null ? "" : texto);
  const documento = { nombre: "#documento", atributos: {}, hijos: [] };
  const pila = [documento];
  const fallo = (posicion, mensaje) => {
    const error = new Error(mensaje + " (línea " + lineaDe(fuente, posicion) + ")");
    error.linea = lineaDe(fuente, posicion);
    throw error;
  };
  let i = 0;
  while (i < fuente.length) {
    const abre = fuente.indexOf("<", i);
    const textoPlano = fuente.slice(i, abre === -1 ? fuente.length : abre);
    if (textoPlano.trim()) pila[pila.length - 1].hijos.push({ nombre: "#texto", texto: textoPlano.trim() });
    if (abre === -1) break;
    i = abre;
    if (fuente.startsWith("<!--", i)) {
      const fin = fuente.indexOf("-->", i + 4);
      if (fin === -1) fallo(i, "comentario sin cerrar");
      i = fin + 3;
      continue;
    }
    if (fuente.startsWith("<?", i)) {
      const fin = fuente.indexOf("?>", i + 2);
      if (fin === -1) fallo(i, "cabecera sin cerrar");
      i = fin + 2;
      continue;
    }
    if (fuente.startsWith("<!", i)) {
      const fin = finDeEtiqueta(fuente, i + 2);
      if (fin === -1) fallo(i, "declaración sin cerrar");
      i = fin + 1;
      continue;
    }
    const fin = finDeEtiqueta(fuente, i + 1);
    if (fin === -1) fallo(i, "etiqueta sin cerrar");
    const interior = fuente.slice(i + 1, fin).trim();
    if (interior.startsWith("/")) {
      const nombre = interior.slice(1).trim();
      const actual = pila[pila.length - 1];
      if (pila.length === 1) fallo(i, "cierra </" + nombre + "> sin abrir nada");
      if (actual.nombre !== nombre) {
        fallo(i, "cierra </" + nombre + "> pero estaba abierto <" + actual.nombre + ">");
      }
      pila.pop();
      actual.fin = fin + 1;
    } else {
      const autocierre = interior.endsWith("/");
      const cuerpo = autocierre ? interior.slice(0, -1).trim() : interior;
      const m = /^([A-Za-z_][\w.:-]*)([^]*)$/.exec(cuerpo);
      if (!m) fallo(i, "etiqueta inválida");
      // `desde`/`hasta` son el tramo de la ETIQUETA de apertura (donde viven los atributos) y
      // `fin`, el final de todo el elemento; el editor de layout reescribe el XML con ellos. El
      // modelo no los copia.
      const nodo = {
        nombre: m[1], atributos: leerAtributos(m[2]), hijos: [], desde: i, hasta: fin + 1,
        fin: fin + 1,
      };
      pila[pila.length - 1].hijos.push(nodo);
      if (!autocierre) pila.push(nodo);
    }
    i = fin + 1;
  }
  if (pila.length !== 1) fallo(fuente.length, "quedan etiquetas sin cerrar: " + pila[pila.length - 1].nombre);
  const elemento = documento.hijos.find((h) => h.nombre !== "#texto");
  if (!elemento) {
    const error = new Error("el fichero no tiene ni una etiqueta (línea 1)");
    error.linea = 1;
    throw error;
  }
  return elemento;
}

function local(atributos, nombre) {
  if (!atributos) return "";
  if (Object.prototype.hasOwnProperty.call(atributos, "android:" + nombre)) return atributos["android:" + nombre];
  const clave = Object.keys(atributos).find((k) => k.endsWith(":" + nombre));
  return clave ? atributos[clave] : "";
}

// El `android:` primero y, si no está, cualquier prefijo con el mismo nombre local. Lo usan el
// mediador del modelo y el editor de layout (para la orientación del LinearLayout).
export function atributoLocal(atributos, nombre) {
  return local(atributos, nombre);
}

// Una medida del layout, con 0 cuando no lo es. Ojo: no es `aNumeroOFinito` de `vista-previa.js`,
// que devuelve null para distinguir «no hay medida» de un cero legítimo; aquí el 0 es el respaldo
// que esperan `paddingDe` y el reparto de pesos.
function aNumeroOCero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

// Un color del layout en la forma que entiende el canvas. Android escribe `#ARGB` y `#AARRGGBB`;
// el canvas espera `#RGBA`/`#RRGGBBAA`, así que se reordenan los canales. `@color/nombre` se resuelve
// con el mapa que lee el panel de `res/values*/colors.xml`; una referencia que no está se deja sin
// color en vez de inventar uno.
function colorDeCanvas(valor, colores, profundidad = 0) {
  if (typeof valor !== "string") return "";
  const v = valor.trim();
  if (!v) return "";
  if (/^#[0-9a-fA-F]{3}$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{4}$/.test(v)) {
    const [a, r, g, b] = v.slice(1).split("");
    return "#" + r + r + g + g + b + b + a + a;
  }
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return "#" + v.slice(3) + v.slice(1, 3);
  const m = /^@color\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(v);
  if (m && colores && profundidad < 2 && Object.prototype.hasOwnProperty.call(colores, m[1])) {
    return colorDeCanvas(String(colores[m[1]]), colores, profundidad + 1);
  }
  return "";
}

// `Ndp`/`Npx`/`Nsp` se toman como dp; match_parent devuelve el máximo y wrap_content devuelve null
// (que el llamante resuelve con la medida intrínseca).
function dimension(valor, maximo) {
  if (typeof valor !== "string" || !valor.trim()) return null;
  const v = valor.trim();
  if (/^match_parent$|^fill_parent$/.test(v)) return maximo;
  if (/^wrap_content$/.test(v)) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*(dp|dip|dpi|px|sp)?$/.exec(v);
  if (!m) return null;
  return Math.max(0, Number(m[1]));
}

export function paddingDe(nodo) {
  const general = aNumeroOCero(dimension(local(nodo.atributos, "padding"), 0));
  const horizontal = aNumeroOCero(dimension(local(nodo.atributos, "paddingHorizontal"), 0));
  const vertical = aNumeroOCero(dimension(local(nodo.atributos, "paddingVertical"), 0));
  const lados = (nombre, respaldo) => {
    const valor = local(nodo.atributos, nombre);
    return valor ? aNumeroOCero(dimension(valor, 0)) : respaldo;
  };
  return {
    izq: lados("paddingLeft", lados("paddingStart", general + horizontal)),
    der: lados("paddingRight", lados("paddingEnd", general + horizontal)),
    arriba: lados("paddingTop", general + vertical),
    abajo: lados("paddingBottom", general + vertical),
  };
}

function margenDe(nodo) {
  const general = aNumeroOCero(dimension(local(nodo.atributos, "layout_margin"), 0));
  const lados = (nombre, respaldo) => {
    const valor = local(nodo.atributos, nombre);
    return valor ? aNumeroOCero(dimension(valor, 0)) : respaldo;
  };
  return {
    izq: lados("layout_marginLeft", lados("layout_marginStart", general)),
    der: lados("layout_marginRight", lados("layout_marginEnd", general)),
    arriba: lados("layout_marginTop", general),
    abajo: lados("layout_marginBottom", general),
  };
}

function esBoton(tipo) {
  return /^(Button|ImageButton|MaterialButton|AppCompatButton)$/.test(tipo);
}

function esTexto(tipo) {
  return /^(TextView|EditText|AutoCompleteTextView|CheckedTextView|TextInputEditText)$/.test(tipo);
}

export function esLineal(tipo) {
  return /^(LinearLayout|RadioGroup|TableRow|TableLayout)$/.test(tipo);
}

// Los contenedores no lineales que el modelo reconoce por nombre simple: se dibujan como marco.
// No es la lista de Android, sino la del subconjunto que dibuja este fichero; lo que falte y llegue
// cualificado se trata como contenedor propio (ver `tipoDeContenedor`).
const CONTENEDORES_MARCO = /^(FrameLayout|RelativeLayout|ScrollView|HorizontalScrollView|GridLayout|ConstraintLayout|CoordinatorLayout|DrawerLayout|NestedScrollView|ViewPager|ViewPager2)$/;

// Las vistas que no admiten hijos, por nombre simple. Sirve para no confundir un tipo del framework
// escrito con su paquete (`android.widget.TextView`) con un contenedor propio sin resolver.
const HOJAS_CONOCIDAS = /^(View|Space|TextView|EditText|AutoCompleteTextView|MultiAutoCompleteTextView|CheckedTextView|TextInputEditText|MaterialTextView|AppCompatTextView|Button|CompoundButton|ImageButton|MaterialButton|AppCompatButton|CheckBox|RadioButton|MaterialCheckBox|MaterialRadioButton|AppCompatCheckBox|AppCompatRadioButton|Switch|SwitchCompat|SwitchMaterial|MaterialSwitch|ToggleButton|ImageView|AppCompatImageView|MaterialImageView|AppCompatImageButton|ProgressBar|SeekBar|AppCompatSeekBar|MaterialSeekBar|RatingBar|Spinner|AppCompatSpinner|WebView|VideoView|SurfaceView|TextureView|Chronometer|AnalogClock|CalendarView|DatePicker|TimePicker|NumberPicker|ViewStub|SearchView|Toolbar|ScrollBar)$/;

// El tipo de contenedor de una etiqueta, por su nombre tal como aparece en el XML: "lineal", "marco"
// o "" (una vista que no admite hijos). Los tipos del framework se reconocen por el nombre simple
// (lista explícita). Precedencia: el PAQUETE manda sobre el sufijo. Un tipo TOTALMENTE CUALIFICADO
// que no sea conocido se trata como contenedor por declaración: no hay forma de resolver la
// herencia de Java desde el editor y el nombre con paquete es la señal de que es una clase del
// proyecto; se dibuja como lineal, que es lo único que reparte a los hijos en vez de apilarlos en el
// origen (`android:orientation` decide el eje). Un nombre desconocido SIN paquete no se adivina: se
// queda hoja aunque acabe en `Layout`, porque el sufijo no dice de qué hereda (`MiLayout extends
// View` es legal) y la frontera declarada es que solo lo cualificado se asume contenedor.
export function tipoDeContenedor(nombre) {
  const completo = String(nombre == null ? "" : nombre).trim();
  const tipo = completo.replace(/^.*\./, "");
  if (esLineal(tipo)) return "lineal";
  if (CONTENEDORES_MARCO.test(tipo)) return "marco";
  if (HOJAS_CONOCIDAS.test(tipo)) return "";
  if (completo.includes(".")) return "lineal";
  return "";
}

// La forma de contenedor de un nodo del modelo. `nodo.contenedor` lo deja `crearNodo`; el respaldo
// por nombre cubre los modelos de `apkc preview` y los nodos construidos a mano en las pruebas.
export function contenedorDe(nodo) {
  if (!nodo) return "";
  if (nodo.contenedor === "lineal" || nodo.contenedor === "marco") return nodo.contenedor;
  return tipoDeContenedor(nodo.tipo || nodo.nombre || "");
}

function resolverTexto(valor, strings, resolucion) {
  if (typeof valor !== "string" || !valor) return "";
  if (valor.startsWith("@string/")) {
    const nombre = valor.slice("@string/".length);
    if (Object.prototype.hasOwnProperty.call(strings, nombre)) return String(strings[nombre]);
    resolucion.sinStrings++;
    return "";
  }
  if (valor.startsWith("@")) return "";
  return decodificar(valor);
}

function crearNodo(elemento, resolucion, strings, colores) {
  const tipo = elemento.nombre.replace(/^.*\./, "");
  const id = (() => {
    const crudo = local(elemento.atributos, "id");
    if (!crudo) return "";
    const m = /^@\+?id\/(.+)$/.exec(crudo.trim());
    return m ? "id/" + m[1] : crudo;
  })();
  const nodo = {
    tipo,
    contenedor: tipoDeContenedor(elemento.nombre),
    id,
    texto: resolverTexto(local(elemento.atributos, "text"), strings, resolucion),
    fondo: colorDeCanvas(local(elemento.atributos, "background"), colores),
    colorTexto: colorDeCanvas(local(elemento.atributos, "textColor"), colores),
    // El pintor comparte la apariencia por defecto con el emulador: lo declarado gana y lo que
    // falta cae al tema del aparato (texto de 14sp, botón gris, relleno del botón).
    tamTexto: String(local(elemento.atributos, "textSize") || "").trim(),
    estilo: String(local(elemento.atributos, "style") || "").trim(),
    estiloTexto: String(local(elemento.atributos, "textStyle") || "").trim(),
    padding: paddingDe(elemento),
    // `android:src` tal cual (`@drawable/foto`, `@android:drawable/ic_delete`): el panel lee el PNG
    // del proyecto para pintarlo; el modelo de `apkc preview` no trae esta clave.
    recurso: String(local(elemento.atributos, "src") || "").trim(),
    atributos: elemento.atributos,
    hijos: [],
    rect: { x: 0, y: 0, ancho: 0, alto: 0 },
  };
  resolucion.elementos++;
  for (const hijo of elemento.hijos) {
    if (hijo.nombre === "#texto") continue;
    nodo.hijos.push(crearNodo(hijo, resolucion, strings, colores));
  }
  return nodo;
}

function intrinseco(nodo) {
  const pad = paddingDe(nodo);
  const hijos = nodo.hijos;
  if (!hijos.length) {
    if (esBoton(nodo.tipo)) {
      return { ancho: Math.max(ANCHO_BOTON, Math.ceil(nodo.texto.length * ANCHO_CARACTER) + PADDING_BOTON), alto: ALTO_BOTON };
    }
    if (esTexto(nodo.tipo)) {
      return { ancho: Math.max(24, Math.ceil(nodo.texto.length * ANCHO_CARACTER) + PADDING_TEXTO), alto: ALTO_TEXTO };
    }
    if (/Image/.test(nodo.tipo)) return { ancho: 48, alto: 48 };
    return { ancho: 48, alto: ALTO_TEXTO };
  }
  const vertical = local(nodo.atributos, "orientation") !== "horizontal";
  let ancho = 0, alto = 0;
  for (const hijo of hijos) {
    const m = margenDe(hijo);
    const tam = medirNodo(hijo, 0, 0);
    if (vertical) {
      ancho = Math.max(ancho, tam.ancho + m.izq + m.der);
      alto += tam.alto + m.arriba + m.abajo;
    } else {
      ancho += tam.ancho + m.izq + m.der;
      alto = Math.max(alto, tam.alto + m.arriba + m.abajo);
    }
  }
  return { ancho: ancho + pad.izq + pad.der, alto: alto + pad.arriba + pad.abajo };
}

function medirNodo(nodo, anchoMax, altoMax) {
  const intr = intrinseco(nodo);
  const ancho = dimension(local(nodo.atributos, "layout_width"), anchoMax);
  const alto = dimension(local(nodo.atributos, "layout_height"), altoMax);
  return { ancho: ancho === null ? intr.ancho : ancho, alto: alto === null ? intr.alto : alto };
}

function medidaCruz(nodo, cruzMax, vertical) {
  const tam = medirNodo(nodo, vertical ? cruzMax : 0, vertical ? 0 : cruzMax);
  return vertical ? tam.ancho : tam.alto;
}

function colocarLineal(nodo, caja, vertical) {
  const principalMax = vertical ? caja.alto : caja.ancho;
  const cruzMax = vertical ? caja.ancho : caja.alto;
  const piezas = nodo.hijos.map((hijo) => {
    const margen = margenDe(hijo);
    const dimPrincipal = dimension(local(hijo.atributos, vertical ? "layout_height" : "layout_width"), principalMax);
    const peso = aNumeroOCero(local(hijo.atributos, "layout_weight"));
    const flexible = peso > 0 && (dimPrincipal === 0 || dimPrincipal === null);
    const tam = flexible ? null : medirNodo(hijo, caja.ancho, caja.alto);
    const fijo = (tam ? (vertical ? tam.alto : tam.ancho) : 0) +
      (vertical ? margen.arriba + margen.abajo : margen.izq + margen.der);
    return { nodo: hijo, margen, peso, flexible, tam, fijo };
  });
  const sumaFijos = piezas.reduce((s, p) => s + (p.flexible ? 0 : p.fijo), 0);
  const pesoTotal = piezas.reduce((s, p) => s + (p.flexible ? p.peso : 0), 0);
  const resto = Math.max(0, principalMax - sumaFijos);
  for (const p of piezas) {
    if (!p.flexible) continue;
    const disponible = pesoTotal > 0 ? resto * (p.peso / pesoTotal) : 0;
    const margenPrincipal = vertical ? p.margen.arriba + p.margen.abajo : p.margen.izq + p.margen.der;
    const principal = Math.max(0, disponible - margenPrincipal);
    const cruz = medidaCruz(p.nodo, cruzMax, vertical);
    p.tam = vertical ? { ancho: cruz, alto: principal } : { ancho: principal, alto: cruz };
  }
  const tamPila = piezas.reduce((s, p) => s + (vertical
    ? p.margen.arriba + p.tam.alto + p.margen.abajo
    : p.margen.izq + p.tam.ancho + p.margen.der), 0);
  const gravedad = local(nodo.atributos, "gravity");
  let cursor = vertical ? caja.y : caja.x;
  if (vertical) {
    if (/(^|\|)(center_vertical|center)(\||$)/.test(gravedad)) cursor += Math.max(0, (caja.alto - tamPila) / 2);
    else if (/(^|\|)(bottom)(\||$)/.test(gravedad)) cursor += Math.max(0, caja.alto - tamPila);
  } else {
    if (/(^|\|)(center_horizontal|center)(\||$)/.test(gravedad)) cursor += Math.max(0, (caja.ancho - tamPila) / 2);
    else if (/(^|\|)(right|end)(\||$)/.test(gravedad)) cursor += Math.max(0, caja.ancho - tamPila);
  }
  for (const p of piezas) {
    const gravedadHijo = local(p.nodo.atributos, "layout_gravity") || gravedad;
    const cruz = vertical ? p.tam.ancho : p.tam.alto;
    let cruzIni = vertical ? caja.x : caja.y;
    const centrada = vertical
      ? /(^|\|)(center_horizontal|center)(\||$)/.test(gravedadHijo)
      : /(^|\|)(center_vertical|center)(\||$)/.test(gravedadHijo);
    const alFinal = vertical ? /(^|\|)(right|end)(\||$)/.test(gravedadHijo) : /(^|\|)(bottom)(\||$)/.test(gravedadHijo);
    if (centrada) cruzIni += Math.max(0, (cruzMax - cruz) / 2);
    else if (alFinal) cruzIni += Math.max(0, cruzMax - cruz);
    p.nodo.rect = {
      x: vertical ? cruzIni + p.margen.izq : cursor + p.margen.izq,
      y: vertical ? cursor + p.margen.arriba : cruzIni + p.margen.arriba,
      ancho: p.tam.ancho,
      alto: p.tam.alto,
    };
    cursor += vertical
      ? p.margen.arriba + p.tam.alto + p.margen.abajo
      : p.margen.izq + p.tam.ancho + p.margen.der;
    disponer(p.nodo);
  }
}

function colocarMarco(nodo, caja) {
  for (const hijo of nodo.hijos) {
    const margen = margenDe(hijo);
    const tam = medirNodo(hijo,
      Math.max(0, caja.ancho - margen.izq - margen.der),
      Math.max(0, caja.alto - margen.arriba - margen.abajo));
    const g = local(hijo.atributos, "layout_gravity") || local(nodo.atributos, "gravity");
    let x = caja.x + margen.izq;
    let y = caja.y + margen.arriba;
    if (/(^|\|)(center_horizontal|center)(\||$)/.test(g)) {
      x = caja.x + Math.max(0, (caja.ancho - tam.ancho) / 2);
    }
    if (/(^|\|)(center_vertical|center)(\||$)/.test(g)) {
      y = caja.y + Math.max(0, (caja.alto - tam.alto) / 2);
    }
    if (/(^|\|)(right|end)(\||$)/.test(g)) x = caja.x + Math.max(0, caja.ancho - tam.ancho - margen.der);
    if (/(^|\|)(bottom)(\||$)/.test(g)) y = caja.y + Math.max(0, caja.alto - tam.alto - margen.abajo);
    hijo.rect = { x, y, ancho: tam.ancho, alto: tam.alto };
    disponer(hijo);
  }
}

function disponer(nodo) {
  const pad = paddingDe(nodo);
  const caja = {
    x: nodo.rect.x + pad.izq,
    y: nodo.rect.y + pad.arriba,
    ancho: Math.max(0, nodo.rect.ancho - pad.izq - pad.der),
    alto: Math.max(0, nodo.rect.alto - pad.arriba - pad.abajo),
  };
  if (!nodo.hijos.length) return;
  if (contenedorDe(nodo) === "lineal") colocarLineal(nodo, caja, local(nodo.atributos, "orientation") !== "horizontal");
  else colocarMarco(nodo, caja);
}

// El modelo de la vista en vivo. La raíz ocupa la pantalla (como el `setContentView`), y el resto
// se reparte con las reglas de arriba. `ok:false` es un XML que no se puede leer: el panel conserva
// el render anterior en vez de pintar basura.
export function modeloDeLayout(xml, opciones = {}) {
  let elemento;
  try {
    elemento = analizarXml(xml);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), linea: (e && e.linea) || 0 };
  }
  const pantalla = {
    ancho: Number(opciones.pantalla && opciones.pantalla.ancho) > 0
      ? Number(opciones.pantalla.ancho) : PANTALLA_POR_DEFECTO.ancho,
    alto: Number(opciones.pantalla && opciones.pantalla.alto) > 0
      ? Number(opciones.pantalla.alto) : PANTALLA_POR_DEFECTO.alto,
  };
  const resolucion = { elementos: 0, sinStrings: 0 };
  const raiz = crearNodo(elemento, resolucion, opciones.strings || {}, opciones.colores || {});
  raiz.rect = { x: 0, y: 0, ancho: pantalla.ancho, alto: pantalla.alto };
  disponer(raiz);
  const modelo = {
    layout: typeof opciones.layout === "string" ? opciones.layout : "",
    pantalla,
    aproximado: true,
    origen: "editor",
    nodos: resolucion.elementos,
    sinStrings: resolucion.sinStrings,
    raiz,
  };
  return { ok: true, modelo };
}
