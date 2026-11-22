// Errores en vivo del fuente que se está escribiendo. No hay reglas nuevas: el texto se manda a
// `apkc check` a través del hospedador de siempre (worker + wasm) y el JSON que vuelve se pinta en
// el panel y como subrayado sobre el textarea. El fichero temporal se limpia después de cada paso,
// así que el árbol del proyecto no se ensucia y nada sale del origen.
import { hospedador, estadoPestana, DOCUMENTOS, RUTA_JAR, irALinea } from "./pestana.js";

(() => {
  const area = document.getElementById("codigo");
  const marcas = document.getElementById("diagnostico-marcas");
  const lista = document.getElementById("diagnostico-vivo-lista");
  const estado = document.getElementById("diagnostico-vivo-estado");
  if (!area || !marcas || !lista || !estado) return;

  const TEMPORAL = "/proyecto/.apkc-check.java";
  const ESPERA = 350; // ms tras la última pulsación
  let temporizador = null;
  let serie = 0;
  let enCurso = false;
  let pendiente = false;
  let errores = [];

  // El resalto y el textarea comparten fuente y padding (10px 12px en style.css); el alto de
  // línea se pregunta al navegador para no copiar aquí el valor de la variable del tema.
  function alturaLinea() {
    const alto = parseFloat(getComputedStyle(area).lineHeight);
    return Number.isFinite(alto) && alto > 0 ? alto : 20;
  }

  function sincronizar() {
    const alto = alturaLinea();
    for (const nodo of marcas.children) {
      const linea = Number(nodo.dataset.linea) || 1;
      nodo.style.top = (10 + (linea - 1) * alto + alto - 2 - area.scrollTop) + "px";
    }
  }

  function pintar() {
    marcas.textContent = "";
    for (const e of errores) {
      const linea = Number(e.linea);
      if (!linea || linea < 1) continue;
      const marca = document.createElement("span");
      marca.className = "marca-error";
      marca.dataset.linea = String(linea);
      marcas.appendChild(marca);
    }
    sincronizar();

    lista.textContent = "";
    if (!errores.length) {
      const limpio = document.createElement("li");
      limpio.className = "sin-errores";
      limpio.textContent = "Sin errores.";
      lista.appendChild(limpio);
      return;
    }
    for (const e of errores) {
      const item = document.createElement("li");
      const boton = document.createElement("button");
      boton.type = "button";
      const where = document.createElement("code");
      where.textContent = "línea " + (Number(e.linea) || "?");
      boton.appendChild(where);
      boton.appendChild(document.createTextNode(String(e.mensaje || "")));
      boton.addEventListener("click", () => {
        const linea = Number(e.linea);
        if (linea > 0) irALinea(linea);
        area.focus();
      });
      item.appendChild(boton);
      lista.appendChild(item);
    }
  }

  // apkc escribe el JSON en el fd 1 y main añade después su línea de tiempo; se busca la última
  // línea que sea el objeto del comando, con los códigos de color de la consola ya quitados.
  function leerJson(consola) {
    const lineas = String(consola || "").split("\n")
      .map((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim());
    for (let i = lineas.length - 1; i >= 0; i--) {
      if (!lineas[i].startsWith('{"tipo":"check"')) continue;
      try {
        const dato = JSON.parse(lineas[i]);
        if (dato && dato.tipo === "check") return dato;
      } catch (e) { /* otra línea con el mismo prefijo: se sigue buscando */ }
    }
    return null;
  }

  function programar() {
    clearTimeout(temporizador);
    temporizador = setTimeout(verificar, ESPERA);
  }

  async function verificar() {
    clearTimeout(temporizador);
    if (enCurso) { pendiente = true; return; }
    const ruta = estadoPestana.ruta || (DOCUMENTOS && DOCUMENTOS.activa) || "";
    if (!/\.java$/i.test(ruta)) {
      errores = [];
      pintar();
      estado.textContent = "Abre un fichero .java para ver los errores mientras escribes.";
      return;
    }
    const texto = area.value;
    const mio = ++serie;
    enCurso = true;
    estado.textContent = "comprobando…";
    try {
      const escrito = await hospedador.escribir(TEMPORAL, new TextEncoder().encode(texto));
      if (escrito && escrito.tipo === "error") throw new Error(escrito.error);
      const r = await hospedador.ejecutar(["check", "--android-jar", RUTA_JAR, TEMPORAL]);
      if (r && r.tipo === "error") throw new Error(r.error);
      const dato = leerJson(r && r.consola);
      if (!dato) throw new Error("apkc check no devolvió JSON");
      if (mio !== serie) return;
      errores = Array.isArray(dato.errores) ? dato.errores : [];
      const resumen = errores.length
        ? errores.length + (errores.length === 1 ? " error" : " errores")
        : "sin errores";
      estado.textContent = resumen + (dato.aviso ? " · " + dato.aviso : "");
      pintar();
    } catch (e) {
      if (mio === serie) {
        errores = [];
        pintar();
        estado.textContent = "no se pudo comprobar: " + ((e && e.message) || e);
      }
    } finally {
      enCurso = false;
      await hospedador.limpiar(TEMPORAL).catch(() => {});
      if (pendiente) { pendiente = false; programar(); }
    }
  }

  area.addEventListener("input", programar);
  area.addEventListener("scroll", sincronizar);
  const arbol = document.getElementById("arbol-pestana");
  if (arbol) arbol.addEventListener("click", programar);
  const pestañas = document.getElementById("pestanas-archivo");
  if (pestañas) {
    pestañas.addEventListener("click", programar);
    // abrir un fichero también puede venir de un atajo o de otra ventana, sin clic en el árbol:
    // la barra de pestañas se vuelve a pintar y ahí lo vemos sin depender de quién la tocó.
    if (typeof MutationObserver === "function") {
      new MutationObserver(programar).observe(pestañas,
        { childList: true, subtree: true, characterData: true });
    }
  }
  window.addEventListener("resize", sincronizar);
  programar();
})();
