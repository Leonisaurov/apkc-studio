// Autocompletado del editor, sin red y sin dependencias. Lo que se sugiere sale de dos sitios que
// ya están en el propio origen: el árbol del proyecto en OPFS (los recursos de `res/`, los ids de
// los layouts y la `R.java` que dejó el build) y el `android.jar` que la pestaña guardó allí (los
// nombres de clase están en su directorio central y los de método, en el propio `.class`).
//
// La parte difícil —qué se está completando, cómo se parte el zip y cómo se lee un `.class`— está en
// autocompletado-datos.js, que es puro y se prueba en node con `prueba.js`. Este fichero lee del
// hospedador, elige qué enseñar y pinta la lista.
//
// Contrato que usa `prueba-pestana.js` (y que la consola de desarrollo puede llamar a mano):
//   window.AUTOCOMPLETADO.refrescar()   vuelve a leer los recursos del proyecto
//   window.AUTOCOMPLETADO.recursos()    resumen { nombres, tipos }
//   window.AUTOCOMPLETADO.cargarJar()   índice del jar y lo que se leyó de OPFS para tenerlo
//   window.AUTOCOMPLETADO.textoSinJar() qué se puede sugerir sin el jar
import { hospedador, EDITOR, RUTA_JAR, estadoPestana } from "./pestana.js";
import {
  recursosDeRutas, agregarValores, agregarIdsDeXml, recursosDeRJava,
  buscarFinDirectorio, leerEntradasDirectorio, clasesDelJar, offsetDeDatosLocales,
  metodosDeClase, contextoDeCompletado,
} from "./autocompletado-datos.js";

(() => {
  const area = document.getElementById("codigo");
  const caja = document.getElementById("autocompletado");
  const lista = document.getElementById("autocompletado-lista");
  const estado = document.getElementById("autocompletado-estado");
  if (!area || !caja || !lista || !estado) return;

  const MAXIMO = 50;
  const TEXTOS = new TextDecoder();

  let recursos = null;          // tipo -> Set de nombres
  let jar = null;               // { clases: Map(simple -> entrada), leidos, medida }
  let jarFallo = null;          // motivo del último fallo al leer el jar
  let jarFalloCuando = 0;       // cuándo falló: si la página trae el jar después, se reintenta
  let limpiarRecursos = null;   // editar res/ o R.java invalida el barrido, pero con pausa
  const metodosVistos = new Map();

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

  function totalDeNombres(mapa) {
    let total = 0;
    for (const tipo of Object.keys(mapa)) total += (mapa[tipo] || new Set()).size;
    return total;
  }

  async function leerRecursos() {
    const mapa = {};
    const arbol = await hospedador.arbol();
    const rutas = ((arbol && arbol.nodos) || [])
      .filter((n) => n && n.ruta && !n.dir)
      .map((n) => n.ruta);
    recursosDeRutas(rutas, mapa);
    for (const ruta of rutas) {
      const esValues = /\/res\/values[^/]*\/[^/]+\.xml$/.test(ruta);
      const esXml = /\/res\/(layout|menu|xml)[^/]*\/[^/]+\.xml$/.test(ruta);
      const esR = /\/src\/(?:.+\/)?R\.java$/.test(ruta);
      if (!esValues && !esXml && !esR) continue;
      let bytes = null;
      try {
        bytes = await hospedador.bytes(ruta); // el hospedador devuelve el Uint8Array, no un envoltorio
      } catch (e) {
        continue;
      }
      if (!bytes) continue;
      const texto = TEXTOS.decode(bytes);
      if (esValues) agregarValores(texto, mapa);
      else if (esR) recursosDeRJava(texto, mapa);
      else agregarIdsDeXml(texto, mapa);
    }
    return mapa;
  }

  async function cargarRecursos() {
    // un barrido vacío no se cachea: el proyecto se puede crear después de la primera consulta
    if (recursos && Object.keys(recursos).length) return recursos;
    recursos = await leerRecursos();
    return recursos;
  }

  // Editar un res/values, un layout o la R.java cambia lo que se sugiere. No se barre por cada
  // pulsación: se marca y se relee cuando la persona deja de teclear.
  function recursosCambiaron() {
    const ruta = (estadoPestana && estadoPestana.ruta) || "";
    if (!/\/proyecto\/res\//.test(ruta) && !/(^|\/)R\.java$/.test(ruta)) return;
    if (limpiarRecursos) clearTimeout(limpiarRecursos);
    limpiarRecursos = setTimeout(() => { recursos = null; limpiarRecursos = null; }, 800);
  }

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

  // `deflate-raw` es del navegador, no una dependencia: el jar guarda las clases comprimidas y el
  // completado de métodos necesita los bytes del `.class` tal cual.
  async function inflar(bytes) {
    if (typeof DecompressionStream !== "function") return null;
    const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(flujo).arrayBuffer());
  }

  async function metodosDe(entrada) {
    if (!entrada || !Number.isFinite(entrada.local)) return [];
    if (metodosVistos.has(entrada.local)) return metodosVistos.get(entrada.local);
    const cabecera = await hospedador.rango(RUTA_JAR, entrada.local, 30);
    const desde = offsetDeDatosLocales(cabecera.bytes);
    if (desde < 0) return [];
    const datos = await hospedador.rango(RUTA_JAR, entrada.local + desde, entrada.comprimido);
    const bytes = entrada.metodo === 8 ? await inflar(datos.bytes) : datos.bytes;
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
      const nombre = item.texto.toLowerCase();
      if (nombre.startsWith(p)) empiezan.push(item);
      else if (nombre.includes(p)) contienen.push(item);
    }
    return empiezan.concat(contienen);
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
    const indice = await cargarJar();
    if (ctx.modo === "clases") {
      const todos = [...indice.clases.keys()].sort();
      const lista = conPrefijo(todos.map((c) => ({
        texto: c, insertar: c, pista: indice.clases.get(c).ruta, clase: "clase",
      })), ctx.prefijo);
      return { estado: `clases del android.jar · ${indice.medida.clases}`, lista };
    }
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
    const ctx = contextoDeCompletado(area.value, area.selectionStart);
    if (!ctx) { cerrar(); return; }
    let resultado = { estado: "", lista: [] };
    try {
      resultado = await candidatosPara(ctx);
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
    recursosCambiaron();
    sugerir();
  });
  area.addEventListener("scroll", () => { if (abierta) cerrar(); });
  area.addEventListener("blur", () => { cerrar(); });

  // Puente para las pruebas CDP y la consola de desarrollo. No es la fuente de verdad del módulo.
  if (typeof window !== "undefined") {
    Object.assign(window, {
      AUTOCOMPLETADO: {
        refrescar: async () => {
          recursos = null;
          const mapa = await cargarRecursos();
          return { nombres: totalDeNombres(mapa), tipos: Object.keys(mapa).sort() };
        },
        recursos: () => {
          const mapa = recursos || {};
          return { nombres: totalDeNombres(mapa), tipos: Object.keys(mapa).sort() };
        },
        cargarJar: async () => {
          const indice = await cargarJar();
          return { clases: indice.clases.size, leidos: indice.leidos, medida: indice.medida };
        },
        // la página puede guardar o cambiar el jar (SDK local, .zip oficial): el índice cacheado
        // y el aviso de «sin jar» se tiran para volver a leerlo
        olvidarJar: () => { jar = null; jarFallo = null; metodosVistos.clear(); },
        textoSinJar: sinJar,
        sugerir,
        cerrar,
      },
    });
  }
})();
