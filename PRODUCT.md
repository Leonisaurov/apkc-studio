# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Desarrolladores que escriben y prueban una app Android mínima desde el navegador, sin SDK ni JDK en su máquina, y que necesitan ver el proyecto, editar fuentes y recursos, compilar, firmar y descargar un apk en una sola sesión de trabajo.

## Product Purpose

Crear un proyecto apkc, editarlo y conservarlo entre sesiones en OPFS, compilarlo y firmarlo enteramente en la pestaña (sin servidor, sin conexión y sin processes), y verificar el resultado con oráculos externos. El éxito es un apk instalable y verificado.

## Positioning

Todo el compilador, el enlazador de recursos, el dexer y el firmante viajan en el propio origen de la página: no se presta una JVM ni se llama a un CDN. Lo que el editor no sabe emitir se rechaza por nombre con su línea.

## Operating Context

Trabajo continuo en un editor de código ligero dentro de una pestaña, habitualmente en escritorio; el proyecto vive en OPFS, el `android.jar` se elige una vez y el usuario vuelve a la misma pestaña. Hay atajos de teclado, consola de salida y un panel de diagnóstico con contadores locales.

## Capabilities and Constraints

Sin red, sin fuentes ni librerías de terceros en la página; COOP/COEP para OPFS sincrónico; los scripts inline se autorizan por hash CSP; se publica en `apkc-studio.surge.sh` con un directorio estático. La interfaz debe seguir siendo funcional con teclado y con foco visible.

## Brand Commitments

Nombre: apkc studio. Voz directa y técnica en español; cero caracteres de otros alfabetos en la prosa. El usuario pidió explícitamente que el editor no parezca una copia barata de Visual Studio Code.

## Evidence on Hand

`README.md`, `docs/plan.md`, `docs/evidencia.md` y `studio/EDITOR.md` documentan el producto y la página. No hay testimoniales, métricas de uso externas ni assets de marca además del favicon y los iconos PWA generados en este repo.

## Product Principles

- La herramienta funciona sin servidor y sin dependencias de terceros en la página.
- Lo no medido se rechaza por nombre, nunca se compila a medias.
- El usuario conserva el proyecto y sus datos en su navegador.
- La interfaz es un instrumento de trabajo: jerarquía clara, estado honesto y atajos descubribles.
