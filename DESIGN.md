# DESIGN — apkc studio

Sistema visual del editor. Superficie **Operate**: el usuario viene a terminar una tarea, así que el mundo aporta solo tipo, paleta, densidad y un gesto de firma. La navegación, los controles y el layout son los de una herramienta web estándar; no se disfrazan de otro instrumento.

## Tres mundos, un mismo editor

Los tres se eligen en **Ajustes → Interfaz** y se aplican como `data-tema` en `<html>`; `temas.js` solo escribe el atributo y `style.css` resuelve las variables. Ninguno añade dependencias ni fuentes externas.

| Tema | Paleta | Tipo | Gesto de firma |
| --- | --- | --- | --- |
| **Taller artesanal** | carbón cálido `#201d19`, ámbar `#e0a44a`, verde seco para `ok` | `Georgia` para títulos y cabeceras de panel, mono para código | marca ámbar de 3px en el riel **y** en el borde inferior de la pestaña activa |
| **Terminal moderno** | casi negro `#0d110e`, ágata `#74d68b`, bajo brillo verde | mono en títulos, mismo mono para código | bloque sólido de ágata a la derecha del riel **y** de la pestaña activa |
| **Azul refinado** | azul pizarra `#16202b`, azul `#5aa9e6`, superficies `2a3b4d` | sans de sistema con tracking `-0.015em` | subrayado de 1px bajo la pestaña activa **y** bajo el icono activo del riel |

Las seis marcas se capturan en `.impeccable/review/{taller,terminal,azul-refinado}{-editor,}.png`: la primera de cada par muestra Inicio y la segunda el editor con la pestaña de fichero activa.

El tema por defecto (`apkc`) y los cuatro temas precedentes se conservan: los nuevos se suman, no sustituyen la continuidad de quien ya usa el editor.

## Tokens

Todos los colores semánticos viven en bloques `:root[data-tema="…"]`: `--fondo`, `--fondo2`, `--actividad`, `--borde`, `--borde2`, `--texto`, `--tenue`, `--brillo`, `--acento`, `--acento2`, `--entrada`, `--superficie*`, `--boton*`, `--foco`, `--numero-linea`, `--scroll-*`, `--sintaxis-*` y `--ansi-0..15` para la consola. No se escriben colores nuevos fuera de un bloque de tema.

Espaciado: grupos compactos (pestañas, botones de una fila) y separación generosa entre bloques (formulario, nota de almacenamiento, atajos). El mismo ritmo en los tres temas; la densidad solo cambia con `--densidad` en el editor.

## Tipografía y estado

- Código: pila mono del sistema; el tamaño se elige en Ajustes (`--ed-fuente`).
- Títulos: `--tipo-titulo` por tema; ningún archivo de fuente se descarga.
- Contraste: texto de cuerpo ≥4,5:1 sobre su superficie. El detector de `impeccable` deja **0 warnings** y **1 advisory**: `3.4:1 — text #ffffff on #2e92d5`, un azul calculado por el detector para el estado hover de un botón primario, no un literal del código. Se reproduce con
  `impeccable detect --json studio/index.html studio/style.css studio/temas.js`.
- Enlace de salto visible al enfocar`<skip-link>` hacia `<main id="area-principal" tabindex="-1">`.
- Foco: `:focus-visible` con `outline` de 2px y `outline-offset`; no se suprime el indicador nativo sin reemplazo.
- Botones: `:hover`, `:disabled`, `:active` y carga (`#ocupado`) con el mismo vocabulario en los tres temas.

## Movimiento y superficies del navegador

Un único momento autorizado: el velo «Preparando el navegador…» mientras el service worker consigue el aislamiento. No hay animaciones de entrada ni efectos decorativos dispersos. Se tematizan selección de texto, caret, scrollbars, subrayados y anillos de foco desde la paleta del tema.

## Origen de los assets

Favicon: `data:` SVG en `index.html`. Iconos PWA: `icons/icon-192.png` e `icon-512.png`, generados en este repo con Python estándar (bloques azul/ blanco), sin stock ni servicios externos. No hay fotografías ni ilustraciones: la interfaz es instrumentos y texto.

## Fuera del sistema

No se usan degradados de texto, cristal/espejo decorativo, tarjetas iguales como estructura de página, números de sección, ni iconos Unicode en lugar de un sistema de iconos. Los carets de los desplegables y el punto de cambios sin guardar se dibujan con `clip-path`/`border-radius` y tokens de tema; el cierre de la búsqueda es un `<svg>` con el mismo trazo que el resto. El editor es un `<textarea>` sobre un `<pre>` resaltado, sin Monaco ni librerías de terceros.
