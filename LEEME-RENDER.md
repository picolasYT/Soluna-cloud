# Soluna Cloud — paquete para Render

Descomprimí este archivo. El proyecto incluye la interfaz web, el servidor,
`render.yaml` y un `Dockerfile`.

**Render no recibe archivos ZIP directamente.** Para publicarlo sin tocar
GitHub, tenés dos caminos:

1. Subir la carpeta descomprimida a GitLab o Bitbucket y crear un Blueprint en
   Render usando `render.yaml`.
2. Crear una imagen Docker con el `Dockerfile`, subirla a Docker Hub y elegir
   **Existing Image** al crear un Web Service en Render.

Las instrucciones paso a paso y las variables necesarias están en
[`docs/cloud-hosting.md`](docs/cloud-hosting.md).

El Blueprint usa una instancia Starter paga con disco persistente. Guardá el
token de acceso y las API keys como variables o configuración privada.
