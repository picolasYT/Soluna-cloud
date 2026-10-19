# Soluna Cloud con Neon

La página sigue alojada en Render. Neon guarda las cuentas, las sesiones de acceso, las claves API cifradas y el registro de acciones del administrador. Las conversaciones y los archivos generados siguen en `SOLUNA_HOME`, en el disco persistente de Render.

## 1. Crear la base

1. Entrá a https://console.neon.tech y creá un proyecto llamado **Soluna**, con el plan **Free**.
2. Elegí una región cercana a la de tu servicio de Render. Podés conservar la base `neondb` y el usuario que crea Neon.
3. Abrí **Connect**. Elegí la rama, base y usuario del proyecto y activá **Connection pooling** si aparece la opción.
4. Copiá únicamente la dirección que empieza por `postgresql://`. Conservá todos sus parámetros, incluido `sslmode=require` y, si aparece, `channel_binding=require`. La dirección agrupada tiene `-pooler` en el servidor.

No hace falta activar Neon Auth ni ejecutar SQL a mano: Soluna crea sus tablas al arrancar.

## 2. Configurar Render

En el servicio **soluna-cloud**, abrí **Environment → Add Environment Variable** y agregá:

| Variable | Valor |
| --- | --- |
| `DATABASE_URL` | La cadena PostgreSQL completa copiada de Neon, sin comillas y sin el comando `psql`. |
| `SOLUNA_ADMIN_PASSWORD` | Una contraseña privada de entre 10 y 128 caracteres para el usuario `picolas`. |
| `SOLUNA_ENCRYPTION_KEY` | Un secreto aleatorio de al menos 32 caracteres. Usá un generador de contraseñas o `openssl rand -hex 32` si tenés terminal. |

Guardá con **Save, rebuild, and deploy** para instalar también la nueva dependencia PostgreSQL. Si usás el Blueprint `render.yaml`, Render solicita la URL y la contraseña y genera la clave de cifrado.

**Conservá `SOLUNA_ENCRYPTION_KEY`**: debe mantenerse igual en reinicios y despliegues. Cambiarla sin migrar los datos impide descifrar las claves existentes. No publiques estos valores en GitHub, capturas ni mensajes.

No elimines el disco persistente ni cambies `SOLUNA_HOME`. La base de Neon no reemplaza el almacenamiento de archivos del agente. Los datos que solo estén en un sistema de archivos efímero pueden perderse al reiniciar o desplegar.

## 3. Primer acceso

1. Abrí tu URL de Render. Aparece la bienvenida.
2. Tocá **Ingresar** e iniciá sesión como `picolas`, usando `SOLUNA_ADMIN_PASSWORD`.
3. En el menú del chat aparece **Administrar**. Desde ahí podés listar cuentas, habilitarlas o deshabilitarlas y agregar, eliminar o revelar claves API.
4. Las otras personas pueden usar **Crear cuenta**. El nombre `picolas` está reservado: el registro público nunca concede permisos de administrador.

La contraseña de `picolas` se configura **solo al crear su cuenta por primera vez**. Modificar después la variable no sobrescribe una contraseña ya guardada. Si no se configura esa variable, el primer arranque puede usar `SOLUNA_WEB_TOKEN` como contraseña inicial, siempre que tenga al menos 10 caracteres.

Al activar cuentas, Soluna copia las conversaciones y carpetas administradas de la instalación anterior al espacio de `picolas` e importa sus claves. Los archivos originales se conservan. Los chats antiguos que apuntaban al código del servidor no se incorporan al espacio del agente.

## Permisos y límites

- Las contraseñas se guardan con scrypt y una sal aleatoria. Las sesiones usan cookies HttpOnly y tokens aleatorios cuyo hash queda en la base.
- Las claves API se cifran con AES-256-GCM en PostgreSQL. Cada proceso del agente mantiene una configuración privada en su carpeta de cuenta para usarlas; protegé también el disco y sus copias.
- El panel devuelve claves ocultas por defecto. Solo `picolas` puede revelarlas; cada revelación, cambio y bloqueo de cuenta queda registrado. La pantalla de registro informa este acceso administrativo.
- Los usuarios normales pueden crear y editar archivos y usar las vistas previas. Los comandos de shell y MCP quedan reservados al administrador. Los procesos separados aíslan el estado de la aplicación; no sustituyen contenedores del sistema operativo para ejecutar código arbitrario de usuarios.
- El máximo predeterminado es de cuatro agentes residentes. Al necesitar espacio se recicla un proceso inactivo, conservando sus archivos, claves y conversaciones. Si todos trabajan, se devuelve un mensaje de servidor ocupado.
- `SOLUNA_ALLOW_REGISTRATION=false` desactiva nuevos registros. `SOLUNA_MAX_WORKERS` permite ajustar el máximo de procesos entre 1 y 16 según la memoria del servicio.
- Sin `DATABASE_URL`, se conserva el modo personal anterior con token de acceso. No se activa el registro ni el panel multiusuario.

El plan gratuito de Neon tiene cuotas de almacenamiento y procesamiento; revisalas en https://neon.com/pricing. Conservá copias de seguridad acordes al uso de tu aplicación.

## Si algo falla

- **La web sigue abriendo el chat antiguo:** comprobá que el despliegue incluya esta versión y que `DATABASE_URL` esté configurada en el servicio correcto.
- **El servidor no inicia:** revisá que estén las tres variables, que la URL conserve los parámetros TLS y que la base esté disponible. No pegues credenciales en los reportes.
- **No podés entrar como picolas:** usá la contraseña del primer arranque, no una cuenta pública creada después.
- **No se pueden leer claves después de cambiar variables:** recuperá el valor original de `SOLUNA_ENCRYPTION_KEY`.

Referencias: https://neon.com/docs/get-started/connect-neon y https://render.com/docs/configure-environment-variables.
