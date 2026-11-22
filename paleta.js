// Paleta de comandos Ctrl+Mayús+P. Todas las acciones son las que ya tiene la página: se llama a
// las funciones exportadas por pestana.js o se enfoca el control existente. Aquí solo hay filtro,
// teclado y presentación; no se reescribe ninguna lógica de guardar, compilar, firmar ni temas.
import { guardar, compilarDelTodo, firmar } from "./pestana.js";

(() => {
  const caja = document.getElementById("paleta");
  const entrada = document.getElementById("paleta-buscar");
  const lista = document.getElementById("paleta-lista");
  if (!caja || !entrada || !lista) return;

  function vista(nombre, id) {
    const boton = document.querySelector('[data-vista="' + nombre + '"]');
    if (boton) boton.click();
    const control = document.getElementById(id);
    if (control) { control.focus(); if (typeof control.click === "function") control.click(); }
  }

  const ACCIONES = [
    { titulo: "Abrir fichero", pista: "Enfoca el filtro del árbol del proyecto",
      ejecutar: () => vista("pestana", "filtro-arbol") },
    { titulo: "Guardar fichero", pista: "Ctrl+S", ejecutar: () => guardar() },
    { titulo: "Compilar APK", pista: "Guarda la clave, compila y verifica",
      ejecutar: () => compilarDelTodo() },
    { titulo: "Firmar otra APK", pista: "Firma un paquete que ya existe", ejecutar: () => firmar() },
    { titulo: "Cambiar tema", pista: "Selector de tema de la interfaz",
      ejecutar: () => vista("crear", "tema-ui") },
    { titulo: "Cambiar idioma", pista: "Selector de idioma de la página",
      ejecutar: () => vista("crear", "idioma-ui") },
  ];

  let visibles = [];
  let activa = 0;

  function pintar() {
    const q = entrada.value.trim().toLocaleLowerCase();
    visibles = ACCIONES.filter((a) => (a.titulo + " " + a.pista).toLocaleLowerCase().includes(q));
    if (activa >= visibles.length) activa = 0;
    lista.textContent = "";
    if (!visibles.length) {
      const vacia = document.createElement("li");
      vacia.className = "paleta-vacia";
      vacia.textContent = "Ningún comando coincide.";
      lista.appendChild(vacia);
      return;
    }
    visibles.forEach((accion, i) => {
      const item = document.createElement("li");
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "paleta-opcion" + (i === activa ? " activa" : "");
      boton.setAttribute("role", "option");
      boton.setAttribute("aria-selected", String(i === activa));
      boton.appendChild(document.createTextNode(accion.titulo));
      const pista = document.createElement("small");
      pista.textContent = accion.pista;
      boton.appendChild(pista);
      boton.addEventListener("click", () => elegir(accion));
      item.appendChild(boton);
      lista.appendChild(item);
    });
  }

  function abrir() {
    caja.hidden = false;
    entrada.value = "";
    activa = 0;
    pintar();
    entrada.focus();
  }

  function cerrar() {
    caja.hidden = true;
    lista.textContent = "";
  }

  function elegir(accion) {
    cerrar();
    Promise.resolve(accion.ejecutar()).catch((e) => {
      const aviso = document.getElementById("estado-pestana");
      if (aviso) aviso.textContent = "no se pudo ejecutar: " + ((e && e.message) || e);
    });
  }

  entrada.addEventListener("input", () => { activa = 0; pintar(); });
  entrada.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!visibles.length) return;
      activa = (activa + (e.key === "ArrowDown" ? 1 : -1) + visibles.length) % visibles.length;
      pintar();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (visibles[activa]) elegir(visibles[activa]);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); cerrar(); }
  });
  caja.addEventListener("click", (e) => { if (e.target === caja) cerrar(); });

  // Captura: el atajo Ctrl+P del editor no distingue de Mayús y también enfocaría el filtro del
  // árbol. Al interceptar en capture se evita que los dos atajos peleen por el foco.
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey || !e.shiftKey) return;
    if ((e.key || "").toLowerCase() !== "p") return;
    e.preventDefault();
    e.stopPropagation();
    if (caja.hidden) abrir(); else cerrar();
  }, true);
})();
