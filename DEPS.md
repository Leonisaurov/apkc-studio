# Dependencias: `deps-index.json` sin red y publicación

La pestaña **Dependencias** tiene dos vías y ninguna habla con Maven en tiempo de ejecución.

- **Resolver** lee `./deps-index.json` del propio origen, busca la coordenada pedida, descarga el
  `.jar`/`.aar` del índice, comprueba tamaño y SHA-256 y lo escribe en OPFS bajo `/deps/`.
- **Importar desde disco** mete `.jar`/`.aar`/`.zip` del disco en `/proyecto/` sin red.

Hay una tercera vía, **opt-in y apagada**: el módulo WISP, que puede pedir un artefacto por un
relay de terceros cuando el índice no lo trae. Sin aceptar su aviso no se hace ni una petición
fuera del origen; se documenta entero más abajo.

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
- `--licencia <texto>` declara la licencia del artefacto (`Apache-2.0`, `MIT`…). El jar **sintético**
  que genera el propio script se declara `CC0-1.0` si no la pasas, porque lo creamos nosotros; un
  jar **real** (`--jar`) sin `--licencia` sale con `licencia: null` (el panel dirá «sin declarar») y
  el script avisa por stdout: la licencia de un artefacto de terceros solo la puede declarar quien
  lo indexa.
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

## El módulo WISP: opt-in, apagado por defecto

**Por qué existe.** Maven Central hoy exige TLS y no manda cabeceras CORS, así que una página no
puede leer sus respuestas. WISP es un proxy de sockets TCP sobre un WebSocket: un relay de terceros
abre la conexión TCP desde su servidor y devuelve los bytes por el WebSocket, y el CORS deja de ser
un muro. Eso rompe la regla 4 (nada fuera del origen) y por eso es un módulo **opcional** con
aviso; el modo por defecto sigue con **cero peticiones ajenas**.

**El aviso.** Al pulsar **Resolver** con el módulo sin decidir, se abre `#wisp-aviso` sin tocar la
red. Dice las seis cosas que importan: (1) sirve para saltarse el CORS abriendo TCP desde el
relay; (2) descarga **archivos extra del módulo** desde este mismo origen —el binario del núcleo
`wasm` y la lista de relays—; (3) si el **TLS propio del núcleo** no está en esta compilación, el
contenido viaja **en claro** por el relay y cualquiera en su camino puede leerlo o sustituirlo:
el TLS del núcleo es la opción segura y, sin él, esto es solo para pruebas; (4) el bundle de CAs
se lee **del dispositivo**, nunca del relay; (5) un bundle de CAs ajeno convertiría al relay en
una CA que puede firmar el certificado de cualquier host; (6) los relays son de **terceros y no
están auditados**. Ofrece «Activar para esta sesión» y «Cancelar», con la casilla
**«Recordar elección»** desmarcada. Cancelar deja el módulo apagado, no guarda nada y esa misma
pulsación sigue por `deps-index.json` del propio origen.

| elección | `localStorage["apkc-studio/wisp"]` | qué hace Resolver |
| --- | --- | --- |
| sin decidir | sin clave | abre el aviso; cero peticiones |
| activar sin recordar | sin clave | vía WISP en esta sesión |
| activar y recordar | `activo` | vía WISP también en próximas visitas |
| cancelar y recordar | `inactivo` | índice del propio origen, sin volver a preguntar |
| **Desactivar** | se borra | índice del propio origen; la próxima visita vuelve a preguntar |

La elección se escribe **solo** si se marcó «Recordar elección»; por defecto no se guarda nada.
`Desactivar` apaga el módulo y borra la clave, para que una elección vieja no resucite.

**El selector de relays.** `#wisp-selector` nace **oculto** y se muestra al activar el módulo; sus
controles están dentro de ese bloque. La lista se pide **al activar** (`./wisp-relays.json`, una
sola petición del propio origen, nunca antes) y muestra host, latencia y «tercero». El campo de
**URL personalizada** manda sobre la lista cuando no está vacío: es la puerta para el WISP propio
(el local futuro). Se valida con la spec v1.2 —`wss://`, o `ws://` para uno local, y **acabar en
«/»**— y el motivo del rechazo se pinta en `#wisp-url-estado`.

**`wisp-relays.json`** (versionado; nada de binarios, es texto). Campos: `version`, `generated`
(fecha de la medición, sin hora inventada), `note`, `spec`, `bufferPackets` y `relays`. Cada relay
lleva `url`, `verified: true` (handshake real), `latencyMs`, `protocol: "v1"` y `bufferPackets`.
`bufferPackets` va en **`null`** a propósito: no se midió por relay, solo se observó que el
`CONTINUE` inicial varía entre **128 y 2147483647**, así que el cliente lo lee al conectar y nunca
asume 128; el fichero lo declara en `bufferPackets.medidoPorRelay: false` con el rango observado.
Ni los hosts ni las latencias se inventan: los seis salen del `§254` de `docs/evidencia.md` y son
**pruebas, no auditoría**. La lista se **re-mide en el gate del modo externo** (el que abre un
relay de verdad), porque la latencia de un handshake cambia y un host puede caerse.

**El contrato con el núcleo.** Esta página **no** implementa WISP ni TLS: el framing v1
(`apkc/wisp.go:16-21`), el `crypto/tls` sobre el `net.Conn` (`apkc/depswisp.go:582`) y los GET sobre
esa conexión ya autenticada (`apkc/puente_wisp.go:96-121`) viven en `apkc/`. Ya no hay una inclusión
condicional decidida por la página: con build tag `js && wasm`, `init()` registra `apkcWisp` y
`apkcWispCargarCAs` en el `globalThis` del worker (`apkc/puente_wisp_js.go:1,36-68`). El contrato
es:

```js
globalThis.apkcWisp = {
  version: "apkc-wisp/1",
  // relay: forma validada en la página y allowlist en el núcleo;
  // coordenada = grupo:artefacto:versión; destino = carpeta canónica de OPFS
  obtener({ version, relay, coordenada, destino }) =>
    Promise<{ bytes: Uint8Array, sha256: string, ruta: string }>
};
```

`version` viaja en cada llamada (`wisp.js:216-219`) y el núcleo la exige
(`apkc/puente_wisp.go:62-65`). La URL se valida **dos veces**: la forma —`wss://` (o `ws://` local),
sin espacios ni credenciales y con barra final— en la página (`wisp.js:25-45`), y la allowlist en
el núcleo (`apkc/puente_wisp.go:72-75`). `destino` es `/deps/<grupo>/<artefacto>/<versión>/`, con
los puntos del grupo convertidos en barras (`a.b.c` → `a/b/c`), que es la carpeta canónica que
construye el núcleo (`apkc/puente_wisp.go:78-85`); el núcleo la exige igual y la página contrasta
la ruta devuelta (`wisp.js:316-322`). El nombre del fichero lo decide el núcleo, porque sin índice no se
sabe si es `.jar` o `.aar`. Si el worker no anuncia el núcleo, `resolverPorWisp()` falla con
**«núcleo WISP no disponible en esta compilación»** y no abre ningún socket; después de esa
decisión de la persona, el panel no inventa un respaldo silencioso.

**El puente real: del worker a la página.** El wasm corre dentro del worker, así que la página no
ve sus globales: el worker anuncia `wisp-nucleo` con el contrato justo antes de `go.run(instance)`
y lo retira en `finally` (`hospedador.js:247-256`). Al recibirlo, la página instala el proxy con
`instalarPuenteWisp()` y el mismo `CONTRATO_NUCLEO`: `apkcWisp.obtener` y
`apkcWispCargarCAs` reenvían por `postMessage` al wasm (`pestana.js:111-146`,
`wisp-puente.js:5-7,35-55`). Un mensaje con otro contrato no instala nada, y al detener el
hospedador se desactiva el proxy (`pestana.js:164-168`). La forma de llamada sigue siendo la de
`wisp.js`, que contrasta `bytes`, `sha256` y `ruta` antes de pintarlos (`wisp.js:294-324`).

**Las CAs: del dispositivo al núcleo.** En `js/wasm` no existe `x509.SystemCertPool`
(`apkc/wispcerts_js.go`), así que el `RootCAs` lo inyecta la página. El contrato es un método
global aparte, para no cambiar la forma de `obtener`:

```js
globalThis.apkcWispCargarCAs({ pem, huella }) =>
  Promise<{ ok: true } | { ok: false, error: string }>
```

- `pem` es el texto del fichero **local** que la persona elige en `#wisp-cas` (`input file`,
  same-origin, sin red): solo `.pem`/`.crt`, hasta **64 KiB**, con uno o más bloques
  `CERTIFICATE` y cero bytes fuera de bloque. La página lo valida con `prepararCAS()` antes de
  llamar al núcleo, que vuelve a validarlo con `CargarCAsPEM` (`apkc/depswisp.go:257`).
- `huella` es `sha256(pem)` calculado sobre el PEM **entregado**, no sobre el fichero crudo: un BOM
  inicial se quita y cualquier otro `U+FEFF` se rechaza (`wisp.js:341-381`). La huella esperada de
  `#wisp-cas-huella` se normaliza —separadores `:` y mayúsculas— antes de compararse
  (`wisp.js:326-335`), y `cargarCAsEnNucleo()` vuelve a exigir `sha256(pem) === huella`
  (`wisp.js:391-403`). El núcleo la decodifica con `hex.DecodeString` y pide 32 bytes
  (`apkc/puente_wisp_js.go:186-200`) antes de fijarla con `CargarCAsPEMFijadas`
  (`apkc/depswisp.go:319`).
- `resolverPorWisp({ cas })` llama a `apkcWispCargarCAs` **antes** de `obtener` (`wisp.js:213-215`).
  Sin núcleo, el error es el de siempre; con un núcleo que no acepta CAs, dice **«núcleo WISP sin
  carga de CAs en esta compilación»** y no abre el relay.
- El bundle **nunca** llega por el relay: un bundle ajeno convertiría al relay en una CA capaz de
  firmar cualquier host. La página no descarga CAs de ninguna URL y rechaza un nombre con esquema
  (`https://…`) antes de leer el fichero.

**Qué queda y qué no.** El puente ya está implementado de punta a punta en el código: el registro
en `init()` con build tag `js && wasm`, el framing y el TLS en `apkc/`, la doble validación del
relay, la conversión de puntos a barras, el anuncio `wisp-nucleo` entre worker y página y el
contraste de la respuesta. Los **dos gates ya están implementados** en `studio/wisp-gates.js` y se
documentan abajo. Fuera del código queda **publicar el sitio** (pendiente de orden) y **correr el
gate del modo externo** contra relays reales: es opt-in y **no se ha ejecutado**, así que aquí no
se afirma que el puente funcione contra relays de terceros.

**Los dos gates.** La regla vive en un solo módulo, `wisp-gates.js`, y la usan la pestaña, la
prueba y la falsificación; no hay una copia más laxa en cada sitio.

- **Gate por defecto (el que corre siempre).** El módulo está apagado y la pestaña no puede sacar
  ninguna `Network.requestWillBeSent` ni abrir ninguna `Network.webSocketCreated` fuera de
  `http://127.0.0.1:<puerto>`, `data:` y `blob:`. Un `wss://` cuenta como ajeno y **hace fallar el
  gate**. Se ejecuta con `prueba-pestana.js` sin variables de entorno (lo lanza `e2e.sh` y
  `tools/entorno.sh gate`), y la falsificación se prueba con:

  ```sh
  node studio/prueba-wisp-gates.mjs   # o: tools/entorno.sh wisp
  ```

- **Gate del modo externo (opt-in y sin red en CI).** Con `APKC_WISP_EXTERNO=1` se enciende el
  módulo y el gate: valida que `wisp-relays.json` trae **6** relays `verified: true`, con latencia y
  `protocol: "v1"`; exige que `nucleoDisponible()` sea cierto y, si no lo es, falla con
  **«núcleo WISP no disponible en esta compilación»** **antes** de llamar a la sonda (cero
  sockets); y, con núcleo, abre cada relay y acepta **solo** el CONTINUE inicial con `streamID=0`,
  sin mandar CONNECT ni descargar artefactos, exigiendo que todas las conexiones salgan de los
  hosts de esa lista. Se corre así:

  ```sh
  APKC_WISP_EXTERNO=1 tools/entorno.sh wisp-externo
  # equivale a, con wasm y una apk de prueba ya construidos:
  APKC_WISP_EXTERNO=1 APKC_WASM=… APK_EJEMPLO=… KS_EJEMPLO=… node studio/prueba-pestana.js
  ```

  Sin `APKC_WISP_EXTERNO=1`, `prueba-pestana.js` imprime «omitido gate del modo externo» y no abre
  ni un relay. El **wrapper** `tools/entorno.sh wisp-externo` es más estricto: sin la variable sale
  **rc 2** con «gate externo omitido: fija APKC_WISP_EXTERNO=1…»; es un fallo de uso, no un aviso
  inofensivo. **Este gate no se corre en CI**: necesita red hacia relays de terceros y no está
  auditado; en CI solo corre el gate por defecto y la falsificación, que no toca la red.

**Pruebas del módulo.**

- `node prueba.js`: el JSON de relays (seis, latencias medidas, sin `bufferPackets` por relay) y su
  validador (sin handshake, sin latencia, sin barra final o con `v2`, fuera); la elección —sin
  recordar no escribe nada, con recordar persiste activo e inactivo—; el contrato (sin núcleo dice
  qué falta, con un núcleo de mentira recibe relay, coordenada y destino); **las CAs**: un PEM
  autocertificado de prueba se acepta y produce `{pem, huella}` con el sha256 real, la basura y
  los bytes fuera de bloque se rechazan, el fichero de más de 64 KiB se rechaza, un nombre con
  `https://` se rechaza antes de leerlo, la huella esperada se compara y `apkcWispCargarCAs`
  recibe exactamente `{pem, huella}` **antes** de `obtener`; el texto del aviso —seis ideas,
  incluidas las dos de CAs— comprobado **contra el HTML que se pinta**, no contra una copia; y el
  panel: sin opt-in va al índice del propio origen, con opt-in y sin núcleo no hace ni una
  petición, y elegir un PEM del disco deja `casActual()` con su huella.
- `node prueba-pestana.js`: sin opt-in, el selector no se muestra y Resolver abre el aviso con
  **cero** peticiones; el aviso contiene CORS, archivos extra, «en claro»/MITM, CAs del
  dispositivo y terceros; «Cancelar» sigue por el índice; activar sin recordar no escribe en
  `localStorage` y lista los 6 relays con su latencia en **una** petición al propio origen; con
  el módulo activo y sin núcleo, Resolver falla con el motivo y **cero** peticiones; un PEM real
  metido con `DataTransfer` se acepta con su sha256 y con un núcleo de mentira Resolver le pasa
  `{pem, huella}` antes de pedir el artefacto; la basura y un nombre con URL se rechazan con su
  motivo; una URL sin barra final se rechaza con el motivo de la spec; «Recordar elección»
  persiste y la recarga deja el módulo activo sin volver a preguntar; y la comprobación global
  cierra con **cero peticiones y cero aperturas de WebSocket** fuera del origen (suma
  `Network.requestWillBeSent` y `Network.webSocketCreated`). Con `APKC_WISP_EXTERNO=1`, el gate
  externo valida la lista, exige el núcleo cableado y, sin él, falla con el motivo sin abrir
  socket.
- `node prueba-wisp-gates.mjs`: falsifica los dos gates sin red: un `wss://` ajeno rompe el gate
  por defecto; un relay fuera de la lista rompe el modo externo; sin núcleo no se abre ningún
  socket; una lista de 5 relays, uno sin verificar, sin latencia o con `v2` se rechazan; el
  handshake acepta solo CONTINUE con `streamID` 0 y rechaza DATA u otro flujo.

