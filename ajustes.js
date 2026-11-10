// Ajustes del proyecto: se leen y se guardan en el propio AndroidManifest.xml. Se monta con
// las piezas del orquestador para no importarlo desde aquí.

export function crearAjustes({ hospedador, rutaManifiesto, conBloqueo, claveRevision,
  nuevaRevision, documentoDe, DOCUMENTOS, EDITOR, renderPestanas, refrescarArbol,
  publicar, nota, ajustesDelManifiesto, conAjustes }) {
  async function leerAjustes(silencioso) {
    const aviso = document.getElementById("estado-ajustes");
    const texto = await hospedador.texto(rutaManifiesto);
    if (!texto) {
      if (aviso) aviso.textContent = "no hay AndroidManifest.xml todavía";
      return null;
    }
    const a = ajustesDelManifiesto(texto);
    const poner = (id, valor) => {
      const campo = document.getElementById(id);
      if (campo && valor !== undefined && valor !== "") campo.value = valor;
    };
    poner("ajustes-minsdk", a.minSdk || "21");
    poner("ajustes-targetsdk", a.targetSdk || "34");
    poner("ajustes-versioncode", a.versionCode || "1");
    poner("ajustes-versionname", a.versionName || "0.1");
    if (aviso && !silencioso) {
      aviso.textContent = "leído del manifiesto: minSdk " + (a.minSdk || "?") +
        " · targetSdk " + (a.targetSdk || "?") + " · " + (a.versionName || "?") +
        " (" + (a.versionCode || "?") + ")";
    }
    return a;
  }

  async function guardarAjustes() {
    const valor = (id) => {
      const campo = document.getElementById(id);
      return campo ? campo.value : "";
    };
    const aviso = document.getElementById("estado-ajustes");
    try {
      const texto = await hospedador.texto(rutaManifiesto);
      if (!texto) { nota("no hay AndroidManifest.xml que ajustar"); return; }
      const nuevo = conAjustes(texto, {
        minSdk: valor("ajustes-minsdk"),
        targetSdk: valor("ajustes-targetsdk"),
        versionCode: valor("ajustes-versioncode"),
        versionName: valor("ajustes-versionname"),
      });
      await conBloqueo(async () => {
        const r = await hospedador.escribir(rutaManifiesto, new TextEncoder().encode(nuevo));
        if (r && r.tipo === "error") throw new Error(r.error);
      });
      try { localStorage.setItem(claveRevision(rutaManifiesto), nuevaRevision()); } catch (e) { /* sin revisión */ }
      const doc = documentoDe(rutaManifiesto);
      if (doc) {
        doc.texto = nuevo;
        doc.sucio = false;
        if (DOCUMENTOS.activa === rutaManifiesto) EDITOR.poner(nuevo);
        renderPestanas();
      }
      await refrescarArbol();
      publicar({ tipo: "mutacion", accion: "guardar", rutas: [rutaManifiesto] });
      const target = Number(valor("ajustes-targetsdk"));
      const politica = target < 34
        ? " · targetSdk " + target + " está por detrás de la política actual de Google Play"
        : "";
      if (aviso) aviso.textContent = "guardado en AndroidManifest.xml" + politica;
      nota("ajustes guardados en el manifiesto" + politica);
    } catch (e) {
      if (aviso) aviso.textContent = "no se pudo guardar: " + (e && e.message ? e.message : e);
    }
  }
  return { leerAjustes, guardarAjustes };
}
