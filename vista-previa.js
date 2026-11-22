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

// Una medida usable. El JSON de apkc trae números, pero un modelo manipulado o una fase futura
// puede colar `null`, cadenas, `NaN` o `1e400` (que es `Infinity`): ninguno de esos es una
// medida. Devolver null deja que el llamante use su respaldo en vez de propagar `NaN` al
// canvas, que se traga los rectángulos sin lanzar nada.
function aNumero(valor) {
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

// El texto visible de un nodo. `texto` es el del layout; si la Fase 2 añade un texto de ejecución
// (`textoDinamico`, `textoCapturado`, …) gana ese, porque describe la pantalla de verdad. Se mira
// cualquier clave que empiece por `texto` y no sea `texto`, en orden alfabético, para no depender
// del nombre exacto que elija la otra fase.
export function textoDeNodo(nodo) {
  if (!nodo || typeof nodo !== "object") return "";
  const dinamicas = Object.keys(nodo)
    .filter((clave) => clave !== "texto" && /^texto[A-Z_]/.test(clave) &&
      typeof nodo[clave] === "string" && nodo[clave].trim() !== "")
    .sort();
  if (dinamicas.length) return String(nodo[dinamicas[0]]);
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

// Encaja la pantalla del modelo en una caja (el canvas en píxeles CSS) sin deformarla: una sola
// escala para los dos ejes y centrada. La traslación resta el origen de `pantalla` y centra el
// rectángulo de la pantalla dentro de la caja.
export function escalaPara(modelo, ancho, alto) {
  const pantalla = (modelo && modelo.pantalla) || {};
  const anchoDeclarado = aNumero(pantalla.ancho);
  const altoDeclarado = aNumero(pantalla.alto);
  const anchoPantalla = anchoDeclarado !== null && anchoDeclarado > 0
    ? anchoDeclarado : PANTALLA_POR_DEFECTO.ancho;
  const altoPantalla = altoDeclarado !== null && altoDeclarado > 0
    ? altoDeclarado : PANTALLA_POR_DEFECTO.alto;
  const anchoCaja = aNumero(ancho);
  const altoCaja = aNumero(alto);
  const cajaAncho = anchoCaja !== null && anchoCaja > 0 ? anchoCaja : anchoPantalla;
  const cajaAlto = altoCaja !== null && altoCaja > 0 ? altoCaja : altoPantalla;
  const escala = Math.min(cajaAncho / anchoPantalla, cajaAlto / altoPantalla);
  // 1e400 llega como Infinity y su división da 0 o NaN: ninguna de las dos es una escala
  if (!Number.isFinite(escala) || escala <= 0) return cajaNula();
  const x = (cajaAncho - anchoPantalla * escala) / 2 - (aNumero(pantalla.x) || 0) * escala;
  const y = (cajaAlto - altoPantalla * escala) / 2 - (aNumero(pantalla.y) || 0) * escala;
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

// Los rectángulos ya escalados, en el orden de pintado. Un nodo sin `rect` numérico se omite en
// lugar de pintarse en (0,0): un rectángulo inventado miente más que un hueco. Nunca devuelve un
// ancho o alto menor que 1 px, para que una view diminuta siga viéndose.
export function rectsEscalados(modelo, ancho, alto) {
  const caja = escalaPara(modelo, ancho, alto);
  if (!caja.valida) return [];
  const rects = [];
  for (const { nodo, profundidad } of nodosAplanados(modelo)) {
    const r = nodo.rect;
    if (!r || typeof r !== "object") continue;
    // las cuatro medidas se leen con la misma regla que la pantalla: `null` o una cadena vacía
    // no valen cero, valen «este nodo no se puede situar»
    const x = aNumero(r.x), y = aNumero(r.y), ancho = aNumero(r.ancho), alto = aNumero(r.alto);
    if ([x, y, ancho, alto].some((v) => v === null)) continue;
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
      // colores del layout, ya normalizados por `vista-xml.js`; vacío significa «el del tema»
      fondo: typeof nodo.fondo === "string" ? nodo.fondo : "",
      colorTexto: typeof nodo.colorTexto === "string" ? nodo.colorTexto : "",
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

// El estado del modelo vive en este módulo para poder repintar al cambiar de vista sin repetir el
// comando: compilar puede ocurrir con la pestaña Vista oculta y el canvas mide cero entonces.
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
  const marco = colorDe("--superficie2", "#252526");
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
  ctx.fillStyle = marco;
  ctx.fillRect(marcoRect.x, marcoRect.y, marcoRect.ancho, marcoRect.alto);
  ctx.strokeStyle = borde;
  ctx.lineWidth = 1;
  ctx.strokeRect(marcoRect.x + 0.5, marcoRect.y + 0.5, marcoRect.ancho - 1, marcoRect.alto - 1);

  const rects = rectsEscalados(modelo, ancho, alto);
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
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
      continue;
    }
    ctx.fillStyle = r.fondo || marco;
    ctx.fillRect(r.x, r.y, r.ancho, r.alto);
    // la vista que responde a un clic se marca con el acento: es la única que el emulador atiende
    ctx.strokeStyle = r.oyente ? acento : bordeFuerte;
    ctx.lineWidth = r.oyente ? 2 : 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.ancho - 1), Math.max(1, r.alto - 1));
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 1, r.y + 1, Math.max(1, r.ancho - 2), Math.max(1, r.alto - 2));
    ctx.clip();
    // El nodo pinta **solo su texto**. Antes se dibujaba encima una etiqueta con el tipo y el id
    // (`Button · id/pulsar`); sobre un botón parecía un diálogo pegado y el usuario pidió quitarlo.
    // El tipo y el id no se pierden: siguen en el modelo, en `rectsEscalados`, en el `resumen` que
    // devuelve `pintarModelo` y en `data-nodos` del canvas (no se pinta nada de eso).
    if (r.texto && r.alto >= 8) {
      // una sola línea, con la fuente encogida al hueco real: 8..12 px
      const tamano = Math.max(8, Math.min(12, Math.floor(r.alto - 6)));
      ctx.font = tamano + "px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.fillStyle = r.colorTexto || tinta;
      ctx.fillText(r.texto, r.x + 5, r.y + 3, Math.max(0, r.ancho - 10));
    }
    ctx.restore();
  }
  // El tipo y el id de cada nodo quedan accesibles sin dibujarse: en el atributo `data-nodos`
  // del canvas y en el objeto que devuelve esta función.
  const resumen = rects.slice(0, 40).filter((r) => r.tipo).map((r) => (r.id ? r.tipo + " · " + r.id : r.tipo)).join(", ");
  if (canvas.dataset) canvas.dataset.nodos = resumen;
  return { ancho, alto, nodos: rects.length, escala: marcoRect.escala, valida: true, modelo, resumen };
}

// Pinta el modelo en el canvas de la página y actualiza la línea de estado. Sin modelo se deja el
// panel vacío con un mensaje: es lo que ve quien abre la vista antes de compilar.
export function pintarVistaPrevia(modelo) {
  if (!modelo) {
    mensajeVistaPrevia("Compila el proyecto (Editor → Compilar → Compilar debug) para ver la vista previa del apk.");
    return null;
  }
  ultimoModelo = modelo;
  const canvas = canvasDeLaVista();
  const pintado = pintarModelo(canvas, modelo);
  if (pintado && pintado.valida === false) {
    // el modelo llegó, pero su pantalla no es medible: panel vacío y motivo en la línea de estado
    mensajeVistaPrevia("El modelo de vista previa no trae una pantalla medible (ancho o alto no " +
      "finitos); no se pinta nada.");
    return null;
  }
  const declarados = aNumero(modelo.nodos);
  const nodos = declarados !== null && declarados > 0 ? declarados : nodosAplanados(modelo).length;
  // esta línea la lee la columna de Pantalla, que es del Emulador: se llama por su nombre, no
  // «Vista previa», que es el otro modo y no ejecuta la app
  const aproximado = modelo.aproximado === false ? "" : " aproximado";
  const texto = "Emulador" + aproximado + " de " + (modelo.layout || "el layout") + ": " +
    nodos + " nodos en una pantalla de " +
    ((modelo.pantalla && modelo.pantalla.ancho) || PANTALLA_POR_DEFECTO.ancho) + "×" +
    ((modelo.pantalla && modelo.pantalla.alto) || PANTALLA_POR_DEFECTO.alto) + " dp.";
  avisoDeLaVista(texto);
  // el panel lateral pinta el mismo modelo y su consola sin volver a pedirlo
  avisar(modelo, texto);
  return pintado;
}

// Repinta con el último modelo al entrar en la vista: al compilar con la pestaña oculta el canvas
// medía cero y los rectángulos salieron con el tamaño de respaldo.
export function repintarVistaPrevia() {
  if (!ultimoModelo) {
    mensajeVistaPrevia("Compila el proyecto (Editor → Compilar → Compilar debug) para ver la vista previa del apk.");
    return null;
  }
  return pintarVistaPrevia(ultimoModelo);
}
