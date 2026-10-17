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
