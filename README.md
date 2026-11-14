# Porcento · Facturas y My NRS Store

El lector procesa fotos, PDF y Pricebooks dentro del navegador. La factura y el catálogo no se envían a servidores. Las librerías públicas se descargan por HTTPS cuando hacen falta. La lectura y la comparación de facturas no requieren un Worker, una API de IA ni una clave.

## Cloudflare Pages

Crea un proyecto de **Direct Upload** en **Workers & Pages** y sube el ZIP de Porcento tal como está, con index.html en la raíz. También puedes subir la carpeta de archivos estáticos mediante Wrangler. No hay paso de compilación ni variables de entorno. Usa la dirección HTTPS que asigna Pages para abrir la cámara en el iPhone.

En un proyecto existente conectado a Git, publica la rama actualizada según su configuración o despliega la carpeta de archivos estáticos con Wrangler. La función independiente de búsqueda web de precios, si se usa, tiene su propia configuración y es opcional para el flujo de facturas y NRS.

## Uso

1. En el portal de My NRS Store, abre **Pricebook → Download / Excel Download**. Usa el archivo original de NRS para conservar los ceros iniciales del UPC.
2. En Porcento entra a **Leer factura → Comparar con My NRS Store**. Selecciona el Excel o CSV y ajusta la meta de margen bruto (40% por defecto). La meta se guarda en el navegador. El catálogo se carga en memoria durante la sesión de la página.
3. Toma una foto o abre un PDF. Toca **Leer factura gratis**. Para las fotos, Tesseract.js trabaja en inglés y español. En PDF, Porcento extrae el texto de cada página cuando está disponible y usa OCR para las páginas escaneadas. Puedes adjuntar una segunda foto del total.
4. Revisa las cantidades vendibles y los importes. Si un código es interno del proveedor, puedes sustituirlo por el UPC real. Porcento marca como **Pendiente de confirmar** las coincidencias ambiguas o inexistentes, y en rojo las que quedan bajo tu meta.
5. **Descargar CSV** guarda el análisis para revisar. Los precios de My NRS Store se actualizan desde NRS.

## Cálculos

- Costo unitario nuevo = costo de renglón ÷ unidades vendibles. Taíno: $35.99 ÷ 24 ≈ $1.50. Para el margen se conserva la precisión completa.
- Precio de NRS: el campo Cents corresponde al importe de la cantidad indicada en Qty. Un precio de 2 por $4.99 equivale a $2.495 por unidad.
- Margen bruto = (precio actual − costo unitario) ÷ precio actual.
- Precio sugerido = costo unitario ÷ (1 − meta de margen), redondeado hacia arriba al centavo.
- La conciliación compara los importes con el total impreso. Si el total o las unidades requieren revisión, Porcento identifica los importes provisionales.

Referencias: [Exportación del Pricebook](https://campnrs.com/wp-content/uploads/2020/01/LabelPrintingNotes.pdf), [campos de NRS](https://campnrs.com/import-products-pricebook-data/), [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).
