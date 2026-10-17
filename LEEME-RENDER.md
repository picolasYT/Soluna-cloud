# Soluna Cloud — despliegue en Render

Este repositorio incluye la interfaz web, el servidor, `render.yaml` y un
`Dockerfile`.

Para publicarlo:

1. Conectá `picolasYT/Soluna-cloud` en Render y creá un **Blueprint**. Render
   usará el archivo `render.yaml` y podrá desplegar los cambios de `main`.
2. Como alternativa, creá una imagen con el `Dockerfile`, subila a Docker Hub
   y elegí **Existing Image** al crear un Web Service en Render.

Las instrucciones paso a paso y las variables necesarias están en
[`docs/cloud-hosting.md`](docs/cloud-hosting.md).

El Blueprint usa una instancia Starter paga con disco persistente. Guardá el
token de acceso y las API keys de manera privada.


## Mejoras de Cloud (17/10/2026)

- En Configuración, OpenRouter permite buscar en el catálogo completo, filtrar modelos gratuitos o con herramientas y actualizar la lista sin esperar a que venza la caché. Todos los modelos siguen disponibles si no activás filtros. Los filtros dependen de los datos que informa OpenRouter; un precio cero no garantiza disponibilidad o ausencia de límites.
- El botón **Exportar** descarga la conversación activa en JSON, incluyendo mensajes y uso de tokens. No incluye las claves de configuración.
- Retomar una sesión restaura también su proveedor, modelo y uso. Crear una tarea nueva reinicia los contadores.
- Se corrigieron los comandos `/clear` y `/resume`, el estado de trabajo al finalizar y los errores HTTP que antes se mostraban como envíos exitosos. Si falla el envío, el texto queda disponible para reintentar.
- Los cambios de sesión y modelo durante una tarea reciben un aviso para esperar a que termine.

Validación: `npm test` usa servidores locales y respuestas simuladas de OpenRouter; no consume saldo de API. La conexión real con un proveedor requiere una clave válida en tu instancia.


## Permisos y visualización de cambios

- Los comandos que requieren autorización muestran el comando completo, el motivo y los botones **Permitir una vez** y **Rechazar**. La decisión se recupera al recargar la página. Detener la tarea también cancela la decisión pendiente.
- La web solicita permisos por defecto. `--unsafe` permite desactivar explícitamente las confirmaciones y el aislamiento de rutas; `--no-unsafe` mantiene el comportamiento predeterminado.
- Los cambios de archivos se abren automáticamente y muestran texto agregado (`+`), eliminado (`-`), números de línea y contexto, con colores para ambos temas.
- Se corrigieron los mensajes finales que llegaban sin fragmentos previos o con un texto distinto al último fragmento recibido.


## Recuperación de respuestas de OpenRouter

- Se conservan los errores reales enviados dentro de JSON o SSE, incluso con HTTP 200, y el último evento recibido sin salto de línea.
- Si una transmisión de OpenRouter termina vacía, se intenta una respuesta sin transmisión con el mismo modelo y mensajes. Esto puede generar una solicitud adicional al proveedor. Las llamadas a herramientas y respuestas con texto no se repiten por esta alternativa.
- Agotar el presupuesto de generación sin texto visible muestra un error específico, sin reiterar automáticamente la misma solicitud.
- Los avisos de reintento se actualizan en una sola línea y desaparecen cuando termina el intento.
