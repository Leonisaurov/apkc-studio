// Idioma de la interfaz. Solo se traduyen las cadenas del marco y del Inicio; el editor y las
// opciones avanzadas conservan su vocabulario técnico. Sin red, sin bibliotecas (§182).
const CLAVE = "apkc-studio/idioma";

const TEXTO = {
  es: {
    "nav.inicio": "Inicio", "nav.editor": "Editor", "nav.explorador": "Explorador",
    "crear.titulo": "Crear un proyecto",
    "crear.sub": "Pon el nombre, el package y, si quieres, un icono. Después editas todos los ficheros generados y compilas la app aquí mismo, sin Gradle y sin salir del navegador.",
    "crear.nombre": "Nombre de la app", "crear.package": "Package",
    "crear.icono": "Icono (opcional, PNG)", "crear.plantilla": "Plantilla",
    "crear.api": "API de compilación",
    "crear.boton": "Crear proyecto y editar", "crear.instalar": "Instalar apkc studio",
    "crear.almacenamiento": "El proyecto vive en el almacenamiento de este navegador (OPFS), en este origen y en este dispositivo. Cambiar de puerto o dominio, abrirlo en otro navegador o borrar los datos del sitio lo elimina. Usa Archivo → Exportar proyecto (.zip) para guardar una copia y poder importarla después.",
    "ayudas.titulo": "Atajos de teclado", "ajustes.idioma": "Idioma",
    "atajo.guardar": "guarda el fichero abierto", "atajo.repetir": "repite el último comando",
    "atajo.panel": "abre o cierra el panel",
  },
  en: {
    "nav.inicio": "Start", "nav.editor": "Editor", "nav.explorador": "Explorer",
    "crear.titulo": "Create a project",
    "crear.sub": "Set the name, package and, optionally, an icon. Then edit every generated file and build the app right here, without Gradle and without leaving the browser.",
    "crear.nombre": "App name", "crear.package": "Package",
    "crear.icono": "Icon (optional, PNG)", "crear.plantilla": "Template",
    "crear.api": "Build API",
    "crear.boton": "Create project and edit", "crear.instalar": "Install apkc studio",
    "crear.almacenamiento": "The project lives in this browser's storage (OPFS), on this origin and this device. Changing port or domain, opening it in another browser or clearing site data removes it. Use File → Export project (.zip) to keep a copy and import it later.",
    "ayudas.titulo": "Keyboard shortcuts", "ajustes.idioma": "Language",
    "atajo.guardar": "saves the open file", "atajo.repetir": "runs the last command again",
    "atajo.panel": "toggles the panel",
  },
};

function lee() {
  try {
    const v = localStorage.getItem(CLAVE);
    return v === "en" ? "en" : "es";
  } catch (e) { return "es"; }
}

export function idiomaActual() { return lee(); }

export function aplicarIdioma(cual) {
  const idioma = cual === "en" ? "en" : "es";
  try { localStorage.setItem(CLAVE, idioma); } catch (e) { /* sin persistencia */ }
  document.documentElement.lang = idioma;
  for (const elemento of document.querySelectorAll("[data-i18n]")) {
    const texto = TEXTO[idioma][elemento.dataset.i18n];
    if (texto !== undefined) elemento.textContent = texto;
  }
  const selector = document.getElementById("idioma-ui");
  if (selector) selector.value = idioma;
  return idioma;
}

(() => {
  aplicarIdioma(lee());
  const selector = document.getElementById("idioma-ui");
  if (selector) selector.addEventListener("change", () => aplicarIdioma(selector.value));
})();
