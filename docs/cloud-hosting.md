# Soluna Cloud en Render

Esta edición incluye el agente de Soluna y una interfaz web renovada. Render
puede desplegar este repositorio directamente mediante `render.yaml` o usar
una imagen Docker creada con el `Dockerfile`.

## Opción 1: este repositorio Git

1. Conectá el repositorio de Soluna en Render y creá un **Blueprint**. Render
   leerá `render.yaml` desde la raíz.
2. Revisá el plan y el disco en el panel antes de crear el servicio.
3. Render instalará las dependencias con `npm ci` e iniciará
   `node bin/soluna-web.js`.
4. En la sección **Environment** del servicio, consultá el valor generado de
   `SOLUNA_WEB_TOKEN`; usalo para ingresar a la URL del servicio.

El Blueprint usa el plan `starter` con un disco persistente de 1 GB. Ese plan
tiene costo. El disco conserva proyectos importados, sesiones y configuración.

## Opción 2: Docker Hub

Necesitás Docker instalado y una cuenta en Docker Hub. Desde la carpeta del
proyecto, reemplazá `TU_USUARIO` y ejecutá:

```sh
docker login
docker build --platform linux/amd64 -t TU_USUARIO/soluna-cloud:1 .
docker push TU_USUARIO/soluna-cloud:1
```

En Render, creá un **Web Service** y elegí **Existing Image**. Indicá
`docker.io/TU_USUARIO/soluna-cloud:1`. Seleccioná `Starter`, agregá un disco
de 1 GB montado en `/var/soluna` y configurá estas variables:

| Variable | Valor |
| --- | --- |
| `SOLUNA_WEB_HOST` | `0.0.0.0` |
| `SOLUNA_HOME` | `/var/soluna` |
| `SOLUNA_WEB_TOKEN` | una clave larga y aleatoria creada por vos |

El servicio escucha el `PORT` asignado por Render. Si elegís desplegar sin
disco, la configuración y las sesiones pueden desaparecer en un reinicio.

## Uso y acceso

Ingresá con el token, elegí un proveedor y configurá su API key si la necesita.
Podés importar repositorios públicos desde la interfaz y cambiar entre
proyectos. La primera versión no incluye importación de repositorios privados.

Mantené el token privado: después de iniciar sesión, Soluna puede ejecutar
comandos de shell dentro de su entorno, sin pedir confirmación adicional.

## Si falla el guardado de una API key

La interfaz muestra el motivo que devuelve el servidor. Si indica `EACCES`,
`EPERM`, `EROFS` o `ENOSPC`, revisá que `SOLUNA_HOME` coincida con el punto de
montaje del disco y que el servicio pueda escribir allí. En el Blueprint es
`/opt/render/project/src/.soluna`; en la imagen Docker es `/var/soluna`.
No compartas la API key ni el token al informar un error.
