// Barra de búsqueda, reemplazo e ir a línea del editor. Se monta con las piezas que le
// pasa pestana.js para no importar el orquestador desde aquí.

export function crearBusqueda({ EDITOR, actualizarCursor, irALinea }) {
  // --- buscar, reemplazar e ir a línea --------------------------------------------------------
  // La barra es del editor, no del navegador: buscar dentro de un fuente no puede abrir el panel
  // de búsqueda de la página, que no conoce el resaltado ni el undo tree.
  function abrirBusqueda(reemplazo) {
    const barra = document.getElementById("buscar-barra");
    if (!barra) return;
    barra.hidden = false;
    const campo = document.getElementById("buscar-texto");
    const area = document.getElementById("codigo");
    for (const id of ["reemplazar-texto", "reemplazar-uno", "reemplazar-todos"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = !reemplazo;
    }
    if (campo) {
      if (area && area.selectionEnd > area.selectionStart) {
        const elegido = area.value.slice(area.selectionStart, area.selectionEnd);
        if (elegido && !elegido.includes("\n")) campo.value = elegido;
      }
      campo.focus();
      campo.select();
    }
  }

  function cerrarBusqueda() {
    const barra = document.getElementById("buscar-barra");
    if (barra) barra.hidden = true;
    const area = document.getElementById("codigo");
    if (area) area.focus();
  }

  function buscarSiguiente(atras) {
    const area = document.getElementById("codigo");
    const campo = document.getElementById("buscar-texto");
    const estado = document.getElementById("buscar-estado");
    if (!area || !campo) return false;
    const aguja = campo.value;
    if (!aguja) return false;
    const pajar = area.value.toLowerCase();
    const busca = aguja.toLowerCase();
    const desde = atras ? Math.max(0, area.selectionStart - 1) : area.selectionEnd;
    let i = atras ? pajar.lastIndexOf(busca, desde) : pajar.indexOf(busca, desde);
    if (i < 0) i = atras ? pajar.lastIndexOf(busca) : pajar.indexOf(busca);
    if (i < 0) {
      if (estado) estado.textContent = "sin coincidencias";
      return false;
    }
    area.focus();
    area.setSelectionRange(i, i + aguja.length);
    const linea = area.value.slice(0, i).split("\n").length;
    const alto = parseFloat(getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (linea - 3) * alto);
    EDITOR.sincronizar();
    actualizarCursor();
    if (estado) estado.textContent = "línea " + linea;
    return true;
  }

  function reemplazarUno() {
    const area = document.getElementById("codigo");
    const aguja = (document.getElementById("buscar-texto") || {}).value || "";
    const nuevo = (document.getElementById("reemplazar-texto") || {}).value || "";
    if (!area || !aguja) return;
    const elegido = area.value.slice(area.selectionStart, area.selectionEnd);
    if (elegido.toLowerCase() !== aguja.toLowerCase()) {
      if (!buscarSiguiente(false)) return;
    }
    const desde = area.selectionStart, hasta = area.selectionEnd;
    EDITOR.cambiar(desde, hasta, nuevo, [desde + nuevo.length, desde + nuevo.length]);
    buscarSiguiente(false);
  }

  function reemplazarTodos() {
    const area = document.getElementById("codigo");
    const aguja = (document.getElementById("buscar-texto") || {}).value || "";
    const nuevo = (document.getElementById("reemplazar-texto") || {}).value || "";
    const estado = document.getElementById("buscar-estado");
    if (!area || !aguja) return;
    const patron = new RegExp(aguja.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const cuantos = (area.value.match(patron) || []).length;
    if (!cuantos) {
      if (estado) estado.textContent = "sin coincidencias";
      return;
    }
    EDITOR.cambiar(0, area.value.length, area.value.replace(patron, nuevo));
    if (estado) estado.textContent = cuantos + " reemplazadas";
    actualizarCursor();
  }

  function irALineaDesdeCuadro() {
    const n = window.prompt("Ir a la línea", "1");
    if (n && /^\d+$/.test(n.trim())) irALinea(Number(n));
  }
  return { abrirBusqueda, cerrarBusqueda, buscarSiguiente, reemplazarUno,
    reemplazarTodos, irALineaDesdeCuadro };
}
