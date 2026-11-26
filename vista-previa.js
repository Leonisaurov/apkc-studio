// La vista previa de la pestaña: toma el JSON que imprime `apkc preview` y lo pinta en un
// <canvas> de solo lectura (no se arrastra ni se edita nada). Las funciones de modelo —
// `modeloDeSalida`, `textoDeNodo`, `nodosAplanados`, `escalaPara` y `rectsEscalados` — son puras y
// se prueban en node; solo `pintarModelo` y `pintarVistaPrevia` tocan el DOM. El canvas existe
// únicamente en la página: ninguna de las funciones puras lee `document`, así que importar este
// módulo desde `prueba.js` no necesita navegador.
//
// El modelo de la Fase 1 es:
//   {paquete, version, actividad, layout, pantalla:{x,y,ancho,alto}, aproximado, nodos,
//    raiz:{tipo, id, idRef, texto, estilo, ancho, alto, rect, hijos:[…]}}
// La Fase 2 puede añadir un campo de texto dinámico al nodo. Aquí se tolera: cualquier clave
// `texto…` distinta de `texto` con una cadena no vacía tiene prioridad (orden alfabético, para que
// la elección sea determinista) y `texto` queda como respaldo. Un campo desconocido no rompe el
// pintor ni la lectura: el modelo se consume tal cual y solo se leen las claves que se usan.

// Las medidas de la aproximación que publica apkc, por si el modelo llegara sin `pantalla`.
const PANTALLA_POR_DEFECTO = { x: 0, y: 0, ancho: 360, alto: 640 };
const NODOS_MAXIMOS = 512;

// Colores del tema del aparato, medidos sobre Contador.apk en Droidloom (wm density 213):
// `windowBackground=@android:color/white`, `textColorPrimary=#30323a` y el fondo de
// `Widget.Material.Button` sale #d6d7d7. Son del tema de la APP, no del editor: el lienzo
// representa la pantalla del teléfono aunque quien lo mire esté en tema oscuro.
const TEMA_APARATO = { fondo: "#ffffff", texto: "#30323a", boton: "#d6d7d7" };
// Los tipos que admiten teclado: los mismos de `admiteTecleo` en apkc preview y de
// `TIPOS_CON_TECLADO` en previa-panel.js. Se repiten aquí para no crear un import circular (ese
// módulo ya importa este); solo sirven para dar al EditText su fondo y su subrayado.
const TIPOS_CON_TECLADO = new Set([
  "EditText", "AutoCompleteTextView", "MultiAutoCompleteTextView", "TextInputEditText",
]);
// Widget.Material.Button (android.jar 34) declara minWidth=88dp; el minHeight declarado es 48dp,
// pero el gris que ART pinta en el aparato mide 40dp: en la captura de Contador.apk en Droidloom
// (1920×1080, density 213) el relleno va de y=408 a y=460, es decir 52 px × 160/213 ≈ 39dp.
// La aproximación de apkc no impone estos mínimos, así que `modeloConMinimos` los aplica al modelo
// **antes** de reescalarlo y devolviendo el centro: ensanchar sin restituirlo corría el botón 12dp.
const ANCHO_BOTON_DP = 88;
const ALTO_BOTON_DP = 40;
const RADIO_BOTON_DP = 4;
// Theme.DeviceDefault.Light usa 14sp por defecto; TextAppearance.Large/Medium/Small son
// 22/18/14sp. `sp` y `dp` coinciden con la escala de fuente del aparato (factor 1).
const TEXTO_DP = 14;
const TEXTO_POR_ESTILO = {
  "1030042": 22, // @android:style/TextAppearance.Large
  "1030044": 18, // @android:style/TextAppearance.Medium
  "1030046": 14, // @android:style/TextAppearance.Small
};

// El mensaje del panel vacío. Vive aquí y lo importa `previa-panel.js` para que el estado vacío
// de las dos superficies (la vista dividida y Pantalla) diga exactamente lo mismo: el canvas de
// las dos es el Emulador, no el modo Vista previa, que dibuja el XML sin compilar.
export const MENSAJE_SIN_MODELO = "Compila el proyecto (Editor → Compilar → Compilar debug) para " +
  "ver aquí la pantalla del emulador y lo que ejecuta la app.";

// Una medida usable. El JSON de apkc trae números, pero un modelo manipulado o una fase futura
// puede colar `null`, cadenas, `NaN` o `1e400` (que es `Infinity`): ninguno de esos es una
// medida. Devolver null deja que el llamante use su respaldo en vez de propagar `NaN` al
// canvas, que se traga los rectángulos sin lanzar nada. No la confundas con `aNumeroOCero` de
// `vista-xml.js`: esta distingue «no hay medida» (null) de un cero legítimo.
function aNumeroOFinito(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor === "string" && valor.trim() !== "") {
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Caja segura para un modelo que no se puede medir: cero rectángulos y `valida: false`, que es
// lo que el pintor y la línea de estado usan para no fingir una pantalla.
function cajaNula() {
  return { escala: 0, x: 0, y: 0, ancho: 0, alto: 0, valida: false };
}

// Busca, entre las líneas de la consola del comando, la que es el modelo. apkc manda el JSON a
// stdout (una sola línea) y la línea de cierre a stderr, así que no vale con tomar la última.
// Devuelve null si no hay ninguna línea que sea un modelo con `raiz` y `pantalla`.
export function modeloDeSalida(salida) {
  for (const linea of String(salida || "").split("\n")) {
    const limpia = linea.trim();
    if (!limpia.startsWith("{") || !limpia.endsWith("}")) continue;
    let modelo;
    try { modelo = JSON.parse(limpia); } catch (e) { continue; }
    if (modelo && typeof modelo === "object" && modelo.raiz && modelo.pantalla) return modelo;
  }
  return null;
}

// El texto visible de un nodo. `texto` es el del layout; si la ejecución añadió un texto
// (`textoDinamico`, `textoCapturado`, …) gana el ÚLTIMO, porque describe el estado final de la
// vista: la app puede haber vuelto a escribir una cadena vacía y esa también es la pantalla de
// verdad. Se miran todas las claves que empiezan por `texto` menos `texto` y se toma la última en
// orden alfabético, para no depender del nombre exacto que elija la otra fase ni del orden en que
// el modelo serializó los campos.
export function textoDeNodo(nodo) {
  if (!nodo || typeof nodo !== "object") return "";
  const dinamicas = Object.keys(nodo)
    .filter((clave) => clave !== "texto" && /^texto[A-Z_]/.test(clave) &&
      typeof nodo[clave] === "string")
    .sort();
  if (dinamicas.length) return String(nodo[dinamicas[dinamicas.length - 1]]);
  return typeof nodo.texto === "string" ? nodo.texto : "";
}

// Recorre el árbol en el orden del XML (padre antes que hijos) y devuelve pares
// {nodo, profundidad}. La cota evita que un JSON hostil con un ciclo deje la pestaña colgada.
export function nodosAplanados(modelo) {
  const salida = [];
  if (!modelo || !modelo.raiz || typeof modelo.raiz !== "object") return salida;
  const pila = [{ nodo: modelo.raiz, profundidad: 0 }];
  while (pila.length && salida.length < NODOS_MAXIMOS) {
    const { nodo, profundidad } = pila.pop();
    if (!nodo || typeof nodo !== "object") continue;
    salida.push({ nodo, profundidad });
    const hijos = Array.isArray(nodo.hijos) ? nodo.hijos : [];
    // al revés para que el primero del XML sea el primero en pintarse
    for (let i = hijos.length - 1; i >= 0; i--) pila.push({ nodo: hijos[i], profundidad: profundidad + 1 });
  }
  return salida;
}

// Una dimensión declarada en dp/sp/px, en unidades dp del modelo. Sin unidades también cuenta:
// el JAX de `apkc preview` escribe números en algunos campos de medida.
function dpDeValor(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) && valor > 0 ? valor : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(sp|dp|dip|px)?\s*$/i.exec(String(valor || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// La apariencia por defecto de una vista sin atributos, tal como la pinta ART con el tema medido.
// Es pura y se prueba en node: decide el relleno del fondo, el tamaño y peso de la letra, las
// mayúsculas del Button y el relleno interior. Lo que el modelo declare gana siempre al respaldo.
export function aparienciaDe(nodo) {
  const tipo = typeof nodo?.tipo === "string" ? nodo.tipo : "";
  const boton = /Button/.test(tipo);
  const estilo = String(nodo?.estilo || "");
  const idEstilo = (/0x([0-9a-f]+)/i.exec(estilo) || [])[1];
  const porEstilo = idEstilo
    ? TEXTO_POR_ESTILO[idEstilo.toLowerCase().replace(/^0+/, "")] || null : null;
  const tamanoDp = dpDeValor(nodo?.tamTexto) || porEstilo || TEXTO_DP;
  const peso = /bold/i.test(String(nodo?.estiloTexto || "")) ? 700 : (boton ? 500 : 400);
  const pad = nodo?.padding && typeof nodo.padding === "object" ? nodo.padding : {};
  // apkc escribe `arr`/`aba`; el modelo del editor (vista-xml.js) escribe `arriba`/`abajo`.
  const alias = { izq: "izq", der: "der", arr: "arriba", aba: "abajo" };
  const lado = (clave, respaldo) => {
    const valor = aNumeroOFinito(pad[clave]);
    const otro = aNumeroOFinito(pad[alias[clave]]);
    const elegido = valor !== null && valor >= 0 ? valor : otro;
    return elegido !== null && elegido >= 0 ? elegido : respaldo;
  };
  const relleno = {
    izq: lado("izq", boton ? 16 : 0),
    der: lado("der", boton ? 16 : 0),
    arr: lado("arr", boton ? 8 : 0),
    aba: lado("aba", boton ? 8 : 0),
  };
  // Solo lo que el layout declara llega en `fondo`; el gris del botón por defecto lo pinta
  // `pintarFondoBoton` con esquinas redondeadas, como el drawable del tema.
  const fondo = typeof nodo?.fondo === "string" && nodo.fondo.trim() !== ""
    ? nodo.fondo : "";
  const colorTexto = typeof nodo?.colorTexto === "string" && nodo.colorTexto.trim() !== ""
    ? nodo.colorTexto : (typeof nodo?.color === "string" && nodo.color.trim() !== ""
      ? nodo.color : TEMA_APARATO.texto);
  return { boton, tamanoDp, peso, mayusculas: boton, relleno, fondo, colorTexto };
}

// Encaja la pantalla del modelo en una caja (el canvas en píxeles CSS) sin deformarla: una sola
// escala para los dos ejes y centrada. La traslación resta el origen de `pantalla` y centra el
// rectángulo de la pantalla dentro de la caja.
export function escalaPara(modelo, ancho, alto) {
  const pantalla = (modelo && modelo.pantalla) || {};
  const anchoDeclarado = aNumeroOFinito(pantalla.ancho);
  const altoDeclarado = aNumeroOFinito(pantalla.alto);
  const anchoPantalla = anchoDeclarado !== null && anchoDeclarado > 0
    ? anchoDeclarado : PANTALLA_POR_DEFECTO.ancho;
  const altoPantalla = altoDeclarado !== null && altoDeclarado > 0
    ? altoDeclarado : PANTALLA_POR_DEFECTO.alto;
  const anchoCaja = aNumeroOFinito(ancho);
  const altoCaja = aNumeroOFinito(alto);
  const cajaAncho = anchoCaja !== null && anchoCaja > 0 ? anchoCaja : anchoPantalla;
  const cajaAlto = altoCaja !== null && altoCaja > 0 ? altoCaja : altoPantalla;
  const escala = Math.min(cajaAncho / anchoPantalla, cajaAlto / altoPantalla);
  // 1e400 llega como Infinity y su división da 0 o NaN: ninguna de las dos es una escala
  if (!Number.isFinite(escala) || escala <= 0) return cajaNula();
  const x = (cajaAncho - anchoPantalla * escala) / 2 - (aNumeroOFinito(pantalla.x) || 0) * escala;
  const y = (cajaAlto - altoPantalla * escala) / 2 - (aNumeroOFinito(pantalla.y) || 0) * escala;
  const caja = {
    escala,
    x,
    y,
    ancho: anchoPantalla * escala,
    alto: altoPantalla * escala,
    valida: true,
  };
  if (![caja.escala, caja.x, caja.y, caja.ancho, caja.alto].every(Number.isFinite)) return cajaNula();
  return caja;
}

// Aplica los mínimos medidos del botón al MODELO, antes de cualquier reescalado. Es una copia:
// el contrato de la vista dividida es que mirar no muta el modelo. Restituye el centro en los dos
// ejes, porque agrandar la caja por la izquierda y arriba desplazaba el botón (y su texto) respecto
// de ART. Al hacerlo aquí, `modeloConPantalla` de `previa-panel.js` escala ya el rect final: con una
// pantalla de 180×320 el botón mide 44×20 en vez de volver a 88×48 «porque sí».
// Recorta un rectángulo de capa DOM (coordenadas de viewport) al rect del canvas. Es lo que evita
// que el `<input>` del EditText, que se coloca sobre el emulador, se vea fuera de la pantalla (§337).
// No muta ni el rect entrado ni la caja; devuelve null si alguna medida no es finita.
export function recortaACaja(rect, caja) {
  if (!rect || !caja) return null;
  const x = Number(rect.x), y = Number(rect.y);
  const ancho = Number(rect.ancho), alto = Number(rect.alto);
  const izqCaja = Number(caja.left), arrCaja = Number(caja.top);
  const anchoCaja = Number(caja.width), altoCaja = Number(caja.height);
  if (![x, y, ancho, alto, izqCaja, arrCaja, anchoCaja, altoCaja].every(Number.isFinite)) return null;
  const izq = Math.max(izqCaja, x);
  const arr = Math.max(arrCaja, y);
  const der = Math.max(izq, Math.min(izqCaja + anchoCaja, x + ancho));
  const abajo = Math.max(arr, Math.min(arrCaja + altoCaja, y + alto));
  return { x: izq, y: arr, ancho: der - izq, alto: abajo - arr };
}

// Refluye una fila de botones que, después de aplicar los mínimos de ART, no cabe en su padre.
// No quita ningún botón ni recorta su texto: reduce proporcionalmente anchos y huecos, con el
// mismo centro relativo, para que los cinco botones de `notas` queden dentro de 360 dp (§336).
// Una fila con un solo botón no se toca: es el caso medido en §293, cuyo centro se conserva.
function refluyeFilaBotones(nodo) {
  if (!nodo || typeof nodo !== "object") return;
  if (Array.isArray(nodo.hijos)) {
    for (const hijo of nodo.hijos) refluyeFilaBotones(hijo);
    const botones = nodo.hijos.filter((h) => h && h.tipo === "Button" && h.rect &&
      [h.rect.x, h.rect.y, h.rect.ancho, h.rect.alto].every(Number.isFinite));
    if (botones.length > 1 && nodo.rect && Number.isFinite(nodo.rect.ancho)) {
      const y = botones[0].rect.y;
      const mismaFila = botones.filter((b) => Math.abs(b.rect.y - y) < 1);
      if (mismaFila.length > 1) {
        const izq = Math.min(...mismaFila.map((b) => b.rect.x));
        const der = Math.max(...mismaFila.map((b) => b.rect.x + b.rect.ancho));
        const padre = nodo.rect.x;
        const disponible = nodo.rect.ancho;
        if (der - izq > disponible && disponible > 0) {
          const factor = disponible / (der - izq);
          for (const b of mismaFila) {
            b.rect.ancho = Math.max(1, b.rect.ancho * factor);
            b.rect.x = padre + (b.rect.x - izq) * factor;
          }
        }
      }
    }
  }
}

// Propaga los mínimos de ART al contenedor inmediato y al hermano que comparte eje con el botón
// crecido. El botón NO se mueve: conserva el centro que mide §293; quien cede es el contenedor —su
// medida pasa a ser max(medida, máximo de hijos con mínimos + padding)— y el EditText, que se remide
// antes del escalado para no solaparse con la caja ensanchada (layout de ApkShare). Solo se toca al
// padre que tiene un botón crecido como hijo directo: la raíz `match_parent` no se agranda por un
// nieto, y una fila de varios botones ya se resolvió en `refluyeFilaBotones` (§336).
function propagaMinimos(nodo, cambios) {
  if (!nodo || typeof nodo !== "object") return;
  if (Array.isArray(nodo.hijos)) for (const hijo of nodo.hijos) propagaMinimos(hijo, cambios);
  if (!nodo.rect || !Array.isArray(nodo.hijos) ||
      ![nodo.rect.x, nodo.rect.y, nodo.rect.ancho, nodo.rect.alto]
        .every((v) => aNumeroOFinito(v) !== null)) return;
  const buenos = nodo.hijos.filter((h) => h && h.rect &&
    [h.rect.x, h.rect.y, h.rect.ancho, h.rect.alto].every((v) => aNumeroOFinito(v) !== null));
  const crecidos = buenos.filter((h) => cambios.has(h) && aparienciaDe(h).boton);
  if (!crecidos.length) return;
  for (const boton of crecidos) {
    for (const hermano of buenos) {
      if (hermano === boton || aparienciaDe(hermano).boton) continue;
      const solapaY = hermano.rect.y < boton.rect.y + boton.rect.alto &&
        boton.rect.y < hermano.rect.y + hermano.rect.alto;
      const solapaX = hermano.rect.x < boton.rect.x + boton.rect.ancho &&
        boton.rect.x < hermano.rect.x + hermano.rect.ancho;
      if (solapaY && hermano.rect.x <= boton.rect.x &&
          hermano.rect.x + hermano.rect.ancho > boton.rect.x) {
        hermano.rect.ancho = Math.max(1, boton.rect.x - hermano.rect.x);
      } else if (solapaY && hermano.rect.x > boton.rect.x &&
                 hermano.rect.x < boton.rect.x + boton.rect.ancho) {
        const der = hermano.rect.x + hermano.rect.ancho;
        hermano.rect.x = boton.rect.x + boton.rect.ancho;
        hermano.rect.ancho = Math.max(1, der - hermano.rect.x);
      } else if (solapaX && hermano.rect.y <= boton.rect.y &&
                 hermano.rect.y + hermano.rect.alto > boton.rect.y) {
        hermano.rect.alto = Math.max(1, boton.rect.y - hermano.rect.y);
      } else if (solapaX && hermano.rect.y > boton.rect.y &&
                 hermano.rect.y < boton.rect.y + boton.rect.alto) {
        const abajo = hermano.rect.y + hermano.rect.alto;
        hermano.rect.y = boton.rect.y + boton.rect.alto;
        hermano.rect.alto = Math.max(1, abajo - hermano.rect.y);
      }
    }
  }
  const pad = nodo.padding && typeof nodo.padding === "object" ? nodo.padding : {};
  const der = aNumeroOFinito(pad.der) ?? 0;
  const aba = aNumeroOFinito(pad.aba) ?? 0;
  const maxDer = Math.max(...buenos.map((h) => h.rect.x + h.rect.ancho));
  const maxAbajo = Math.max(...buenos.map((h) => h.rect.y + h.rect.alto));
  nodo.rect.ancho = Math.max(nodo.rect.ancho, maxDer - nodo.rect.x + der);
  nodo.rect.alto = Math.max(nodo.rect.alto, maxAbajo - nodo.rect.y + aba);
}

export function modeloConMinimos(modelo) {
  if (!modelo || typeof modelo !== "object" || !modelo.raiz) return modelo;
  const cambios = new WeakMap();
  const copiar = (nodo) => {
    if (!nodo || typeof nodo !== "object") return nodo;
    const copia = { ...nodo };
    if (nodo.rect && typeof nodo.rect === "object") {
      const { x, y, ancho, alto } = nodo.rect;
      if ([x, y, ancho, alto].every((v) => aNumeroOFinito(v) !== null)) {
        const boton = aparienciaDe(nodo).boton;
        const anchoNuevo = boton ? Math.max(ancho, ANCHO_BOTON_DP) : ancho;
        // `apkc preview` estima 48dp para un Button wrap_content (el minHeight del tema), pero el
        // relleno gris que ART pinta mide 40dp. Corregimos esa estimación y conservamos una altura
        // mayor si el layout la declaró explícitamente.
        const altoNuevo = boton ? Math.max(alto === 48 ? ALTO_BOTON_DP : alto, ALTO_BOTON_DP) : alto;
        copia.rect = {
          ...nodo.rect,
          x: x - (anchoNuevo - ancho) / 2,
          y: y - (altoNuevo - alto) / 2,
          ancho: anchoNuevo,
          alto: altoNuevo,
        };
        if (anchoNuevo !== ancho || altoNuevo !== alto) cambios.set(copia, true);
      }
    }
    if (Array.isArray(nodo.hijos)) copia.hijos = nodo.hijos.map(copiar);
    return copia;
  };
  const raiz = copiar(modelo.raiz);
  refluyeFilaBotones(raiz);
  propagaMinimos(raiz, cambios);
  return { ...modelo, raiz };
}

// Los rectángulos ya escalados, en el orden de pintado. Un nodo sin `rect` numérico se omite en
// lugar de pintarse en (0,0): un rectángulo inventado miente más que un hueco. Nunca devuelve un
// ancho o alto menor que 1 px, para que una view diminuta siga viéndose. Los mínimos se aplican en
// `modeloConMinimos`, antes de llegar aquí: reaplicarlos sobre píxeles ya reducidos era lo que
// dejaba el botón en 88×48 px a media pantalla.
export function rectsEscalados(modelo, ancho, alto) {
  const caja = escalaPara(modelo, ancho, alto);
  if (!caja.valida) return [];
  const rects = [];
  for (const { nodo, profundidad } of nodosAplanados(modelo)) {
    const r = nodo.rect;
    if (!r || typeof r !== "object") continue;
    // una vista que la app puso gone o invisible no se pinta ni responde al clic: el nodo sigue en
    // el árbol (su id y su sitio los necesita la colocación), pero no sale en el lienzo
    if (nodo.visibilidad === "gone" || nodo.visibilidad === "invisible") continue;
    // las cuatro medidas se leen con la misma regla que la pantalla: `null` o una cadena vacía
    // no valen cero, valen «este nodo no se puede situar»
    const x = aNumeroOFinito(r.x), y = aNumeroOFinito(r.y);
    let ancho = aNumeroOFinito(r.ancho), alto = aNumeroOFinito(r.alto);
    if ([x, y, ancho, alto].some((v) => v === null)) continue;
    const apariencia = aparienciaDe(nodo);
    const escalado = {
      x: caja.x + x * caja.escala,
      y: caja.y + y * caja.escala,
      ancho: Math.max(1, ancho * caja.escala),
      alto: Math.max(1, alto * caja.escala),
      tipo: String(nodo.tipo || ""),
      id: String(nodo.id || ""),
      // el id de recurso numérico y la marca de oyente son lo que necesita el clic del canvas: el
      // primero para pedir `--pulsar`, la segunda para saber si esa vista responde
      idRef: String(nodo.idRef || ""),
      oyente: nodo.oyente === true,
      texto: textoDeNodo(nodo),
      // La pista (`android:hint`) es del layout, no de la ejecución: viaja aparte de `texto` para
      // que `textoDeNodo` siga sin confundirla con lo que la app escribió.
      pista: typeof nodo.pista === "string" ? nodo.pista : "",
      // colores y letra del layout o, si no los declara, los del tema medido del aparato
      fondo: apariencia.fondo,
      colorTexto: apariencia.colorTexto,
      boton: apariencia.boton,
      tamanoDp: apariencia.tamanoDp,
      peso: apariencia.peso,
      mayusculas: apariencia.mayusculas,
      relleno: apariencia.relleno,
      // `src` y, si el panel ya lo decodificó, el mapa de bits del PNG del proyecto
      recurso: typeof nodo.recurso === "string" ? nodo.recurso : "",
      imagen: nodo.imagen || null,
      // lo que el `onDraw` de una vista propia pidió al Canvas del modelo (`previewdibujo.go`):
      // viaja con el nodo y se pinta dentro de este rect. Sin `dibujo` no cambia nada.
      dibujo: nodo.dibujo && typeof nodo.dibujo === "object" ? nodo.dibujo : null,
      profundidad,
    };
    if (![escalado.x, escalado.y, escalado.ancho, escalado.alto].every(Number.isFinite)) continue;
    rects.push(escalado);
  }
  return rects;
}

// --- pintura -------------------------------------------------------------------------------
// Solo se llama desde la página. El color sale siempre de las variables de tema
// (`style.css`), nunca de un literal: los tres mundos de `DESIGN.md` se ven sin tocar este
// fichero. Los respaldos son los del tema por defecto, por si alguien pinta antes de que
// `temas.js` resuelva las variables.
function colorDe(nombre, respaldo) {
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return respaldo;
  const valor = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
  return valor || respaldo;
}

// El fondo del botón del tema medido: un rectángulo redondeado de 4dp, como el que se mide en la
// captura de ART. No toca el rect del modelo ni la escala; el recorte a la pantalla lo pone quien
// llama, antes de pintar cualquier nodo.
function pintarFondoBoton(ctx, r, escala) {
  const radio = Math.min(RADIO_BOTON_DP * escala, r.ancho / 2, r.alto / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(r.x, r.y, r.ancho, r.alto, radio);
  else ctx.rect(r.x, r.y, r.ancho, r.alto);
  ctx.fillStyle = TEMA_APARATO.boton;
  ctx.fill();
}

// --- el dibujo de una vista propia ---------------------------------------------------------
// `previewdibujo.go` publica en `nodo.dibujo.operaciones` lo que el `onDraw` de una vista del
// proyecto pidió al Canvas del modelo, en el orden en que lo pidió: `color` (fondo), `linea`,
// `rectangulo`, `circulo` y `texto`, con el `color` y el `grosor` del `Paint`. Aquí se consumen
// dentro del rect del nodo y con la escala de la pantalla: no cambia el tamaño del canvas ni la
// escala, y un nodo sin `dibujo` se pinta exactamente como antes. El modelo no publica el
// `Style` del `Paint` (el intérprete acepta `setStyle` sin inventar el efecto): con `grosor`
// mayor que cero se traza el contorno, que es lo que se busca al dar grosor, y con grosor cero se
// rellena, que es el estilo por defecto del framework. La cota evita que un JSON hostil deje la
// pestaña dibujando sin fin.
const OPERACIONES_MAXIMAS = 256;
const TEXTO_DIBUJO = 12; // el `textSize` por defecto de un `Paint`, en píxeles del modelo

// El color de una operación como lo entiende el canvas. `formatoColor` de apkc imprime
// `#rrggbb`, o `#aarrggbb` cuando hay alfa; el canvas de 8 dígitos espera RGBA, así que el alfa
// se pasa a `rgba()`. Un color que no es un hex válido cae al respaldo del tema: nunca se pinta
// con una cadena que el canvas descartaría en silencio.
function colorDeOperacion(valor, respaldo) {
  const texto = typeof valor === "string" ? valor.trim() : "";
  if (!/^#[0-9a-fA-F]{3,8}$/.test(texto)) return respaldo;
  let digitos = texto.slice(1);
  if (digitos.length === 3 || digitos.length === 4) {
    digitos = [...digitos].map((c) => c + c).join("");
  }
  if (digitos.length === 6) return "#" + digitos.toLowerCase();
  if (digitos.length !== 8) return respaldo;
  const alfa = parseInt(digitos.slice(0, 2), 16) / 255;
  const rojo = parseInt(digitos.slice(2, 4), 16);
  const verde = parseInt(digitos.slice(4, 6), 16);
  const azul = parseInt(digitos.slice(6, 8), 16);
  return "rgba(" + rojo + ", " + verde + ", " + azul + ", " + (Math.round(alfa * 1000) / 1000) + ")";
}

// Pinta las operaciones de `r.dibujo` dentro del rect ya escalado del nodo. `escala` es la de la
// pantalla: las coordenadas del Canvas del modelo van en los mismos píxeles del modelo que el
// `rect`. Devuelve cuántas operaciones se pintaron, que es lo que va al resumen de la prueba.
function pintarOperaciones(ctx, r, escala, tinta) {
  const dibujo = r.dibujo;
  if (!dibujo || typeof dibujo !== "object" || !Array.isArray(dibujo.operaciones)) return 0;
  const alLienzo = (v) => r.x + v * escala;
  const altoLienzo = (v) => r.y + v * escala;
  let pintadas = 0;
  for (const op of dibujo.operaciones.slice(0, OPERACIONES_MAXIMAS)) {
    if (!op || typeof op !== "object") continue;
    const x1 = aNumeroOFinito(op.x1), y1 = aNumeroOFinito(op.y1);
    const x2 = aNumeroOFinito(op.x2), y2 = aNumeroOFinito(op.y2);
    const radio = aNumeroOFinito(op.radio);
    const grosor = aNumeroOFinito(op.grosor);
    const color = colorDeOperacion(op.color, tinta);
    switch (op.operacion) {
      case "color": {
        // `drawColor` pinta todo el lienzo de la vista: el rect entero del nodo
        ctx.fillStyle = color;
        ctx.fillRect(r.x, r.y, r.ancho, r.alto);
        pintadas++;
        break;
      }
      case "linea": {
        if (x1 === null || y1 === null || x2 === null || y2 === null) break;
        ctx.strokeStyle = color;
        ctx.lineWidth = grosor !== null && grosor > 0 ? Math.max(0.5, grosor * escala) : 1;
        ctx.beginPath();
        ctx.moveTo(alLienzo(x1), altoLienzo(y1));
        ctx.lineTo(alLienzo(x2), altoLienzo(y2));
        ctx.stroke();
        pintadas++;
        break;
      }
      case "rectangulo": {
        if (x1 === null || y1 === null || x2 === null || y2 === null) break;
        const ancho = Math.max(0, (x2 - x1) * escala);
        const alto = Math.max(0, (y2 - y1) * escala);
        if (grosor !== null && grosor > 0) {
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(0.5, grosor * escala);
          ctx.strokeRect(alLienzo(x1), altoLienzo(y1), ancho, alto);
        } else {
          ctx.fillStyle = color;
          ctx.fillRect(alLienzo(x1), altoLienzo(y1), ancho, alto);
        }
        pintadas++;
        break;
      }
      case "circulo": {
        if (x1 === null || y1 === null || radio === null) break;
        const rl = Math.max(0, radio * escala);
        ctx.beginPath();
        ctx.arc(alLienzo(x1), altoLienzo(y1), rl, 0, Math.PI * 2);
        if (grosor !== null && grosor > 0) {
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(0.5, grosor * escala);
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
        pintadas++;
        break;
      }
      case "texto": {
        if (x1 === null || y1 === null) break;
        const texto = typeof op.texto === "string" ? op.texto : "";
        if (!texto) break;
        // `drawText` recibe la línea base, no la esquina: se pinta con la base alfabética y se
        // devuelve el lienzo a la de arriba que usa el texto del nodo. El intérprete publica el
        // `textSize` del Paint en `tamano`; las operaciones antiguas no lo traen y caen al
        // respaldo de 12px del modelo, igual que los valores que no se pueden medir.
        const publicado = aNumeroOFinito(op.tamano);
        const base = publicado !== null && publicado > 0 ? publicado : TEXTO_DIBUJO;
        const px = Math.max(1, base * escala);
        ctx.font = px + "px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = color;
        ctx.fillText(texto, alLienzo(x1), altoLienzo(y1));
        ctx.textBaseline = "top";
        pintadas++;
        break;
      }
      default:
        // una operación que este pintor no conoce se ignora: el modelo puede crecer antes que la
        // página y una vista no se queda en blanco por un `drawArc` que aún no se dibuja
        break;
    }
  }
  return pintadas;
}

// El estado del modelo vive en este módulo para poder repintar al cambiar de vista sin repetir el
// comando: compilar puede ocurrir con la vista Pantalla oculta y el canvas mide cero entonces.
let ultimoModelo = null;

// El panel lateral de la vista dividida (previa-panel.js) no puede importar `ultimoModelo` sin
// duplicar el estado, así que se le avisa con un evento cada vez que el modelo cambia. Va con el
// modelo o con el motivo por el que no hay modelo, y nunca lleva el objeto a un `innerHTML`.
const EVENTO = "apkc:previa-actualizada";

// Nombre público del evento: el panel lateral lo escucha sin importar el estado interno.
export const EVENTO_PREVIA = EVENTO;

function avisar(modelo, mensaje) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") return;
  document.dispatchEvent(new CustomEvent(EVENTO, { detail: { modelo, mensaje } }));
}

// Lo que se puede repintar sin repetir `apkc preview`: solo la lectura del último modelo.
export function modeloActual() {
  return ultimoModelo;
}

function canvasDeLaVista() {
  if (typeof document === "undefined") return null;
  return document.getElementById("vista-previa");
}

function avisoDeLaVista(texto) {
  if (typeof document === "undefined") return;
  const aviso = document.getElementById("vista-previa-estado");
  if (aviso) aviso.textContent = texto;
}

// Deja el panel vacío con un mensaje legible. Se usa cuando no hay apk, cuando el comando falla y
// al arrancar, antes de la primera compilación.
export function mensajeVistaPrevia(texto) {
  ultimoModelo = null;
  const canvas = canvasDeLaVista();
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // sin resetear la matriz, el borrado de un canvas ya pintado se multiplica por la densidad
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  const mensaje = String(texto || "");
  avisoDeLaVista(mensaje);
  avisar(null, mensaje);
}

// Pinta el modelo en el canvas. `medir` existe para las pruebas: permite fijar la caja lógica sin
// depender del tamaño real del canvas, que en la vista oculta es cero. Devuelve un resumen con lo
// que se pintó (también lo usan las pruebas) o null si no hay canvas.
export function pintarModelo(canvas, modelo, medir) {
  if (!canvas || !canvas.getContext || !modelo) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const pantalla = modelo.pantalla || PANTALLA_POR_DEFECTO;
  const caja = medir || {
    ancho: canvas.clientWidth || Number(pantalla.ancho) || PANTALLA_POR_DEFECTO.ancho,
    alto: canvas.clientHeight || Number(pantalla.alto) || PANTALLA_POR_DEFECTO.alto,
  };
  const ancho = Math.max(1, Math.round(caja.ancho));
  const alto = Math.max(1, Math.round(caja.alto));
  // la densidad del aparato no puede inflar el lienzo hasta hacerlo lento: 2 es suficiente
  const dpr = typeof window !== "undefined" && window.devicePixelRatio
    ? Math.min(2, Math.max(1, window.devicePixelRatio)) : 1;
  if (canvas.width !== Math.round(ancho * dpr) || canvas.height !== Math.round(alto * dpr)) {
    canvas.width = Math.round(ancho * dpr);
    canvas.height = Math.round(alto * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ancho, alto);

  const fondo = colorDe("--superficie", "#202020");
  const borde = colorDe("--borde", "#2b2b2b");
  const bordeFuerte = colorDe("--borde2", "#3c3c3c");
  const acento = colorDe("--acento", "#007acc");
  const tinta = colorDe("--texto-fuerte", "#e7e7e7");

  // el fondo del panel y el rectángulo de la pantalla, que es el límite de lo que se pinta
  ctx.fillStyle = fondo;
  ctx.fillRect(0, 0, ancho, alto);
  const marcoRect = escalaPara(modelo, ancho, alto);
  if (!marcoRect.valida) {
    // un modelo sin pantalla medible deja el fondo y lo dice el estado; no se inventan rectángulos
    return { ancho, alto, nodos: 0, escala: 0, valida: false, modelo };
  }
  // La pantalla del teléfono lleva el fondo de su tema, no el del editor: es lo que mide
  // `windowBackground=@android:color/white` en el APK real. El marco oscuro de alrededor
  // sigue siendo la diferencia visual entre el lienzo y la interfaz de la página.
  ctx.fillStyle = TEMA_APARATO.fondo;
  ctx.fillRect(marcoRect.x, marcoRect.y, marcoRect.ancho, marcoRect.alto);
  ctx.strokeStyle = borde;
  ctx.lineWidth = 1;
  ctx.strokeRect(marcoRect.x + 0.5, marcoRect.y + 0.5, marcoRect.ancho - 1, marcoRect.alto - 1);

  const rects = rectsEscalados(modelo, ancho, alto);
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
  // Todo lo que represente la pantalla va recortado a su marco. Sin este clip, un nodo que se sale
  // por la derecha (el quinto botón de la plantilla Notas, en x=359…447dp) pintaba su gris sobre
  // el editor, fuera de los 360dp de la pantalla. El borde del marco se pintó antes, sin recortar.
  ctx.save();
  ctx.beginPath();
  ctx.rect(marcoRect.x, marcoRect.y, marcoRect.ancho, marcoRect.alto);
  ctx.clip();
  let operacionesPintadas = 0;
  for (const r of rects) {
    // el nodo raíz es el contenedor de toda la pantalla: se marca con el acento, no se rellena,
    // salvo que el layout le haya dado un fondo
    if (r.profundidad === 0) {
      if (r.fondo) {
        ctx.fillStyle = r.fondo;
        ctx.fillRect(r.x, r.y, r.ancho, r.alto);
      }
      ctx.strokeStyle = acento;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, Math.max(1, r.ancho - 2), Math.max(1, r.alto - 2));
      // una vista propia puede ser la raíz del layout: su `onDraw` se pinta igual, recortado a la
      // pantalla como el de cualquier otro nodo
      if (r.dibujo) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x + 1, r.y + 1, Math.max(1, r.ancho - 2), Math.max(1, r.alto - 2));
        ctx.clip();
        operacionesPintadas += pintarOperaciones(ctx, r, marcoRect.escala, tinta);
        ctx.restore();
      }
      continue;
    }
    // Un TextView sin `android:background` no pinta nada: deja ver el fondo blanco del tema.
    // El Button sin fondo declarado sí pinta el gris de Widget.Material.Button medido en ART.
    if (r.fondo) {
      ctx.fillStyle = r.fondo;
      ctx.fillRect(r.x, r.y, r.ancho, r.alto);
    } else if (r.boton) {
      pintarFondoBoton(ctx, r, marcoRect.escala);
    } else if (TIPOS_CON_TECLADO.has(r.tipo)) {
      // Un EditText sin fondo declarado deja ver el blanco del tema, nunca el gris del botón, y
      // lleva un subrayado inferior de 1dp escalada: es lo que lo distingue de un TextView en ART.
      ctx.fillStyle = TEMA_APARATO.fondo;
      ctx.fillRect(r.x, r.y, r.ancho, r.alto);
      // HIPÓTESIS (sin medición propia): el color del subrayado es el del texto del tema. No se ha
      // medido en el aparato el tono exacto del EditText de Theme.DeviceDefault.Light, así que se
      // reutiliza `colorTexto`/`texto` del tema en vez de inventar un literal nuevo.
      const grosorSubrayado = Math.max(1, marcoRect.escala);
      ctx.strokeStyle = r.colorTexto || TEMA_APARATO.texto;
      ctx.lineWidth = grosorSubrayado;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + r.alto - grosorSubrayado / 2);
      ctx.lineTo(r.x + r.ancho, r.y + r.alto - grosorSubrayado / 2);
      ctx.stroke();
    }
    // ART no pone ningún borde alrededor de las vistas que tienen oyente: antes se dibujaba aquí
    // un píxel de acento que en el aparato no existe. La lista de vistas que responden sigue en el
    // panel de Pulsar y en `r.oyente`; el canvas solo pinta lo que pinta la app.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 1, r.y + 1, Math.max(1, r.ancho - 2), Math.max(1, r.alto - 2));
    ctx.clip();
    // Una vista con `android:src` pinta su imagen si el panel pudo decodificar el PNG del proyecto
    // (`r.imagen`); si es un recurso del framework o no se pudo leer, deja un marcador con el nombre
    // del recurso. Nunca es una URL: los bytes salen del OPFS del propio proyecto.
    if (r.imagen && typeof ctx.drawImage === "function") {
      const iw = r.imagen.width || 1;
      const ih = r.imagen.height || 1;
      const escalaImagen = Math.min(r.ancho / iw, r.alto / ih);
      const w = Math.max(1, iw * escalaImagen);
      const h = Math.max(1, ih * escalaImagen);
      ctx.drawImage(r.imagen, r.x + (r.ancho - w) / 2, r.y + (r.alto - h) / 2, w, h);
    } else if (r.recurso && r.alto >= 10) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = bordeFuerte;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 2.5, r.y + 2.5, Math.max(1, r.ancho - 5), Math.max(1, r.alto - 5));
      ctx.setLineDash([]);
      const nombre = String(r.recurso).replace(/^@/, "");
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.fillStyle = r.colorTexto || tinta;
      ctx.fillText(nombre, r.x + 4, r.y + 3, Math.max(0, r.ancho - 8));
    }
    // El `onDraw` de una vista propia va antes que el texto del nodo: su `drawColor` no debe
    // tapar el texto, y una vista propia no suele traer `texto` del layout.
    operacionesPintadas += pintarOperaciones(ctx, r, marcoRect.escala, tinta);
    // El nodo pinta **solo su texto**. Antes se dibujaba encima una etiqueta con el tipo y el id
    // (`Button · id/pulsar`); sobre un botón parecía un diálogo pegado y el usuario pidió quitarlo.
    // El tipo y el id no se pierden: siguen en el modelo, en `rectsEscalados`, en el `resumen` que
    // devuelve `pintarModelo` y en `data-nodos` del canvas (no se pinta nada de eso).
    // Si no hay texto pero el nodo trae pista (`android:hint`), se pinta la pista atenuada: es
    // como ART muestra el hint de un EditText vacío. No se convierte en `texto`: el modelo y
    // `textoDeNodo` siguen distinguiendo lo que declaró el layout de lo que escribió la app.
    // El `save`/`restore` de este nodo deja el alfa limpio para los demás.
    const visibleTexto = r.texto || r.pista;
    if (visibleTexto && r.alto >= 8) {
      // `tamTexto`/`estilo` del modelo (sp≈dp) escalados con la pantalla: un TextView sin
      // estilo usa los 14sp del tema; el de la plantilla Contador trae Large (22sp).
      const escalaTexto = marcoRect.escala;
      const tamano = Math.max(6, Math.min(96, r.tamanoDp * escalaTexto));
      ctx.font = r.peso + " " + Math.round(tamano * 100) / 100 +
        "px Roboto, 'Noto Sans', system-ui, sans-serif";
      ctx.fillStyle = r.colorTexto || TEMA_APARATO.texto;
      ctx.textBaseline = "middle";
      ctx.textAlign = r.boton ? "center" : "left";
      if (!r.texto && r.pista) ctx.globalAlpha = 0.5;
      // TextAppearance.Material.Button pone textAllCaps: en el aparato «Pulsar» se lee PULSAR.
      const visible = r.mayusculas ? visibleTexto.toUpperCase() : visibleTexto;
      const hueco = Math.max(0, r.ancho - (r.relleno.izq + r.relleno.der) * escalaTexto);
      const xTexto = r.boton ? r.x + r.ancho / 2 : r.x + r.relleno.izq * escalaTexto;
      ctx.fillText(visible, xTexto, r.y + r.alto / 2, hueco);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
    }
    ctx.restore();
  }
  ctx.restore();
  // El tipo y el id de cada nodo quedan accesibles sin dibujarse: en el atributo `data-nodos`
  // del canvas y en el objeto que devuelve esta función.
  const resumen = rects.slice(0, 40).filter((r) => r.tipo).map((r) => (r.id ? r.tipo + " · " + r.id : r.tipo)).join(", ");
  if (canvas.dataset) canvas.dataset.nodos = resumen;
  // el espacio con el que se pintó queda en el canvas: el manejador del clic mide con él y no con
  // el clientWidth del momento, que puede haber cambiado entre pintar y pulsar
  canvas.__espacio = { ancho, alto };
  return { ancho, alto, nodos: rects.length, escala: marcoRect.escala, valida: true, modelo, resumen,
    operaciones: operacionesPintadas };
}

// La línea de estado del Emulador, pura y compartida: la escriben la vista Pantalla (aquí) y el
// panel de la vista dividida (previa-panel.js) al repintar, así que las dos superficies dicen lo
// mismo del mismo modelo. Se llama por su nombre —«Emulador», no «Vista previa», que es el otro
// modo y no ejecuta la app—.
export function textoDelModelo(modelo) {
  const declarados = aNumeroOFinito(modelo && modelo.nodos);
  const nodos = declarados !== null && declarados > 0 ? declarados : nodosAplanados(modelo).length;
  const aproximado = modelo && modelo.aproximado === false ? "" : " aproximado";
  const pantalla = (modelo && modelo.pantalla) || {};
  return "Emulador" + aproximado + " de " + ((modelo && modelo.layout) || "el layout") + ": " +
    nodos + " nodos en una pantalla de " +
    (pantalla.ancho || PANTALLA_POR_DEFECTO.ancho) + "×" +
    (pantalla.alto || PANTALLA_POR_DEFECTO.alto) + " dp.";
}

// Pinta el modelo en el canvas de la página y actualiza la línea de estado. Sin modelo se deja el
// panel vacío con un mensaje: es lo que ve quien abre la vista antes de compilar.
export function pintarVistaPrevia(modelo) {
  if (!modelo) {
    mensajeVistaPrevia(MENSAJE_SIN_MODELO);
    return null;
  }
  ultimoModelo = modelo;
  // Los mínimos y su centro se aplican antes de pintar, igual que en el panel: este primer trazo
  // deja de dibujar el botón 12dp desplazado mientras el evento avisa y el panel repinta.
  const canvas = canvasDeLaVista();
  const pintado = pintarModelo(canvas, modeloConMinimos(modelo));
  if (pintado && pintado.valida === false) {
    // el modelo llegó, pero su pantalla no es medible: panel vacío y motivo en la línea de estado
    mensajeVistaPrevia("El modelo de vista previa no trae una pantalla medible (ancho o alto no " +
      "finitos); no se pinta nada.");
    return null;
  }
  const texto = textoDelModelo(modelo);
  avisoDeLaVista(texto);
  // el panel lateral pinta el mismo modelo y su consola sin volver a pedirlo
  avisar(modelo, texto);
  return pintado;
}

// Repinta con el último modelo al entrar en la vista: al compilar con la pestaña oculta el canvas
// medía cero y los rectángulos salieron con el tamaño de respaldo.
export function repintarVistaPrevia() {
  if (!ultimoModelo) {
    mensajeVistaPrevia(MENSAJE_SIN_MODELO);
    return null;
  }
  return pintarVistaPrevia(ultimoModelo);
}
