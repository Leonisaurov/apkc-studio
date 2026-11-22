// Trusted Types: la página solo escribe HTML escapado por sus propias funciones. La política no
// es una identidad ciega: rechaza etiquetas `script` y atributos de evento antes de devolver el
// TrustedHTML. Si el navegador no tiene la API, devuelve la cadena y el comportamiento es el de
// siempre (§184).
const NOMBRE = "apkc-studio";

let politica = null;
try {
  if (typeof TrustedTypes !== "undefined" && TrustedTypes.createPolicy) {
    politica = TrustedTypes.createPolicy(NOMBRE, {
      createHTML(cadena) {
        const texto = String(cadena);
        if (/<\s*script\b|\son[a-z]+\s*=/i.test(texto)) {
          throw new Error("la política de Trusted Types rechazó este HTML");
        }
        return texto;
      },
    });
  }
} catch (e) {
  politica = null; // otra política ya tomó el nombre: seguimos sin romper la página
}

export function htmlConfiable(cadena) {
  return politica ? politica.createHTML(cadena) : String(cadena);
}
