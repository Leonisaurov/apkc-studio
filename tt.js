// Trusted Types: la página solo escribe HTML escapado por sus propias funciones. La política no
// es una identidad ciega: rechaza etiquetas `script` y atributos de evento antes de devolver el
// TrustedHTML. Si el navegador no tiene la API, devuelve la cadena y el comportamiento es el de
// siempre (§184).
const NOMBRE = "apkc-studio";

let politica = null;
try {
  if (typeof trustedTypes !== "undefined" && trustedTypes.createPolicy) {
    politica = trustedTypes.createPolicy(NOMBRE, {
      createHTML(cadena) {
        const texto = String(cadena);
        if (/<\s*script\b|\son[a-z]+\s*=/i.test(texto)) {
          throw new Error("la política de Trusted Types rechazó este HTML");
        }
        return texto;
      },
      createScriptURL(cadena) {
        const texto = String(cadena);
        if (!/^(hospedador\.js|\/[^/].*)$/.test(texto) && !texto.startsWith("blob:")) {
          throw new Error("la política de Trusted Types rechazó esta URL de script");
        }
        return texto;
      },
      // createURL no existe en todos los motores: enlaceConfiable comprueba su presencia.
    });
  }
} catch (e) {
  politica = null; // otra política ya tomó el nombre: seguimos sin romper la página
}

export function htmlConfiable(cadena) {
  return politica ? politica.createHTML(cadena) : String(cadena);
}

export function urlConfiable(cadena) {
  return politica ? politica.createScriptURL(cadena) : String(cadena);
}

export function enlaceConfiable(cadena) {
  return politica && typeof politica.createURL === "function"
    ? politica.createURL(cadena)
    : String(cadena); // Chromium aún no expone TrustedURL; estos href son literales o blobs de aquí
}
