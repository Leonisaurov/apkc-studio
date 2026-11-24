#!/usr/bin/env node
// Genera un `deps-index.json` mínimo y reproducible, sin red, con un artefacto de prueba.
//
// El índice real lo produce el workflow `.github/workflows/deps-maven.yml` en un runner que sí
// habla con Maven. Este script existe para el caso sin red: deja en un directorio temporal el
// índice y el `.jar` con la misma forma que `deps.js` valida (`fichero` bajo `deps/`, `bytes`,
// `sha256`, `extension`), más la `licencia` y la `fecha` que el workflow también registra. Nada
// se escribe en el repo: los binarios no se versionan (regla 2).
//
// uso:
//   node studio/deps-index-local.mjs --salida /ruta/temporal [opciones]
//     --salida <dir>        dónde dejar deps-index.json y deps/ (obligatorio)
//     --jar <ruta>          jar real a indexar; si se omite se genera uno mínimo en memoria
//     --coordenada <g:a:v>  por defecto com.example:prueba:1.0 (solo si no hay --jar)
//     --licencia <texto>    licencia declarada; solo el jar sintético (creado por nosotros) toma
//                           CC0-1.0 por defecto — un jar real sin --licencia sale sin declararla
//     --fecha <iso>         fecha del índice; por defecto ahora en UTC
//
// El índice y el artefacto se sirven con el propio origen: `SITIO_DIR=<dir> node studio/servidor.js`
// o copiándolos en `sitio/` después de empaquetar. Ver `studio/DEPS.md`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Las mismas reglas de parte que valida `deps.js`: sin separadores, sin `..`, sin normalizar fuera
// de `deps/`. Si el generador escribiera algo que la página rechaza, el índice no serviría de nada.
const PARTE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function morir(mensaje) {
  console.error("error: " + mensaje);
  process.exit(1);
}

function partirArgs(argv) {
  // La licencia no tiene valor por defecto aquí: la decide `main` según lo que se indexe. Declarar
  // CC0-1.0 un jar de terceros sería una afirmación que este generador no puede hacer.
  const opciones = { salida: "", jar: "", coordenada: "com.example:prueba:1.0",
    licencia: "", fecha: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valor = () => {
      const v = argv[++i];
      if (v === undefined) morir("falta el valor de " + a);
      return v;
    };
    if (a === "--salida") opciones.salida = valor();
    else if (a === "--jar") opciones.jar = valor();
    else if (a === "--coordenada") opciones.coordenada = valor();
    else if (a === "--licencia") opciones.licencia = valor();
    else if (a === "--fecha") opciones.fecha = valor();
    else if (a === "-h" || a === "--ayuda") {
      console.log("uso: node studio/deps-index-local.mjs --salida <dir> " +
        "[--jar <ruta>] [--coordenada g:a:v] [--licencia <texto>] [--fecha <iso>]");
      process.exit(0);
    } else morir("argumento desconocido: " + a);
  }
  if (!opciones.salida) morir("falta --salida <dir>");
  return opciones;
}

// Un CRC-32 de zip (polinomio 0xEDB88320), para que el jar sintético sea un zip STORE de verdad
// y no un montón de bytes: así el artefacto se puede abrir con `unzip`/`jar` si hace falta mirarlo.
function crc32(datos) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < datos.length; i++) {
    c ^= datos[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Zip mínimo en modo STORE con las entradas dadas. Sin compresión ni data descriptors: lo que
// necesita un lector de zip es el directorio central y el EOCD, y aquí no se busca rendimiento.
function zipStore(entradas) {
  const locales = [];
  const centrales = [];
  let desplazamiento = 0;
  // 2026-11-22 00:00:00 en el formato de fecha/hora MS-DOS del zip (solo metadatos).
  const hora = ((0 << 11) | (0 << 5) | (0 >> 1)) & 0xFFFF;
  const dia = (((2026 - 1980) << 9) | (11 << 5) | 22) & 0xFFFF;
  for (const { nombre, datos } of entradas) {
    const nombreBytes = Buffer.from(nombre, "utf8");
    const crc = crc32(datos);
    const cabecera = Buffer.alloc(30);
    cabecera.writeUInt32LE(0x04034b50, 0);
    cabecera.writeUInt16LE(20, 4);          // versión necesaria
    cabecera.writeUInt16LE(0, 6);           // flags
    cabecera.writeUInt16LE(0, 8);           // método STORE
    cabecera.writeUInt16LE(hora, 10);
    cabecera.writeUInt16LE(dia, 12);
    cabecera.writeUInt32LE(crc, 14);
    cabecera.writeUInt32LE(datos.length, 18);
    cabecera.writeUInt32LE(datos.length, 22);
    cabecera.writeUInt16LE(nombreBytes.length, 26);
    cabecera.writeUInt16LE(0, 28);          // extra
    locales.push(cabecera, nombreBytes, datos);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);           // versión que creó
    central.writeUInt16LE(20, 6);           // versión necesaria
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(dia, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nombreBytes.length, 28);
    central.writeUInt16LE(0, 30);           // extra
    central.writeUInt16LE(0, 32);           // comentario
    central.writeUInt16LE(0, 34);           // disco
    central.writeUInt16LE(0, 36);           // atributos internos
    central.writeUInt32LE(0, 38);           // atributos externos
    central.writeUInt32LE(desplazamiento, 42);
    centrales.push(central, nombreBytes);
    desplazamiento += cabecera.length + nombreBytes.length + datos.length;
  }
  const cd = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entradas.length, 8);
  eocd.writeUInt16LE(entradas.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(desplazamiento, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locales, cd, eocd]);
}

function jarSintetico() {
  const manifiesto = Buffer.from(
    "Manifest-Version: 1.0\r\nCreated-By: apkc-studio deps-index-local\r\n\r\n", "utf8");
  return zipStore([{ nombre: "META-INF/MANIFEST.MF", datos: manifiesto }]);
}

function main() {
  const opciones = partirArgs(process.argv.slice(2));
  const salida = path.resolve(opciones.salida);
  const fecha = opciones.fecha || new Date().toISOString();

  let grupo, artefacto, version, datos;
  if (opciones.jar) {
    const rutaJar = path.resolve(opciones.jar);
    if (!fs.existsSync(rutaJar) || !fs.statSync(rutaJar).isFile()) {
      morir("no existe el jar: " + rutaJar);
    }
    datos = fs.readFileSync(rutaJar);
    const partes = opciones.coordenada.split(":");
    if (partes.length !== 3) morir("--coordenada debe ser grupo:artefacto:versión");
    [grupo, artefacto, version] = partes;
  } else {
    const partes = opciones.coordenada.split(":");
    if (partes.length !== 3) morir("--coordenada debe ser grupo:artefacto:versión");
    [grupo, artefacto, version] = partes;
    datos = jarSintetico();
  }
  for (const [valor, que] of [[grupo, "grupo"], [artefacto, "artefacto"], [version, "versión"]]) {
    if (!PARTE.test(valor) || valor.includes("..")) morir(que + " no válido: " + JSON.stringify(valor));
  }

  // Solo el jar sintético —un zip que construimos aquí con nuestro manifiesto— se declara CC0-1.0
  // al no pedir licencia. Un jar real es de quien lo escribió: si no se pasa `--licencia`, la
  // entrada sale con `licencia: null` (el panel dirá «sin declarar») y el generador avisa.
  let licencia = opciones.licencia;
  if (!licencia) {
    if (opciones.jar) {
      licencia = null;
      console.log("aviso: el jar " + path.basename(opciones.jar) + " no declara licencia; " +
        "pasa --licencia <texto> (p. ej. --licencia Apache-2.0) para que el índice la registre");
    } else {
      licencia = "CC0-1.0";
    }
  }

  const nombre = artefacto + "-" + version + ".jar";
  const fichero = ["deps", grupo, artefacto, version, nombre].join("/");
  const sha256 = crypto.createHash("sha256").update(datos).digest("hex");
  const entrada = {
    coordenada: grupo + ":" + artefacto + ":" + version,
    grupo, artefacto, version, extension: "jar",
    fichero,
    bytes: datos.length,
    sha256,
    licencia,
    fecha,
  };
  const indice = {
    version: 1,
    generado: fecha,
    origen: "deps-index-local.mjs (generador local, sin red)",
    artefactos: [entrada],
  };

  const destinoArtefacto = path.join(salida, fichero);
  fs.mkdirSync(path.dirname(destinoArtefacto), { recursive: true });
  fs.writeFileSync(destinoArtefacto, datos);
  const destinoIndice = path.join(salida, "deps-index.json");
  fs.writeFileSync(destinoIndice, JSON.stringify(indice, null, 2) + "\n");

  console.log("índice: " + destinoIndice);
  console.log("artefacto: " + destinoArtefacto);
  console.log("coordenada: " + entrada.coordenada);
  console.log("fichero: " + fichero);
  console.log("bytes: " + datos.length);
  console.log("sha256: " + sha256);
  console.log("licencia: " + (entrada.licencia || "sin declarar"));
  console.log("fecha: " + fecha);
}

main();
