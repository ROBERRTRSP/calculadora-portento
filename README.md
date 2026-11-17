# Porcento

El lector procesa fotos y PDF en el navegador. Las librerías públicas se descargan por HTTPS cuando hacen falta.

## Cloudflare Pages

Crea un proyecto de **Direct Upload** en **Workers & Pages** y sube el ZIP de Porcento tal como está, con index.html en la raíz. También puedes subir la carpeta de archivos estáticos mediante Wrangler. No hay paso de compilación ni variables de entorno. Usa la dirección HTTPS que asigna Pages para abrir la cámara en el iPhone.

En un proyecto existente conectado a Git, publica la rama actualizada según su configuración o despliega la carpeta de archivos estáticos con Wrangler.

## Facturas y catálogo

1. En **Leer factura**, toma una foto o selecciona un PDF. Porcento lo lee automáticamente. Puedes adjuntar una foto del total y volver a leerlo.
2. Los UPC de productos guardados muestran el costo anterior y el nuevo por unidad, y el margen al precio de venta guardado. Revisa los renglones pendientes antes de registrar sus compras.
3. Pulsa **Guardar compra** o usa **Guardar seleccionados** para registrar varios renglones. Los productos guardados conservan su foto, nombre y precio de venta si dejas este último vacío.
4. En **Escanear producto**, escribe o escanea el UPC para abrir la ficha de Mi catálogo. Puedes registrar otra compra introduciendo el costo nuevo y las unidades.
5. En **Mi catálogo**, abre la ficha para completar la foto, editar los datos o consultar el historial de compras y su margen. Los datos se guardan en IndexedDB en el navegador del dispositivo. Usa **Respaldo del catálogo** para descargar las fichas, fotos e historial. Al importar, las fichas que ya existen se conservan.

## Cálculos

- Costo por unidad = costo del renglón ÷ unidades vendibles.
- Precio con costo +50% = costo por unidad × 1.5.
- Precio por margen = costo por unidad ÷ (1 − meta de margen), redondeado hacia arriba al centavo.
- La conciliación compara los importes con el total impreso. Los costos pendientes de confirmar se muestran como provisionales.

[Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
