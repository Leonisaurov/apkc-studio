// Autocompletado del editor, sin red y sin dependencias. Lo que se sugiere sale de dos sitios que
// ya están en el propio origen: el árbol del proyecto en OPFS (los recursos de `res/`, los ids de
// los layouts y la `R.java` que dejó el build) y el `android.jar` que la pestaña guardó allí (los
// nombres de clase están en su directorio central y los de método, en el propio `.class`).
//
// Hay **dos lenguajes y dos contextos**: un `.java` sugiere recursos de `R.` y APIs del jar
// (`contextoDeCompletado`), y un `.xml` del proyecto sugiere etiquetas, atributos `android:`/
// `tools:`, valores enumerados y referencias `@string/…` (`contextoXml`). Nunca se cruzan: la
// extensión del fichero activo elige la rama, así que en un layout no aparece `R.` ni una clase
// Java, y en un fuente no aparece una etiqueta XML. El estado del popup dice cuál es (`xml · …`).
//
// La parte difícil —qué se está completando, cómo se parte el zip y cómo se lee un `.class`— está en
// autocompletado-datos.js, que es puro y se prueba en node con `prueba.js`. Este fichero lee del
// hospedador, elige qué enseñar y pinta la lista.
//
// Contrato que usa `prueba-pestana.js` (y que la consola de desarrollo puede llamar a mano):
//   window.AUTOCOMPLETADO.refrescar()   vuelve a leer los recursos del proyecto
//   window.AUTOCOMPLETADO.recursos()    resumen { nombres, tipos }
//   window.AUTOCOMPLETADO.cargarJar()   índice del jar y lo que se leyó de OPFS para tenerlo
//   window.AUTOCOMPLETADO.medida()      lecturas del jar, clases cacheadas y recursos barridos
//   window.AUTOCOMPLETADO.textoSinJar() qué se puede sugerir sin el jar
import { hospedador, EDITOR, RUTA_JAR, estadoPestana } from "./pestana.js";
import {
  buscarFinDirectorio, leerEntradasDirectorio, clasesDelJar, offsetDeDatosLocales,
  metodosDeClase, contextoDeCompletado, agregarIdsDeXml, clasesDeclaradas, esRutaXml,
} from "./autocompletado-datos.js";
import {
  cargarRecursosProyecto, cargarClasesProyecto, invalidarRecursosProyecto, recursosEnCache,
  totalDeNombres,
} from "./recursos-proyecto.js";
import { contextoXml, sugerenciasXml } from "./xml-editor.js";

// Un `.class` del android.jar ocupa unos cientos de KiB: 8 MiB dejan sitio de sobra a una clase
// grande y cortan una entrada que declare poco y expanda mucho. La cota se cuenta sobre los bytes
// que el flujo produce de verdad, no sobre el `descomprimido` del directorio central, que es una
// promesa del fichero: la auditoría de seguridad infló 1024 B declarados a 200 MiB.
const MAX_CLASE = 8 * 1024 * 1024;

// `deflate-raw` es del navegador, no una dependencia: el jar guarda las clases comprimidas y el
// completado de métodos necesita los bytes del `.class` tal cual. La lectura se corta —y se
// cancela— en cuanto lo producido pasa de `tope`; `nombre` es la ruta de la clase y va en el
// mensaje de rechazo, que es lo que enseña el popup. Vive fuera del IIFE para poder probarla sin
// DOM.
export async function inflarConTope(bytes, tope, nombre) {
  if (typeof DecompressionStream !== "function") return null;
  const lector = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const trozos = [];
  let producido = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    producido += value.length;
    if (producido > tope) {
      // cancelar cierra el flujo: lo que quedaba comprimido no se descomprime ni se guarda
      await lector.cancel();
      throw new Error("la clase " + nombre + " se expande por encima de " + (tope / (1024 * 1024)) +
        " MiB: no es un .class del android.jar y no se infla");
    }
    trozos.push(value);
  }
  const salida = new Uint8Array(producido);
  let at = 0;
  for (const trozo of trozos) { salida.set(trozo, at); at += trozo.length; }
  return salida;
}

(() => {
  // sin DOM no hay editor que completar: el módulo se puede importar en node para probar sus
  // funciones puras (`inflarConTope`) sin arrastrar la página
  if (typeof document === "undefined") return;
  const area = document.getElementById("codigo");
  const caja = document.getElementById("autocompletado");
  const lista = document.getElementById("autocompletado-lista");
  const estado = document.getElementById("autocompletado-estado");
  if (!area || !caja || !lista || !estado) return;

  const MAXIMO = 50;

  let jar = null;               // { clases: Map(simple -> entrada), leidos, medida }
  let jarFallo = null;          // motivo del último fallo al leer el jar
  let jarFalloCuando = 0;       // cuándo falló: si la página trae el jar después, se reintenta
  const metodosVistos = new Map();
  // Cuentas para poder medir el overhead sin abrir la pestaña: cuántas veces se pidió el índice
  // del jar, cuántos `.class` se inflaron y cuántos métodos salieron de la caché.
  let lecturasJar = 0;
  let lecturasMetodos = 0;

  // Insertar con `EDITOR.cambiar` dispara un `input`; sin esta marca la lista se reabriría con el
  // nombre que se acaba de completar.
  let insertando = false;
  let generacion = 0;
  let abierta = false;
  let candidatos = [];
  let activo = 0;
  let contexto = null;

  const sinJar = () => "sin android.jar en OPFS: las clases y los métodos del jar no se pueden " +
    "sugerir (los recursos del proyecto sí, que salen de res/ y de R.java, y nada de esto usa la red)";

  // ---- datos del proyecto ------------------------------------------------------------

  // El barrido y su caché viven en `recursos-proyecto.js`: el linter de XML necesita el mismo mapa
  // para saber si un `@string/…` existe, y no se recorre OPFS dos veces por pulsación.
  const cargarRecursos = () => cargarRecursosProyecto();

  // ---- el jar, por trozos ------------------------------------------------------------

  // El android.jar no se baja ni se copia: se pide su tamaño, la cola donde vive el EOCD y el
  // directorio central. Los nombres de clase salen de ahí; los de método, solo de la clase que se
  // está completando.
  async function cargarJar() {
    if (jar) return jar;
    // Si el jar no estaba, el aviso se queda, pero no para siempre: la página lo puede traer del
    // SDK local o de un .zip, y entonces `View.` tiene que volver a funcionar sin recargar.
    if (jarFallo && Date.now() - jarFalloCuando < 5000) throw new Error(jarFallo);
    if (jarFallo) jarFallo = null;
    const t0 = performance.now();
    try {
      lecturasJar++;
      const vacio = await hospedador.rango(RUTA_JAR, 0, 0);
      if (!vacio || !vacio.tamano) throw new Error(sinJar());
      const cola = await hospedador.rango(RUTA_JAR, Math.max(0, vacio.tamano - 65557), 65557);
      const fin = buscarFinDirectorio(cola.bytes);
      if (!fin) throw new Error("el directorio central del android.jar no se entiende");
      if (fin.zip64) throw new Error("el android.jar es un zip64 y este lector no lo parte");
      const directorio = await hospedador.rango(RUTA_JAR, fin.inicioDirectorio, fin.tamanoDirectorio);
      // el offset local de cada entrada es relativo al principio del fichero: sin pasarle el
      // inicio del directorio, `metodosDe` leería la cabecera local en un sitio equivocado y
      // `View.` salía con cero métodos (los nombres de clase sí se leían: van en el nombre)
      const clases = clasesDelJar(leerEntradasDirectorio(directorio.bytes, fin.inicioDirectorio));
      const leidos = (cola.bytes ? cola.bytes.length : 0) + (directorio.bytes ? directorio.bytes.length : 0);
      jar = {
        // la entrada del zip, con su ruta punteada: el lector de métodos necesita `local`,
        // `comprimido` y `metodo`, que viven en la entrada y no en el nombre de la clase
        clases: new Map(clases.map((c) => [c.simple, Object.assign({}, c.entrada, { ruta: c.ruta })])),
        leidos,
        medida: {
          clases: clases.length, bytes: leidos, tamanoArchivo: vacio.tamano,
          ms: Math.round(performance.now() - t0),
        },
      };
      return jar;
    } catch (e) {
      jarFallo = (e && e.message) || String(e);
      jarFalloCuando = Date.now();
      throw e;
    }
  }

  async function metodosDe(entrada) {
    if (!entrada || !Number.isFinite(entrada.local)) return [];
    // una clase se lee una vez aunque se teclee `View.`, `View.ge` y `View.getW`: la caché no
    // depende del prefijo, solo de la entrada del zip
    if (metodosVistos.has(entrada.local)) return metodosVistos.get(entrada.local);
    lecturasMetodos++;
    const cabecera = await hospedador.rango(RUTA_JAR, entrada.local, 30);
    const desde = offsetDeDatosLocales(cabecera.bytes);
    if (desde < 0) return [];
    const datos = await hospedador.rango(RUTA_JAR, entrada.local + desde, entrada.comprimido);
    const bytes = entrada.metodo === 8
      ? await inflarConTope(datos.bytes, MAX_CLASE, entrada.ruta || "sin ruta")
      : datos.bytes;
    const metodos = bytes ? metodosDeClase(bytes) : [];
    metodosVistos.set(entrada.local, metodos);
    return metodos;
  }

  // ---- qué se sugiere ----------------------------------------------------------------

  function conPrefijo(items, prefijo) {
    const p = String(prefijo || "").toLowerCase();
    if (!p) return items;
    const empiezan = [];
    const contienen = [];
    for (const item of items) {
      // `filtro` deja que un atributo se encuentre por su nombre local (`textS`) aunque se
      // inserte con prefijo (`android:textSize`)
      const nombre = String(item.filtro || item.texto).toLowerCase();
      if (nombre.startsWith(p)) empiezan.push(item);
      else if (nombre.includes(p)) contienen.push(item);
    }
    return empiezan.concat(contienen);
  }

  // El fichero activo decide el lenguaje. La extensión manda: un layout no lleva Java y un
  // fuente no lleva etiquetas XML, aunque su texto se parezca.
  function esFicheroXml() {
    return esRutaXml((estadoPestana && estadoPestana.ruta) || "");
  }

  async function candidatosXml(ctx) {
    // las etiquetas no necesitan OPFS; las referencias y los valores sí
    const necesitaDatos = ctx.modo === "referencia" || ctx.modo === "valor";
    let mapa = {};
    let ids = null;
    if (necesitaDatos) {
      try { mapa = await cargarRecursos(); } catch (e) { mapa = {}; }
      // los `@+id` del buffer cuentan aunque no se hayan guardado
      ids = agregarIdsDeXml(area.value, {}).id || null;
    }
    return sugerenciasXml(ctx, {
      recursos: mapa,
      id: ids,
      ruta: (estadoPestana && estadoPestana.ruta) || "",
    });
  }

  async function candidatosPara(ctx) {
    if (ctx.modo === "tipos") {
      const mapa = await cargarRecursos();
      const tipos = Object.keys(mapa).sort();
      return {
        estado: `recursos del proyecto · ${tipos.length} tipos`,
        lista: tipos.map((tipo) => ({
          texto: "R." + tipo, insertar: tipo,
          pista: `${(mapa[tipo] || new Set()).size} nombres`, clase: "recurso",
        })),
      };
    }
    if (ctx.modo === "valores") {
      const mapa = await cargarRecursos();
      const nombres = mapa[ctx.tipo] ? [...mapa[ctx.tipo]].sort() : [];
      return {
        estado: `R.${ctx.tipo} · ${nombres.length} nombres`,
        lista: nombres.map((n) => ({ texto: n, insertar: n, pista: "recurso", clase: "recurso" })),
      };
    }
    if (ctx.modo === "clases") {
      // tipos del jar + del proyecto + los declarados en el buffer. El jar puede faltar y los
      // otros dos siguen valiendo: se dice en el estado y no se pierde la lista del proyecto.
      const pistas = new Map();
      let sinJar = "";
      try {
        const indice = await cargarJar();
        for (const c of indice.clases.keys()) pistas.set(c, indice.clases.get(c).ruta);
      } catch (e) {
        sinJar = (e && e.message) || String(e);
      }
      for (const c of clasesDeclaradas(area.value)) {
        if (!pistas.has(c)) pistas.set(c, "de este fichero");
      }
      try {
        for (const c of await cargarClasesProyecto()) {
          if (!pistas.has(c)) pistas.set(c, "proyecto");
        }
      } catch (e) { /* sin OPFS solo quedan el jar y el buffer */ }
      const lista = conPrefijo([...pistas.keys()].sort().map((c) => ({
        texto: c, insertar: c, pista: pistas.get(c), clase: "clase",
      })), ctx.prefijo);
      const estado = sinJar
        ? `clases del proyecto · ${pistas.size} · ${sinJar}`
        : `clases del android.jar y del proyecto · ${pistas.size}`;
      return { estado, lista };
    }
    const indice = await cargarJar();
    const entrada = indice.clases.get(ctx.clase);
    if (!entrada) return { estado: `sin ${ctx.clase} en el android.jar`, lista: [] };
    const metodos = await metodosDe(entrada);
    const vistos = new Set();
    const lista = [];
    for (const m of metodos) {
      // `<init>`/`<clinit>` no se llaman con un punto: el constructor se escribe con `new`
      if (!m.publico || m.nombre.startsWith("<") || vistos.has(m.nombre)) continue;
      vistos.add(m.nombre);
      lista.push({
        texto: m.nombre, insertar: m.nombre,
        pista: (m.estatico ? "static " : "") + m.descriptor, clase: "metodo",
      });
    }
    lista.sort((a, b) => a.texto.localeCompare(b.texto));
    return { estado: `métodos de ${entrada.ruta} · ${lista.length}`, lista };
  }

  // ---- pintar -------------------------------------------------------------------------

  function anchoDe(texto) {
    const estilo = getComputedStyle(area);
    const sonda = document.createElement("span");
    sonda.textContent = texto;
    sonda.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    sonda.style.fontFamily = estilo.fontFamily;
    sonda.style.fontSize = estilo.fontSize;
    sonda.style.fontWeight = estilo.fontWeight;
    sonda.style.letterSpacing = estilo.letterSpacing;
    document.body.appendChild(sonda);
    const ancho = sonda.getBoundingClientRect().width;
    sonda.remove();
    return Number.isFinite(ancho) && ancho > 0 ? ancho : 0;
  }

  // La lista se abre debajo de la línea del cursor. La columna se lleva a píxeles con el ancho de un
  // carácter: es una ventana emergente, no subraya nada, así que un tabulador solo la desplaza.
  function colocar() {
    const antes = area.value.slice(0, area.selectionStart);
    const linea = antes.split("\n").length;
    const columna = antes.length - antes.lastIndexOf("\n");
    const alto = parseFloat(getComputedStyle(area).lineHeight) || 20;
    const ancho = anchoDe("0") || 8;
    const marco = area.getBoundingClientRect();
    const izquierda = 12 + (columna - 1) * ancho - area.scrollLeft;
    const arriba = 10 + linea * alto - area.scrollTop;
    caja.style.left = Math.max(4, Math.min(izquierda, Math.max(4, marco.width - 260))) + "px";
    caja.style.top = Math.max(4, Math.min(arriba, Math.max(4, marco.height - 40))) + "px";
  }

  function pintar(mensaje) {
    lista.textContent = "";
    const cuantos = Math.min(candidatos.length, MAXIMO);
    for (let i = 0; i < cuantos; i++) {
      const c = candidatos[i];
      const fila = document.createElement("li");
      fila.setAttribute("role", "presentation");
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "autocompletado-opcion" + (i === activo ? " activa" : "");
      boton.id = "autocompletado-opcion-" + i;
      boton.setAttribute("role", "option");
      boton.setAttribute("aria-selected", i === activo ? "true" : "false");
      const nombre = document.createElement("code");
      nombre.textContent = c.texto;
      const pista = document.createElement("span");
      pista.className = "autocompletado-pista";
      pista.textContent = c.pista || c.clase || "";
      boton.appendChild(nombre);
      boton.appendChild(pista);
      // el foco se queda en el textarea: pulsar una sugerencia no puede mover el cursor
      boton.addEventListener("mousedown", (e) => { e.preventDefault(); aceptar(c); });
      fila.appendChild(boton);
      lista.appendChild(fila);
    }
    estado.textContent = mensaje || "";
    // sin sugerencias pero con un motivo (falta el android.jar, no hay recursos declarados) la
    // caja se enseña igual: el aviso tiene que verse, no quedarse en un estado oculto
    caja.hidden = cuantos === 0 && !mensaje;
    abierta = cuantos > 0;
    if (!caja.hidden) colocar();
  }

  function cerrar() {
    generacion++;
    candidatos = [];
    activo = 0;
    abierta = false;
    contexto = null;
    lista.textContent = "";
    caja.hidden = true;
  }

  async function sugerir() {
    const mio = ++generacion;
    const enXml = esFicheroXml();
    const ctx = enXml
      ? contextoXml(area.value, area.selectionStart)
      : contextoDeCompletado(area.value, area.selectionStart);
    if (!ctx) { cerrar(); return; }
    let resultado = { estado: "", lista: [] };
    try {
      resultado = enXml ? await candidatosXml(ctx) : await candidatosPara(ctx);
    } catch (e) {
      if (mio !== generacion) return;
      contexto = null;
      candidatos = [];
      activo = 0;
      pintar((e && e.message) || String(e));
      return;
    }
    if (mio !== generacion) return;
    contexto = ctx;
    candidatos = conPrefijo(resultado.lista, ctx.prefijo);
    activo = 0;
    const total = resultado.lista.length;
    const nota = total > candidatos.length ? `${candidatos.length} de ${total}` : `${total}`;
    pintar(`${resultado.estado}${ctx.prefijo ? " · " + nota : ""}`);
  }

  function mover(paso) {
    const cuantos = Math.min(candidatos.length, MAXIMO);
    if (!abierta || cuantos === 0) return;
    activo = (activo + paso + cuantos) % cuantos;
    for (const boton of lista.querySelectorAll(".autocompletado-opcion")) {
      const i = Number(boton.id.slice("autocompletado-opcion-".length));
      boton.classList.toggle("activa", i === activo);
      boton.setAttribute("aria-selected", i === activo ? "true" : "false");
    }
  }

  function aceptar(elegido) {
    const c = elegido || candidatos[activo];
    const ctx = contexto;
    if (!c || !ctx) { cerrar(); return; }
    cerrar();
    const desde = ctx.desde;
    const hasta = ctx.hasta;
    insertando = true;
    try {
      EDITOR.cambiar(desde, hasta, c.insertar, [desde + c.insertar.length, desde + c.insertar.length]);
    } finally {
      insertando = false;
    }
    area.focus();
  }

  // ---- enganches ---------------------------------------------------------------------

  // En captura sobre `document`: así corre antes que el Tab/Enter del editor, que si no insertaría
  // cuatro espacios o una línea nueva con la lista abierta. Las demás teclas pasan de largo (la
  // paleta, Ctrl+G y los atajos de la página siguen funcionando con la lista abierta).
  document.addEventListener("keydown", (e) => {
    if (document.activeElement !== area) return;
    if (!abierta) {
      if (e.key === " " && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sugerir();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cerrar();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      mover(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      aceptar();
    }
  }, true);

  area.addEventListener("input", () => {
    if (insertando) return;
    // Los recursos se invalidan al guardar, crear, importar o recibir un cambio de otra
    // ventana (`apkc:proyecto-cambio`), no en cada pulsación: el buffer ya aporta sus `@+id` y
    // un `res/` sin guardar no forma parte del proyecto.
    sugerir();
  });
  area.addEventListener("scroll", () => { if (abierta) cerrar(); });
  area.addEventListener("blur", () => { cerrar(); });

  // Puente para las pruebas CDP y la consola de desarrollo. No es la fuente de verdad del módulo.
  if (typeof window !== "undefined") {
    Object.assign(window, {
      AUTOCOMPLETADO: {
        refrescar: async () => {
          invalidarRecursosProyecto();
          const mapa = await cargarRecursos();
          return { nombres: totalDeNombres(mapa), tipos: Object.keys(mapa).sort() };
        },
        recursos: () => {
          const mapa = recursosEnCache();
          return { nombres: totalDeNombres(mapa), tipos: Object.keys(mapa).sort() };
        },
        cargarJar: async () => {
          const indice = await cargarJar();
          return { clases: indice.clases.size, leidos: indice.leidos, medida: indice.medida };
        },
        // la página puede guardar o cambiar el jar (SDK local, .zip oficial): el índice cacheado
        // y el aviso de «sin jar» se tiran para volver a leerlo
        olvidarJar: () => {
          jar = null; jarFallo = null; metodosVistos.clear();
          lecturasJar = 0; lecturasMetodos = 0;
        },
        textoSinJar: sinJar,
        // overhead medido sin abrir DevTools: el índice del jar se pide una vez (`lecturasJar`),
        // cada `.class` se infla una vez (`lecturasMetodos`) y el resto son aciertos de caché
        medida: () => ({
          jar: jar ? { clases: jar.medida.clases, bytes: jar.medida.bytes, ms: jar.medida.ms,
            lecturas: lecturasJar } : null,
          metodos: { leidos: lecturasMetodos, enCache: metodosVistos.size },
          recursos: { nombres: totalDeNombres(recursosEnCache()),
            tipos: Object.keys(recursosEnCache()).length },
        }),
        sugerir,
        cerrar,
      },
    });
  }
})();
