# Porcento

El lector procesa fotos y PDF en el navegador. Las librerías públicas se descargan por HTTPS cuando hacen falta.

## Cloudflare Pages

Crea un proyecto de **Direct Upload** en **Workers & Pages** y sube el ZIP de Porcento tal como está, con index.html en la raíz. También puedes subir la carpeta de archivos estáticos mediante Wrangler. No hay paso de compilación ni variables de entorno. Usa la dirección HTTPS que asigna Pages para abrir la cámara en el iPhone.

En un proyecto existente conectado a Git, publica la rama actualizada según su configuración o despliega la carpeta de archivos estáticos con Wrangler. La función independiente de búsqueda web de precios, si se usa, tiene su propia configuración y es opcional para el lector de facturas.

## Facturas y catálogo

1. Abre **Leer factura**, toma una foto o selecciona un PDF y pulsa **Leer factura gratis**. Puedes adjuntar otra foto del total.
2. Revisa el importe y las unidades vendibles de cada producto. **Descargar CSV** exporta el análisis.
3. Cada renglón tiene **Guardar en catálogo** y un campo de precio de venta opcional. Si guardas de nuevo un producto y dejas el precio vacío, se conserva el precio de venta existente.
4. Cuando hay varios renglones, marca los productos que quieras o usa **Seleccionar todos**. **Guardar seleccionados** añade los productos nuevos y avisa cuáles ya estaban guardados.
5. Desde la calculadora, **Guardar en catálogo** abre una ficha con los precios del cálculo. En **Mi catálogo** puedes añadir, buscar, editar y eliminar productos. El catálogo se guarda en IndexedDB en el navegador del dispositivo.

## Cálculos

- Costo por unidad = costo del renglón ÷ unidades vendibles.
- Precio con costo +50% = costo por unidad × 1.5.
- Precio por margen = costo por unidad ÷ (1 − meta de margen), redondeado hacia arriba al centavo.
- La conciliación compara los importes con el total impreso. Los costos pendientes de confirmar se muestran como provisionales.

[Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
