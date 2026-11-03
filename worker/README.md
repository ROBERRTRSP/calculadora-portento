# Activar lectura con IA en Porcento

El lector básico sigue funcionando sin una API. La opción **Leer con IA** requiere configurar un servidor seguro y un proveedor de IA de pago por uso.

## Pasos de activación

1. Crea una cuenta en Cloudflare y abre **Workers & Pages > Create > Worker**.
2. Copia el contenido de `worker/worker.js` al editor del Worker y despliega.
3. En **Settings > Variables and Secrets**, crea un secreto **OPENAI_API_KEY** con una clave propia de la API de OpenAI. **No pegues la clave en GitHub ni en Porcento.**
4. Opcional: agrega `ALLOWED_ORIGIN` con `https://roberrtrsp.github.io`. El código usa ese origen por defecto.
5. Copia la URL HTTPS del Worker, abre `scanner.html`, expande **Configurar conexión IA**, pega la URL y guarda.
6. Sube una factura, toca **Leer con IA**, revisa los datos resaltados en amarillo y confirma costos y cantidades antes de usarlos.

## Límites

- La IA no garantiza 90% de exactitud; mide precisión por línea y campo con facturas reales.
- PDF: por ahora solo se procesa la primera página.
- No se guarda una copia en Porcento, pero la imagen se envía al Worker y al proveedor de IA durante el análisis.
- Este ejemplo no incluye autenticación ni límites de uso por usuario. **No publiques el endpoint para uso general sin agregar controles de acceso y cuotas**: alguien podría consumir tu crédito de API. Puedes configurar límites y protección de acceso en Cloudflare.
- El Worker valida origen de navegador, pero eso por sí solo **no es autenticación**.
- Los precios mostrados son margen bruto antes de gastos e impuestos.
