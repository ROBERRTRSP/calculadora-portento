(function () {
  'use strict';

  let library;
  let readerNumber = 0;

  function load() {
    if (window.Html5Qrcode) return Promise.resolve();
    library ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      script.onload = () => window.Html5Qrcode ? resolve() : reject(Error('Lector no disponible.'));
      script.onerror = () => {
        script.remove();
        reject(Error('No se pudo descargar el lector.'));
      };
      document.head.append(script);
    }).catch(error => { library = null; throw error; });
    return library;
  }

  function createReader(id) {
    const formats = window.Html5QrcodeSupportedFormats;
    return new window.Html5Qrcode(id, {
      formatsToSupport: [formats.EAN_13, formats.EAN_8, formats.UPC_A, formats.UPC_E],
      verbose: false
    });
  }

  function scanInto(input) {
    const dialog = document.createElement('dialog');
    dialog.className = 'barcode-dialog';
    dialog.setAttribute('aria-label', 'Escanear código de barras');
    dialog.innerHTML = `
      <h2>Escanear código de barras</h2>
      <div class="barcode-preview" hidden></div>
      <p class="status" role="status">Abriendo cámara…</p>
      <div class="actions">
        <button type="button" data-photo>Leer desde foto</button>
        <button type="button" data-close autofocus>Cerrar</button>
      </div>
      <input type="file" accept="image/*" capture="environment" hidden>
    `;

    const preview = dialog.querySelector('.barcode-preview');
    preview.id = 'barcode-preview-' + ++readerNumber;
    const status = dialog.querySelector('[role="status"]');
    const photoButton = dialog.querySelector('[data-photo]');
    const photo = dialog.querySelector('input');
    let reader;
    let phase = 'camera';

    async function resetReader() {
      if (!reader) return;
      if (reader.isScanning) await reader.stop();
      reader.clear();
      reader = null;
    }

    function accept(raw) {
      const code = String(raw).trim();
      if (!/^\d{8,14}$/.test(code) || !dialog.open || !input.isConnected) return false;
      dialog.close();
      input.value = code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    async function camera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        status.textContent = 'Puedes tomar una foto del código con «Leer desde foto».';
        return;
      }
      try {
        await load();
        if (!dialog.open || phase !== 'camera') return;
        preview.hidden = false;
        reader = createReader(preview.id);
        const width = Math.min(300, Math.floor(preview.clientWidth * .85));
        await reader.start({ facingMode: 'environment' }, {
          fps: 12, qrbox: { width, height: Math.round(width * .42) }, disableFlip: true
        }, raw => { if (phase === 'camera') accept(raw); }, () => {});
        if (dialog.open && phase === 'camera') status.textContent = 'Coloca el código dentro del recuadro.';
      } catch {
        if (dialog.open && phase === 'camera') {
          preview.hidden = true;
          status.textContent = 'No se pudo abrir la cámara. Revisa el permiso o usa «Leer desde foto».';
        }
      }
    }

    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    photoButton.onclick = () => photo.click();
    photo.onchange = async () => {
      const file = photo.files?.[0];
      if (!file || !dialog.open) return;
      phase = 'photo';
      photoButton.disabled = true;
      photo.value = '';
      status.textContent = 'Leyendo el código…';
      try {
        await cameraReady;
        await resetReader();
        await load();
        if (!dialog.open) return;
        preview.hidden = false;
        reader = createReader(preview.id);
        const code = await reader.scanFile(file, true);
        if (!accept(code) && dialog.open) status.textContent = 'La foto no muestra un código UPC o EAN legible.';
      } catch {
        if (dialog.open) status.textContent = 'No pude leer el código. Toma una foto más cerca y sin reflejos.';
      } finally {
        photoButton.disabled = false;
      }
    };
    document.body.append(dialog);
    dialog.showModal();
    const cameraReady = camera();
    const leavePage = () => dialog.close();
    window.addEventListener('pagehide', leavePage, { once: true });
    dialog.addEventListener('close', async () => {
      window.removeEventListener('pagehide', leavePage);
      dialog.hidden = true;
      try {
        await cameraReady;
        await resetReader();
      } catch { /* The reader may already be closed. */ }
      finally { dialog.remove(); }
    }, { once: true });
  }

  function addButton(input) {
    const field = document.createElement('div');
    field.className = 'barcode-field';
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Escanear código de barras con la cámara');
    button.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4l2-3h4l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    button.onclick = () => scanInto(input);
    input.replaceWith(field);
    field.append(input, button);
  }

  window.PorcentoBarcode = { addButton, load, createReader };
})();
