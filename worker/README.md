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

## Activar búsqueda de múltiples precios en la nube

Porcento incluye el endpoint **GET /prices?upc=012345678905** en `worker/worker.js`, pero requiere desplegarlo y agregar una clave comercial privada.

1. Abre https://serpapi.com/, crea una cuenta y genera tu propia clave API. Su servicio Google Shopping devuelve comerciantes, títulos, precios y enlaces. Consulta cuotas en https://serpapi.com/pricing.
2. Abre **Cloudflare → Workers & Pages → porcento-ia → Settings → Variables and Secrets**. Añade el secreto cifrado **SERPAPI_API_KEY**. No lo escribas en GitHub, en un HTML ni en el chat.
3. Vuelve a desplegar el contenido de `worker/worker.js` **en el mismo Worker existente** y conserva su URL. El lector de facturas seguirá usando su endpoint POST.
4. Actualiza https://roberrtrsp.github.io/calculadora-portento/comparador.html, escanea el UPC y comprueba la sección **Precios de menor a mayor**.

### Funcionamiento

- El Worker busca por UPC en Google Shopping; si la búsqueda no encuentra resultados y se conoce el nombre, realiza como máximo una segunda búsqueda por nombre.
- Entrega hasta 30 resultados con vendedor, precio, nombre, fuente y enlace. La página organiza las ofertas de menor a mayor junto con precios públicos de Open Prices y los que introduces manualmente.
- Si el anuncio no menciona el UPC, **no es una coincidencia confirmada**; revisa que sean la misma presentación y tamaño antes de comparar.
- La caché de Cloudflare conserva respuestas 24 horas para reducir consumo de la API, aunque los distintos centros de datos pueden tener cachés separadas.
- Si falta el secreto SERPAPI_API_KEY o todavía no desplegaste el Worker actualizado, el comparador muestra un aviso y permite las búsquedas y comparaciones manuales.

### Seguridad y costos

SerpApi usa cuotas de búsqueda; una consulta UPC puede consumir una o dos búsquedas. El permiso CORS a GitHub Pages **no es autenticación**: configura límites de peticiones y protección de abuso en Cloudflare antes de compartir el servicio públicamente. Los precios pueden excluir impuestos, envío o disponibilidad local. Walmart, Amazon u otros comercios aparecen solo si Google Shopping los devuelve.
