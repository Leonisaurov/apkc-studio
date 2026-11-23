// Errores en vivo del fichero que se está escribiendo, en dos lenguajes con dos motores distintos:
//
//   - `.java`: el texto se copia a `/proyecto/.apkc-check.java` y se manda a `apkc check` por el
//     hospedador de siempre (worker + wasm). No hay reglas nuevas y el temporal se borra después
//     de cada pasada.
//   - `.xml`: el análisis es local y puro (`diagnosticarXml`, en `xml-editor.js`): etiquetas sin
//     cerrar, atributos sin valor, comillas desbalanceadas, `@+id` repetidos, referencias a
//     recursos que no existen y atributos `android:` con errata. No lanza ningún comando, así que
//     no toca la consola ni `#ultimo-codigo`, y no necesita el wasm.
//
// Los errores de un lenguaje no se mezclan con los del otro: cada fila lleva su origen (`Java` o
// `XML`) y cambiar de fichero reemplaza la lista entera. Ambos comparten el debounce de 350 ms,
// el mismo formato `archivo:línea:columna` (§200) y la misma capa de subrayado.
import { hospedador, estadoPestana, DOCUMENTOS, RUTA_JAR, irALinea } from "./pestana.js";
import { cargarRecursosProyecto } from "./recursos-proyecto.js";
import { diagnosticarXml } from "./xml-editor.js";

(() => {
  const area = document.getElementById("codigo");
  const marcas = document.getElementById("diagnostico-marcas");
  const lista = document.getElementById("diagnostico-vivo-lista");
  const estado = document.getElementById("diagnostico-vivo-estado");
  if (!area || !marcas || !lista || !estado) return;

  const TEMPORAL = "/proyecto/.apkc-check.java";
  const ESPERA = 350; // ms tras la última pulsación, igual para los dos lenguajes
  let temporizador = null;
  let serie = 0;
  let enCurso = false;
  let pendiente = false;
  let errores = [];
  // Lo último que se comprobó y salió limpio: (ruta, texto sin espacios de sobra en cada línea).
  // Volver a lanzar el mismo check no puede cambiar el resultado; se salta.
  let ultimaLimpia = null;
  // contadores para la sonda acotada: pasadas lanzadas y pasadas que no hacía falta lanzar
  let pasadas = 0;
  let saltadas = 0;

  // Añadir o quitar espacios al principio o al final de una línea no puede cambiar ningún token
  // fuera de una cadena (el subconjunto no mide bloques de texto), ni las líneas vacías del final
  // pueden contener un error. Solo se usa cuando la pasada anterior salió limpia, así que un
  // cambio de columnas no importa: no hay columna que enseñar.
  function mismaEstructura(a, b) {
    if (a === b) return true;
    const la = a.split("\n");
    const lb = b.split("\n");
    while (la.length && !la[la.length - 1].trim()) la.pop();
    while (lb.length && !lb[lb.length - 1].trim()) lb.pop();
    if (la.length !== lb.length) return false;
    for (let i = 0; i < la.length; i++) {
      if (la[i].trim() !== lb[i].trim()) return false;
    }
    return true;
  }

  // una mutación del proyecto (guardar, crear, mover, importar) o un cambio en la R.java que dejó
  // un build puede cambiar el diagnóstico aunque el texto del editor sea el mismo: se invalida.
  document.addEventListener("apkc:proyecto-cambio", () => { ultimaLimpia = null; });

  // El resalto y el textarea comparten fuente y padding (10px 12px en style.css); el alto de
  // línea se pregunta al navegador para no copiar aquí el valor de la variable del tema.
  function alturaLinea() {
    const alto = parseFloat(getComputedStyle(area).lineHeight);
    return Number.isFinite(alto) && alto > 0 ? alto : 20;
  }

  // Geometría de una línea. Hay dos conversiones y ninguna es opcional:
  //   (a) `apkc` cuenta la columna en caracteres (runes) y el editor indexa en unidades UTF-16, así
  //       que un carácter astral (`\uD83D\uDE00`, un rune y dos unidades) desplaza el corte;
  //   (b) el ancho no es «columnas por ancho de carácter»: un tabulador llega a su parada (`tab-size:
  //       4` en style.css) y un astral puede ocupar dos celdas. Se mide el prefijo.
  // El linter de XML emite la columna con la misma convención (runes, desde 1).
  function indiceUTF16(texto, columna) {
    let i = 0;
    let runes = 1;
    while (i < texto.length && runes < columna) {
      const punto = texto.codePointAt(i) || 0;
      i += punto > 0xffff ? 2 : 1;
      runes++;
    }
    return i;
  }

  // Mide en píxeles un trozo de texto con la fuente y el tabulador del textarea. Es una sonda fuera
  // de pantalla: el resultado no depende de dónde esté el cursor ni del scroll.
  function anchoDe(texto) {
    if (!texto) return 0;
    const estilo = getComputedStyle(area);
    const sonda = document.createElement("span");
    sonda.textContent = texto;
    sonda.style.position = "absolute";
    sonda.style.visibility = "hidden";
    sonda.style.whiteSpace = "pre";
    sonda.style.fontFamily = estilo.fontFamily;
    sonda.style.fontSize = estilo.fontSize;
    sonda.style.fontWeight = estilo.fontWeight;
    sonda.style.letterSpacing = estilo.letterSpacing;
    sonda.style.tabSize = estilo.tabSize;
    document.body.appendChild(sonda);
    const ancho = sonda.getBoundingClientRect().width;
    sonda.remove();
    return Number.isFinite(ancho) ? ancho : 0;
  }

  // El token que hay que subrayar: desde el índice, el identificador, la referencia `@string/x` o
  // el atributo `android:text`. Si el error cae en un signo, se subraya ese signo.
  function tokenEn(texto, indice) {
    const resto = String(texto || "").slice(Math.max(0, indice));
    const m = /^[@+]?[A-Za-z0-9_$.:/-]+/.exec(resto);
    return m ? m[0] : resto.slice(0, 1);
  }

  function sincronizar() {
    const alto = alturaLinea();
    for (const nodo of marcas.children) {
      const linea = Number(nodo.dataset.linea) || 1;
      nodo.style.top = (10 + (linea - 1) * alto + alto - 2 - area.scrollTop) + "px";
      // la izquierda y el ancho se midieron al pintar; aquí solo se les suma el padding y el scroll
      if (nodo.dataset.izquierda !== undefined) {
        nodo.style.right = "auto";
        nodo.style.left = (12 + Number(nodo.dataset.izquierda) - area.scrollLeft) + "px";
        nodo.style.width = (Number(nodo.dataset.ancho) || 0) + "px";
      }
    }
  }

  function pintar() {
    marcas.textContent = "";
    const lineas = area.value.split("\n");
    for (const e of errores) {
      const linea = Number(e.linea);
      if (!linea || linea < 1) continue;
      const marca = document.createElement("span");
      marca.className = "marca-error";
      marca.dataset.linea = String(linea);
      if (e.origen) marca.dataset.origen = e.origen;
      const columna = Number(e.columna);
      if (columna > 0) {
        const texto = lineas[linea - 1] || "";
        const indice = indiceUTF16(texto, columna);
        const token = tokenEn(texto, indice);
        marca.dataset.columna = String(columna); // la de apkc, en caracteres
        marca.dataset.utf16 = String(indice);    // lo que el editor corta
        marca.dataset.izquierda = String(anchoDe(texto.slice(0, indice)));
        marca.dataset.ancho = String(anchoDe(token));
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
      // el origen va delante para que una fila de `apkc check` y una del linter de XML no se
      // confundan aunque compartan panel
      if (e.origen) {
        const origen = document.createElement("span");
        origen.className = "origen-error";
        origen.dataset.origen = e.origen;
        origen.textContent = e.origen;
        boton.appendChild(origen);
      }
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

  function rutaActiva() {
    return estadoPestana.ruta || (DOCUMENTOS && DOCUMENTOS.activa) || "";
  }

  // XML: análisis local, sin worker, sin temporal y sin `apkc check`. Los recursos del proyecto
  // (los mismos del autocompletado) dicen si un `@string/…` existe de verdad; si el barrido no
  // pudo leer nada, el estado lo dice en vez de fingir que la referencia está bien.
  function verificarXml(ruta) {
    const mio = ++serie;
    enCurso = true;
    errores = [];
    pintar();
    estado.textContent = "comprobando…";
    const texto = area.value;
    const nombre = ruta.split("/").pop() || "AndroidManifest.xml";
    return cargarRecursosProyecto()
      .catch(() => ({}))
      .then((recursos) => {
        if (mio !== serie) return;
        const encontrados = diagnosticarXml(texto, { archivo: ruta, recursos });
        errores = encontrados.map((e) => ({
          ...e,
          origen: "XML",
          posicion: nombre + ":" + e.linea + ":" + e.columna,
        }));
        const resumen = errores.length
          ? errores.length + (errores.length === 1 ? " error" : " errores")
          : "sin errores";
        const notas = ["XML"];
        if (!Object.keys(recursos || {}).length) notas.push("sin recursos del proyecto que consultar");
        estado.textContent = resumen + " · " + notas.join(" · ");
        pintar();
      });
  }

  async function verificar() {
    clearTimeout(temporizador);
    if (enCurso) {
      // una pasada vieja no puede pintar su resultado encima de la nueva: se invalida su serie
      serie++;
      pendiente = true;
      // Cancelar la pasada vieja (matar el worker) se midió en la pestaña y no compensa: con la R
      // escrita cuesta más arrancar el worker que dejar terminar el check, y en el camino caro el
      // resultado fue un empate (studio/sonda-check.js). Se deja terminar y se encola una sola
      // pasada nueva; el despilfarro que sí se evita es el de los checks que no cambiarían nada.
      // mientras corre la pasada nueva no se dejan las filas de la anterior: si el fichero acaba
      // de cambiar pueden ser del otro lenguaje (una fila XML sobre un .java, y al revés)
      errores = [];
      pintar();
      estado.textContent = "comprobando…";
      return;
    }
    const ruta = rutaActiva();
    if (/\.xml$/i.test(ruta)) {
      try {
        await verificarXml(ruta);
      } finally {
        enCurso = false;
        if (pendiente) { pendiente = false; programar(); }
      }
      return;
    }
    if (!/\.java$/i.test(ruta)) {
      errores = [];
      pintar();
      estado.textContent = "Abre un fichero .java o .xml para ver los errores mientras escribes.";
      return;
    }
    const texto = area.value;
    // la clave de una pasada limpia: el fuente, la ruta y el platform con el que se compiló. La API
    // y el codename se pueden cambiar sin tocar el editor (pestana.js los sincroniza desde
    // Ajustes), y cambian la compilación: el mismo texto con otra API no es el mismo resultado.
    const api = document.getElementById("sdk-version");
    const codename = document.getElementById("codename");
    const clave = {
      ruta, texto, jar: RUTA_JAR,
      api: api ? api.value : "",
      codename: codename ? codename.value : "",
    };
    // el mismo fuente que ya salió limpio no se vuelve a compilar: ni un clic en el árbol, ni un
    // repintado de pestañas, ni cambiar solo espacios de sobra pueden cambiar el resultado.
    const yaLimpia = ultimaLimpia && ultimaLimpia.ruta === clave.ruta &&
      ultimaLimpia.api === clave.api && ultimaLimpia.codename === clave.codename &&
      ultimaLimpia.jar === clave.jar &&
      (ultimaLimpia.texto === texto || mismaEstructura(ultimaLimpia.texto, texto));
    if (yaLimpia) {
      saltadas++;
      // una pasada invalidada dejó «comprobando…»: saltar no puede dejarlo así, se repinta el
      // resumen limpio que ya se tenía (sin errores, porque `ultimaLimpia` solo guarda limpias).
      errores = [];
      pintar();
      estado.textContent = ultimaLimpia.estado;
      return;
    }
    const mio = ++serie;
    pasadas++;
    enCurso = true;
    // las filas del fichero anterior (posiblemente XML) no esperan al check: se vacían ya
    errores = [];
    pintar();
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
      // D6: toda fila dice dónde. Si `apkc` trae `posicion` se respeta; si el error nació en el
      // parser y solo hay línea, se compone `archivo:línea` con el nombre real del fichero (el
      // temporal solo saldría si no hubiera nombre, y el mensaje no repite esa posición).
      const nombre = ruta.split("/").pop() || TEMPORAL;
      errores = (Array.isArray(dato.errores) ? dato.errores : [])
        .map((e) => {
          const linea = Number(e.linea) > 0 ? Number(e.linea) : null;
          const columna = Number(e.columna) > 0 ? Number(e.columna) : null;
          const posicion = e.posicion ||
            (linea ? nombre + ":" + linea + (columna ? ":" + columna : "") : nombre);
          return { ...e, origen: "Java", posicion };
        });
      const resumen = errores.length
        ? errores.length + (errores.length === 1 ? " error" : " errores")
        : "sin errores";
      const notas = [dato.aviso, dato.recursos && /^sin R/.test(dato.recursos) ? dato.recursos : ""]
        .filter(Boolean);
      estado.textContent = resumen + " · Java" + (notas.length ? " · " + notas.join(" · ") : "");
      pintar();
      ultimaLimpia = errores.length ? null : { ...clave, estado: estado.textContent };
    } catch (e) {
      if (mio === serie) {
        errores = [];
        ultimaLimpia = null;
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
  // la sonda acotada (studio/sonda-check.js) lee estos contadores por CDP; la página no los usa
  window.DIAGNOSTICO_VIVO = { pasadas: () => pasadas, saltadas: () => saltadas };
  programar();
})();
