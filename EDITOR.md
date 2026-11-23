# El editor de apkc studio

Este documento explica cómo está montada la vista **Editor** de `studio/index.html`: qué pieza
hace qué, qué ids son contrato con las pruebas y qué límites tiene. No es una medición: las
mediciones de la pestaña (compilar, firmar, verificar) están en `docs/evidencia.md`; el resumen de
uso, en `studio/README.md`.

La referencia visual es un editor ligero al estilo Visual Studio Code, **adaptado** a esta página:
barra de actividad, explorador del proyecto, pestaña del fichero, área de código y panel inferior.
No se copia ninguna pieza de VS Code ni se carga ningún editor de terceros.

## Regla de diseño

- **Sin dependencias y sin red.** El editor es un `<textarea>` nativo superpuesto a un `<pre>`
  resaltado. No hay Monaco, CodeMirror, Ace ni CDN. Es la regla 4 del `AGENTS.md`: todo lo que
  compila, empaqueta y firma viaja en el propio origen de la página.
- **Los ids son contrato.** `prueba.js`, `prueba-navegador.js`, `prueba-crear.js`,
  `prueba-pestana.js` y `e2e.sh` buscan ids concretos. Cambiar un id sin cambiar la prueba rompe
  el gate.
- **La vista no guarda estado propio.** El fichero abierto vive en `estadoPestana.ruta`; el
  contenido, en el `<textarea>` y en OPFS. La página no tiene un modelo de documento aparte.

## Mapa de la vista

```text
+--------------------------------------------------------------------------+
| barra de titulo: semaforo, "apkc studio - Mi app", "sin conexion"        |
+------+-------------------+-----------------------------------------------+
| act. | EXPLORADOR        | pestanas de vista: Inicio | Editor | Vista    |
|      | COM.MI.APP        +-----------------------------------------------+
|      | arbol del         | fichero  [Guardar] [Archivo v] [Compilar]     |
|      | proyecto          +-----------------------------------------------+
|      |                   | numeros | editor (textarea + pre resaltado)   |
|      |                   +-----------------------------------------------+
|      |                   | Consola | Historial | Compilar | Firmar       |
|      |                   |         (cerrada hasta que hace falta)         |
+------+-------------------+-----------------------------------------------+
| barra de estado: main | Editor | ultimo codigo - | apkc.wasm | OPFS      |
+--------------------------------------------------------------------------+
```

La cuadricula exterior es `.cuerpo`: 48 px de actividad, 260 px de explorador y el resto para
`.area`. `.area` tiene la fila de pestanas de vista (35 px) y `#vistas`. Cuando la vista activa es
`#pestana`, `vistas.js` pone `#vistas.modo-editor`, que cambia `overflow: auto` por
`overflow: hidden`; así el editor ocupa el alto disponible y no arrastra la pagina.

`#pestana` lleva las clases `vista vista-editor`. Es un `display: flex` en columna con tres filas:
la pestaña del fichero, el editor y el panel inferior. El panel esta `hidden` por defecto; cuando
se abre, el editor se encoge y conserva su propio scroll.

## Vistas

`vistas.js` es el unico fichero que decide que vista se ve:

- `mostrar(vista)` activa la seccion `#crear`, `#pestana` o `#vista`, marca el boton de la barra
  de actividad y la pestana de vista, escribe `document.body.dataset.vista`, cambia
  `#vistas.modo-editor` y actualiza `#estado-general`.
- Los botones `[data-vista]` de la barra de actividad y las pestanas `.pestana-vista` comparten
  el mismo manejador; el hash (`#crear`, `#pestana`, `#vista`) tambien cambia de vista.
- Al entrar en `#vista`, `vistas.js` llama a `repintarVistaPrevia()`: compilar puede ocurrir con
  la vista oculta y entonces el canvas mide cero, así que el primer pintado usa el tamaño de
  respaldo y se rehace al mostrarla.
- Al arrancar, `iniciarPestana()` (en `pestana.js`) abre el `AndroidManifest.xml` si ya hay un
  proyecto en OPFS y pulsa la vista Editor. Si no hay proyecto, deja Inicio con el formulario.

## Pantalla

La tercera vista (`#vista`, clases `vista vista-previa`) es la misma pareja de lecturas que la vista
dividida, a página completa: el teléfono a la izquierda y, a la derecha, el estado y las **tres
secciones del emulador** (Pulsar, Registro y Consola) en una columna redimensionable. Lleva los
**dos modos** de la vista dividida (pestañas propias, `#vista-modo-previa` y `#vista-modo-emulador`),
el canvas de cada uno y las mismas secciones con ids propios: `previa-panel.js` pinta las dos
superficies con el mismo modelo (`SUPERFICIES`), así que la vista no puede quedarse atrás. El canvas
`#vista-previa` también entrega el clic: pulsar el teléfono grande ejecuta el mismo `--pulsar` que
el del panel.

| Id | Qué es |
| --- | --- |
| `#vista` | la sección; `data-vista="vista"` en el `<body>` cuando está delante |
| `#vista-modo-previa`, `#vista-modo-emulador` | las dos pestañas (`role="tab"`, `aria-selected`) |
| `#vista-layout`, `#vista-layout-canvas`, `#vista-layout-estado` | el modo Vista previa: el layout del editor dibujado, sin compilar |
| `#vista-emulador`, `#vista-previa` | el modo Emulador: el canvas del modelo de `apkc preview` (pulsable, `tabindex="0"`) |
| `#vista-previa-estado` | la línea de estado del emulador; la escribe `vista-previa.js` con el modelo |
| `#vista-seccion-*`, `#vista-pulsos`, `#vista-log`, `#vista-consola` | las tres secciones del emulador en Pantalla, con los mismos ids que la del panel al revés (`vista-` en vez de `previa-`) |
| `#marco-vista-lado` y sus ocho `#vista-tirador-*` | la columna de estado y consola, redimensionable |
| `#vista-lado` | la columna; su ancho y su alto viven en `--previa-ancho`/`--previa-alto` |

`vista-previa.js` sigue siendo el pintor y el dueño del modelo (`pintarModelo`, `modeloActual`,
evento `apkc:previa-actualizada`): la vista solo aporta la caja y las pestañas. Al entrar en Pantalla,
`vistas.js` llama a `repintarVistaPrevia()` y a `PREVIA_PANEL.repintar()`: compilar puede ocurrir con
la vista oculta y entonces el canvas mide cero.

La vista se llamaba **Vista** y solo enseñaba el emulador; con los modos renombrados, el nombre
«Vista» chocaba con el modo **Vista previa**, así que la sección pasa a llamarse **Pantalla** (el
`data-vista="vista"` y el id `#vista` no cambian: son contrato de `vistas.js` y de las pruebas).

`vista-previa.js` separa las dos mitades:

- **Modelo puro, probado en node** (`prueba.js`): `modeloDeSalida()` encuentra la línea JSON del
  modelo entre la consola de apkc; `textoDeNodo()` prefiere un campo de texto dinámico (`texto…`
  distinto de `texto`) y cae a `texto`; `nodosAplanados()` recorre el árbol en orden y pone cota;
  `escalaPara()` encaja la pantalla en la caja sin deformarla; `rectsEscalados()` devuelve un
  rectángulo por nodo y omite los que no traen `rect` numérico.
- **Pintura** (`pintarModelo`, `pintarVistaPrevia`, `repintarVistaPrevia`,
  `mensajeVistaPrevia`): lee los colores de las variables CSS del tema, nunca de literales, así
  que los tres mundos de `DESIGN.md` se ven sin tocar el pintor.
- **La medida es una frontera cerrada.** `escalaPara` solo acepta números finitos (o cadenas
  numéricas): `1e400` llega como `Infinity`, y `NaN`, `null`, `{}` o `""` no son medidas. Si la
  pantalla no se puede medir se usa el respaldo de 360×640; si aun así la escala no es finita,
  devuelve `valida: false`, `rectsEscalados` no pinta ningún rectángulo y `pintarVistaPrevia`
  deja el panel vacío con el motivo en `#vista-previa-estado`. Un `rect` con una medida inválida
  se omite en vez de dibujarse en `(0,0)`. `prueba.js` cubre `1e400`, `NaN`, `Infinity`, `null`
  y cadenas.

`pestana.js` llama a `previsualizarLoCompilado()` **después** de un build correcto, con
`hospedador.ejecutar(["preview", "build/app.apk"])` y no con `correr()`: no es una orden de la
persona, así que no pisa `#ultimo-codigo` ni la consola, y si el comando falla se queda en un
mensaje del panel sin tocar el resultado de la compilación. Un campo nuevo en el JSON (por
ejemplo el texto dinámico de la Fase 2) no rompe nada: se ignoran las claves que no se usan.

El pintor no esconde el texto de un nodo bajo: el texto se pinta con la fuente encogida al hueco
(8-12 px) y recortado al rectángulo. Antes había un `alto >= 28` que dejaba sin pintar el
«Hello World!» del apk Hola y el «Pulsos: 1» del Contador, que llegan con 18 px a la escala 0,75.
`prueba-pestana.js` cuenta tinta dentro del nodo con texto y sin él, no solo la etiqueta.

**El nodo no lleva rótulo.** Antes se dibujaba encima una etiqueta con el tipo y el id
(`Button · id/pulsar`) cuando el nodo pasaba de 30 px; sobre un botón parecía un diálogo pegado y
se quitó. El tipo y el id no se pierden: siguen en el modelo (`raiz`/`hijos`), en `rectsEscalados`
y en el `resumen` que devuelve `pintarModelo`, que además se deja en `data-nodos` del canvas para
las pruebas y para inspeccionar el DOM. La comprobación de la pestaña mide que sin texto no queda
ni una mota de tinta en el `Button` y que con «Press me» sí hay texto.

## Vista dividida: editor y teléfono

La pestaña **Editor** se puede partir en dos: a la izquierda el editor de siempre y a la derecha
un marco de teléfono con dos lecturas del mismo proyecto. Vive dentro de `#pestana`, no en la
pestaña **Pantalla**, porque la utilidad es editar y ver a la vez; **Pantalla** es la misma pareja a
página completa. El editor no cambia: mismo textarea, mismo undo tree, misma búsqueda, mismo
diagnóstico en vivo y misma paleta. La fila es `.editor-fila`, con dos hijos: el editor y el marco
del panel, que a su vez contiene los ocho tiradores y el `<aside>`:

```html
<div id="editor-fila" class="editor-fila">
  <div class="editor">…</div>
  <div id="marco-previa" class="marco-previa">
    <div id="separador-previa" class="tirador-previa tirador-oeste" data-eje="oeste" role="separator" …></div>
    … #tirador-previa-este | -norte | -sur | -noroeste | -noreste | -suroeste | -sureste …
    <aside id="previa-lateral">
      … #previa-modo-vivo (Vista previa) | #previa-modo-render (Emulador) | #previa-modo-editar …
      <div id="previa-vivo">…#previa-vivo-canvas … #previa-paleta (capa) … #previa-propiedades (capa) … #previa-editar-estado</div>
      <div id="previa-render">…#previa-lateral-canvas … #previa-pulsos … #previa-log … #previa-consola</div>
    </aside>
  </div>
</div>
```

| Id | Qué es |
| --- | --- |
| `#editor-fila` | la fila que reparte el ancho |
| `#marco-previa` | el marco del panel; guarda `--previa-ancho`, `--previa-alto` y `--previa-arriba` |
| `#separador-previa` | la arista **izquierda**: `role="separator"`, `aria-orientation="vertical"`, `tabindex="0"`, `aria-valuenow/min/max` y `aria-controls="previa-lateral"` |
| `#tirador-previa-este`, `-norte`, `-sur`, `-noroeste`, `-noreste`, `-suroeste`, `-sureste` | las otras siete aristas y esquinas (`role="separator"`, `data-eje`, `tabindex="-1"` salvo la sur) |
| `#previa-aviso-estrecho` | el aviso de que en pantalla estrecha no se redimensiona |
| `#previa-lateral` | el panel; `hidden` cuando se oculta |
| `#previa-alternar` | el botón **Previa** de la barra del fichero; `aria-expanded` |
| `#previa-cerrar` | la × de la cabecera del panel |
| `#previa-modo-vivo`, `#previa-modo-render` | las dos pestañas (**Vista previa** y **Emulador**; `role="tab"`, `aria-selected`) |
| `#previa-modo-editar` | el **lápiz** del modo editar: interruptor con `aria-pressed`, `aria-label="Editar layout"` y `aria-controls="previa-paleta"` |
| `#previa-vivo`, `#previa-render` | los paneles (`role="tabpanel"`) |
| `#previa-vivo-canvas`, `#previa-vivo-estado` | el canvas del layout dibujado (enfocable: `tabindex="0"`) y su línea de estado |
| `#previa-paleta` | la paleta de añadir elementos (`role="toolbar"`), capa flotante a la izquierda del dibujo; `hidden` fuera del modo editar; lleva `data-plegada` |
| `#previa-paleta-titulo`, `#previa-paleta-plegar`, `#previa-paleta-scroll` | la cabecera («Añadir»), el botón que pliega la paleta (`aria-expanded`, `aria-controls`) y la lista con scroll por categorías (`tabindex="0"`, `aria-label`) |
| `#previa-anadir-textview`, `#previa-anadir-edittext`, `#previa-anadir-button`, `#previa-anadir-imagebutton`, `#previa-anadir-imageview`, `#previa-anadir-checkbox`, `#previa-anadir-radiobutton`, `#previa-anadir-switch`, `#previa-anadir-progressbar`, `#previa-anadir-seekbar`, `#previa-anadir-view`, `#previa-anadir-space`, `#previa-anadir-linearlayout`, `#previa-anadir-framelayout`, `#previa-anadir-relativelayout`, `#previa-anadir-scrollview`, `#previa-anadir-tablelayout`, `#previa-anadir-gridlayout` | los botones de la paleta; cada uno con `data-tipo` y `aria-label` (los tipos con `*` dibujan un bloque que no imita la vista). El orden y los grupos son los de `gruposPaleta()` |
| `#previa-propiedades`, `#previa-propiedades-titulo`, `#previa-propiedades-campos` | la ficha de propiedades del nodo seleccionado (incluida la raíz, con tipo/orientación/padding/fondo), capa flotante arriba a la derecha; `hidden` si no hay nodo o no está el modo editar; lleva `data-plegada`. En una imagen, el control de `android:src` trae «Elegir fichero» (con `role="button"`), el selector de iconos del sistema y `aria-label="Arrastra una imagen o pulsa Elegir fichero"` |
| `#previa-propiedades-vacio` | el aviso de la ficha cuando no hay nada seleccionado (queda oculto: sin selección no hay ficha) |
| `#previa-propiedades-plegar`, `#previa-propiedades-cerrar` | pliegan la ficha (`aria-expanded`) y la cierran (suelta el nodo, como `Esc`) |
| `#previa-editar-estado` | el estado del modo editar, al pie de la paleta: qué está seleccionado, el último cambio o el motivo por el que no se puede editar (`role="status"`) |
| `#previa-jerarquia` | la capa del **visor de jerarquía** (`hidden` hasta que se abre); `#previa-jerarquia-lista` son sus filas (`button[data-ruta]`, con `activa` y `aria-current`) y `#previa-jerarquia-cerrar` la cierra |
| `#previa-jerarquia-alternar` | el interruptor del visor en la barra de acciones; `aria-pressed` y `aria-controls="previa-jerarquia"` |
| `#previa-editar-deshacer`, `#previa-editar-rehacer` | deshacer y rehacer del **historial del diseñador** (`aria-keyshortcuts`); `disabled` cuando no hay pasos |
| `#previa-editar-eliminar`, `#previa-propiedades-eliminar` | la basura: borran el nodo seleccionado (`aria-label="Eliminar elemento"`); la raíz se rechaza con mensaje |
| `#previa-propiedades-padre` | «↑ Padre»: sube la selección al contenedor; `disabled` en la raíz |
| `#previa-destino-linea`, `#previa-destino-hueco` | las dos formas del **indicador de destino** del arrastre (línea en un lineal, hueco discontinuo en un marco); `hidden` fuera del gesto |
| `#previa-imagen-archivo` | el `<input type="file" accept="image/*">` oculto del campo de imagen |
| `#previa-lateral-canvas`, `#previa-render-estado` | el canvas del emulador (enfocable y pulsable) y su línea de estado |
| `#previa-seccion-pulsos`, `#previa-seccion-registro`, `#previa-seccion-consola` | las tres secciones del emulador en el panel (`role="tab"`, `aria-selected`, `aria-controls`); Pulsar es la de por defecto |
| `#previa-pulsos`, `#previa-oyentes`, `#previa-pulsos-cuenta`, `#previa-pulsos-nota` | la sección de pulsar: los botones de las vistas con `OnClickListener`, la cuenta de clics y la nota cuando no hay a quién pulsar |
| `#previa-log`, `#previa-log-cabecera`, `#previa-log-lista`, `#previa-log-vacio` | la sección **registro del emulador** (`role="log"`) |
| `#previa-consola`, `#previa-consola-cabecera`, `#previa-consola-lista`, `#previa-consola-vacio` | la sección **consola de la app** (`role="log"`): `println` y `Log.*` |
| `#vista-seccion-pulsos`, `#vista-seccion-registro`, `#vista-seccion-consola` | las mismas tres secciones en la vista Pantalla |
| `#vista-pulsos`, `#vista-oyentes`, `#vista-pulsos-cuenta`, `#vista-pulsos-nota` | la sección de pulsar de Pantalla |
| `#vista-consola`, `#vista-consola-cabecera`, `#vista-consola-lista`, `#vista-consola-vacio` | la consola de la app de Pantalla |
| `#previa-modo-vivo`/`-render` y los ids `vista-*` | las dos superficies: Editor y Pantalla comparten modelo y consola |
| `#consola-pestana` | la consola de los **comandos** de compilación; no es la de la app |

`previa-panel.js` es dueño de esta pieza y no importa `pestana.js`: recibe `hospedador`, la carpeta
del proyecto, `estadoPestana` y `EDITOR` desde `pestana.js` (`crearPreviaPanel`). Así el editor no
gana una copia del estado y la prueba de node puede importar las funciones puras. `vista-xml.js`
convierte el XML en modelo, también sin DOM; `layout-editor.js` hace el camino de vuelta del modo
editar (modelo → XML), con las mismas reglas y sin DOM.

### Los ocho tiradores

- **Puntero**: `pointerdown` en cualquier `.tirador-previa`; el `pointermove` y el `pointerup` se
  siguen en el documento para que soltar fuera no deje el arrastre pegado. Una arista horizontal
  cambia el **ancho** y una vertical el **alto**; las esquinas, las dos cosas. La arista que se
  mueve sigue al puntero y la de enfrente se queda quieta (`cajaRedimensionada`, pura y probada en
  node). Solo cambian variables CSS del marco y `body.separando-previa`: **no tocan el modelo, el
  fichero ni el canvas**. El cursor es `col-resize`, `row-resize`, `nwse-resize` o `nesw-resize`
  según el tirador, y también mientras se arrastra (`body[data-eje]`).
- **Teclado**: `←`/`→` mueven 16 px (48 con `Shift`), `Home`/`End` van al mínimo y al máximo; en la
  arista izquierda, `Alt+↑/↓` cambia el alto. La arista inferior (enfocable) hace lo mismo con el
  alto: `↑`/`↓`, `Home` (320 px) y `End` (la fila entera). `aria-valuenow` se actualiza en cada paso.
- **Rango**: 240-900 px de ancho y el editor nunca baja de 280 px; el alto mínimo es 320 px y nunca
  deja hueco fuera de la fila. Sin alto propio el panel ocupa la fila entera (como siempre) y el
  `ResizeObserver` rehace el recorte al cambiar de vista o de ventana.
- **Doble clic** en cualquier tirador vuelve al tamaño de siempre.
- **Persistencia**: `apkc-studio/previa-ancho`, `apkc-studio/previa-alto` y
  `apkc-studio/previa-arriba` (lo elegido), `apkc-studio/previa-visible` (`1`/`0`) y
  `apkc-studio/previa-modo` (`vivo`/`render` — el modo **Vista previa** o **Emulador**) en
  `localStorage`. Una preferencia corrupta cae a 340 px de ancho, sin alto propio, visible y en
  `vivo` (el valor viejo `xml` se lee como `vivo`). La vista Pantalla guarda su columna aparte:
  `apkc-studio/previa-lado`, `-alto` y `-arriba`.
- **Pantallas estrechas** (≤760 px): la fila se apila, los ocho tiradores se ocultan y
  `#previa-aviso-estrecho` explica que ahí no se redimensiona; un `pointerdown` se ignora.

### Vista previa: el layout dibujado

El panel **nunca enseña el código XML**: dibuja el layout en el canvas del teléfono. El XML del
editor se convierte en el mismo modelo que entiende `vista-previa.js` (`pantalla` + nodos con
`rect`) con `vista-xml.js`, que es puro y se prueba en node: un parser mínimo (sin `DOMParser`),
la jerarquía de vistas y estas reglas:

- `LinearLayout` (vertical y horizontal) con **`layout_weight`**; `FrameLayout`,
  `RelativeLayout`, `ScrollView` y cualquier otro contenedor como marco;
- un **tipo propio totalmente cualificado** (`com.ejemplo.lienzo.Lienzo`) como contenedor por
  declaración: el editor no resuelve la herencia de Java, así que un nombre con paquete que no
  sea del framework de hoja se dibuja como lineal (`android:orientation` decide el eje) para que
  sus hijos se repartan y no se apilen en (0,0);
- `android:text` literal y **`@string/nombre`**, resuelto con los `res/values*/strings.xml` del
  proyecto leídos de OPFS (con caché de 5 s); lo que no se resuelve se cuenta en el estado;
- `layout_width`/`layout_height` (`match_parent`, `wrap_content`, `Ndp`);
- `gravity` y `layout_gravity`, `padding` y `layout_margin` (y sus lados);
- `@+id/...` y `@id/...` como `id/...`.

La medida es una aproximación declarada (dp≈px, texto a 7 px por carácter) y la raíz ocupa la
pantalla, como el `setContentView`. La ruta del layout se resuelve en este orden y se queda con la
primera que se puede leer:

1. el fichero abierto, si es un `res/layout*/*.xml`;
2. el `layout` del modelo de `apkc preview` (acepta `main` o `res/layout/main.xml`);
3. los layouts del árbol del proyecto (`res/layout*` en la raíz, `main.xml` primero). `build/` y
   los layouts de otras carpetas no cuentan: son copias o cosas de otro proyecto.

El contenido sale del **buffer del editor** cuando el layout mostrado es el documento activo —así
se dibuja lo que se escribe aunque no se haya guardado, y el estado lo dice con `· sin guardar`— y
de **OPFS** cuando está cerrado. Se refresca con debounce de **350 ms** al teclear, 160 ms al
cambiar de documento y 400 ms cuando el árbol se repinta; nunca lanza un comando de apkc, así que
`#ultimo-codigo` y `#consola-pestana` no cambian. Sin ningún layout el canvas se vacía con el
motivo; con un **XML a medias o inválido** se conserva el último render bueno y la línea de estado
avisa con `XML inválido (línea N): se conserva el último render…` (clase `.con-aviso`), sin pintar
nada de código en el canvas.

### Modo editar: el lápiz

El botón `#previa-modo-editar` (un lápiz, con `aria-pressed`) enciende y apaga el **modo editar**
sobre la lectura **Vista previa**. No es una tercera pestaña: es un interruptor que convierte el
dibujo en un lienzo de edición. Al encenderlo se fuerza `vivo`; cambiar a **Emulador** u ocultar el
panel lo apaga, y el modo no se persiste: al recargar se vuelve a la vista de solo lectura.

- **Paleta.** `#previa-paleta` es una **capa flotante** pegada al borde izquierdo del dibujo, con
  scroll propio (`#previa-paleta-scroll`), agrupada por categorías (Contenedores, Texto, Botones,
  Entradas, Imágenes, Indicadores y Espaciadores; el orden y los grupos salen de `gruposPaleta()` en
  `layout-editor.js`). No ocupa sitio en la columna: está en `position: absolute` sobre el marco, así
  que abrirla no encoge el canvas. `#previa-paleta-plegar` deja solo su cabecera (`data-plegada="1"`,
  `aria-expanded`) y el dibujo recupera lo que tapaba. Sus botones siguen siendo los mismos
  `#previa-anadir-*`, con `data-tipo`, `title` y `aria-label`; ofrecen dieciocho tipos que el render
  en vivo dibuja o, si no los imita, lo dice con un `*` y su `aria-label`: `TextView`, `EditText`,
  `Button`, `ImageButton`, `ImageView`, `CheckBox`, `RadioButton`, `Switch`, `ProgressBar`,
  `SeekBar`, `View`, `Space`, `LinearLayout`, `FrameLayout`, `RelativeLayout`, `ScrollView`,
  `TableLayout` y `GridLayout`.
  Un **clic** añade el elemento como último hijo de la raíz. **Arrastrarlo** (puntero con umbral de
  5 px; hay un fantasma que sigue al puntero y un hueco delimitado con el tamaño del tipo) lo suelta
  donde se quiere: en un **marco** con `android:layout_marginLeft` y `android:layout_marginTop` del
  punto, y en un **`LinearLayout`** en la posición que marca el punto entre sus hermanos. El destino
  es el contenedor más profundo bajo el puntero; si se suelta sobre una vista, entra en su padre. Al
  soltar, el nodo nuevo queda seleccionado y su ficha abierta; la **jerarquía** marca esa misma fila.
  El XML que se escribe lleva `android:layout_width="wrap_content"`,
  `android:layout_height="wrap_content"`, `android:text` en las vistas de texto y un
  `android:id="@+id/…"` libre (`boton`, `boton2`…): así el elemento se puede tocar en el canvas
  enseguida. **Un contenedor entra vacío** con una caja de 160dp × 96dp (sin el `TextView` «Texto»
  que se veía primero y hacía creer que se había insertado un TextView) y los espaciadores
  `View`/`Space` con 48dp × 24dp; `tamanoDeTipo()` es la única tabla de tamaños y el indicador de
  destino usa la misma. Los tipos marcados con `*` se dibujan como bloque porque el render no
  reproduce su forma: la paleta no los pinta como si funcionaran.
- **Arrastrar.** `pointerdown` sobre el canvas hace *hit-test* con los `rect` del modelo en vivo
  (gana el nodo más profundo; la raíz no se selecciona) y arranca un arrastre que se sigue en el
  documento. Mientras se mueve se dibuja el contorno desplazado; al soltar se aplica:
  - en un contenedor **de marco** (`FrameLayout`, `RelativeLayout`, `ScrollView`…) se escriben
    `android:layout_marginLeft` y `android:layout_marginTop` en dp y se quita `android:layout_gravity`,
    porque con gravedad el margen no se aplica; el nodo no se reparenta;
  - en un **`LinearLayout`** (vertical u horizontal) se **reordena el hijo** en el XML: el índice
    sale de comparar el punto donde se suelta con los centros de sus hermanos.
- **Selección y borrado.** Un clic selecciona (contorno con `--acento` y estado con el tipo y el
  id), `Supr` borra el nodo del XML y `Esc` suelta la selección. El manejador ignora los campos de
  texto y cualquier combinación con `Ctrl`/`Alt`/`Meta`, así que no toca el autocompletado, la
  paleta `Ctrl+Mayús+P` ni `Ctrl+G`. `Esc` sí funciona desde dentro de la ficha (es una capa, no una
  columna): cierra la ficha y suelta el nodo. La **basura** está en la barra del modo editar
  (`#previa-editar-eliminar`) y en la ficha (`#previa-propiedades-eliminar`), con
  `aria-label="Eliminar elemento"`; las dos y `Supr` escriben con el mismo
  `layout-editor.borrarElemento`, con diff mínimo y en el historial del diseñador. La raíz no se
  borra: se rechaza con el motivo en `#previa-editar-estado`.
- **Propiedades del nodo.** Con un nodo seleccionado, `#previa-propiedades` es una **ficha
  flotante** en la esquina superior derecha del marco (`position: absolute`): aparece al seleccionar
  y desaparece al soltar; no reduce el canvas. `#previa-propiedades-cerrar` hace lo mismo que `Esc`
  y `#previa-propiedades-plegar` la deja en su cabecera (`data-plegada="1"`, `aria-expanded`). La
  ficha muestra `android:id`, `android:text`, `android:textColor`, `android:background`,
  `android:layout_width`, `android:layout_height`, `android:gravity`, `android:layout_gravity`,
  `android:padding`, `android:layout_margin`, `android:layout_weight`, `android:orientation` (solo
  en un lineal) y `android:enabled`. Los campos se crean con `createElement` y se rellenan con
  `value` y `textContent` —nunca con `innerHTML`—, y el texto se escapa a `&amp;`, `&lt;`, `&gt;` y
  `&quot;` al escribirlo. Los valores se validan por su nombre: un id que no es un identificador, un
  color que no es `#RGB`/`#ARGB`/`#RRGGBB`/`#AARRGGBB` ni `@color/…`, una dimensión sin unidad, una
  gravedad inventada o un peso negativo se rechazan con el motivo en `#previa-editar-estado` sin
  tocar el XML. `change` (salir del campo o `Enter`) aplica el cambio con `escribirPropiedad` y el
  diff mínimo de `EDITOR.cambiar()`: entra en el undo tree, marca el documento sucio y repinta el
  canvas, sin compilar y sin tocar `#ultimo-codigo`. `android:background` y `android:textColor`
  llegan al modelo (`vista-xml.js` resuelve también `@color/…` desde `res/values*/colors.xml`) y el
  canvas los usa para rellenar y para el texto.
- **Propiedades de la raíz.** El hueco del layout —un clic dentro de la raíz que no cae en ningún
  hijo— selecciona la raíz (ruta `[]`); **no hay botón** para eso. Su ficha es la configuración
  general del layout: tipo (`LinearLayout`/`FrameLayout`), orientación, gravedad, padding y fondo,
  con los mismos `leerPropiedades`/`escribirPropiedad` que el resto. `cambiarTipoRaiz` renombra solo
  la etiqueta de apertura y la de cierre, conserva atributos e hijos y pone
  `android:orientation="vertical"` al volver a un lineal. **`RelativeLayout` se rechaza por su
  nombre**: sus reglas (`layout_toRightOf`, `layout_alignParent…`) no las escribe este editor y la
  gravedad que sí escribe no la aplica Android, así que el dibujo no coincidiría con el aparato. La
  raíz no se borra ni se arrastra.
- **Cómo escribe.** Toda edición es `layout-editor.js` (puro: `insertarElemento`, `moverEnMarco`,
  `reordenarHijo`, `borrarElemento`, `leerPropiedades`, `escribirPropiedad` y `cambiarTipoRaiz`)
  sobre el texto del buffer y se aplica con `EDITOR.cambiar()`: el cambio entra en el undo tree y el
  documento queda sucio una sola vez. Después del cambio el foco vuelve al canvas para que `Supr` y
  `Esc` sigan respondiendo —salvo al editar una propiedad, que se queda en el campo—. Si el layout
  dibujado no es el documento abierto, el XML está a medias o no hay layout válido, la paleta y la
  ficha se deshabilitan y `#previa-editar-estado` dice por qué en vez de escribir a ciegas. Guardar
  es lo de siempre: `Ctrl+S`.
- **Historial del diseñador.** El modo editar lleva su **propia** pila de operaciones
  (`pilaDeshacer`/`pilaRehacer` en `previa-panel.js`, con el XML anterior y el posterior de cada
  añadido, arrastre, borrado o cambio de propiedad). `Ctrl+Z`/`Ctrl+Mayús+Z` (y `Ctrl+Y`) y los
  botones `#previa-editar-deshacer`/`#previa-editar-rehacer` deshacen y rehacen **el diseño**, no el
  texto: con el foco en el canvas, en la paleta o en un campo de la ficha, el atajo se captura antes
  de que llegue al editor de código (y `preventDefault` corta el undo nativo del navegador, que
  reescribía el XML a espaldas del modelo). Cada paso se aplica con `EDITOR.cambiar` como mecanismo
  de escritura, así que el undo tree del documento también lo ve, pero la fuente de verdad del gesto
  es la pila del diseñador. Una edición a mano del XML (un `input` que no dejó el diseñador) o abrir
  otro fichero vacía la pila y se avisa: nunca se aplica el XML de otro layout. Tras deshacer, el
  modelo y el canvas se repintan y `#ultimo-codigo` no cambia.
- **Indicador de destino.** Mientras se arrastra un tipo desde la paleta, `pintarDestino` calcula el
  destino con la misma `destinoDeSoltar` que usa el soltar y pinta una **línea** en el hueco de un
  lineal (`#previa-destino-linea`) o un **hueco** en un marco (`#previa-destino-hueco`). El hueco
  mide exactamente lo que entrará (`tamanoDeTipo`, la misma tabla que `elementoDe`: 160×96 para
  contenedores, el intrínseco de la vista para el resto), tiene borde continuo y relleno translúcido,
  y se **recorta al canvas** para que se vea dónde termina; la línea de un lineal mide el **hermano
  de referencia**, no todo el contenedor. No se marca el canvas entero. Se recalcula en cada
  `pointermove`, se apaga al soltar, al cancelar y al salir del modo editar. No toca el documento.
- **Jerarquía.** `#previa-jerarquia-alternar` abre una capa flotante (abajo a la derecha) con el
  árbol de nodos del layout, indentado y con `tipo · id` (o `(sin id)`); cada fila es un botón que
  selecciona ese nodo, y las ramas con hijos se pliegan con la flecha. Se reconstruye cuando cambia
  la estructura o los rótulos, así que añadir, borrar, mover o cambiar un id se ven al momento, sin
  compilar. `#previa-propiedades-padre` («↑ Padre», deshabilitado en la raíz) sube la selección al
  contenedor, igual que la barra de Android Studio.
- **Imagen.** Para `ImageView`/`ImageButton` la ficha ofrece `android:src` (tipo `imagen`, validado a
  `@drawable/…` o `@android:drawable/…`) con tres vías: el texto, **«Elegir fichero»**
  (`#previa-imagen-archivo`, un `<input type="file" accept="image/*">` que lee el fichero y lo
  escribe en `/proyecto/res/drawable/<nombre>.<ext>`), **soltar la imagen sobre el canvas** del nodo
  seleccionado (mismo camino) y el **selector de iconos del sistema**. El campo y el canvas llevan
  `aria-label="Arrastra una imagen o pulsa Elegir fichero"` y el control `role="button"`;
  `android:contentDescription` (el «alt») es otro campo de la misma ficha. El `@drawable/…` se
  dibuja con el PNG real (`createImageBitmap` desde los bytes de OPFS, escalado al nodo) y el
  `@android:drawable/…` como marcador con su nombre: los iconos del framework viven en el jar, no en
  el proyecto. Nada sale del origen.
- **Iconos del sistema.** La lista (`iconosSistema()` en `layout-editor.js`) son los `ic_*` con
  nombre **público** en API 34, comprobados con
  `aapt2 dump resources android.jar | grep " resource .* drawable/… PUBLIC"`: `ic_delete`, `ic_info`,
  `ic_menu_add`, `ic_menu_camera`, `ic_menu_delete`, `ic_menu_edit`, `ic_menu_gallery`,
  `ic_menu_help`, `ic_menu_search` e `ic_menu_share`. **No hay** variantes `*_white`/`*_black`/
  `*_gray` de `ic_*` como recurso público en 34 (sí `_holo_dark`/`_holo_light`, privadas), así que
  no se ofrecen; la ficha lo dice.

Frontera del modo editar: solo cambia lo que el render en vivo entiende. No hay constraints de
`ConstraintLayout` (ni `bias`, ni cadenas), ni estilos ni temas, ni reparentado de un nodo que ya
está dibujado (arrastrar un nodo dentro de otro contenedor), ni edición de `@string`, ni de `@color`
(se referencian, no se crean), y un layout lineal no admite posición libre: ahí mover es reordenar.
Un tipo propio cualificado cuenta como contenedor aunque en el código herede de `View` (el
editor no lee las clases): es la frontera del reconocimiento por declaración. `android:enabled`
se escribe como atributo válido pero el dibujo no lo imita. Cambiar la raíz a
`RelativeLayout` se rechaza por nombre por la razón de arriba; tampoco se cambia una raíz que no sea
`LinearLayout` o `FrameLayout`. En las imágenes, un `drawable` vectorial (`.xml`) no se dibuja (solo
PNG/JPG/WebP), los iconos `@android:drawable/…` se dibujan como marcador con su nombre porque viven
en el `android.jar`, y no hay recorte (`scaleType`): el PNG se escala para caber, centrado.

### Emulador, clics y consola de la ejecución

La pestaña **Emulador** pinta el modelo real de `apkc preview` en `#previa-lateral-canvas` y debajo
lleva **tres secciones con pestañas**, igual que el panel inferior de compilación (Consola,
Diagnóstico, Historial, Compilar, Firmar): **Pulsar**, **Registro** y **Consola**. No son tres
bloques apilados: una sección visible cada vez, y las otras dos siguen en el DOM con su contenido y
su scroll, así que alternar no vuelve a ejecutar nada ni pierde líneas. La sección activa se guarda
en `apkc-studio/previa-seccion` (y `apkc-studio/vista-seccion` en Pantalla); las pestañas se
recorren con `←`/`→`, `Home` y `End`, con `role="tab"`, `aria-selected` y `aria-controls`.
`#consola-pestana` sigue siendo la de los comandos de compilación y no se ensucia con texto de la
app. El mismo modelo y las tres secciones se pintan en la vista **Pantalla**, sin segunda ejecución.

**El emulador no pulsa solo.** `apkc preview` ejecuta `onCreate` y se detiene (`Pulsos: 0`); los
`OnClickListener` quedan publicados en `ejecucion.oyentes`. Un clic —en el canvas o en un botón de
`#previa-oyentes`— manda `apkc preview --pulsar <idRef>` con toda la lista de clics desde la última
compilación, en orden: repetir la lista reproduce `Pulsos: 2` tras dos clics; un build nuevo la
vacía. `pointerdown` usa `nodoEnPunto` (gana la vista más profunda con `oyente: true`); el canvas es
`tabindex="0"` y Enter/espacio pulsan el primero. **Los dos canvas entregan el clic**: el del panel
(`#previa-lateral-canvas`) y el de Pantalla (`#vista-previa`), con la misma geometría. La medida del
clic usa `canvas.__espacio` (lo que dejó `pintarModelo`), no el `clientWidth` del momento, para que
el punto caiga sobre los píxeles visibles. `#previa-render` lleva `overflow-y: auto` y el marco un
mínimo de 220 px.

**`android:onClick` del layout se ejecuta.** Una app que declara el clic en el XML
(`android:onClick="sumar"` y `public void sumar(View v)` en la actividad, el patrón de los
contadores de tutorial) no llama a `setOnClickListener` en `onCreate`. `apkc preview` enlaza esos
oyentes al leer el layout —como el inflado del framework— y los publica con su id real, así que el
nodo queda `oyente: true` y `--pulsar` lo ejecuta. Si el método no existe o la vista no tiene
`android:id`, no se inventa el oyente y el registro del emulador lo dice en un aviso.

**La nota de «Pulsar» no miente.** Sin modelo (antes de compilar o con el preview fallido) dice que
compiles; con la ejecución detenida, el error; y solo cuando `onCreate` corrió de verdad y no
registró ningún listener con id dice «Esta ejecución no registró ningún OnClickListener sobre una
vista con id».

`resumenEjecucion(modelo)` (puro) acota `ejecucion` antes de pintarlo: `capturas` (máximo 64,
`origen`, `id`, `texto`), `consola` (máximo 128, `origen`, `texto`, `secuencia`), `oyentes`,
`pulsaciones`, `avisos` (máximo 24), `pasos`, `interacciones` (los clics entregados, que es lo que
la cabecera cuenta como «N clics»), `actividad`, `metodo` y `error`.
Solo acepta cadenas donde el JSON promete cadenas y números finitos donde promete números.

Los tres paneles no son el mismo canal:

- **Pulsar** (`#previa-pulsos`): un botón por vista con `OnClickListener`, con su `id/texto`, y la
  cuenta de clics entregados. Es la sección de por defecto.
- **Registro del emulador** (`#previa-log`, `role="log"`, `aria-label="Registro del emulador"`): la
  lista completa en el orden de la ejecución —primero las capturas (`TextView.setText id/total:
  Pulsos: 1`, y también `Log.d: …` y `println: …` porque ahí se ve todo—, después los avisos con la
  clase `aviso` y al final el `error` con `peligro`. La cabecera resume
  `onCreate · actividad · N pasos · M clics`.
- **Consola de la app** (`#previa-consola`, `role="log"`, `aria-label="Consola de la app"`): solo la
  salida estándar de la app —`System.out.println`/`print` y `Log.*`—, una línea por llamada, con su
  número de `secuencia` (el orden real de emisión; el reloj no existe en el intérprete y no se
  finge) y su origen. Su cabecera cuenta líneas y clics (`2 líneas · 1 clic`).

La consola de los **comandos de compilación** es otra: `#consola-pestana`, en el panel inferior. No
comparte ni ids ni pintor con la de la app, y un clic del emulador no escribe en ella.

**Fronteras del `android:onClick`.** (a) Se enlaza **solo** el layout de la actividad lanzadora: no se
siguen `include`, ni `menu`, ni el contexto de un Fragment o un servicio. (b) La firma tiene que ser
`(Landroid/view/View;)V`; si el método no existe o la vista no lleva `android:id`, no se inventa el
oyente y el registro del emulador lo dice en un aviso. (c) Las **lambdas Java siguen fuera del
subconjunto** del compilador propio: `v -> {…}` se rechaza al compilar (`">" no es una expresion que
este parser reconozca`); el patrón anónimo, `this`, la clase interna y `android:onClick` sí se
ejecutan. Y el sitio publicado (`https://apkc-studio.surge.sh/`) sigue con la **build anterior**:
estos cambios no se han empaquetado ni publicado.

Todo se pinta con `textContent`: un `texto` con `<script>` sale escapado y no se convierte en
marcado. Sin `ejecucion` (por ejemplo con `--sin-ejecutar` o sin `classes.dex`) el vacío explica
por qué; si el preview falla, los paneles se vacían con el mismo motivo y no tocan `#consola-pestana`
ni `#ultimo-codigo`. Al recargar la página arranca vacía.

### Congeniar con compilar

Compilar **guarda antes lo sucio**: `compilarCon()` llama a `guardarParaCompilar()`, que guarda el
documento activo con `guardar()` y los inactivos sucios con su `doc.texto`, y escribe en la consola
`guardados N fichero(s) con cambios antes de compilar`. El build lee OPFS, no el textarea: sin ese
paso el comando salía 0 y el Emulador seguía con el texto anterior aunque el editor enseñara el
nuevo (el síntoma «compilo y el Emulador no recarga la última APK»). Si un guardado falla no se
compila a medias: el motivo queda en la barra y `compilarCon()` devuelve `null`.

`#ultimo-codigo` es del **build**, no de cualquier orden. Si el build ni siquiera empieza (guardado,
jar o keystore) dice `no compilé` y la consola guarda el motivo (C1); el `verify` interno corre con
`{recordar:false}` y no pisa el código del build ni lo que repite `Ctrl+Enter` (C2). `Ctrl+Enter`
repite el último `build` por `compilarDebug()`/`compilarDelTodo()` —vuelve a pedir la clave—, así que
también guarda los sucios antes (C3). `ULTIMO.argv` guarda solo la copia redactada: una orden con
contraseña (`sign`, `keystore`, `rotate`) no se repite desde el atajo y lo dice en la barra (C4).

Compilar no cambia de pestaña: `previsualizarLoCompilado()` pinta el modelo y publica el evento; en
en modo Emulador el canvas se repinta en su caja, el registro y la consola de la app se llenan, y en
modo Vista previa se relee el layout. El editor no pierde foco, cursor ni scroll porque nadie escribe
en `#codigo`. La compilación corre en el worker como siempre; el fallo del preview se queda en el
panel (`#previa-render-estado`, `#previa-log-vacio`, `#previa-consola-vacio`).

## Diagnóstico

El bloque `#detalle-diagnostico` de Inicio es independiente del editor: un `<textarea
id="salida-apkc">`, los botones `#analizar-salida` y `#limpiar-salida`, el resultado
`#resultado-analisis` y el enlace `#descargar-informe`. `diagnostico.js` llama a `analyze()` y a
`informe()` de `app.js`; no tiene reglas propias ni envía el texto a ningún sitio. Cada regla
reconocida se registra en `localStorage` y el informe se descarga como `informe-apkc.md`.

### Diagnóstico en vivo

`diagnostico-vivo.js` es otra pieza: mientras se escribe un `.java`, el texto del editor se copia a
`/proyecto/.apkc-check.java` y se manda a `apkc check` por el hospedador de siempre (worker + wasm).
No hay reglas nuevas ni envío a ningún sitio, y el temporal se borra después de cada pasada. El
debounce son **350 ms** (`ESPERA`), y una pasada tarda ~1,6 s en la pestaña (§200).

Ids y contrato:

| Id | Papel |
| --- | --- |
| `#diagnostico-vivo-estado` | resumen: `sin errores`, `N error(es)`, `comprobando…`, `no se pudo comprobar: …`. Lleva `role="status"` y `aria-live="polite"` |
| `#diagnostico-vivo-lista` | una entrada por error; cada una es un `<button>` con un `<code>` (la posición) y el mensaje |
| `#diagnostico-marcas` | la capa del subrayado, encima de `#codigo` y con `pointer-events: none` |

El JSON de `apkc check` trae, por error, `linea`, `columna` (solo si el error nació en un token),
`posicion` (`archivo:linea:columna`, o `archivo:linea` cuando no hay columna) y `mensaje` (la
explicación, sin la posición repetida). **La posición es lo que se pinta**, no la línea suelta: el
enlace del botón salta a `linea` y el subrayado usa `columna` para caer sobre el token real
(`R.layout.main`), no sobre la línea entera. Ahí hay **dos conversiones** y las dos importan:

- `apkc` cuenta la columna en **caracteres** (runes) y desde 1; el editor indexa en **unidades
  UTF-16** y desde 0. Un carácter astral (`\uD83D\uDE00`: un rune, dos unidades) desplaza el corte,
  así que `indiceUTF16()` traduce la columna al índice del editor. La marca guarda las dos cosas:
  `data-columna` (runes, la de `apkc`) y `data-utf16` (unidades, con la que se corta).
- El ancho **no** es «columnas por ancho de carácter»: un tabulador llega a su parada (`tab-size: 4`
  en `style.css`) y un astral puede ocupar dos celdas. `anchoDe()` mide con una sonda de la misma
  fuente el prefijo y el token; la marca guarda `data-izquierda` (píxeles del prefijo) y
  `data-ancho` (píxeles del token). `sincronizar()` solo les suma el padding de 12 px y el
  `scrollLeft`: no se vuelve a medir texto al desplazarse. Las medidas se rehacen al pintar, así que
  cambiar `#fuente-editor` no las deja viejas.

Convención, dicha una sola vez: **la columna del JSON está en runes y desde 1**; la traducción a
UTF-16 y a píxeles es del editor.

`apkc check` recibe cuatro banderas que la pestaña usa juntas:

- `--proyecto /proyecto`: enlaza `res/` en memoria (o usa la `R.java` que dejó el build) para que
  `R.layout.main` exista. Sin esto la `R` no viaja en el `android.jar` y el diagnóstico inventaba un
  error que la compilación nunca da.
- `--nombre MainActivity.java`: el temporal se llama `.apkc-check.java`; la posición tiene que decir
  el fichero real.
- `--sdk-version` y `--codename`: en la pestaña el jar está en `/sdk/android.jar` y su ruta no dice la
  versión del platform; son los mismos valores ocultos (`#sdk-version`/`#codename`) que lee
  `apkc build`.

El diagnóstico no pasa por `correr()`: no escribe en la consola ni cambia `#ultimo-codigo`, y
`prueba-pestana.js` lo comprueba junto con el caso de `R.layout.main` (§200). `diagnostico.js` no
participa en esto: pinta la salida pegada de `apkc`, no los errores del editor.

### Diagnóstico en vivo de XML

El mismo panel atiende los `.xml` del proyecto (`res/layout/*.xml`, `res/values/*.xml`,
`AndroidManifest.xml`), pero con **motor propio y local**: `diagnosticarXml` de `xml-editor.js`, sin
worker y sin `apkc check`. Un `.xml` no escribe el temporal `.apkc-check.java`, no lanza ningún
comando y no toca la consola; el debounce son los mismos **350 ms**. Qué comprueba:

- etiquetas sin cerrar y cierres que no casan (`cierra </A> pero estaba abierto <B>`);
- atributos sin valor y comillas sin cerrar;
- `@+id/…` repetido en el mismo fichero;
- `@string/…`, `@color/…`, `@layout/…` que no existen en el proyecto (los datos salen del mismo
  barrido de `recursos-proyecto.js` que usa el autocompletado; si el barrido no leyó nada, el
  estado lo dice en vez de acusar en falso; `@android:` y `@null` no se comprueban);
- atributos `android:` con errata **cuando hay un parecido a distancia ≤ 2** con uno conocido
  (`android:layout_widht` → `layout_width`). Un atributo desconocido sin parecido no se marca: la
  lista de atributos del módulo no es el framework entero y no se inventan errores.

`<![CDATA[ … ]]>`, los comentarios `<!-- … -->`, la cabecera `<?xml …?>` y las declaraciones
—también un `<!DOCTYPE … [ … ]>` con subconjunto interno— **no son marcado y no se tokenizan**: un
`<![CDATA[<b>text & stuff</b>]]>` es texto literal, no un `<b>` que abre y cierra. Lo que va fuera
del CDATA se sigue comprobando. `prueba.js` fija ese caso exacto.

Cada fila lleva delante su origen, `Java` o `XML` (`.origen-error[data-origen]`), y las marcas de
`#diagnostico-marcas` lo llevan en `data-origen`. **Los dos lenguajes no se mezclan**: cambiar de
fichero reemplaza la lista entera **en cuanto arranca la pasada nueva** (la lista y las marcas se
vacían al pasar a `comprobando…`, no cuando llega el resultado, así que una fila XML no se queda
sobre un `.java` durante el check), y una pasada vieja de `apkc check` no puede pintar su resultado
encima de la nueva (se invalida su serie). El estado acaba en `· Java` o `· XML`, y conserva el
formato `archivo:línea:columna` del §200: la columna del linter también va en **runes** y desde 1,
y el editor la traduce a UTF-16 y a píxeles como la de `apkc`.

## Explorador

El arbol vive en la barra lateral, no dentro del area de codigo:

```html
<aside class="lateral">
  <div class="lateral-cab">Explorador
    <span class="lateral-acciones">
      <button id="subir-arbol">...</button>
      <button id="recargar-arbol">...</button>
    </span>
  </div>
  <div class="lateral-proyecto" id="lateral-proyecto">MI APP</div>
  <div id="arbol-pestana" class="arbol-pestana" role="tree"></div>
  <div class="lateral-pie">/proyecto · OPFS <span id="aislacion">?</span></div>
</aside>
```

`refrescarArbol()` pide `hospedador.arbol()` al worker, filtra las rutas que empiezan por
`/proyecto/` y construye un mapa `padre -> hijos`. Dentro de cada carpeta ordena primero los
directorios y despues los ficheros por `localeCompare`. Cada fila es un `<a>` con:

| Atributo | Para que sirve |
| --- | --- |
| `data-ruta` | ruta completa; `prueba-crear.js` la usa para comprobar el package y el icono |
| `title` | ruta relativa, para verla al pasar el raton |
| `style.paddingLeft` | `8 + profundidad * 12` px; es la jerarquia visual |
| `class="dir"` / `class="archivo"` | icono y color |
| `class="activo"` | fila del fichero abierto |
| `draggable` | solo con puntero fino; en táctil se mueve con **Mover a…** |
| `class="arrastrando"` / `class="soltar"` | realimentación visual del arrastre |

Cada fila tiene tres piezas: la flecha (`.arbol-flecha`), el icono (`.arbol-icono`) y el nombre
(`.nombre`). Los ficheros añaden un `↓` (`.arbol-descargar`) que descarga esa entrada de OPFS sin
abrirla, también si es binaria. Las carpetas se pliegan con `ARBOL.abiertos`, un `Set` que
**empieza vacío**: el árbol arranca cerrado. `#plegar-arbol` lo vacía y `#desplegar-arbol` mete
todas las carpetas del proyecto; `revelarRuta()` abre los ancestros del fichero que se abre o se
mueve. Pulsar una carpeta alterna el `Set` y vuelve a pintar; pulsar un fichero llama a
`abrir(ruta)`.

`#filtro-arbol` filtra por subcadena (sin distinguir mayúsculas) y conserva la cadena de carpetas
del fichero que coincide; mientras hay filtro, las carpetas se pintan abiertas. `Ctrl+P` enfoca el
campo. `build/` y sus hijos llevan la clase `generado`, el color atenuado y la etiqueta
`generado` en la carpeta raíz: se puede abrir, pero se regenera en cada compilación.

`#subir-arbol` pide archivos con `#subir-ficheros` y los escribe en la carpeta del fichero
abierto, o en `/proyecto` si no hay ninguno. En el menú de una carpeta, **Subir archivos aquí** y
**Subir carpeta aquí** fijan el destino; el segundo usa el input `#subir-carpeta` con
`webkitdirectory` y conserva los subdirectorios vía `webkitRelativePath`. `subirSeleccion()`
pregunta una sola vez antes de reemplazar archivos existentes, escribe los bytes directamente en
OPFS y abre el resultado si solo se subió un fichero de texto y no había cambios pendientes.

Con el botón derecho o manteniendo pulsada una fila aparece `#menu-archivo`, un menú con
**Abrir** y **Descargar** (ficheros), **Nuevo fichero aquí**, **Subir archivos aquí** y **Subir
carpeta aquí** (carpetas), **Mover a…**, **Renombrar** y **Borrar**. Renombrar cambia el nombre en
la misma carpeta con `hospedador.renombrar` (host `renombrar` → `fs.rename`, sin copiar bytes) y
actualiza la pestaña si el fichero abierto es el renombrado o está dentro de la carpeta
renombrada. Borrar usa `hospedador.limpiar`; si se borra el fichero abierto, el editor vuelve a
`Sin fichero`.

Mover usa el mismo `fs.rename`: `moverRuta(origen, carpeta)` calcula el destino, rechaza mover
una carpeta dentro de sí misma y remapea `ARBOL.abiertos` y la ruta del fichero abierto. Con
ratón o lápiz las filas son `draggable` y las carpetas aceptan el `drop`; en táctil —donde el
arrastre nativo choca con el menú de mantener pulsado— se usa **Mover a…**, que pide la carpeta
destino y la valida contra el árbol real.

Si `/proyecto` esta vacio, el arbol pinta un estado vacio con un enlace a Inicio. Si OPFS no esta
disponible (por ejemplo, `http` sin COOP/COEP), `refrescarArbol()` captura el error y deja el estado vacio en
vez de reventar la pagina. `#recargar-arbol` vuelve a pedir el arbol sin recargar la pagina.

## Barra del fichero

La fila superior del editor separa la acción principal de las de mantenimiento:

- `#guardar-fichero` es el único botón primario y guarda con `Ctrl+S`.
- `#menu-editor` es un `<details>` con `#nuevo-fichero`, `#subir-ficheros-boton`,
  `#exportar-proyecto`, `#importar-proyecto` (y su `#importar-archivo` oculto),
  `#descargar-fichero`, `#renombrar-fichero` y `#borrar-fichero`. Se cierra al pulsar una acción,
  al hacer clic fuera o con `Escape`; no guarda estado propio.
- `#alternar-panel` se llama **Compilar**: abre `#panel-inferior` en la pestaña Compilar y lo
  cierra si ya está abierto. ``Ctrl + ` `` sigue alternando el panel y conserva la pestaña activa.
  La pestaña de salida se llama **Consola** y lleva el icono de terminal.
- `#descargar-fichero` sigue oculto hasta que hay un fichero abierto; descarga el buffer del
  editor (aunque tenga cambios sin guardar), no solo lo último guardado.

## Pestañas y persistencia

El editor ya no tiene un solo documento. `DOCUMENTOS = { lista, activa }` guarda por pestaña
`{ ruta, texto, sucio, cursor, scroll }`:

- `abrir(ruta)` añade la pestaña si no existe y activa; si ya existe, solo cambia a ella. Cambiar
  de pestaña **no descarta** cambios: cada una conserva lo suyo.
- `activarDocumento()` guarda el texto de la pestaña anterior si está sucia, suelta el de una
  limpia (`texto = null`) y, si hace falta, lee OPFS en ese momento. Así restaurar diez ficheros
  solo lee el que se ve; los demás se cargan al pulsarlos.
- `#pestanas-archivo` se repinta en `renderPestanas()`. La pestaña activa lleva los ids
  `#fichero-abierto` y `#marca-sucio`; las demás usan `.editor-tab-nombre` y `.marca-sucio`. El
  botón `×` cierra (con confirmación solo si hay cambios) y, si era la activa, abre la vecina.
- `PERSISTENCIA = "apkc-studio/editor-v1"` guarda en **sessionStorage** las rutas de las pestañas,
  la activa y `ARBOL.abiertos`: cada ventana tiene su vista y no pisa la de otra. **No guarda
  contenido**: al recargar, un fichero sucio se relee de OPFS; el undo tree es la red de rescate.
- `guardarEnMemoria()` conserva texto sucio, cursor y scroll por pestaña; una pestaña limpia se
  puede reconstruir desde OPFS y no ocupa memoria.
- `activacion` es un contador de turno: si una lectura lenta termina después de que se pulse otra
  pestaña, no pisa el editor.
- `cargandoDocumento` cuenta las activaciones en vuelo: la pestaña activa se marca antes de leer
  OPFS para que responda aunque la lectura quede en cola detrás de un build, y mientras el contador
  esté alto `guardar()` no escribe (lo dice en la barra). Sin ese bloqueo, un `Ctrl+S` en esa
  ventana guardaba el buffer del fichero anterior en la ruta nueva (F1).
- `VENTANA` es un id estable en sessionStorage; indexa el undo tree en IndexedDB.

### Undo tree

`historial.js` guarda un árbol por documento. Cada nodo tiene padre, hijos, autor, selección y
scroll; el primer nodo guarda el texto completo y los siguientes un **delta** contra el padre
(`{i, b, s}`), con un **checkpoint** cada 24 niveles o cuando el delta es enorme. Reconstruir un
nodo es subir hasta el checkpoint y aplicar deltas.

- `Ctrl+Z` va al padre; `Ctrl+Shift+Z`/`Ctrl+Y` al último hijo. Si deshaces y escribes, se crea una
  rama nueva y la anterior queda en el árbol.
- Una pausa de tecleo de 500 ms agrupa la edición en un nodo; guardar, cambiar de pestaña, perder
  el foco o cerrar la página vuelca lo pendiente.
- `panel-historial` pinta el árbol con hora, autor (`local`/`remoto`), delta y nodo actual. Un clic
  restaura ese nodo sin borrar los demás. `#historial-deshacer`, `#historial-rehacer` y
  `#historial-limpiar` son las acciones.
- Persistencia: IndexedDB `apkc-studio-historial`, clave `VENTANA|ruta`; se guarda con debounce y
  se carga solo al activar el documento. Límite de 240 nodos y 4 MB; `podar()` quita hojas
  antiguas y `rebase()` re-enraíza una cadena demasiado larga en un checkpoint.
- Un fichero que cambió en OPFS desde otra ventana entra como nodo `remoto`; el editor muestra el
  texto del disco y la rama local queda en el historial.

### Temas

`temas.js` aplica `data-tema` y `data-tema-consola` en `<html>` y guarda la elección en
`localStorage` (preferencia compartida por las ventanas). `style.css` define las variables por
tema: Oscuro, Catppuccin Mocha, Rosé Pine, Tokyo Night y Gruvbox; y paletas ANSI Catppuccin,
Rosé Pine, Gruvbox, Solarized Dark y Dracula. El menú `#menu-apariencia` de la barra de estado
tiene los dos selectores `#tema-ui` y `#tema-consola`. No hay hojas externas.

### Varias ventanas

- `VENTANA` identifica la pestaña del navegador; la vista (tabs, activa, `ARBOL.abiertos`) va en
  `sessionStorage`, no en `localStorage`.
- Cada mutación pasa por `conBloqueo()` (`navigator.locks.request("apkc-studio:/proyecto")`), de
  modo que dos ventanas no interleaven escrituras. Si Web Locks no existe, se ejecuta directo.
- `guardar()` guarda una revisión en `localStorage` (`apkc-studio/rev/<ruta>`), la pone en el
  documento y publica `{tipo:"guardado"}` por `BroadcastChannel`. Si la revisión del disco ya no
  es la del documento, pide confirmación antes de sobrescribir.
- `publicar()` avisa también de `crear`, `subir`, `renombrar`, `mover`, `borrar` y `proyecto`.
- Cada documento guarda `base`: el texto de la última versión de OPFS. Al guardar o recargar se
  actualiza.
- `recibirRemoto()` ignora su propia `VENTANA`, refresca el espejo del worker
  (`hospedador.refrescar`) y compara `base`, el buffer local y el remoto con `fusionar()`:
  - sin cambios locales, recarga el remoto;
  - sin cambios remotos, conserva el local;
  - cambios en líneas distintas, **fusión automática** y el documento queda sucio para revisar;
  - cambios en las mismas líneas, **conflicto** con `#conflicto-aviso`: **Mantener el mío**,
    **Usar el remoto** o **Marcar conflicto** (marcas `<<<<<<<` / `=======` / `>>>>>>>`).
- La fusión es de tres vías por líneas (`fusion.js`), sin CRDT ni servidor. En ficheros de más de
  2000 líneas cae a conflicto explícito. Un borrado remoto conserva las pestañas sucias y marca
  `remotoEliminado`.

### Sin red

`main.js` importa `offline.js`, que registra `sw.js` por http(s). El worker cachea el shell en la
instalación e intenta cachear `apkc.wasm`/`wasm_exec.js`; si fallan, los cachea la primera vez que se piden; no toca `/android-jar`, los
keystores ni OPFS. Las respuestas cacheadas conservan COOP/COEP, así que una recarga offline sigue
siendo `crossOriginIsolated`. `prueba-pestana.js` comprueba la recarga con la red emulada apagada.

## El editor de codigo

La pieza central son tres capas superpuestas:

```html
<div class="editor">
  <pre id="numeros" class="numeros"></pre>
  <div class="capas">
    <pre id="resalto" class="resalto" aria-hidden="true"></pre>
    <textarea id="codigo" spellcheck="false" wrap="off"></textarea>
  </div>
</div>
```

- `#codigo` es el unico elemento editable. Tiene el texto transparente
  (`color: transparent; -webkit-text-fill-color: transparent`) y el cursor visible
  (`caret-color: #fff`). El texto real lo pinta `#resalto` debajo.
- `#resalto` recibe el HTML de `resaltar()`. Es `pointer-events: none` para que el raton siga
  llegando al textarea.
- `#numeros` pinta la columna de numeros. Su ancho se calcula en `EDITOR.numeros()` como
  `calc(Nch + 18px)`, donde `N` crece con el numero de lineas y 18 px son los paddings.

Las dos capas comparten las métricas (`font`, `line-height`, `padding`, `tab-size` y
`white-space: pre`). `EDITOR.sincronizar()` copia `scrollTop` y `scrollLeft` del textarea a
`#resalto`, y `scrollTop` a `#numeros`. Las tres capas son contenedores con scroll propio; la
primera versión trasladaba las capas con `transform`, pero el `<pre>` recortaba su contenido al
alto visible y al moverlo hacia arriba no quedaba nada pintado: a partir de la primera pantalla
el editor se veía vacío y parecía que el scroll no funcionaba. Un `ResizeObserver` sobre
`.editor` repite la sincronía cuando el panel inferior cambia el alto. La rueda sobre la columna
de números se reenvía al textarea, y pulsar en el margen devuelve el foco al código.

`EDITOR.pintar()` hace dos cosas: `resaltar(texto, modo)` y `EDITOR.numeros(texto)`. El modo es
`xml` cuando `esXml()` ve un `<?xml`, un `<manifest`, o —quitando BOM, espacios y comentarios—
el texto empieza por una etiqueta; si no, `java`. Esa última condición importa: un fuente Java
con genéricos (`List<String>`) no puede confundirse con XML. El resaltador es léxico, no un
parser:

- Java: palabras clave, anotaciones (`@Override`), números, literales de `char`, cadenas entre
  comillas y comentarios `//` y `/* ... */`.
- XML: comentarios, etiquetas, atributos y valores entre comillas.
- Los literales no cruzan de línea: una comilla sin cerrar no se come el resto del fichero.

`EDITOR.poner(texto)` es la entrada única para cargar un fichero: escribe el valor, deja el
cursor al principio, reinicia el scroll de las tres capas, pinta y marca el documento como
limpio. `EDITOR.texto()` devuelve el valor actual.

### Teclado

| Tecla | Qué hace |
| --- | --- |
| `Tab` | con selección, indenta las líneas; sin selección, inserta 4 espacios en el cursor |
| `Shift+Tab` | con selección, desindenta las líneas; sin selección, quita la sangría de su línea |
| `Enter` | conserva la sangría de la línea; si la línea termina en `{`, añade 4 espacios |
| `Ctrl+S` / `Cmd+S` | guarda el fichero abierto, tenga el foco donde tenga |
| `Ctrl+Enter` / `Cmd+Enter` | repite el último comando de `apkc` |
| ``Ctrl + ` `` | abre o cierra la consola inferior |

Las tres ediciones programáticas (Tab, Shift+Tab y Enter) pasan por `EDITOR.cambiar()`, que usa
`execCommand("insertText")` cuando existe para que entren en el historial nativo de deshacer
(`Ctrl+Z`); si el navegador no lo soporta, cae a `setRangeText` y solo se pierde el deshacer de
esa edición. `e.isComposing` se comprueba antes de tocar Tab/Enter, para no romper la composición
de un IME. La selección del textarea usa un azul con alfa (`rgba(38, 79, 120, .55)`) para que el
texto del `<pre>` se siga leyendo mientras se selecciona. `#estado-cursor` muestra `Ln`/`Col` en
la barra de estado y se actualiza al teclear, al hacer clic y con `selectionchange`.

### Autocompletado

`autocompletado.js` completa **recursos del proyecto** y **nombres de API del `android.jar`** sin
salir del origen. Se abre al teclear; en un fichero `.java` (recursos y jar) y en un `.xml` del
proyecto (etiquetas, atributos, valores y referencias) con **dos contextos separados**. En texto
plano no toca Tab.

| Id | Papel |
| --- | --- |
| `#autocompletado` | la caja flotante (`hidden` hasta que hay algo que enseñar), hermana de `#codigo` dentro de `.capas` |
| `#autocompletado-lista` | `role="listbox"`; cada opción es un `<button role="option">` con id `autocompletado-opcion-<i>` y `aria-selected` |
| `#autocompletado-estado` | `role="status"`: cuántas sugerencias hay, de dónde salen o qué falta (`android.jar`), y el recordatorio de Tab/Esc |

- **Recursos.** `R.` ofrece los tipos declarados; `R.layout.` (o `R.string.`, `R.id.`…) sus
  nombres. Salen de `res/values*/*.xml` (etiquetas con `name`, incluido `<item type="id">`), de
  los ficheros de `res/layout`, `drawable`, `mipmap`, `menu`, `xml`, `raw`, `anim`, `color`,
  `font`… (con calificadores y `.9.png`), de los `@+id/` de los XML y de la `R.java` que deja el
  build en `src/<package>/R.java`. El barrido se guarda y **no se recorre OPFS por tecla**: lo
  invalidan `guardar`, crear, importar, mover, borrar y los cambios de otra ventana
  (`apkc:proyecto-cambio`, que publica `pestana.js`); `refrescar()` sigue existiendo para forzarlo.
- **API.** Al escribir una clase con mayúscula (`Acti`) se completan las clases del jar, los tipos
  del proyecto (`/src/…/Foo.java`, sin abrir ni parsear los ficheros) y los declarados en el
  buffer; con `View.` se listan sus métodos públicos, leídos del `.class` bajo demanda, y `v.` los
  del tipo declarado de `v` en el propio buffer (`TextView v = null; v.`). Del jar **no
  se descarga ni se copia nada**: `hospedador.rango` pide el final del fichero (EOCD), después el
  directorio central y, solo al abrir una clase, su entrada comprimida
  (`DecompressionStream("deflate-raw")`). Todo sale de `/sdk/android.jar` en OPFS. Sin jar, los
  recursos funcionan igual y el estado dice con claridad que falta el jar.
- **Teclado.** `Tab` acepta la opción resaltada, `Esc` cierra y `↑`/`↓` recorren. El manejador
  está en captura sobre `#codigo` y corta la propagación: con la lista abierta, `Tab` no indenta
  y `Shift+Tab` sigue desindentando. No toca `Ctrl+S`, `Ctrl+F`, `Ctrl+H`, `Ctrl+P`, `Ctrl+G`,
  `Ctrl+Mayús+P` ni ``Ctrl + ` ``.
- **Undo tree.** Aceptar es un solo `EDITOR.cambiar(desde, hasta, texto, selección)`: la
  inserción entra en el deshacer nativo y el documento queda sucio una vez. No se escribe
  `value` a mano.
- **Diagnóstico en vivo.** Mover la lista o cerrarla no dispara `apkc check`; aceptar produce un
  solo cambio, no uno por letra de la sugerencia.
- **Fronteras.** El contexto se detecta dentro de bloques `/* … */` de varias líneas y de bloques
  de texto `""" … """`; un `v.` sin declaración en el buffer no ofrece lista (el tipo de un campo
  heredado de otra clase no se adivina). Dos clases del jar con el mismo nombre simple resuelven a
  la de `android.*`. La lista se corta en 50 opciones y lo dice. `Tab` con la lista vacía (solo el
  aviso del jar) sigue siendo la sangría del editor.

### Autocompletado

`autocompletado.js` abre una lista con lo que se puede escribir tras un punto, sin red y sin
dependencias. Los datos salen de dos sitios que ya están en el propio origen:

- **el proyecto**: `res/` (los nombres de fichero dan `R.layout`, `R.drawable`…; los `<string>`,
  `<color>`, `<style>`… de `res/values` y los `@+id/` de los layouts dan los nombres) y la
  `R.java` que dejó el build, si está. Los tipos y los nombres se recalculan al guardar, crear,
  renombrar o borrar un fichero de `res/`/`.java`, al importar un proyecto y con
  `AUTOCOMPLETADO.refrescar()`; un `.java` no obliga a repetir el barrido de `res/`.
- **el `android.jar` de OPFS**: las clases salen de su **directorio central** y los métodos, del
  `.class` de la clase que se está completando, descomprimido en la página con `deflate-raw`. El jar
  no se baja ni se copia: se leen por rango su cola (EOCD) y su directorio central —1,35 MB de los
  26,3 MB del jar en la medición del §200— y, para los métodos, una entrada.

Ids y contrato:

| Id / selector | Papel |
| --- | --- |
| `#autocompletado` | la caja; `hidden` cuando no hay nada que sugerir. Se coloca bajo la línea del cursor |
| `#autocompletado-lista` | las opciones, una por `<li>` con un `<button class="autocompletado-opcion">` |
| `#autocompletado-opcion-N` | id de cada opción (0, 1, 2…), con la clase `activa` en la resaltada y `aria-selected` |
| `#autocompletado-estado` | de dónde salen: `recursos del proyecto · N tipos`, `R.layout · N nombres`, `clases del android.jar y del proyecto · N`, `métodos de android.view.View · N` |

Cada opción pinta el texto a completar en un `<code>` (primer hijo) y una pista al lado (el número de
nombres, la ruta de la clase o el descriptor). `window.AUTOCOMPLETADO` expone `refrescar()`,
`recursos()`, `cargarJar()`, `medida()` y `textoSinJar()` para las pruebas por CDP y la consola de desarrollo; no
es la fuente de verdad del módulo.

Teclado: `Ctrl+Espacio` abre la lista; `↑`/`↓` recorren, `Tab`/`Enter` aceptan (el cambio pasa por
`EDITOR.cambiar`, así que entra en el deshacer) y `Esc` cierra sin tocar el texto. Con la lista
abierta, las demás teclas pasan de largo: `Ctrl+Mayús+P` abre la paleta y `Ctrl+G` pide la línea.
El detector de contexto, el lector del zip y el del `.class` están en `autocompletado-datos.js`, que
es puro y se prueba en `prueba.js`.

Límites escritos: `v.`/`this.v.` resuelven el tipo por la declaración que haya en el buffer (local,
parámetro o campo de la misma clase); si el tipo solo se declara en otro fichero o lo hereda una
superclase, no se inventa la lista. Un recurso sin guardar no forma parte del proyecto y no aparece
hasta guardar o `refrescar()`; el `@+id` del buffer sí cuenta.

### Autocompletado de XML

La extensión del fichero activo elige la rama, y **no se cruzan**: en un `.xml` nunca sale `R.` ni
una clase Java, y en un `.java` nunca sale una etiqueta XML. El detector de contexto es
`contextoXml` (en `xml-editor.js`, separado del `contextoDeCompletado` de Java) y distingue cuatro
posiciones dentro de una etiqueta, con `desde`/`hasta` sobre el textarea:

| Lo que se escribe | Qué sugiere | El estado dice |
| --- | --- | --- |
| `<TextVie` | etiquetas Android | `xml · etiquetas de vista · N` |
| `android:te` (o `textS` sin prefijo) | atributos `android:*` y `tools:*` | `xml · atributos de vista · N` |
| `android:layout_width="wrap` | valores enumerados (`match_parent`, `wrap_content`, `center`, `visible`/`gone`…) | `xml · valores de android:layout_width · N` |
| `android:text="@string/ap` | nombres del proyecto de ese tipo | `xml · @string · N nombres` |

- Las etiquetas cambian con el fichero: un `res/values` ofrece `<string>`, `<color>`, `<item>`…, el
  manifiesto ofrece `<uses-permission>`, `<activity>`… y un layout, vistas.
- Los atributos se insertan completos (`android:textSize`) aunque se busquen por su nombre local; un
  `android:` mal escrito se completa por el nombre completo, sin duplicar el prefijo.
- Las referencias salen del mapa de `recursos-proyecto.js` (el mismo del autocompletado Java), más
  los `@+id` del buffer aunque no se hayan guardado. Los colores se ofrecen como `@color/…` y los
  atributos de color (`background`, `textColor`, `tint`…) enlazan con ellos.
- Aceptar con `Tab`/`Enter` pasa por `EDITOR.cambiar`, igual que en Java: entra en el deshacer del
  documento XML y no toca el de otro fichero. Esc y las flechas se comportan igual.
- `#autocompletado-estado` empieza por `xml` en esta rama para que no se confunda con la lista Java.
- Un `res/values` solo ofrece atributos sin prefijo (`name`, `type`, `value`…): `android:` no se
  escribe como atributo en `values`.
- Límites: no se completa dentro de comentarios, de `<?xml …?>` ni de un cierre `</…>`; un valor
  `@tipo/` de un recurso que aún no se ha guardado no aparece hasta guardar o `refrescar()`; y un
  atributo `android:` desconocido que no se parece a ninguno del catálogo no se acusa (el catálogo
  no es el `frameworks` entero).

### Estado del fichero

- `#fichero-abierto` muestra la ruta **relativa** a `/proyecto`; su `title` guarda la ruta
  completa. Si no hay fichero, dice `Sin fichero`.
- `#marca-sucio` es el punto amarillo de la pestaña; `marcarSucio(true)` lo muestra y
  `marcarSucio(false)` lo esconde. Se marca al teclear, indentar, pegar o entrar, y se limpia al
  guardar o al cargar otro fichero. `beforeunload` avisa antes de cerrar la pestaña con cambios.
- `abrir(ruta)` pregunta antes de descartar cambios (`confirmarDescartes`), lee los bytes con
  `hospedador.bytes` (un error del fs se anuncia en la barra, no se convierte en un fichero
  vacío), los decodifica como UTF-8 y llama a `EDITOR.poner`. Si se abre desde el explorador y
  la vista activa no es Editor, salta a Editor.
- `guardar()` pide una ruta si no hay ninguna, escribe los bytes con `hospedador.escribir`,
  actualiza el estado y refresca el árbol. Solo marca limpio si el texto sigue siendo el que se
  escribió: si se tecleó mientras el worker guardaba, el documento sigue sucio.
- `nuevo-fichero` pide una ruta con `nuevoNombre()`. El valor por defecto sale del package del
  formulario (`/proyecto/src/<package>/MainActivity.java`), la ruta se ancla a `/proyecto`, se
  normalizan `.` y `..`, y se avisa si el fichero ya existe. Después crea el fichero vacío en
  OPFS para que el explorador lo muestre, vacía el editor y pone el foco.

Todo el contenido vive en OPFS a traves del worker `hospedador.js`; la pagina no envia el fuente a
ningun servidor.

## Panel inferior

El **panel inferior** (`#panel-inferior`) es la zona de salida, historial y acciones pesadas.
Empieza cerrado para que el editor ocupe todo el alto; `#alternar-panel` lo abre en **Compilar**
o lo cierra, y ``Ctrl + ` `` conserva la pestaña activa.

```html
<div class="panel-inferior" id="panel-inferior" hidden>
  <div class="panel-tabs">
    <button class="panel-tab activo" data-panel="salida">Consola</button>
    <button class="panel-tab" data-panel="historial">Historial</button>
    <button class="panel-tab" data-panel="compilar">Compilar</button>
    <button class="panel-tab" data-panel="firmar">Firmar otra apk</button>
    <button class="panel-tab" data-panel="deps">Dependencias</button>
    <span id="estado-pestana"></span>
    <button id="cerrar-panel">...</button>
  </div>
  <div class="panel-descargas" id="panel-descargas" hidden>...</div>
  <div class="panel-cuerpos">
    <div id="panel-salida" class="panel-vista activa"><pre id="consola-pestana"></pre></div>
    <div id="panel-historial" class="panel-vista">...</div>
    <div id="panel-compilar" class="panel-vista">...</div>
    <div id="panel-firmar" class="panel-vista">...</div>
    <div id="panel-deps" class="panel-vista">...</div>
  </div>
</div>
```

- `mostrarPanel(nombre)` quita `hidden`, marca la pestana `data-panel=nombre` y ensena la vista
  `#panel-nombre`. Si el nombre es `historial`, llama a `renderHistorial()`.
- `#panel-historial` pinta el undo tree del documento activo. `#historial-deshacer`,
  `#historial-rehacer` y `#historial-limpiar` son sus acciones; el menú **Archivo → Historial…**
  y `#abrir-historial` abren esta pestaña.
- `alternarPanel()` abre o cierra el panel; si lo abre, vuelve a la pestana activa.
- `cerrarPanel()` lo esconde y deja `aria-expanded="false"` en el boton `#alternar-panel`.
- `correr(argv)` abre siempre la pestaña Consola, escribe `$ apkc ...`, muestra `#ocupado` y
  `#detener-comando` mientras el worker trabaja, actualiza `#ultimo-codigo` y refresca el arbol al
  terminar. La salida llega por trozos (`hospedador.escucharSalida`), así que se pinta mientras el
  comando corre y la última línea se enseña como fase en `#ocupado`; **Detener** termina el worker
  (`hospedador.cancelar`) y el siguiente comando arranca otro. La
  consola no usa `textContent` directo: `CONSOLA` guarda el texto y `consolaHtml()` convierte los
  códigos ANSI (`\u001b[34m...\u001b[0m`) en `<span class="consola-fg-4">`; las demás secuencias
  CSI se descartan. `enlazarSalidas()` convierte `ruta:línea` en un `<a class="salto">` que
  `saltarALinea()` resuelve abriendo el fichero e `irALinea()` seleccionando esa línea. Así se ven los colores de `apkc` y no los códigos crudos. La paleta de
  `.consola` sale de `--ansi-0..15` y se cambia con `#tema-consola` (Catppuccin por defecto;
  también Rosé Pine, Gruvbox, Solarized Dark y Dracula).
- `#panel-descargas` es una barra encima de las vistas, visible en todas las pestanas. `descargar()`
  y `ofrecerDescarga()` ponen allí los enlaces de `app.apk`, su `.idsig` y los de la firma de una
  apk existente, con nombre y tamaño; así la descarga no se queda escondida en Compilar. El enlace
  `#descargar-fichero` de la fila de pestañas descarga el buffer abierto (aunque no esté guardado).
- `#cargando` es un velo con una rueda (`conCarga(texto, tarea)`) para las operaciones que no son
  compilar pero tardan: leer el apk para el blob, sacar `android.jar` de un `.zip`, abrir un
  fichero grande o descargar el jar del SDK. Solo aparece si la tarea pasa de 120 ms, y se retira
  en `finally`, también cuando falla.
- `#panel-compilar` empieza por las acciones (`#compilar-debug`, `#compilar-apk`,
  `#verificar-apk`, `#descargar-debug-keystore`) y deja el resto en desplegables:
  `#detalle-ajustes` (`#ajustes-minsdk`, `#ajustes-targetsdk`, `#ajustes-versioncode`,
  `#ajustes-versionname`, `#leer-ajustes`, `#guardar-ajustes`, `#estado-ajustes`; avisa si
  targetSdk < 34 y aplica los ajustes sobre el buffer del manifiesto si está abierto, no sobre la
  copia de OPFS, para no pisar cambios sin guardar), `#detalle-sdk`
  (`#abrir-dialogo-sdk`, `#dialogo-sdk`, `#sdk-entiendo`, `#sdk-terminos`, `#sdk-descarga`,
  `#sdk-elegir-archivo`, `#sdk-usar-servidor`, `#sdk-cerrar`, `#traer-android-jar`,
  `#estado-jar-sdk`, `#android-jar`, `#usar-android-jar`, `#estado-jar`), `#detalle-release`
  (`#keystore-compilar`, `#storepass-compilar`, `#keyalias-compilar`) y opciones avanzadas
  (`#api-version`, los ocultos `#sdk-version`/`#codename`, `#v4-compilar`). `#api-version` es el
  selector visible, 34 por defecto; al cambiar sincroniza los dos campos que lee `apkc build`.
  En una página estática, el diálogo exige marcar el acuse antes de habilitar los enlaces a los
  términos y a la descarga oficial de Google; no descarga nada por su cuenta y el editor extrae
  `android-34/android.jar` del `.zip`. El `.jar` suelto también vale. Con `servidor.js`, el botón «Traer el del SDK local» y
  el primer compilar piden `/android-jar` al mismo origen. El jar nunca se versiona en el repo.
- `decirEstadoJar()` marca `#detalle-sdk` con `.jar-listo`, muestra `#sdk-badge` como **listo**,
  cambia `#abrir-dialogo-sdk` a **Cambiar android.jar** y pliega el desplegable cuando el jar ya
  está en OPFS. Así la sección no vuelve a pedir atención en cada visita.
- `#buscar-barra` es del editor: `#buscar-texto`, `#reemplazar-texto`, `#buscar-anterior`,
  `#buscar-siguiente`, `#reemplazar-uno`, `#reemplazar-todos`, `#buscar-cerrar` y
  `#buscar-estado`. `Ctrl+F`/`Ctrl+H` la abren, `Enter`/`Shift+Enter` recorren y `Esc` la cierra;
  reemplazar pasa por `EDITOR.cambiar`, así que entra en el undo tree.
- `Ctrl+G` pide una línea y llama a `irALinea()`; `Ctrl+P` enfoca `#filtro-arbol`.
- `#fuente-editor` cambia `--ed-fuente` (12, 13, 14 o 16 px) y lo guarda en
  `apkc-studio/fuente-editor`. Las filas del árbol llevan `tipo-java`, `tipo-kt`, `tipo-xml` o
  `tipo-png`, que colorean el icono.
- `#compilar-debug` no lee el keystore de release: la primera vez llama a
  `apkc debug-keystore`, que escribe `/sdk/debug.keystore` (alias `androiddebugkey`,
  contraseña `android`, `CN=Android Debug`) y lo reutiliza en las siguientes compilaciones.
  `#compilar-apk` sigue siendo el camino release con keystore y contraseña.
- `#crear-clave-release` abre `#dialogo-clave`. El formulario pide alias, CN, organización, país,
  contraseña y confirmación; un aviso obligatorio explica que perder la clave impide actualizar la
  app. Al generar, `apkc create-keystore` escribe `/sdk/release.keystore` (JKS), la página descarga
  `<alias>.jks`, rellena `#storepass-compilar`/`#keyalias-compilar` y pasa al paso **Clave
  creada**, que no deja cerrar hasta marcar que se guardó una copia. No se persiste la contraseña.
  `decirEstadoClave()` deja `#detalle-release` plegado con `.jar-listo`, `#clave-badge` y el botón
  **Cambiar clave de release** cuando el fichero ya existe.
- `#panel-firmar` conserva los ids de firma y rotacion: `#keystore`, `#storepass-firmar`,
  `#keyalias-firmar`, `#apk-a-firmar`, `#firmar-aqui`, `#keystore-viejo`, `#storepass-viejo`,
  `#keyalias-viejo`, `#rotation-min-sdk`, `#usar-rotacion`, `#crear-linaje`, `#olvidar-linaje` y
  `#estado-linaje`.
- `#panel-deps` es la sección de **Dependencias**, aparte de Consola, Diagnóstico,
  Historial, Compilar y Firmar. Tiene dos vías y ninguna habla con Maven. La primera importa un
  artefacto publicado en el propio origen: sus ids son `#deps-coordenada` (por defecto
  `com.google.code.gson:gson:2.10.1`, de ejemplo), `#deps-resolver`, `#deps-estado`,
  `#deps-resultado`, `#deps-nombre`, `#deps-bytes`, `#deps-hash`, `#deps-ruta` y `#deps-indice`.
  `crearPanelDeps()` de `deps.js` solo engancha el botón y el Enter del campo: al cargar y al
  compilar no se pide nada. Al pulsar, `deps.js` lee `./deps-index.json` **del propio origen**,
  busca la coordenada, descarga `./deps/<grupo>/<artefacto>/<versión>/<fichero>` también del
  origen, comprueba tamaño y SHA-256 contra el índice y solo entonces escribe en OPFS bajo
  `/deps/`, con un `deps.json` al lado (coordenada, fichero, bytes, sha256, fecha del índice).
  Ningún `.pom`, `.aar` o `.jar` se pide a Maven: ese paquete lo genera el workflow
  `.github/workflows/deps-maven.yml` en el runner y se sirve estático. Si el índice no existe,
  `#deps-estado` lo dice y manda al workflow; no se inventan coordenadas ni hashes. La sección no
  resuelve el grafo: importa lo que el índice publicó, sin transitivas.
  La segunda vía es **local y sin red**: `#deps-ficheros` (`.jar`/`.aar` múltiples) o soltar un
  `.zip` en `#deps-soltar`; el progreso va en `#deps-progreso`, el aviso en `#deps-importar-estado`
  y el resultado en `#deps-importado` (`#deps-importado-ficheros`, `#deps-importado-bytes`,
  `#deps-importado-destino`, `#deps-importado-descriptor`). El `.zip` se lee con `leerZip` (CRC y
  rutas seguras) y solo se aceptan `jar/*.jar`, `lib/<abi>/*.so` y
  `res/__deps/<isla>/<tipo>/<archivo>`; un `.aar` se abre igual y se reparte en esas tres carpetas
  (`classes.jar` y `libs/*.jar` a `jar/`, `jni/<abi>/*.so` a `lib/<abi>/`, `res/**` a
  `res/__deps/<isla>/`). Los bytes se escriben en OPFS bajo `/proyecto/` dentro de `conBloqueo`, se
  pregunta antes de reemplazar y el sha256 de cada fichero queda en `/proyecto/deps.importado.json`.

Las acciones concretas de compilar y firmar se documentan en `studio/README.md` y en
`docs/evidencia.md` (§44-§47, §55, §117-§136). Este documento solo cubre la interfaz.

## Barra de estado

La barra azul (`#007acc`, como la de VS Code) muestra `#estado-general` (Inicio o Editor), la rama
`main`, `#estado-cursor` (`Ln`/`Col`), `#ultimo-codigo`, y la firma de la página:
`apkc.wasm · OPFS · UTF-8`. `#estado-pestana` vive en la cabecera del panel; `vistas.js` lo copia a
`#estado-pestana-cab` con un `MutationObserver`, para que el mensaje se vea aunque el panel esté
cerrado. `#ocupado` está en la fila de la pestaña del fichero y solo aparece mientras corre un
comando; `correr()` garantiza que se esconde también cuando el hospedador falla.

## Pantallas estrechas

En `@media (max-width: 760px)`:

- `.cuerpo` pasa a dos columnas (44 px de actividad y el resto) y dos filas (9rem de explorador y
  el resto). La barra de actividad ocupa las dos filas.
- El explorador queda como una tira superior con scroll propio; el pie del explorador se oculta.
- El panel inferior pasa a `42vh`.
- La pestaña del fichero se limita a `22ch` para que Guardar, Archivo y Compilar sigan cabiendo.
- La barra de titulo oculta el estado de la derecha.

## Pruebas

| Comando | Que cubre |
| --- | --- |
| `node studio/prueba.js` | genera el zip, comprueba EOCD, plantillas, reglas, ids de `index.html` (de `diagnostico.js`, `temas.js`, `historial.js`, `vista-previa.js`, `previa-panel.js`, `autocompletado.js`, `diagnostico-vivo.js`), ids viejos prohibidos, sin `<pre>` en el panel, el resaltador puro, el modelo del layout dibujado en vivo, los datos del autocompletado (recursos, `R.java`, contexto y lector de zip/.class), el XML del editor (contexto, catálogo, linter con columna en runes), las funciones puras de los tiradores y las del editor de layout (`leerPropiedades`/`escribirPropiedad`, colores, paleta y `cambiarTipoRaiz`), y el bucle de los **18 tipos** de la paleta: cada uno entra como el tipo pedido, solo (los contenedores sin hijos) y con el tamaño de `tamanoDeTipo` |
| `node studio/prueba-navegador.js` | `http` sin COOP/COEP: DOM, tres vistas, tres botones de actividad, reflejo del nombre/package, aviso de que no hay OPFS, localStorage, el diagnóstico, los temas y la paleta ANSI, y el contrato de la vista dividida (separador con teclado, alternancia Vista previa/Emulador, los dos modos y la consola de Pantalla, que no haya `<pre>` con el XML y consola vacía con su motivo) |
| `APKC_WASM=... node studio/prueba-crear.js` | por http con OPFS: crear, escribir el proyecto, abrir el manifiesto, comprobar `data-ruta` del arbol, API 34, el árbol cerrado, subir/mover ficheros, exportar/importar el `.zip`, ajustes, pestañas, undo tree, dos ventanas y fusión/conflicto |
| `APKC_WASM=... APK_EJEMPLO=... KS_EJEMPLO=... ANDROID_JAR=... node studio/prueba-pestana.js` | la pestaña completa: editar, guardar, recargar, jar del SDK, compilar debug/release, firmar, verificar, recargar sin red, cero peticiones fuera del origen, autocompletado y linter XML separados del Java, vista dividida con ocho tiradores por marco, compilar→pintar sin mover el cursor, layout dibujado en vivo, Vista previa/Emulador en las dos superficies, consola con `<script>` escapado y nodo sin rótulo de tipo/id; el **modo editar** (paleta flotante con scroll, arrastre con una sombra del tamaño del nodo que se inserta y recortada al canvas, 7 tipos que entran como el tipo pedido —contenedores vacíos—, undo del diseñador, basura, jerarquía con «↑ Padre», ficha de propiedades, imágenes y `contentDescription`) sin cambiar `clientWidth/clientHeight` del canvas; y que **recompilar recarga el Emulador** (SHA del apk distinto, modelo nuevo, evento publicado otra vez) y **compilar guarda antes lo sucio** (el layout tecleado sin `Ctrl+S` llega al apk y al modelo) |
| `APKC=... APKC_WASM=... sh studio/e2e.sh` | todo lo anterior más los apk/aab nativos y la plantilla Contador; el número exacto de comprobaciones se mide en cada gate |

El gate completo de la pagina es `e2e.sh`; `prueba-pestana.js` solo no basta para decir que la
pagina funciona. Los comandos de entorno estan en `tools/entorno.sh` (`test`, `wasm`, `gate`).

## Como abrirlo en Brave Nightly

Con `servidor.js` escuchando en `127.0.0.1:8787`, el comando y las trampas del entorno Android
estan en `studio/README.md` y en `docs/evidencia.md` §140. En resumen: se copian
`BOOTCLASSPATH` y `DEX2OATBOOTCLASSPATH` del `environ` de `zygote64` y se lanza
`com.brave.browser_nightly/org.chromium.chrome.browser.ChromeTabbedActivity` con
`android.intent.action.VIEW`. No se usa `cmd activity`: en este aparato falla con
`Failed transaction`.

## Limites conocidos

- **La vista dividida es de una sola pareja.** El editor y el teléfono comparten fila; no hay dos
  grupos de pestañas ni ventanas. En pantallas de 760 px o menos el panel pasa debajo y no se
  redimensiona con el dedo.
- **El modo Vista previa es una aproximación, no Android.** Dibuja el layout desde el XML con reglas
  propias (LinearLayout con pesos, marcos, textos, tamaños, gravedad, padding y márgenes); no
  conoce `ConstraintLayout` por sus constraints, estilos, temas, `drawable` ni medidas de fuente
  reales. No ejecuta la app: los eventos están en **Emulador**.
- **El XML se edita en el panel, pero solo lo que la vista en vivo entiende.** El lápiz
  (`#previa-modo-editar`) añade los dieciocho tipos de la paleta —un clic al final de la raíz o
  arrastrándolos a un punto del dibujo—, arrastra nodos dentro de su padre (márgenes en un marco,
  reordenar en un `LinearLayout`), edita sus propiedades —también las del layout raíz—, los borra
  con la basura o `Supr` y deshace con su propio historial (`Ctrl+Z`); no hay `ConstraintLayout`,
  estilos ni reparentado de un nodo ya dibujado (soltar un tipo en otro contenedor sí crea el nodo
  dentro de él), y la raíz no se cambia a `RelativeLayout`. El panel escribe con `EDITOR.cambiar()`,
  así que el texto, el cursor y el undo tree son los del editor de siempre. La paleta, la ficha y la
  jerarquía son capas: tapan parte del dibujo mientras están abiertas, pero no cambian su caja; se
  pliegan y, la ficha, se cierra con `Esc`. La vista **Pantalla** y el modo **Emulador** siguen
  siendo de solo lectura.
- **El render es el modelo de `apkc preview`, no la app ejecutándose.** La consola muestra lo que
  el intérprete capturó en `onCreate` y en los clics registrados; no es un `logcat` ni hay hilos,
  JNI ni excepciones fuera del subconjunto que el intérprete resuelve.
- **Sin buscar ni reemplazar.** `Ctrl+F` es el del navegador, no el del editor.
- **Sin cortar y pegar ni arrastrar en táctil.** Con ratón o lápiz hay arrastrar y soltar entre
  carpetas; en táctil, el menú de la fila ofrece **Mover a…**. Tampoco hay arrastrar y soltar para
  subir archivos: se suben con el botón del explorador o el menú de la carpeta.
- **Sin autosave.** El guardado es explicito (`Ctrl+S` o el boton).
- **Sin plegado de codigo, minimapa, multicursor ni diff.**
- **El autocompletado no es un LSP.** Completa recursos y nombres de clases/métodos del
  `android.jar`; no conoce el tipo de una variable local (para `View` hay que escribir la
  clase, no la variable) ni los campos, y no completa dentro de un bloque `/* … */`.
- **El resaltado es lexico.** No entiende de tipos, scopes ni errores; no sustituye a un LSP.
- **La indentacion automatica solo mira `{`.** No conoce `switch`, `try` ni el estilo de cada
  fichero.
- **No edita binarios.** El contenido se decodifica como UTF-8; un PNG del arbol no se abre en el
  editor.
- **La consola no es redimensionable con el raton.** Su alto lo fija el CSS (34vh, 42vh en movil).
- **El editor recarga de OPFS, no autosalva.** Al recargar vuelven las pestañas y la activa; un
  cambio sin guardar queda como rama del undo tree, pero el editor muestra el texto del disco.
  `beforeunload` avisa antes.
- **El cursor y el scroll se guardan por pestaña** mientras la sesión vive; la vista (pestañas,
  activa y `ARBOL.abiertos`) va en `sessionStorage` y el undo tree en IndexedDB por ventana.
- **El undo tree tiene límites:** 240 nodos y 4 MB por documento; las ramas más antiguas se podan.
  No hay colaboración en tiempo real ni merge entre ventanas: se avisa y se puede sobrescribir.

Estas fronteras son las de la pagina, no las de `apkc`. Lo que el subconjunto Java acepta o
rechaza esta en el inventario de la Fase 5 de `docs/plan.md`.
