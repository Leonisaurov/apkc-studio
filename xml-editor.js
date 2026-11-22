// xml-editor.js — lo que el editor sabe del XML de Android sin tocar el DOM: el contexto de tecleo
// (etiqueta, atributo, valor o referencia), el catálogo de etiquetas/atributos/valores y el linter.
// Todo son funciones puras sobre texto: `prueba.js` las ejercita en node, `autocompletado.js` pinta
// la lista y `diagnostico-vivo.js` pinta los errores.
//
// Nada de red y nada de `DOMParser`: el XML de Android es un subconjunto y `vista-xml.js` ya
// demostró que un recorrido propio basta. Aquí el recorrido es **tolerante**: en vez de lanzar en
// el primer fallo devuelve una lista de diagnósticos con línea y columna, que es lo que el panel
// necesita para pintar el subrayado. La columna se cuenta en runes y desde 1, igual que `apkc`
// (§200): `diagnostico-vivo.js` la traduce a UTF-16 y a píxeles.
import { agregarIdsDeXml, agregarValores } from "./autocompletado-datos.js";

// --- catálogo ---------------------------------------------------------------------------
// Etiquetas por tipo de fichero: un `<string>` no pinta nada en un layout y `LinearLayout` no
// existe en un `values`.
const ETIQUETAS_VISTA = [
  "LinearLayout", "RelativeLayout", "FrameLayout", "GridLayout", "TableLayout", "TableRow",
  "ScrollView", "HorizontalScrollView", "NestedScrollView", "ConstraintLayout",
  "CoordinatorLayout", "AppBarLayout", "CollapsingToolbarLayout", "DrawerLayout",
  "SwipeRefreshLayout", "TextInputLayout", "View", "ViewGroup", "ViewStub", "Space",
  "TextView", "EditText", "AutoCompleteTextView", "MultiAutoCompleteTextView",
  "CheckedTextView", "TextInputEditText",
  "Button", "ImageButton", "ToggleButton", "CheckBox", "RadioButton", "RadioGroup", "Switch",
  "ImageView", "ProgressBar", "SeekBar", "RatingBar", "Spinner", "ListView", "GridView",
  "RecyclerView", "WebView", "VideoView", "SurfaceView", "TextureView", "CalendarView",
  "DatePicker", "TimePicker", "NumberPicker", "SearchView", "Toolbar", "TabHost", "TabWidget",
  "ViewFlipper", "ViewSwitcher", "AdapterViewFlipper", "NavigationView", "BottomNavigationView",
  "FloatingActionButton", "CardView", "Chip", "ChipGroup", "MaterialButton", "ViewPager",
  "ViewPager2", "ExpandableListView", "Gallery", "include", "merge", "requestFocus", "fragment",
];
const ETIQUETAS_VALORES = [
  "resources", "string", "color", "dimen", "integer", "bool", "style", "item", "string-array",
  "integer-array", "array", "plurals", "attr", "declare-styleable", "fraction",
];
const ETIQUETAS_MANIFIESTO = [
  "manifest", "application", "activity", "activity-alias", "service", "receiver", "provider",
  "uses-permission", "uses-permission-sdk-23", "permission", "uses-sdk", "uses-feature",
  "intent-filter", "action", "category", "data", "meta-data", "queries", "package",
  "uses-library", "uses-native-library", "profileable", "property", "grant-uri-permission",
  "path-permission", "instrumentation", "supports-screens", "compatible-screens",
];

// Atributos del framework, sin el prefijo `android:`. La lista no pretende ser el frameworks
// entero: es lo que se escribe en un layout/manifiesto normal y lo que el linter usa para
// proponer la corrección de una errata.
const ATRIBUTOS_ANDROID = [
  "id", "tag", "contentDescription", "importantForAccessibility", "accessibilityLabel",
  "layout_width", "layout_height", "layout_weight", "layout_margin", "layout_marginLeft",
  "layout_marginRight", "layout_marginTop", "layout_marginBottom", "layout_marginStart",
  "layout_marginEnd", "layout_marginHorizontal", "layout_marginVertical", "layout_gravity",
  "layout_centerInParent", "layout_centerHorizontal", "layout_centerVertical",
  "layout_alignParentTop", "layout_alignParentBottom", "layout_alignParentLeft",
  "layout_alignParentRight", "layout_alignParentStart", "layout_alignParentEnd",
  "layout_alignLeft", "layout_alignRight", "layout_alignTop", "layout_alignBottom",
  "layout_alignStart", "layout_alignEnd", "layout_below", "layout_above", "layout_toLeftOf",
  "layout_toRightOf", "layout_toStartOf", "layout_toEndOf", "layout_alignBaseline",
  "layout_span", "layout_column", "layout_row", "layout_columnSpan", "layout_rowSpan",
  "orientation", "gravity", "weightSum",
  "text", "textSize", "textColor", "textStyle", "textAllCaps", "textAlignment", "hint",
  "inputType", "maxLines", "minLines", "singleLine", "lines", "ellipsize", "maxLength",
  "imeOptions", "fontFamily", "lineSpacingExtra", "letterSpacing", "textAppearance",
  "padding", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "paddingStart",
  "paddingEnd", "paddingHorizontal", "paddingVertical",
  "background", "backgroundTint", "foreground", "foregroundTint", "src", "srcCompat",
  "scaleType", "adjustViewBounds", "visibility", "enabled", "clickable", "focusable",
  "focusableInTouchMode", "selected", "alpha", "rotation", "rotationX", "rotationY", "scaleX",
  "scaleY", "translationX", "translationY", "translationZ", "elevation", "onClick",
  "drawableLeft", "drawableRight", "drawableTop", "drawableBottom", "drawableStart",
  "drawableEnd", "drawablePadding", "tint", "tintMode",
  "checked", "button", "progress", "max", "min", "indeterminate", "numStars", "rating",
  "stepSize", "checkedButton", "divider", "dividerHeight", "listitem",
  "name", "value", "resource", "format", "label", "icon", "roundIcon", "theme",
  "screenOrientation", "exported", "launchMode", "parentActivityName", "configChanges",
  "allowBackup", "supportsRtl", "fullBackupContent", "versionCode", "versionName",
  "minSdkVersion", "targetSdkVersion", "hardwareAccelerated", "debuggable",
  "usesCleartextTraffic", "requestLegacyExternalStorage", "localeConfig",
  "enableOnBackInvokedCallback", "resizeableActivity", "alwaysRetainTaskState",
  "clearTaskOnLaunch", "noHistory", "stateNotNeeded", "taskAffinity", "excludeFromRecents",
  "finishOnTaskLaunch", "colorAccent", "colorPrimary", "colorPrimaryDark", "windowBackground",
  "windowLightStatusBar", "windowActionBar", "windowNoTitle", "largeHeap", "extractNativeLibs",
];

const ATRIBUTOS_TOOLS = [
  "context", "layout", "listitem", "itemCount", "ignore", "targetApi", "showIn",
  "viewBindingIgnore", "text", "visibility", "background", "srcCompat", "menu",
  "actionBarNavMode", "node", "tools", "listitem",
];

// Atributos sin prefijo: `values` y manifiesto los llevan así.
const ATRIBUTOS_SIN_PREFIJO = [
  "name", "type", "value", "format", "parent", "item", "description", "translatable",
];

// Valores enumerados por atributo (nombre local). Los que admiten `|` se ofrecen por el último
// tramo: `center|to` → se sugiere sobre `to`.
const VALORES = {
  layout_width: ["match_parent", "wrap_content", "fill_parent"],
  layout_height: ["match_parent", "wrap_content", "fill_parent"],
  width: ["match_parent", "wrap_content", "fill_parent"],
  height: ["match_parent", "wrap_content", "fill_parent"],
  orientation: ["vertical", "horizontal"],
  visibility: ["visible", "invisible", "gone"],
  gravity: ["center", "center_horizontal", "center_vertical", "left", "right", "top", "bottom",
    "start", "end", "fill", "fill_horizontal", "fill_vertical", "clip_horizontal",
    "clip_vertical"],
  layout_gravity: ["center", "center_horizontal", "center_vertical", "left", "right", "top",
    "bottom", "start", "end", "fill", "fill_horizontal", "fill_vertical"],
  textStyle: ["normal", "bold", "italic"],
  textAlignment: ["gravity", "center", "textStart", "textEnd", "viewStart", "viewEnd"],
  ellipsize: ["start", "middle", "end", "marquee"],
  scaleType: ["center", "centerCrop", "centerInside", "fitCenter", "fitEnd", "fitStart",
    "fitXY", "matrix"],
  inputType: ["text", "textCapCharacters", "textCapWords", "textCapSentences", "textMultiLine",
    "textPassword", "textEmailAddress", "textUri", "number", "numberDecimal", "numberSigned",
    "phone", "datetime", "date", "time"],
  layout_centerInParent: ["true", "false"],
  layout_centerHorizontal: ["true", "false"],
  layout_centerVertical: ["true", "false"],
  layout_alignParentTop: ["true", "false"],
  layout_alignParentBottom: ["true", "false"],
  layout_alignParentLeft: ["true", "false"],
  layout_alignParentRight: ["true", "false"],
  layout_alignParentStart: ["true", "false"],
  layout_alignParentEnd: ["true", "false"],
  exported: ["true", "false"],
  enabled: ["true", "false"],
  clickable: ["true", "false"],
  focusable: ["true", "false"],
  focusableInTouchMode: ["true", "false"],
  checked: ["true", "false"],
  selected: ["true", "false"],
  singleLine: ["true", "false"],
  adjustViewBounds: ["true", "false"],
  allowBackup: ["true", "false"],
  supportsRtl: ["true", "false"],
  hardwareAccelerated: ["true", "false"],
  debuggable: ["true", "false"],
  usesCleartextTraffic: ["true", "false"],
  requestLegacyExternalStorage: ["true", "false"],
  resizeableActivity: ["true", "false"],
  largeHeap: ["true", "false"],
  screenOrientation: ["portrait", "landscape", "sensor", "unspecified", "user", "behind",
    "nosensor", "fullSensor", "reversePortrait", "reverseLandscape", "locked", "fullUser"],
  launchMode: ["standard", "singleTop", "singleTask", "singleInstance", "singleInstancePerTask"],
  configChanges: ["orientation", "screenSize", "keyboardHidden", "locale", "uiMode",
    "screenLayout", "smallestScreenSize", "density", "fontScale", "layoutDirection", "mcc",
    "mnc", "navigation", "keyboard", "touchscreen"],
  format: ["reference", "string", "color", "dimension", "boolean", "integer", "float",
    "fraction", "enum", "flags"],
};

// Atributos que toman un recurso: qué tipos tiene sentido ofrecer cuando el valor está vacío.
const TIPOS_POR_ATRIBUTO = {
  text: ["string"], hint: ["string"], title: ["string"], summary: ["string"],
  label: ["string"], description: ["string"], contentDescription: ["string"],
  textOn: ["string"], textOff: ["string"], accessibilityLabel: ["string"],
  background: ["color", "drawable"], backgroundTint: ["color"], foreground: ["drawable"],
  foregroundTint: ["color"], src: ["drawable", "mipmap"], srcCompat: ["drawable", "mipmap"],
  icon: ["drawable", "mipmap"], roundIcon: ["drawable", "mipmap"], tint: ["color"],
  textColor: ["color"], colorAccent: ["color"], colorPrimary: ["color"],
  colorPrimaryDark: ["color"], windowBackground: ["color", "drawable"], layout: ["layout"],
  id: ["id"], style: ["style"], theme: ["style"], menu: ["menu"], fontFamily: ["font"],
  drawableLeft: ["drawable"], drawableRight: ["drawable"], drawableTop: ["drawable"],
  drawableBottom: ["drawable"], drawableStart: ["drawable"], drawableEnd: ["drawable"],
  listitem: ["layout"], divider: ["drawable", "color"],
};

// Atributos de color: cuando el valor está vacío se ofrecen los `@color` del proyecto.
const ATRIBUTOS_COLOR = new Set(["textColor", "background", "backgroundTint", "tint",
  "colorAccent", "colorPrimary", "colorPrimaryDark", "windowBackground", "foregroundTint"]);

// Tipos de recurso que el linter sabe comprobar. `id` no está: declarar un id con `@+id` es
// crearlo, y un `@id/` sin `+` puede venir de cualquier otra parte del proyecto.
const TIPOS_VERIFICABLES = ["string", "color", "dimen", "layout", "drawable", "mipmap", "menu",
  "xml", "style", "array", "plurals", "bool", "integer", "fraction", "font", "raw", "anim"];

// --- posición ---------------------------------------------------------------------------
// La columna va en runes y desde 1, como la de `apkc`; el editor la traduce a UTF-16.
function posicionDe(fuente, indice) {
  const hasta = Math.max(0, Math.min(Number(indice) || 0, fuente.length));
  const antes = fuente.slice(0, hasta);
  const salto = antes.lastIndexOf("\n");
  const linea = (antes.match(/\n/g) || []).length + 1;
  const columna = Array.from(antes.slice(salto + 1)).length + 1;
  return { linea, columna };
}

function grupoDe(ruta) {
  const r = String(ruta || "");
  if (/AndroidManifest\.xml$/i.test(r)) return "manifiesto";
  if (/\/res\/values[^/]*\//.test(r)) return "valores";
  return "vista";
}

function etiquetasPara(ruta) {
  const grupo = grupoDe(ruta);
  if (grupo === "manifiesto") return { grupo, etiquetas: ETIQUETAS_MANIFIESTO };
  if (grupo === "valores") return { grupo, etiquetas: ETIQUETAS_VALORES };
  return { grupo, etiquetas: ETIQUETAS_VISTA };
}

// --- estado del recorrido y contexto de tecleo --------------------------------------------
// Recorre el texto hasta el cursor y dice en qué se está: texto, comentario, cabecera o dentro
// de una etiqueta (con la comilla abierta, si la hay). De ahí sale todo lo demás.
function estadoEn(fuente, cursor) {
  let i = 0;
  let tipo = "texto";
  let inicio = 0;
  let comilla = null;
  while (i < cursor) {
    const c = fuente[i];
    if (tipo === "comentario") {
      const fin = fuente.indexOf("-->", i);
      if (fin === -1 || fin >= cursor) return { tipo, inicio };
      i = fin + 3;
      tipo = "texto";
      continue;
    }
    if (tipo === "cabecera") {
      const fin = fuente.indexOf("?>", i);
      if (fin === -1 || fin >= cursor) return { tipo, inicio };
      i = fin + 2;
      tipo = "texto";
      continue;
    }
    if (tipo === "etiqueta" || tipo === "declaracion") {
      if (comilla) {
        if (c === comilla) comilla = null;
      } else if (c === '"' || c === "'") {
        comilla = c;
      } else if (c === ">") {
        tipo = "texto";
      }
      i++;
      continue;
    }
    if (tipo === "cdata") {
      // `<![CDATA[ … ]]>` puede llevar `<`, `>` y `&` sin escapar: no es marcado y no se mira
      const fin = fuente.indexOf("]]>", i);
      if (fin === -1 || fin + 3 > cursor) return { tipo, inicio };
      i = fin + 3;
      tipo = "texto";
      continue;
    }
    // texto plano
    if (c === "<") {
      if (fuente.startsWith("<![CDATA[", i)) { tipo = "cdata"; inicio = i; i += 9; continue; }
      if (fuente.startsWith("<!--", i)) { tipo = "comentario"; inicio = i; i += 4; continue; }
      if (fuente.startsWith("<?", i)) { tipo = "cabecera"; inicio = i; i += 2; continue; }
      if (fuente.startsWith("<!", i)) { tipo = "declaracion"; inicio = i; i += 2; continue; }
      tipo = "etiqueta";
      inicio = i;
      i++;
      continue;
    }
    i++;
  }
  return { tipo, inicio };
}

// Parte el interior de una etiqueta (sin `<` ni `>`) en nombre y atributos con sus índices. Es
// tolerante: lo que no entiende lo salta en vez de reventar.
function analizarCuerpo(cuerpo) {
  let i = 0;
  while (i < cuerpo.length && /\s/.test(cuerpo[i])) i++;
  const m = /^[A-Za-z_][\w.:-]*/.exec(cuerpo.slice(i));
  const nombre = m ? m[0] : "";
  i += nombre.length;
  const finNombre = i;
  const atributos = [];
  let fin = finNombre;
  while (i < cuerpo.length) {
    while (i < cuerpo.length && /\s/.test(cuerpo[i])) i++;
    if (i >= cuerpo.length) break;
    if (cuerpo[i] === "/") { i++; continue; }
    const a = /^[A-Za-z_:][\w:.-]*/.exec(cuerpo.slice(i));
    if (!a) { i++; continue; }
    const attr = { nombre: a[0], inicio: i, igual: false, valor: "", valorDesde: i + a[0].length, comilla: null, abierto: false };
    i += a[0].length;
    fin = i;
    while (i < cuerpo.length && /\s/.test(cuerpo[i])) i++;
    if (cuerpo[i] === "=") {
      attr.igual = true;
      i++;
      while (i < cuerpo.length && /\s/.test(cuerpo[i])) i++;
      const q = cuerpo[i];
      if (q === '"' || q === "'") {
        attr.comilla = q;
        attr.valorDesde = i + 1;
        const cierre = cuerpo.indexOf(q, i + 1);
        if (cierre === -1) {
          attr.abierto = true;
          attr.valor = cuerpo.slice(i + 1);
          i = cuerpo.length;
        } else {
          attr.valor = cuerpo.slice(i + 1, cierre);
          i = cierre + 1;
        }
      } else {
        attr.valorDesde = i;
        const v = /^[^\s>]*/.exec(cuerpo.slice(i));
        attr.valor = v ? v[0] : "";
        i += attr.valor.length;
      }
      fin = i;
    }
    atributos.push(attr);
  }
  return { nombre, finNombre, atributos, fin };
}

// Clasifica el valor de un atributo: referencia a recurso (`@string/…`, `@+id/…`) o valor
// enumerado. `desde`/`hasta` son índices absolutos del textarea.
function clasificarValor(atributo, valor, valorDesde, hasta) {
  const m = /^@(\+)?([A-Za-z_][\w-]*)\//.exec(valor);
  if (m) {
    const prefijo = valor.slice(m[0].length);
    return {
      modo: "referencia", tipo: m[2], declara: m[1] === "+", atributo,
      prefijo, desde: hasta - prefijo.length, hasta,
    };
  }
  if (valor.startsWith("@")) {
    // `@` a secas o `@te`: se ofrecen los tipos de recurso, y se sustituye el valor entero
    return { modo: "referencia", tipo: "", declara: false, atributo, prefijo: valor,
      desde: valorDesde, hasta };
  }
  const corte = valor.lastIndexOf("|");
  const prefijo = corte >= 0 ? valor.slice(corte + 1) : valor;
  return { modo: "valor", atributo, prefijo, desde: hasta - prefijo.length, hasta };
}

// Qué se está completando en un XML y qué rango se sustituye. `null` fuera de una etiqueta,
// dentro de un comentario, de la cabecera `<?xml …?>` o de un cierre `</…>`.
function contextoXml(texto, cursor) {
  const fuente = String(texto == null ? "" : texto);
  const hasta = Math.max(0, Math.min(Number(cursor) || 0, fuente.length));
  const estado = estadoEn(fuente, hasta);
  if (estado.tipo !== "etiqueta") return null;
  const cuerpo = fuente.slice(estado.inicio + 1, hasta);
  const limpio = cuerpo.trimStart();
  if (!limpio || limpio.startsWith("/") || limpio.startsWith("!")) return null;
  const analisis = analizarCuerpo(cuerpo);
  if (!analisis.nombre) return null;
  const base = estado.inicio + 1;
  if (cuerpo.length <= analisis.finNombre) {
    return { modo: "etiqueta", prefijo: analisis.nombre,
      desde: base, hasta: base + analisis.nombre.length };
  }
  const ultimo = analisis.atributos[analisis.atributos.length - 1];
  if (ultimo && ultimo.abierto) {
    return clasificarValor(ultimo.nombre, ultimo.valor,
      base + ultimo.valorDesde, base + analisis.fin);
  }
  // el último atributo se está escribiendo ahora mismo y aún no lleva `=`: el prefijo es su nombre
  if (ultimo && !ultimo.igual && base + analisis.fin === hasta) {
    return { modo: "atributo", prefijo: ultimo.nombre, desde: base + ultimo.inicio, hasta };
  }
  if (ultimo && ultimo.igual && /=\s*$/.test(cuerpo) && !ultimo.comilla) {
    return { modo: "valor", atributo: ultimo.nombre, prefijo: "", desde: hasta, hasta };
  }
  // posición de nombre de atributo: lo tecleado desde el final del último atributo
  const cola = cuerpo.slice(analisis.fin);
  const parcial = /([A-Za-z_:][\w:.-]*)$/.exec(cola);
  const prefijo = parcial ? parcial[1] : "";
  return { modo: "atributo", prefijo, desde: hasta - prefijo.length, hasta };
}

// --- sugerencias -------------------------------------------------------------------------
function nombresDe(recursos, tipo) {
  const conjunto = recursos && recursos[tipo];
  if (!conjunto) return [];
  return [...conjunto].sort((a, b) => a.localeCompare(b));
}

// `datos` = { recursos: {tipo: Set}, id: Set de los `@+id` del buffer, ruta }.
// Devuelve `{estado, lista}` con el mismo formato que la lista Java; el estado empieza por `xml`
// para que el popup diga de qué lenguaje es.
function sugerenciasXml(ctx, datos) {
  const recursos = (datos && datos.recursos) || {};
  const ruta = (datos && datos.ruta) || "";

  if (ctx.modo === "etiqueta") {
    const { grupo, etiquetas } = etiquetasPara(ruta);
    const pista = grupo === "manifiesto" ? "manifiesto" : (grupo === "valores" ? "recurso" : "vista");
    return {
      estado: `xml · etiquetas de ${grupo} · ${etiquetas.length}`,
      lista: etiquetas.map((e) => ({ texto: e, insertar: e, pista, clase: "etiqueta" })),
    };
  }

  if (ctx.modo === "atributo") {
    const { grupo } = etiquetasPara(ruta);
    // Con algo tecleado y sin prefijo (`textS`), se filtra por el nombre local pero se inserta
    // la forma completa: nadie escribe `android:` dos veces.
    const sinPrefijo = !!ctx.prefijo && !ctx.prefijo.includes(":");
    const item = (texto, insertar, pista, clase) => ({
      texto, insertar,
      filtro: sinPrefijo ? String(texto).replace(/^(?:android|tools):/, "") : texto,
      pista, clase,
    });
    const lista = [];
    for (const a of ATRIBUTOS_ANDROID) lista.push(item("android:" + a, "android:" + a, "android", "atributo"));
    for (const a of ATRIBUTOS_TOOLS) lista.push(item("tools:" + a, "tools:" + a, "herramienta", "atributo"));
    if (grupo !== "vista") {
      for (const a of ATRIBUTOS_SIN_PREFIJO) lista.push(item(a, a, "sin prefijo", "atributo"));
    }
    return { estado: `xml · atributos android: · ${lista.length}`, lista };
  }

  if (ctx.modo === "referencia") {
    const tipo = ctx.tipo;
    if (!tipo) {
      const tipos = ["string", "color", "dimen", "layout", "drawable", "mipmap", "style",
        "menu", "xml", "array", "bool", "integer", "font", "raw", "anim"];
      return {
        estado: `xml · tipos de recurso · ${tipos.length}`,
        lista: tipos.map((t) => ({ texto: "@" + t + "/", insertar: "@" + t + "/",
          pista: "referencia", clase: "referencia" })),
      };
    }
    let nombres = nombresDe(recursos, tipo);
    if (tipo === "id" && datos && datos.id) {
      nombres = [...new Set(nombres.concat([...datos.id]))].sort((a, b) => a.localeCompare(b));
    }
    return {
      estado: `xml · @${tipo} · ${nombres.length} nombres`,
      lista: nombres.map((n) => ({ texto: n, insertar: n, pista: "@" + tipo + "/", clase: "recurso" })),
    };
  }

  // valor enumerado, o referencias cuando el atributo toma un recurso
  const local = String(ctx.atributo || "").replace(/^.*:/, "");
  const enumerados = VALORES[local] || [];
  if (enumerados.length) {
    return {
      estado: `xml · valores de ${ctx.atributo} · ${enumerados.length}`,
      lista: enumerados.map((v) => ({ texto: v, insertar: v, pista: ctx.atributo, clase: "valor" })),
    };
  }
  const tipos = TIPOS_POR_ATRIBUTO[local] || (ATRIBUTOS_COLOR.has(local) ? ["color"] : []);
  const lista = [];
  for (const tipo of tipos) {
    const nombres = nombresDe(recursos, tipo).concat(tipo === "id" && datos && datos.id ? [...datos.id] : []);
    for (const nombre of new Set(nombres)) {
      lista.push({ texto: "@" + tipo + "/" + nombre, insertar: "@" + tipo + "/" + nombre,
        pista: ctx.atributo, clase: "referencia" });
    }
  }
  if (!lista.length) {
    return { estado: `xml · ${ctx.atributo || "valor"} · sin valores enumerados`, lista: [] };
  }
  return { estado: `xml · referencias de ${ctx.atributo} · ${lista.length}`, lista };
}

// --- linter ------------------------------------------------------------------------------
// Distancia de edición con corte: solo interesa saber si dos nombres se parecen lo bastante para
// que el aviso sea útil (una errata), no la distancia exacta de dos nombres distintos.
function parecido(a, b, maximo) {
  if (Math.abs(a.length - b.length) > maximo) return maximo + 1;
  const anterior = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) anterior[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = anterior[0];
    anterior[0] = i;
    let fila = i;
    for (let j = 1; j <= b.length; j++) {
      const arriba = anterior[j];
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      const valor = Math.min(anterior[j] + 1, anterior[j - 1] + 1, diagonal + costo);
      anterior[j] = valor;
      if (valor < fila) fila = valor;
      diagonal = arriba;
    }
    if (fila > maximo) return maximo + 1;
  }
  return anterior[b.length];
}

function atributoParecido(local) {
  let mejor = null;
  let mejorDistancia = 3;
  for (const conocido of ATRIBUTOS_ANDROID) {
    const d = parecido(local, conocido, 2);
    if (d < mejorDistancia) { mejorDistancia = d; mejor = conocido; }
  }
  return mejorDistancia <= 2 ? mejor : null;
}

// Recorre el texto y devuelve `{etiquetas, errores}`. Las etiquetas llevan sus posiciones para
// que el linter pueda señalar el token y no la línea entera.
function leerEtiquetas(fuente) {
  const etiquetas = [];
  const errores = [];
  let i = 0;
  const error = (indice, mensaje) => {
    const p = posicionDe(fuente, indice);
    errores.push({ linea: p.linea, columna: p.columna, mensaje, origen: "XML" });
  };
  while (i < fuente.length) {
    if (fuente.startsWith("<![CDATA[", i)) {
      // el contenido de un CDATA es texto, no marcado: `<b>text & stuff</b>` es un literal
      const fin = fuente.indexOf("]]>", i + 9);
      if (fin === -1) { error(i, "sección CDATA sin cerrar"); break; }
      i = fin + 3;
      continue;
    }
    if (fuente.startsWith("<!--", i)) {
      const fin = fuente.indexOf("-->", i + 4);
      if (fin === -1) { error(i, "comentario sin cerrar"); break; }
      i = fin + 3;
      continue;
    }
    if (fuente.startsWith("<?", i)) {
      const fin = fuente.indexOf("?>", i + 2);
      if (fin === -1) { error(i, "cabecera sin cerrar"); break; }
      i = fin + 2;
      continue;
    }
    if (fuente.startsWith("<!", i)) {
      // declaración o DOCTYPE: se salta hasta el `>` de fuera de comillas y de un subconjunto
      // interno `[ … ]` (`<!DOCTYPE x [ <!ELEMENT y (#PCDATA)> ]>`)
      let j = i + 2;
      let corchetes = 0;
      let comilla = null;
      while (j < fuente.length) {
        const c = fuente[j];
        if (comilla) { if (c === comilla) comilla = null; }
        else if (c === '"' || c === "'") comilla = c;
        else if (c === "[") corchetes++;
        else if (c === "]") corchetes = Math.max(0, corchetes - 1);
        else if (c === ">" && corchetes === 0) break;
        j++;
      }
      if (j >= fuente.length) { error(i, "declaración sin cerrar"); break; }
      i = j + 1;
      continue;
    }
    if (fuente[i] !== "<") { i++; continue; }
    // desde `<` hasta `>`, respetando las comillas
    let j = i + 1;
    let comilla = null;
    let comillaEn = -1;
    while (j < fuente.length) {
      const c = fuente[j];
      if (comilla) {
        if (c === comilla) comilla = null;
      } else if (c === '"' || c === "'") {
        comilla = c;
        comillaEn = j;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    const abierta = j >= fuente.length;
    if (comilla) error(comillaEn, "comillas sin cerrar en un valor");
    const interior = fuente.slice(i + 1, abierta ? fuente.length : j);
    if (!interior.trim()) { error(i, "etiqueta vacía"); i = j + 1; continue; }
    const cierre = interior.trimStart().startsWith("/");
    const autocierre = interior.trimEnd().endsWith("/");
    const cuerpo = cierre
      ? interior.trimStart().slice(1).trim()
      : (autocierre ? interior.trimEnd().slice(0, -1) : interior);
    const analisis = analizarCuerpo(cuerpo);
    if (!analisis.nombre) {
      error(i, "etiqueta inválida");
    } else {
      etiquetas.push({
        inicio: i, nombre: analisis.nombre, cierre, autocierre,
        atributos: analisis.atributos.map((a) => ({
          nombre: a.nombre, inicio: i + 1 + a.inicio, igual: a.igual,
          valor: a.valor, valorDesde: i + 1 + a.valorDesde,
        })),
      });
      if (!cierre) {
        for (const a of analisis.atributos) {
          if (!a.igual) {
            const p = posicionDe(fuente, i + 1 + a.inicio);
            errores.push({ linea: p.linea, columna: p.columna,
              mensaje: "el atributo " + a.nombre + " no lleva valor", origen: "XML" });
          }
        }
      }
    }
    if (abierta) {
      if (!comilla) error(i, "la etiqueta <" + (analisis.nombre || "?") + "> no se cierra con >");
      break;
    }
    i = j + 1;
  }
  return { etiquetas, errores };
}

// Valida el XML mientras se escribe. `opciones` = { archivo, recursos, maximo }:
//   - archivo: la ruta real, de la que se decide qué comprobar de recursos;
//   - recursos: el mapa del proyecto que barre `recursos-proyecto.js` (puede venir vacío);
//   - maximo: tope de diagnósticos (80 por defecto).
// Las declaraciones del propio buffer cuentan: un `<string>` que se acaba de escribir o un
// `@+id` que se repite en el fichero abierto se ven sin guardar.
export function diagnosticarXml(texto, opciones = {}) {
  const fuente = String(texto == null ? "" : texto);
  const archivo = typeof opciones.archivo === "string" ? opciones.archivo : "";
  const maximo = Number(opciones.maximo) > 0 ? Number(opciones.maximo) : 80;
  const propios = {};
  agregarIdsDeXml(fuente, propios);
  if (grupoDe(archivo) === "valores") agregarValores(fuente, propios);
  const recursos = opciones.recursos || {};

  const { etiquetas, errores } = leerEtiquetas(fuente);

  // estructura: pila de etiquetas abiertas
  const pila = [];
  for (const etiqueta of etiquetas) {
    if (etiqueta.cierre) {
      const p = posicionDe(fuente, etiqueta.inicio);
      if (!pila.length) {
        errores.push({ linea: p.linea, columna: p.columna,
          mensaje: "cierra </" + etiqueta.nombre + "> sin abrir nada", origen: "XML" });
        continue;
      }
      const abierta = pila[pila.length - 1];
      if (abierta.nombre !== etiqueta.nombre) {
        errores.push({ linea: p.linea, columna: p.columna,
          mensaje: "cierra </" + etiqueta.nombre + "> pero estaba abierto <" + abierta.nombre + ">",
          origen: "XML" });
      }
      pila.pop();
      continue;
    }
    if (!etiqueta.autocierre) pila.push(etiqueta);
  }
  for (const abierta of pila) {
    const p = posicionDe(fuente, abierta.inicio);
    errores.push({ linea: p.linea, columna: p.columna,
      mensaje: "la etiqueta <" + abierta.nombre + "> no se cierra", origen: "XML" });
  }

  // atributos: erratas de `android:` y referencias a recursos que no existen
  const idsDeclarados = new Map();
  const existe = (tipo, nombre) => {
    const propio = propios[tipo];
    if (propio && propio.has(nombre)) return true;
    const delProyecto = recursos[tipo];
    return !!(delProyecto && delProyecto.has(nombre));
  };
  const hayDatos = (tipo) => {
    const propio = propios[tipo];
    const delProyecto = recursos[tipo];
    return !!((propio && propio.size) || (delProyecto && delProyecto.size));
  };

  for (const etiqueta of etiquetas) {
    if (etiqueta.cierre) continue;
    for (const atributo of etiqueta.atributos) {
      const nombre = atributo.nombre;
      if (nombre.startsWith("android:")) {
        const local = nombre.slice("android:".length);
        if (!ATRIBUTOS_ANDROID.includes(local)) {
          const sugerido = atributoParecido(local);
          if (sugerido) {
            const p = posicionDe(fuente, atributo.inicio);
            errores.push({ linea: p.linea, columna: p.columna,
              mensaje: "el atributo " + nombre + " no existe en Android; ¿" + sugerido + "?",
              origen: "XML" });
          }
        }
      }
      const valor = String(atributo.valor || "");
      // @+id duplicado en el mismo fichero: declarar dos veces el mismo id casi siempre es una copia
      for (const m of valor.matchAll(/@\+id\/([A-Za-z_]\w*)/g)) {
        const p = posicionDe(fuente, atributo.valorDesde + m.index);
        if (idsDeclarados.has(m[1])) {
          errores.push({ linea: p.linea, columna: p.columna,
            mensaje: "el id " + m[1] + " ya se declaró en la línea " + idsDeclarados.get(m[1]),
            origen: "XML" });
        } else {
          idsDeclarados.set(m[1], p.linea);
        }
      }
      // @string/x, @color/y… que no están en el proyecto. `@android:` y `@*android:` son del
      // framework; `@null`/`@empty` no son recursos.
      for (const m of valor.matchAll(/@(?!\+)([A-Za-z_][\w-]*)\/([A-Za-z_][\w.]*)/g)) {
        const tipo = m[1];
        if (tipo === "android" || !TIPOS_VERIFICABLES.includes(tipo)) continue;
        if (!hayDatos(tipo)) continue;
        if (existe(tipo, m[2])) continue;
        const p = posicionDe(fuente, atributo.valorDesde + m.index);
        errores.push({ linea: p.linea, columna: p.columna,
          mensaje: "no existe @" + tipo + "/" + m[2] + " en el proyecto", origen: "XML" });
      }
    }
  }

  const vistos = new Set();
  const limpios = [];
  for (const e of errores) {
    const clave = e.linea + ":" + e.columna + ":" + e.mensaje;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    limpios.push(e);
  }
  limpios.sort((a, b) => a.linea - b.linea || a.columna - b.columna);
  return limpios.slice(0, maximo);
}

export {
  ETIQUETAS_VISTA, ETIQUETAS_VALORES, ETIQUETAS_MANIFIESTO,
  ATRIBUTOS_ANDROID, ATRIBUTOS_TOOLS, VALORES,
  grupoDe, etiquetasPara, contextoXml, sugerenciasXml, posicionDe,
};
