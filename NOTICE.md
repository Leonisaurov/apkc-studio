# Avisos de terceros

El código propio de este repositorio se publica bajo la licencia MIT de `LICENSE`. Lo que sigue
enumera lo que no es propio y las condiciones con las que viaja.

## apkc (fork)

`apkc/` es un fork de [ajinasokan/apkc](https://github.com/ajinasokan/apkc), publicado bajo la
licencia MIT de Ajin Asokan (2022). El aviso original está en `apkc/LICENSE`. Los cambios de este
fork se mantienen bajo la misma licencia MIT.

## Vista previa del APK

El módulo de vista previa (`apkc/preview.go`, `apkc/previewinterprete.go` y el pintor de la
pestaña, `studio/vista-previa.js`) es **implementación propia**, publicada bajo la misma licencia
MIT que el resto de este repositorio. No incorpora código de terceros: se apoya en los lectores
AXML, `resources.arsc` y DEX que ya vivían en el fork y en la biblioteca estándar de Go, y lee los
bytes del zip con `archive/zip`. No ejecuta procesos ni hace peticiones de red.

Su comportamiento (qué se lee de un layout y cómo se ejecuta `onCreate` para capturar el texto) se
contrastó como **referencia de comportamiento** con NekoDroid, publicado bajo licencia MIT: sirvió
para saber qué esperar de una vista previa, no se copió ni se tradujo su código.

**No se incorporó código de WineDroid (GPL-3.0).** La licencia del proyecto no cambia: no hay
código GPL en este repositorio ni en el sitio publicado, y la vista previa no es un runtime de
terceros ni un emulador.

## Go y `wasm_exec.js`

El ejecutor de WebAssembly que el navegador necesita (`wasm_exec.js`) es parte de la distribución
de Go y se usa bajo la licencia BSD de tres cláusulas de The Go Authors. No se versiona: cada
quien lo copia de su `GOROOT` (`$(go env GOROOT)/lib/wasm/wasm_exec.js`).

## SDK de Android

El `android.jar` es un componente del SDK de Android de Google. **No se distribuye con este
repositorio ni con la página**: se toma del SDK instalado por el usuario o se descarga desde la
página oficial de Google, y sus términos se aceptan allí. La página solo hace un acuse informado;
no concede derechos sobre el binario.

## Navegador de las pruebas

`studio/prueba-navegador.js`, `studio/prueba-crear.js` y `studio/prueba-pestana.js` conducen un
Chromium instalado en el sistema (por ejemplo `chromium-browser` en Termux). No se redistribuye y
no viaja con el sitio.

## Fuentes y dependencias del sitio

El sitio no carga nada de terceros: ni CDN, ni fuentes, ni telemetría, ni runtimes ajenos. Las
paletas de los temas son listas de colores; no incluyen ficheros de los proyectos que las
inspiran.

## Lo que no cubre esta licencia

La licencia MIT de este repositorio no cubre el SDK de Android, las apps que el usuario escriba ni
los binarios que produzca. Tampoco es asesoría jurídica: si se empaqueta o se cobra por el
producto, la conversación sobre licencias cambia y hay que revisarla aparte.
