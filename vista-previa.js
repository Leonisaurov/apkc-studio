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
  const anchoPantalla = Number(pantalla.ancho) > 0 ? Number(pantalla.ancho) : PANTALLA_POR_DEFECTO.ancho;
  const altoPantalla = Number(pantalla.alto) > 0 ? Number(pantalla.alto) : PANTALLA_POR_DEFECTO.alto;
  const cajaAncho = Number(ancho) > 0 ? Number(ancho) : anchoPantalla;
  const cajaAlto = Number(alto) > 0 ? Number(alto) : altoPantalla;
  const escala = Math.min(cajaAncho / anchoPantalla, cajaAlto / altoPantalla);
  const x = (cajaAncho - anchoPantalla * escala) / 2 - (Number(pantalla.x) || 0) * escala;
  const y = (cajaAlto - altoPantalla * escala) / 2 - (Number(pantalla.y) || 0) * escala;
  return {
    escala,
    x,
    y,
    ancho: anchoPantalla * escala,
    alto: altoPantalla * escala,
  };
}

// Los rectángulos ya escalados, en el orden de pintado. Un nodo sin `rect` numérico se omite en
// lugar de pintarse en (0,0): un rectángulo inventado miente más que un hueco. Nunca devuelve un
// ancho o alto menor que 1 px, para que una view diminuta siga viéndose.
export function rectsEscalados(modelo, ancho, alto) {
  const caja = escalaPara(modelo, ancho, alto);
  const rects = [];
  for (const { nodo, profundidad } of nodosAplanados(modelo)) {
    const r = nodo.rect;
    if (!r || typeof r !== "object") continue;
    const valores = [r.x, r.y, r.ancho, r.alto].map(Number);
    if (!valores.every((v) => Number.isFinite(v))) continue;
    rects.push({
      x: caja.x + valores[0] * caja.escala,
      y: caja.y + valores[1] * caja.escala,
      ancho: Math.max(1, valores[2] * caja.escala),
      alto: Math.max(1, valores[3] * caja.escala),
      tipo: String(nodo.tipo || ""),
      id: String(nodo.id || ""),
      texto: textoDeNodo(nodo),
      profundidad,
    });
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
  avisoDeLaVista(String(texto || ""));
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
  const tintaTenue = colorDe("--texto-medio", "#b0b0b0");

  // el fondo del panel y el rectángulo de la pantalla, que es el límite de lo que se pinta
  ctx.fillStyle = fondo;
  ctx.fillRect(0, 0, ancho, alto);
  const marcoRect = escalaPara(modelo, ancho, alto);
  ctx.fillStyle = marco;
  ctx.fillRect(marcoRect.x, marcoRect.y, marcoRect.ancho, marcoRect.alto);
  ctx.strokeStyle = borde;
  ctx.lineWidth = 1;
  ctx.strokeRect(marcoRect.x + 0.5, marcoRect.y + 0.5, marcoRect.ancho - 1, marcoRect.alto - 1);

  const rects = rectsEscalados(modelo, ancho, alto);
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
  for (const r of rects) {
    // el nodo raíz es el contenedor de toda la pantalla: se marca con el acento, no se rellena
    if (r.profundidad === 0) {
      ctx.strokeStyle = acento;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, Math.max(1, r.ancho - 2), Math.max(1, r.alto - 2));
      continue;
    }
    ctx.fillStyle = marco;
    ctx.fillRect(r.x, r.y, r.ancho, r.alto);
    ctx.strokeStyle = bordeFuerte;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.ancho - 1), Math.max(1, r.alto - 1));
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 1, r.y + 1, Math.max(1, r.ancho - 2), Math.max(1, r.alto - 2));
    ctx.clip();
    let linea = r.y + 3;
    if (r.alto >= 14) {
      const etiqueta = r.id ? r.tipo + " · " + r.id : r.tipo;
      ctx.fillStyle = tintaTenue;
      ctx.fillText(etiqueta, r.x + 5, linea, Math.max(0, r.ancho - 10));
      linea += 13;
    }
    if (r.texto && r.alto >= 28) {
      ctx.fillStyle = tinta;
      ctx.fillText(r.texto, r.x + 5, linea, Math.max(0, r.ancho - 10));
    }
    ctx.restore();
  }
  return { ancho, alto, nodos: rects.length, escala: marcoRect.escala, modelo };
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
  const nodos = Number(modelo.nodos) > 0 ? Number(modelo.nodos) : nodosAplanados(modelo).length;
  const aproximado = modelo.aproximado === false ? "" : " (aproximada)";
  avisoDeLaVista("Vista previa" + aproximado + " de " + (modelo.layout || "el layout") + ": " +
    nodos + " nodos en una pantalla de " +
    ((modelo.pantalla && modelo.pantalla.ancho) || PANTALLA_POR_DEFECTO.ancho) + "×" +
    ((modelo.pantalla && modelo.pantalla.alto) || PANTALLA_POR_DEFECTO.alto) + " dp.");
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
