# AGENTS.md — apkc-studio

Página estática sin dependencias ni bundler que genera proyectos [apkc](../apkc) y ejecuta
`apkc.wasm` dentro de la pestaña (OPFS + worker). Se publica copiando `studio/`; no hay
`npm install`. El contrato de la herramienta y las mediciones están en el `AGENTS.md` de la raíz.

## Comandos que importan

```sh
# suite rápida: node, sin navegador. Compara las plantillas con el repo apkc.
node prueba.js                          # npm test

# navegador real sin OPFS: vistas, formulario, diagnóstico y localStorage
node prueba-navegador.js                # npm run test:navegador

# con OPFS y wasm: construye el binario y conduce chromium por CDP
sh -c 'cd ../apkc && GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -o "$PREFIX/tmp/apkc-wasm.wasm" .'
APKC_WASM="$PREFIX/tmp/apkc-wasm.wasm" node prueba-crear.js
APKC_WASM=… APK_EJEMPLO=… KS_EJEMPLO=… node prueba-pestana.js

# el sitio empaquetado, sin cabeceras ni endpoints: en local o en el host real
SITIO_DIR=../sitio ANDROID_JAR=… APKSIGNER=… node prueba-sitio.js
SITIO_URL=https://apkc-studio.surge.sh/ ANDROID_JAR=… APKSIGNER=… node prueba-sitio.js

# el gate de verdad: descomprime, compila, firma y verifica con oráculos externos
APKC="$PREFIX/tmp/apkc-gate" APKC_WASM="$PREFIX/tmp/apkc-wasm.wasm" sh e2e.sh
```

`npm start` es `node servidor.js` y exige `APKC_WASM` y un `wasm_exec.js` en
`$(go env GOROOT)/lib/wasm`; sin uno de los dos sale con código 2. `e2e.sh` usa `TCR` si está,
`tcr` del PATH si existe y, si no, ejecuta directo: en Termux conviene tenerlo, en un runner Linux
no hace falta. No hay lint, typecheck ni formatter; para
una comprobación rápida de sintaxis, `node --check <fichero>`.
`prueba-pestana.js` exige `APKC_WASM`, `APK_EJEMPLO` y `KS_EJEMPLO`; con `KS_RELEASE` y
`AAB_EJEMPLO` añade release, v4, `.aab` y rotación (es lo que le pasa `e2e.sh`). `prueba.js`
compara las plantillas contra `APKC_REPO` (`~/Develop/Go/apkc` por defecto): si el repo no está,
omite la comparación y **no falla**, así que no confundas «reglas: 24» con «plantillas iguales».

Desde la raíz del repo, `tools/entorno.sh gate` construye los binarios y lanza `e2e.sh` con
`HOME`/`PREFIX`/`ANDROID_HOME` correctos (el shell puede arrancar con otro `HOME`). No declares
la página terminada con `prueba.js` ni con `prueba-navegador.js`: solo `e2e.sh` descomprime el
zip y compila con `apksigner`, `zipalign` y `zipcheck.py`. `prueba-pestana.js` cuenta las
peticiones y falla si la página pide algo fuera de su origen.

**`e2e.sh` puede decir «todo en orden» con la pestaña omitida**: sin `chromium-browser`, sin
`APKC_WASM` o sin el apk de fixtures, esas secciones se saltan con un aviso, no fallan. Antes de
dar el editor por probado, comprueba en la salida `pestaña: N comprobaciones` y que no aparezca
`sin chromium` ni `sin APKC_WASM`.

## Mapa y orden de carga

| Fichero | Papel |
| --- | --- |
| `main.js` | entrada ESM: importa `pestana.js`, `vistas.js` y `diagnostico.js`. |
| `app.js` | **modelo puro**: plantillas, `buildProject`, `makeZip`, `RULES`, `analyze`, `informe`. Sin DOM; `export` para el navegador y para node. |
| `pestana.js` | editor, pestañas, árbol de OPFS, comandos y el puente `hospedador`; `export` de lo que consumen `vistas.js`, `main.js` y las pruebas. |
| `consola.js` | salida ANSI, enlaces `ruta:línea`, buffer de la consola y velo de carga. |
| `editor.js` | `resaltar()` y `esXml()`: puros, sin DOM, probados en node. |
| `autocompletado.js` | la lista de sugerencias del editor (recursos y APIs del `android.jar` en `.java`; etiquetas, atributos, valores y referencias en `.xml`), sus atajos y la lectura por trozos de `/sdk/android.jar` en OPFS. |
| `autocompletado-datos.js` | datos puros del autocompletado: recursos de `res/` y `R.java`, contexto de tecleo, EOCD/directorio central del zip y nombres de método de un `.class`. |
| `xml-editor.js` | puro: contexto de tecleo del XML (`contextoXml`), catálogo de etiquetas/atributos/valores por tipo de fichero (`sugerenciasXml`) y linter (`diagnosticarXml`, con línea y columna en runes). |
| `recursos-proyecto.js` | el barrido de `res/` + `R.java` y su caché, compartido por el autocompletado (Java y XML) y el linter de XML. |
| `busqueda.js` | barra de buscar/reemplazar y `Ctrl+G`; se monta con `EDITOR` e `irALinea`. |
| `ajustes.js` | ajustes del proyecto leídos y escritos en el manifiesto. |
| `historial.js` | undo tree por documento: deltas, checkpoints, poda, IndexedDB por ventana. |
| `fusion.js` | fusión de tres vías (base/local/remoto) por líneas; conflicto explícito si se pisan. |
| `proyecto.js` | zip de exportar/importar (STORE/DEFLATE, CRC y rutas seguras) y ajustes leídos/escritos en el manifiesto. |
| `temas.js` | temas de interfaz y terminal; cambia `data-tema` y variables CSS. Se carga como módulo en el `<head>`. |
| `vistas.js` | cambio de vista, reflejo nombre/package y creación del proyecto desde el formulario. |
| `vista-previa.js` | modelo y pintura de `apkc preview`: funciones puras y canvas; publica `apkc:previa-actualizada`. |
| `vista-xml.js` | el XML del editor convertido en modelo (`pantalla` + nodos con `rect`): parser mínimo, jerarquía, pesos, gravedad y `@string`. Puro, sin DOM. |
| `layout-editor.js` | el camino de vuelta del modo editar: añadir (como último hijo de la raíz o dentro de un contenedor, en una posición y con los márgenes del punto; los contenedores entran vacíos con una caja de 160×96 dp), mover (margen en un marco, reordenar en un `LinearLayout`), leer y escribir propiedades de cualquier nodo (incluida la raíz), cambiar el tipo de la raíz y borrar sobre el XML. Publica la paleta agrupada por categorías (`gruposPaleta`), los tamaños de entrada (`tamanoDeTipo`) y los iconos públicos de API 34 (`iconosSistema`). Puro, sin DOM. |
| `previa-panel.js` | las dos superficies de la vista previa (la vista dividida del editor y la vista Pantalla): cuatro aristas y cuatro esquinas por marco, modo **Vista previa** (layout dibujado), **Emulador** (modelo de `apkc preview`), consola del intérprete y el **modo editar** del layout: paleta de 18 tipos por categorías, ficha de propiedades del nodo y de la raíz y visor de jerarquía como **capas flotantes** sobre el dibujo (el canvas no cambia de tamaño), con arrastre de un tipo hasta el punto donde se suelta, indicador de destino, basura, historial propio del diseñador (Ctrl+Z/Ctrl+Mayús+Z) e importación de imágenes a `res/drawable` desde un fichero o un arrastre. Recibe `hospedador` y `EDITOR`; no importa `pestana.js`. |
| `diagnostico.js` | panel de Inicio que pinta `analyze()`; solo DOM, sin reglas propias. |
| `deps.js` | sección de dependencias: lee `./deps-index.json` del propio origen, verifica tamaño y SHA-256 del artefacto y lo importa a OPFS bajo `/deps/`; sin red ajena y solo al pulsar «Resolver». |
| `hospedador.js` | worker de módulo: `fs`/`path`/`process` para Go y una cola de un comando por vez. |
| `fs-fragmento.js` | `fs` con forma de Node sobre OPFS (lo importa el worker, no la página). |
| `servidor.js` | servidor de desarrollo ESM: estáticos + COOP/COEP + `/apkc.wasm` + `/wasm_exec.js` + `/android.jar`. De los `platforms/` del SDK elige **android-34** antes que el más nuevo: la tabla de recursos de 35 y 36 viene en forma rala y el enlazador de Go no la lee (falla con «tabla rala»), así que servirla deja la compilación de la pestaña rota en un escritorio con SDK nuevo. |
| `_headers` | COOP/COEP para hosts estáticos que las respetan (Netlify, Cloudflare Pages). |

Todo el sitio son **ES modules** y `package.json` declara `"type": "module"`: no hay bundler ni
orden de `<script>` que mantener. `index.html` carga `temas.js` en el `<head>` (para aplicar el
tema antes de pintar) y `main.js` al final; `main.js` importa el resto. Los scripts de node
(`prueba*.js`, `servidor.js`) son ESM: usan `import` y `import.meta.url`, no `require`.
`window` conserva un puente con nombres antiguos solo para las pruebas CDP; el código nuevo usa
los imports y no debe depender de ese puente.

`hospedador.js` pide `/wasm_exec.js` y `/apkc.wasm` con ruta **absoluta al origen**. Publica
`studio/` como raíz del sitio, no bajo `/studio/`, o cambia esas dos rutas a la vez.

## Contratos que rompen pruebas

- **La vista dividida no muta el modelo por mirar.** `previa-panel.js` reparte ancho y alto con
  `--previa-ancho`/`--previa-alto`/`--previa-arriba` desde sus ocho tiradores, pinta el layout
  **dibujado** desde el buffer o de OPFS (nunca su código en un `<pre>`) y, en el otro modo, el
  modelo ya emitido, en la vista dividida **y** en la vista Pantalla; ningún `pointerdown` de un
  tirador ni del panel escribe en OPFS, cambia `estadoPestana` ni reescribe `#codigo`. La excepción
  es el **modo editar** (`#previa-modo-editar`): solo con el lápiz encendido, y solo al pulsar la
  paleta, soltar un arrastre o `Supr`, `layout-editor.js` devuelve el XML nuevo y se aplica con
  `EDITOR.cambiar()` (undo tree y documento sucio); sigue sin escribir en OPFS —eso es `Ctrl+S`— ni
  cambiar `estadoPestana`. El texto del intérprete se pinta con `textContent`: `<script>` sale
  escapado.
- **Los ids son contrato.** `prueba.js` comprueba que todo `getElementById` de `vistas.js`,
  `pestana.js` y `diagnostico.js` exista en `index.html`; `prueba-crear.js`, `prueba-pestana.js`
  y `e2e.sh` buscan ids concretos. Cambiar uno exige cambiar su prueba.
- **Las reglas de `app.js` no se inventan.** Cada `de: "apkc"` debe existir literalmente en
  `apkc/*.go`; `prueba.js` lo verifica. Una regla sin `lit:` o sin evidencia es un fallo.
- **Las contraseñas se limpian** de los campos después de firmar o compilar, también cuando
  falla; `prueba-pestana.js` lo comprueba.
- **Subir escribe en OPFS, no en un servidor.** El botón del explorador usa la carpeta del
  fichero abierto; el menú de una carpeta fija el destino. La subida de carpeta conserva
  `webkitRelativePath` y descarta los tramos `..`; `prueba-crear.js` conduce el input con
  `DataTransfer`.
- **El proyecto se exporta e importa en `.zip`.** `proyecto.js` escribe con `makeZip` (ahora
  acepta `Uint8Array`) y lee STORE y DEFLATE con CRC; rechaza `..`, rutas absolutas, `\` y ZIP64.
  Importar reemplaza `/proyecto` **solo tras confirmar** y **solo si el borrado en disco funcionó**
  (`borradoDelDisco`): si otra pestaña tiene un handle abierto, se aborta en vez de mezclar. Si una
  escritura falla a mitad, se restaura la copia previa; si tampoco se puede, `/proyecto` queda vacío
  y se avisa (`reemplazarProyecto` en `pestana.js`, falsificado en `prueba.js`). No metas el zip en
  OPFS sin pasar por `leerZip`.
- **Los ajustes viven en el manifiesto.** `conAjustes()` toca `versionCode`, `versionName`,
  `minSdkVersion` y `targetSdkVersion`, añade `<uses-sdk>` si falta y quita `maxSdkVersion`; no
  crea un fichero paralelo. La plantilla de `app.js` tampoco escribe `maxSdkVersion`.
- **La salida se pinta mientras corre.** Go escribe en el fd 1 del fs, no en `process.stdout`;
  `hospedador.js` envuelve `consola.escribir` y manda `{tipo:"salida"}`. `correr()` la pinta al
  llegar, usa la última línea como fase en `#ocupado` y no inventa porcentajes. **Detener** llama a
  `hospedador.cancelar()`: termina el worker, resuelve lo pendiente con error y el siguiente
  comando crea otra instancia (el fs sigue en OPFS).
- **La consola enlaza `ruta:línea`.** `enlazarSalidas()` corre sobre el texto ya escapado; no
  vuelvas a aplicarlo al HTML final. El clic se delega en `#consola-pestana` y `saltarALinea()`
  resuelve rutas relativas contra `/proyecto`.
- **El árbol filtra y marca lo generado.** `#filtro-arbol` conserva padres; `build/` lleva
  `generado` y la etiqueta, pero se puede abrir. `Ctrl+P` enfoca el filtro.
- **Las plantillas no son decoración.** `#plantilla` elige `hola` o `contador`; la segunda cambia
  el layout y la actividad en `app.js` y `e2e.sh` la compila y la verifica con los oráculos. Si
  tocas una plantilla, añade su comprobación en `prueba.js` y su build en `e2e.sh`.
- **La búsqueda es del editor, no del navegador.** `#buscar-barra` la controla `abrirBusqueda()`;
  reemplazar usa `EDITOR.cambiar()` para no perder el undo tree. No vuelvas a un `window.find`.
- **El árbol empieza cerrado.** `ARBOL.abiertos` vacío significa todo plegado; no lo vuelvas a
  invertir a `plegados`. Mover es `hospedador.renombrar` a través de `moverRuta`, que remapea
  `ARBOL.abiertos` y la ruta del fichero abierto. El arrastre solo se activa con puntero fino;
  en táctil se usa **Mover a…**.
- **La barra del fichero es deliberada:** `#guardar-fichero` es la acción primaria y
  `#menu-editor` (un `<details>`) agrupa Nuevo, Subir, Descargar, Renombrar y Borrar. No vuelvas
  a sacar esos botones sueltos a la barra.
- **Pestañas con carga diferida.** `DOCUMENTOS` guarda `{ruta, texto, sucio, hist}`; una pestaña
  limpia inactiva tiene `texto = null` y se relee de OPFS al activarla. `PERSISTENCIA`
  (`apkc-studio/editor-v1`) va en **sessionStorage** (vista por ventana, no compartida) y guarda
  rutas y `ARBOL.abiertos`, nunca contenido. La activa se restaura al cargar, las demás al
  pulsarlas; `activacion` evita que una lectura lenta pise otra pestaña y `cargandoDocumento`
  bloquea `guardar()` mientras el textarea todavía tiene el buffer anterior (F1: un `Ctrl+S` en esa
  ventana escribía el fichero viejo en la ruta nueva). En esa misma ventana el textarea se pone
  `readOnly` y el listener de `input`/`keydown` rechaza el tecleo con un aviso: el buffer no es del
  documento nuevo, y aceptarlo dejaba la pestaña sucia con `texto = null` y perdía lo tecleado (F5).
- **Undo tree persistente.** `historial.js` guarda deltas, checkpoints cada 24 niveles y poda
  (240 nodos / 4 MB). Se hidrata por documento al activarlo y se guarda en IndexedDB con clave
  `VENTANA|ruta`; `VENTANA` sale de sessionStorage. No persistas `cache` (se reconstruye). Las
  ramas antiguas se pueden podar, pero nunca la raíz ni los ancestros del nodo actual; si la
  cadena es demasiado larga, `rebase()` re-enraíza en un checkpoint.
- **Temas sin dependencias.** `temas.js` solo pone `data-tema`/`data-tema-consola` en `<html>` y
  `style.css` resuelve las variables. No metas colores nuevos a mano fuera de un bloque de tema;
  la paleta ANSI se cambia con `--ansi-0..15`. El modo **Solo iconos** pone `data-botones="iconos"`
  y oculta `.texto-boton`; los botones deben conservar `title`/`aria-label`.
- **Dos contextos de autocompletado, nunca cruzados.** La extensión del fichero activo elige la
  rama: `.java` → `contextoDeCompletado` (recursos y jar) y `.xml` → `contextoXml` (etiquetas,
  atributos, valores y referencias). En un `.xml` no puede salir `R.` ni una clase Java; en un
  `.java`, ni una etiqueta. El estado del popup dice `xml · …` en la rama XML. `prueba-pestana.js`
  lo comprueba en las dos direcciones.
- **El linter de XML es local y etiqueta su origen.** `diagnosticarXml` no lanza `apkc check`, no
  escribe `.apkc-check.java` y no toca la consola; sus filas llevan `origen: "XML"` (y las de
  `apkc`, `Java`), y cambiar de fichero vacía lista y marcas al arrancar la pasada nueva (no al
  recibir el resultado). La columna va en runes y desde 1, como la de `apkc`. Si el barrido de
  `res/` no leyó nada, no se acusan referencias. `<![CDATA[…]]>`, comentarios y declaraciones
  (incluido un `<!DOCTYPE … [ … ]>`) no se tokenizan: no son marcado.
- **El canvas no rotula los nodos.** `pintarModelo` dibuja solo el texto del nodo; el tipo y el id
  van en el modelo, en `rectsEscalados`, en el `resumen` devuelto y en `data-nodos` del canvas.
  No vuelvas a pintar `Button · id/pulsar` encima: la prueba cuenta tinta y exige cero sin texto.
- **El emulador tiene tres secciones, no tres bloques.** Pulsar, Registro y Consola son pestañas
  (`#previa-seccion-*` en el panel y `#vista-seccion-*` en Pantalla; paneles `previa-pulsos`/`-log`/
  `-consola` y `vista-*`). Alternar solo cambia `hidden`: el contenido y el scroll se conservan y no
  se relanza ningún comando; la activa se guarda en `apkc-studio/previa-seccion` y
  `apkc-studio/vista-seccion`. Los **dos** canvas entregan el clic (`#previa-lateral-canvas` y
  `#vista-previa`) y la nota de Pulsar distingue «sin ejecución» de «la ejecución no registró
  oyentes»: no vuelvas a decir lo segundo antes de ejecutar `onCreate`. `apkc preview` enlaza los
  `android:onClick` del layout; si tocas ese enlace, su prueba es
  `TestElPreviewEnlazaElOnClickDeclarativoDelLayout`.
- **La barra separa consola de compilación.** El botón `#alternar-panel` se llama **Compilar** y
  abre la pestaña Compilar; la pestaña de salida se llama **Consola** y lleva el icono de terminal.
  No vuelvas a poner «Salida» ni un botón de build clásico: ese build no corre en wasm.
- **API de compilación.** `#api-version` es el selector visible (34 por defecto) y sincroniza los
  ocultos `#sdk-version`/`#codename` que lee `apkc build`; las pruebas siguen usando los ocultos.
- **Varias ventanas sin pisarse.** Las escrituras pasan por `conBloqueo()` (Web Locks); la revisión
  se guarda en `localStorage` (`apkc-studio/rev/<ruta>`) y `BroadcastChannel` avisa de `guardado`,
  `crear`, `subir`, `renombrar`, `mover`, `borrar` y `proyecto`. `recibirRemoto()` refresca el
  espejo del worker (`hospedador.refrescar`) y fusiona con `fusionar(base, local, remoto)`: sin
  cambios locales recarga, sin cambios remotos conserva, cambios separados se combinan y los que
  tocan la misma línea abren `#conflicto-aviso`. No hay CRDT ni servidor; la base es la última
  versión de OPFS y los ficheros de más de 2000 líneas caen a conflicto explícito.
- **El jar listo no se reclama.** Si `/sdk/android.jar` existe en OPFS, `decirEstadoJar()` deja
  `#detalle-sdk` plegado con `.jar-listo`, muestra `#sdk-badge`, y convierte `#abrir-dialogo-sdk`
  en «Cambiar android.jar». No vuelvas a abrir el desplegable ni mantengas el botón primario.
- **La clave de release se genera, se descarga y se confirma.** `apkc create-keystore` escribe
  `/sdk/release.keystore` (JKS) desde `#dialogo-clave`; la página descarga `<alias>.jks` y no deja
  cerrar hasta marcar que se guardó. La contraseña no se persiste. Si el fichero existe,
  `decirEstadoClave()` deja `#detalle-release` plegado con `.jar-listo` y `#clave-badge`.
- **Service worker.** `sw.js` cachea el shell e intenta cachear `apkc.wasm`/`wasm_exec.js`; nunca
  `/android-jar`, keystores ni OPFS. Además pone **COOP/COEP en todas las respuestas del mismo
  origen**, incluidas las de caché: es la única forma de aislar el origen en un host que no fija
  cabeceras. `index.html` lo registra antes de los módulos y recarga una vez si no hay
  `crossOriginIsolated`; la marca `apkc-coi-reintento` evita el bucle y un aviso dice cuándo el
  navegador no lo consiguió. No borrar la marca al recargar. `offline.js` vuelve a registrarlo por
  http(s) con la misma URL versionada. `prueba-pestana.js` prueba la recarga offline y, con
  `SIN_CABECERAS=1`, la recarga del arranque.
- **Nada fuera del origen.** Sin CDN, fuentes, telemetría ni runtimes de terceros. El favicon es
  un `data:` y el informe se descarga como `blob:`.
- **`apkc build` clásico no corre en wasm.** `js` no tiene `fork/exec`; la interfaz no ofrece ese
  botón porque ya sabemos que falla (`aapt2 compile never started: pipe: not implemented on js`).
  Lo que sí compila es `build --linker go --compiler go`.

## Trampas de OPFS y wasm ya pagadas

- `navigator.storage` **no existe dentro del worker**: la página baja el mango raíz y se lo pasa
  por `postMessage`. No lo muevas al worker.
- `createSyncAccessHandle()` es **asíncrona**; sus métodos sí son sincrónicos. Sin
  `crossOriginIsolated` no hay handle: hacen falta COOP/COEP y servir por `http(s)`, no `file://`.
- `wasm_exec.js` **no se versiona** (viene del GOROOT). `servidor.js` lo sirve desde
  `$(go env GOROOT)/lib/wasm/`; en un host estático hay que copiarlo junto a `index.html`.
- Un binario de Go en wasm **no se reutiliza**: `hospedador.js` guarda los bytes y crea una
  instancia por comando. Un comando por vez, en cola; no hay tuberías.
- Los ES modules no cargan por `file://`: la página muestra un aviso. Todo (Inicio, Editor,
  OPFS y `apkc.wasm`) exige `servidor.js` o un host estático donde el SW pueda poner COOP/COEP.

## Publicar

`_headers` cubre Netlify y Cloudflare Pages. **Surge no cubre cabeceras**, pero el `sw.js` de la
propia página las pone y el sitio publicado funciona en `https://apkc-studio.surge.sh/`: eso sí,
la primera visita se recarga una vez. GitHub Pages sí permite service workers, así que el mismo
mecanismo sirve allí. El `android.jar` y el keystore no se versionan ni se empaquetan: la
página los pide al SDK local (mismo origen) o al selector de fichero, y el paquete oficial de
Google se descarga como navegación del usuario: el diálogo exige un acuse y los términos se aceptan en el sitio de Google, no aquí.

## Documentos gemelos

`studio/README.md` (uso y pruebas), `studio/EDITOR.md` (estructura del editor e ids),
`docs/evidencia.md` (cada medición con su comando) y el `AGENTS.md` de la raíz (reglas del repo).
