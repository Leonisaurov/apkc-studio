# Dependencias: `deps-index.json` sin red y publicación

La pestaña **Dependencias** tiene dos vías y ninguna habla con Maven en tiempo de ejecución.

- **Resolver** lee `./deps-index.json` del propio origen, busca la coordenada pedida, descarga el
  `.jar`/`.aar` del índice, comprueba tamaño y SHA-256 y lo escribe en OPFS bajo `/deps/`.
- **Importar desde disco** mete `.jar`/`.aar`/`.zip` del disco en `/proyecto/` sin red.

El índice y los artefactos **no se versionan** (regla 2: nada de binarios en el repo). Este
documento fija cómo se generan, cómo se sirven en un origen propio y cómo se publican.

## El contrato del índice

Cada artefacto de `artefactos` lleva, como mínimo, lo que valida `deps.js`:

| campo | qué es |
| --- | --- |
| `coordenada` | `grupo:artefacto:versión` tal cual |
| `grupo`, `artefacto`, `version`, `extension` | las partes, sin separadores ni `..` |
| `fichero` | **la ruta** del artefacto, relativa al origen y siempre bajo `deps/` |
| `bytes` | tamaño exacto en bytes |
| `sha256` | SHA-256 en hex (64 caracteres) de esos bytes |

Además, y opcionales para que un índice viejo siga sirviendo:

| campo | qué es |
| --- | --- |
| `licencia` | licencia declarada (texto); el panel la pinta y, si falta, dice «sin declarar» |
| `licencia_url` | URL de la licencia en el `.pom`, si el workflow la encontró |
| `fecha` | cuándo se indexó ese artefacto (ISO 8601 UTC) |

`leerIndice` rechaza el índice entero si una entrada no cumple; no completa datos a ojo.

## Generar un índice local sin red (reproducible)

`studio/deps-index-local.mjs` deja un índice mínimo con un artefacto de prueba. Sin red y sin
dependencias: el jar sintético se construye en memoria (un zip STORE con `META-INF/MANIFEST.MF`)
y el SHA-256 se calcula con `node:crypto`.

```sh
DIR="$HOME/.cache/apkc-web/deps-index/sitio"
node studio/deps-index-local.mjs --salida "$DIR"
# -> $DIR/deps-index.json
#    $DIR/deps/com.example/prueba/1.0/prueba-1.0.jar
```

Opciones:

- `--jar <ruta>` indexa un jar real en vez del sintético; el SHA-256 y los bytes son los del
  fichero de entrada.
- `--coordenada grupo:artefacto:versión` (por defecto `com.example:prueba:1.0`).
- `--licencia <texto>` (por defecto `CC0-1.0` para el jar sintético; usa p. ej. `Apache-2.0`).
- `--fecha <iso>` fija la fecha del índice (útil para pruebas reproducibles).

El script imprime la ruta del índice, la del artefacto, la coordenada, los bytes, el `sha256`, la
licencia y la fecha; esos son los valores que verás en el panel.

## Servirlo en un origen propio (mismo origen, sin salir de la pestaña)

`studio/servidor.js` sirve un directorio arbitrario con `SITIO_DIR` y pone COOP/COEP. Apunta el
origen al directorio que acabas de generar:

```sh
SITIO_DIR="$HOME/.cache/apkc-web/deps-index/sitio" \
APKC_WASM="$HOME/.cache/apkc-web/deps-index/apkc-wasm.wasm" \
node studio/servidor.js 8791
```

`SITIO_DIR` sustituye al árbol de `studio/`, así que copia también allí `index.html`, los módulos
y `apkc.wasm` si quieres abrir la página entera; para probar solo el índice basta con que el
`deps-index.json` y `deps/` estén ahí. Las peticiones de Resolver son dos y las dos del mismo
origen: `./deps-index.json` y `./deps/...`.

### El 404 actual, falsificado a propósito

Si el directorio servido **no** trae `deps-index.json`, Resolver no inventa nada: el `fetch`
recibe 404 y el panel dice

> no hay deps-index.json en este origen: ejecuta el workflow de dependencias (Actions → deps-maven) …

Ese es el estado de un sitio publicado sin el paquete. Para reproducirlo, sirve un directorio sin
el índice y pulsa Resolver; `prueba-pestana.js` lo comprueba borrando el índice a mitad de la
sección de dependencias (ver más abajo).

## El índice real: el workflow `deps-maven`

`.github/workflows/deps-maven.yml` es el único que habla con Maven. En el runner descarga los
artefactos y su `.pom`, calcula el SHA-256, **lee la licencia del `.pom`** (`<licenses><license>`)
y escribe `deps-index.json` con `licencia`, `licencia_url` y `fecha` por artefacto, además de
`fichero`, `bytes` y `sha256`. El paso «Verificar el índice contra los ficheros» recorre cada
fichero y comprueba tamaño y SHA-256 antes de subir el artefacto `deps-maven`.

No ejecutes el workflow desde aquí: requiere red y `workflow_dispatch` con las coordenadas.

## Publicar en `sitio/`

`tools/sitio.sh` empaqueta `studio/` con `git archive HEAD`, así que **no ve los ficheros sin
versionar**. Por eso el índice no puede quedarse en `studio/`: hay que copiarlo al paquete ya
construido.

```sh
tools/entorno.sh sitio                       # deja el sitio empaquetado en sitio/
# copia el paquete de dependencias dentro del sitio ya empaquetado
cp -r "$HOME/.cache/apkc-web/deps-index/sitio/deps-index.json" sitio/
cp -r "$HOME/.cache/apkc-web/deps-index/sitio/deps" sitio/
# publicación manual (no la hace este documento)
#   cd sitio && surge . publish
```

Tras publicar, se verifica con el host real:
`SITIO_URL=https://apkc-studio.surge.sh/ … node studio/prueba-sitio.js`.

**Estado:** el índice existe en local y se genera sin red; el sitio público **no** está
actualizado con él hasta que se ejecute la publicación, que queda pendiente de orden.

## Pruebas

```sh
# node, sin navegador: generador, validación, hash y el camino con fetch de mentira
node prueba.js

# chromium real: sirve una copia de studio con el índice, conduce Resolver, cuenta las
# peticiones (solo del mismo origen) y falsifica el 404 quitando el índice
APKC_WASM=… APK_EJEMPLO=… KS_EJEMPLO=… node prueba-pestana.js
```

`prueba.js` comprueba que el generador deja `coordenada`, `fichero`, `bytes`, `sha256`, `licencia`
y `fecha`, que el índice valida y que la página lo importa. `prueba-pestana.js` comprueba que
Resolver hace exactamente dos peticiones al mismo origen y que, sin índice, el panel dice el 404
en vez de inventar datos.
