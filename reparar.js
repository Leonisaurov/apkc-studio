// Último recurso del usuario: descarta el service worker y todas las cachés del origen y recarga.
// No se ofrece en la barra principal: vive dentro de Tema → Reparar caché, tras un confirm.
const boton = document.getElementById("reparar-cache");
if (boton) {
  boton.addEventListener("click", async () => {
    if (!confirm("Se borrará la copia guardada de apkc studio y se recargará la página. ¿Continuar?")) return;
    boton.disabled = true;
    try {
      const registro = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registro.map((r) => r.unregister()));
      const claves = await caches.keys();
      await Promise.all(claves.map((c) => caches.delete(c)));
      location.reload();
    } catch (e) {
      boton.disabled = false;
      boton.textContent = "No se pudo reparar: " + (e && e.message ? e.message : e);
    }
  });
}
