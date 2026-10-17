# Soluna Cloud en Render

Esta edición incluye el agente de Soluna y una interfaz web renovada. El ZIP es
el código fuente completo. Render **no permite subir un ZIP directamente** como
origen de un servicio: necesita un repositorio Git o una imagen Docker en un
registro. No hace falta usar GitHub.

## Opción 1: GitLab o Bitbucket

1. Descomprimí el ZIP y subí su contenido a un repositorio privado en GitLab o
   Bitbucket. El archivo `render.yaml` debe quedar en la raíz.
2. Conectá ese proveedor en Render y creá un **Blueprint** con el repositorio.
3. Render instalará las dependencias con `npm ci` e iniciará
   `node bin/soluna-web.js`.
4. En la sección **Environment** del servicio, consultá el valor generado de
   `SOLUNA_WEB_TOKEN`; usalo para ingresar a la URL del servicio.

El Blueprint usa el plan `starter` con un disco persistente de 1 GB. Ese plan
tiene costo. El disco conserva proyectos importados, sesiones y configuración.

## Opción 2: sin repositorio Git, usando Docker Hub

Necesitás Docker instalado y una cuenta en Docker Hub. Desde la carpeta
descomprimida, reemplazá `TU_USUARIO` y ejecutá:

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
