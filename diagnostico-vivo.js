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

  // El ancho de un carácter se mide con la fuente del textarea, que es monoespaciada: sin esto el
  // subrayado de la columna no cae sobre el token. Se mide una vez por fuente y no por error; si el
  // usuario cambia `#fuente-editor`, la clave cambia y se vuelve a medir.
  let anchoCaracter = 0;
  let fuenteMedida = "";
  function medirCaracter() {
    const estilo = getComputedStyle(area);
    const clave = estilo.fontSize + "|" + estilo.fontFamily;
    if (anchoCaracter > 0 && clave === fuenteMedida) return anchoCaracter;
    const sonda = document.createElement("span");
    sonda.textContent = "0".repeat(40);
    sonda.style.position = "absolute";
    sonda.style.visibility = "hidden";
    sonda.style.whiteSpace = "pre";
    sonda.style.fontFamily = estilo.fontFamily;
    sonda.style.fontSize = estilo.fontSize;
    sonda.style.fontWeight = estilo.fontWeight;
    sonda.style.letterSpacing = estilo.letterSpacing;
    document.body.appendChild(sonda);
    const ancho = sonda.getBoundingClientRect().width / 40;
    sonda.remove();
    anchoCaracter = Number.isFinite(ancho) && ancho > 0 ? ancho : 8;
    fuenteMedida = clave;
    return anchoCaracter;
  }

  // El token que hay que subrayar: desde la columna, el identificador o la cadena de accesos
  // (`R.layout.main`) que sigue. Si el error cae en un signo, se subraya ese signo.
  function largoDeToken(texto, columna) {
    const resto = String(texto || "").slice(Math.max(0, columna - 1));
    const m = /^[A-Za-z0-9_$.]+/.exec(resto);
    return m ? m[0].length : 1;
  }

  function sincronizar() {
    const alto = alturaLinea();
    const ancho = medirCaracter();
    for (const nodo of marcas.children) {
      const linea = Number(nodo.dataset.linea) || 1;
      nodo.style.top = (10 + (linea - 1) * alto + alto - 2 - area.scrollTop) + "px";
      const columna = Number(nodo.dataset.columna) || 0;
      if (columna > 0) {
        nodo.style.right = "auto";
        nodo.style.left = (12 + (columna - 1) * ancho - area.scrollLeft) + "px";
        nodo.style.width = (Number(nodo.dataset.ancho) || ancho) + "px";
      }
    }
  }

  function pintar() {
    marcas.textContent = "";
    const lineas = area.value.split("\n");
    const ancho = medirCaracter();
    for (const e of errores) {
      const linea = Number(e.linea);
      if (!linea || linea < 1) continue;
      const marca = document.createElement("span");
      marca.className = "marca-error";
      marca.dataset.linea = String(linea);
      const columna = Number(e.columna);
      if (columna > 0) {
        const largo = largoDeToken(lineas[linea - 1], columna);
        marca.dataset.columna = String(columna);
        marca.dataset.ancho = String(largo * ancho);
      }
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
      // `archivo:línea:columna` cuando el error nació en un token; `archivo:línea` si solo se sabe la
      // línea. Se enlaza al sitio exacto y el texto dice qué pasa, sin repetir la posición.
      where.textContent = e.posicion || ("línea " + (Number(e.linea) || "?"));
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
      // `--proyecto` es lo que hace que `R.layout.main` exista: check enlaza res/ (o usa la R.java que
      // dejó el build) y, sin él, la R no viaja en el android.jar y el diagnóstico acusaba un error
      // que la compilación nunca da. `--nombre` pone el fichero real en `archivo:línea:columna` en vez
      // del temporal. La API va porque en la pestaña el jar está en `/sdk/android.jar` y su ruta no
      // dice la versión del platform; son los mismos valores ocultos que lee `apkc build`.
      const argv = ["check", "--android-jar", RUTA_JAR];
      const api = document.getElementById("sdk-version");
      const codename = document.getElementById("codename");
      if (api && api.value) {
        argv.push("--sdk-version", api.value);
        if (codename && codename.value) argv.push("--codename", codename.value);
      }
      argv.push("--nombre", ruta.split("/").pop() || TEMPORAL);
      if (ruta.startsWith("/proyecto/")) argv.push("--proyecto", "/proyecto");
      argv.push(TEMPORAL);
      const r = await hospedador.ejecutar(argv);
      if (r && r.tipo === "error") throw new Error(r.error);
      const dato = leerJson(r && r.consola);
      if (!dato) throw new Error("apkc check no devolvió JSON");
      if (mio !== serie) return;
      errores = Array.isArray(dato.errores) ? dato.errores : [];
      const resumen = errores.length
        ? errores.length + (errores.length === 1 ? " error" : " errores")
        : "sin errores";
      const notas = [dato.aviso, dato.recursos && /^sin R/.test(dato.recursos) ? dato.recursos : ""]
        .filter(Boolean);
      estado.textContent = resumen + (notas.length ? " · " + notas.join(" · ") : "");
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
