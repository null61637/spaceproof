# SpaceProof — Estado y pendientes

Última actualización: 2026-11-13, al cierre de **F3 y F4**, de su auditoría y de la validación final previa a la integración (sección 8). Fases F0 a F4 terminadas y verificadas en local: ya se puede emitir el certificado de un archivo y verificarlo, por API y desde la interfaz. **F5 en adelante sigue sin implementar: no existe integración con Avalanche**, y por eso ninguna verificación devuelve «válido»: el mejor resultado posible hoy es «coincide con el registro de SpaceProof; no verificable en Avalanche». El trabajo de F3 y F4 está en la rama `feat/f3-f4-certification`, pendiente de fusión en `main`.

Este documento es la referencia central: qué está hecho y comprobado, qué se decidió, qué riesgos se conocen, qué falta para terminar el MVP y **qué quedó fuera** (sección 7). Detalle operativo en el [README](../README.md) y en [backups.md](backups.md).

**Alcance de las comprobaciones.** Todo lo marcado como verificado se probó **en local** (Windows + Docker Desktop): en el PostgreSQL de desarrollo, en la base `spaceproof_test` y en un servidor PostgreSQL descartable con volumen nuevo. **Nada se validó en producción** (ni siquiera se inspeccionó el servidor). El CI corrió una vez en GitHub Actions, con éxito.

**Objetivo del MVP:** certificar la integridad de un archivo satelital y de sus metadatos. El servidor calcula el SHA-256 del archivo, lo vincula con los metadatos en un manifiesto, ancla el hash del manifiesto en Avalanche y permite verificar después el original y detectar cualquier modificación. En la blockchain solo van hashes. Demo: original → válido; modificado → inválido; evidencia del anclaje.

Estados usados: **CRÍTICO** (bloquea el funcionamiento o la integridad), **IMPORTANTE** (necesario antes de la entrega o publicación), **POSTERGADO** (no se implementa en esta etapa), **RESUELTO** (implementado y comprobado).

---

## 1. Estado actual

### Funciona y está cubierto por pruebas automatizadas

| Funcionalidad | Evidencia |
|---|---|
| Listar y consultar certificados (API y UI) | e2e `certificates.e2e-spec.ts` |
| **Emitir el certificado de un archivo** (`POST /api/certificates`): cuerpo crudo en flujo, SHA-256 en el servidor, metadatos validados antes de leer el cuerpo, firma TIFF, límite de 200 MB por `Content-Length` y por bytes recibidos, un único `INSERT` al terminar. Contrato en [API_EMISION_VERIFICACION.md](API_EMISION_VERIFICACION.md) | Unit `file-upload.spec.ts`, `metadata-header.spec.ts`, `certificates.service.spec.ts`; e2e `certificates.e2e-spec.ts` (incluye 200 MB reales aceptados y 200 MB + 1 byte rechazados) |
| **Verificar un archivo** (`POST /api/certificates/:id/verify-file`): original → coincide; un bit cambiado, un byte de más o de menos, otro archivo → `FILE_MISMATCH`; registro inconsistente → `RECORD_MISMATCH` | Unit y e2e, ídem |
| Cargas rechazadas o interrumpidas no dejan ninguna fila | e2e: metadatos inválidos, sin firma TIFF, vacío, demasiado grande, conexión cortada (con y sin `Content-Length`) |
| El archivo no se guarda: ni columna binaria, ni escritura a disco, ni acumulación en memoria | e2e (esquema sin `bytea`/`oid`, fila < 1 KB, ningún archivo abierto para escritura durante emisión y verificación, RSS estable con 200 MB) |
| Sin integración de cadena o con error de RPC el resultado es `UNVERIFIABLE`, nunca `VALID` | Unit y e2e con un lector de anclaje falso (override de proveedor de Nest) |
| `GET /api/certificates/:id/manifest` devuelve el texto exacto cuyo SHA-256 es el hash del certificado | Unit (vector A de la especificación) y e2e |
| Certificados v1: se listan, consultan y verifican igual; `verify` conserva `valid` | e2e `certificates.e2e-spec.ts` («version-1 certificates»), `db-privileges` |
| Los logs no contienen metadatos, nombre de archivo ni el valor de la cabecera | e2e `observability.e2e-spec.ts` (emisión correcta, rechazos y errores de base) |
| Hash SHA-256 canónico v1 (`id`, `title`, `recipient`, `createdAt`; NFC) calculado solo en el servidor | Unit `certificate-hash.spec.ts` (vector conocido calculado con `sha256sum`); e2e rechaza `contentHash`/`id`/`txHash` enviados por el cliente |
| Manifiesto v2 (archivo + metadatos) y selección de la función de hash por `hashVersion`; especificación en [manifiesto-v2.md](manifiesto-v2.md) | Unit `certificate-hash.spec.ts`: tres vectores calculados fuera del código (`sha256sum` y `hashlib` sobre el texto de la especificación), determinismo (NFC/NFD, orden de entrada, husos horarios), sensibilidad a cada uno de los once valores, rechazo de valores sin forma canónica, y el vector v1 sin cambios |
| Esquema para certificados de archivo: `hashVersion`, hash, tamaño y nombre del archivo, metadatos; `CHECK` de forma por versión; inmutabilidad extendida a las columnas nuevas; ninguna columna binaria ni tabla de archivos | e2e `db-privileges.e2e-spec.ts` T16–T20 |
| `verify` y `verify:certificates` verifican cada certificado con la función de su versión (v1 y v2) | Unit `certificate-audit.spec.ts`; e2e T17 (v2 válido y v2 con metadatos alterados) |
| La migración de F2 no altera certificados v1 existentes | Ensayo en `spaceproof_test`: esquema anterior, 3 certificados v1, migración aplicada; columnas anteriores idénticas, los 3 con `hashVersion` 1 y `verify:certificates` 3/3 válidos |
| Verificación de un certificado (`GET /api/certificates/:id/verify`), incluido `valid:false` | e2e T13 (registro insertado con hash que no corresponde) |
| Inmutabilidad: trigger bloquea `UPDATE` de campos protegidos; `txHash` solo una vez | e2e T8, T9 |
| `DELETE` y `TRUNCATE` bloqueados por permisos y por trigger (también para el owner) | e2e T7, T10 |
| Roles separados: `spaceproof_app` (solo `SELECT`, `INSERT`), `spaceproof_owner` (migraciones), superusuario solo para bootstrap | e2e T1–T6, T11 |
| Sin acceso de `PUBLIC` a las bases; app sin `CONNECT` a `postgres`, `template1`, shadow; funciones sin `EXECUTE` público | e2e T14, T15 |
| Bootstrap idempotente (`db/init/10-roles.sh`) en volumen existente y en volumen nuevo (`initdb` de la imagen oficial) | Ejecutado 3+ veces en cada caso con estado idéntico; 75/75 e2e en servidor nuevo |
| Base de tests aislada y reconstruida en cada ejecución; guard contra otra base, host, rol o parámetros `?host=`/`?user=` | e2e `test-env.e2e-spec.ts`; ejecución real con `?host=` abortada antes de conectar |
| Protección CSRF de la API: `image/tiff` en las dos rutas de archivo y `application/json` en cualquier otra escritura (415 en otro caso), sin CORS | e2e `csrf.e2e-spec.ts`; la vulnerabilidad se reprodujo antes de corregirla (201 con formulario) |
| Healthchecks `/api/health/live` y `/api/health/ready` (`SELECT 1`, límite 2 s) | Unit `health.controller.spec.ts`; e2e `observability.e2e-spec.ts` |
| Logs de errores con `requestId`, código Prisma y SQLSTATE, sin cuerpos de solicitud | e2e `observability.e2e-spec.ts` (comprueba que no aparecen datos personales) |
| Verificación masiva de solo lectura (`pnpm verify:certificates`) | Unit y e2e `certificate-audit`; mismo resultado en origen y copia restaurada |
| Backup y restauración en base nueva | Simulacro en servidor descartable: catálogo, permisos, triggers, migraciones y datos idénticos |
| Migraciones sincronizadas con el schema | `prisma migrate status` y `migrate diff` (contra la base y contra la shadow) sin diferencias, en dev y en servidor nuevo |
| Lint y build de backend y frontend; build del frontend sin backend | Ejecutados localmente |

Últimos resultados (validación final de F3 y F4): **179/179 unitarios** y **169/169 e2e** del backend, y lint y build de backend y frontend sin errores, **en dos entornos**: el de desarrollo (Windows, base `spaceproof_test`) y una reproducción local de los jobs del CI en contenedores Linux (Node 22, pnpm 10.27.0, PostgreSQL 17 con volumen nuevo: bootstrap en `initdb` y repetido, las 6 migraciones desde cero, sin drift). No hubo migraciones nuevas. El CI de GitHub Actions corre sobre el pull request de `feat/f3-f4-certification`; su resultado no figura en este documento, que se escribió antes. Detalle en la sección 8.

### Comprobado solo manualmente

- **Interfaz en un navegador real** (Edge sin interfaz gráfica, manejado por un script que no forma parte del repositorio): validación de campos, firma TIFF y extensión antes de enviar; progreso y cancelación con un archivo de 120 MB; emisión y redirección al certificado; verificación del original (panel ámbar «No verificable en Avalanche», nunca verde), de una copia con un bit cambiado y de otro archivo (panel rojo); certificado v1; certificado inexistente; sin errores de consola. 33 de 33 comprobaciones. **No hay pruebas automatizadas del frontend en el repositorio.**
- **Subida de 200 MB por la cadena completa** Caddy → Next → backend (Caddy 2.11 en un contenedor descartable con las directivas del `Caddyfile` y solo el upstream cambiado; Next y backend como procesos locales contra `spaceproof_test`): `201` con el SHA-256 correcto; memoria de Caddy estable (~11 MiB), Next +8 MB, backend +18 MB; ningún archivo nuevo en el contenedor ni en el directorio temporal. **No es el stack de producción**: sin TLS ni las imágenes Docker reales.
- **Rechazos e interrupciones a través del proxy de Next**: metadatos inválidos, más de 200 MB (con y sin `Content-Length`), certificado inexistente y corte del cliente a mitad de la subida: el estado real llega al cliente y no queda ninguna fila. Un cuerpo sin fin tras un rechazo se corta a los ~5 s con memoria estable.
- **Proxy `/api/*` del frontend**: preflight de otro origen sin cabeceras CORS; formularios y `text/plain` → 415; `DELETE` → 405.

### Validado solo de forma estática

- **`.github/workflows/ci.yml`**: pasa `actionlint` (con shellcheck), y sus pasos se reprodujeron localmente. Corrió una vez en GitHub (PR de `checkpoint/phase-3b-3d`, 2026-11-13): exitosa.
- **`docker-compose.prod.yml`**: `docker compose config` resuelve con valores ficticios. **No se levantó** el stack de producción.

### No comprobado

- El estado del servidor de producción, si existe un despliegue activo y qué datos contiene.
- El flujo completo desde un navegador real (todas las pruebas fueron por HTTP).

---

## 2. Decisiones tomadas

No reabrir sin una razón concreta (un fallo, un requisito nuevo o un costo demostrado).

| Decisión | Motivo |
|---|---|
| **Tres roles fijos de PostgreSQL**: superusuario (`POSTGRES_USER`) solo para bootstrap; `spaceproof_owner` propietario y migraciones; `spaceproof_app` en ejecución | La app no puede desactivar triggers ni modificar el esquema. Los nombres son fijos porque las migraciones los referencian |
| **`spaceproof_app` solo `SELECT` e `INSERT`**; sin `UPDATE`, ni siquiera de `txHash` | Nada en la app escribe `txHash`; el anclaje se rediseñará (ver pendientes) |
| **Certificados no borrables** (`DELETE`/`TRUNCATE` bloqueados por permisos y triggers) | Un certificado es evidencia |
| **Procedimiento de borrado por solicitudes legales o de privacidad: pospuesto** | Decisión explícita de fase 3B |
| **Se acepta temporalmente** que un rol con `INSERT` guarde un hash arbitrario | La base no recalcula el hash; la prueba T13 documenta y verifica el comportamiento |
| **Permisos de tablas explícitos en cada migración**; sin `ALTER DEFAULT PRIVILEGES` para tablas | Evita conceder acceso por defecto a tablas futuras; la prueba T11 detecta cualquier diferencia. (Para funciones sí se revoca `EXECUTE` público por defecto) |
| **Bootstrap idempotente** en `db/init/10-roles.sh`, automático en volumen nuevo y manual (`pnpm db:bootstrap`) en uno existente | Un solo script para ambos casos; `REASSIGN OWNED` no sirve con el superusuario de bootstrap |
| **La base de desarrollo se migró in-place**; no se recrea el volumen | Conservar datos y ensayar el procedimiento de producción |
| **Base `spaceproof_test` independiente**, reconstruida antes de cada e2e borrando su esquema como owner | Las filas no se pueden borrar; nunca se toca `spaceproof` |
| **Base `spaceproof_shadow`** para `prisma migrate dev`, solo para el owner | El owner no tiene `CREATEDB` |
| **CLI de Prisma con `MIGRATION_DATABASE_URL`** (sin caer en `DATABASE_URL`); NestJS solo con `DATABASE_URL` | Separación real de credenciales; un error de configuración falla de forma visible |
| **Producción solo con `prisma migrate deploy`**; no se editan migraciones aplicadas | `deploy` no borra datos; los checksums deben coincidir |
| **CSRF**: escrituras de la API solo en JSON, sin CORS; las Server Actions dependen de la comprobación de `Origin` de Next.js | La autenticación básica de Caddy hace que el navegador envíe credenciales automáticamente |
| **Origen único**: el navegador solo habla con Next.js, que reenvía `/api/*` | Sin CORS |
| **Healthchecks separados** (`live` sin base, `ready` con `SELECT 1`); `/api` se mantiene | El healthcheck actual de producción usa `/api` |
| **Healthcheck de PostgreSQL por TCP** (`pg_isready -h 127.0.0.1`) en desarrollo | Durante `initdb` el socket responde antes de que termine el bootstrap (medido) |
| **Logs sin cuerpos de solicitud ni mensajes de Prisma**; JSON en producción | Los cuerpos contienen datos personales; el mensaje de Prisma puede citar argumentos |
| **Backups con `pg_dump -Fc`**; restaurar siempre en base nueva; **nunca `pg_restore --clean`** sobre `spaceproof` o producción | `DROP` no dispara los triggers de borrado |
| **Hash canónico v1** (JSON con orden fijo, NFC, fecha ISO UTC en ms); el cliente nunca envía el hash | Determinismo; cambiar el formato exige una versión nueva |
| **PostgreSQL de desarrollo solo en `127.0.0.1`** (puerto 5433 en esta máquina, porque el 5432 lo usa un PostgreSQL nativo) | No exponer la base en la red local |
| **Gestores de paquetes**: pnpm en backend, npm en frontend y raíz; instalaciones con lockfile congelado | Respetar los lockfiles existentes |

### Decisiones del MVP (2026-11-13)

Las cinco primeras son decisiones de producto; el resto, las decisiones técnicas del plan (detalle en la sección 4).

| Decisión | Motivo |
|---|---|
| **Se certifican archivos completos y sus metadatos, vinculados** (cierra D1) | Solo metadatos no demuestra la integridad del dato original |
| **SHA-256 del archivo calculado en el servidor**, en streaming; el cliente nunca envía un hash | Un hash enviado por el cliente no prueba nada |
| **Manifiesto** que contiene el hash del archivo y los metadatos; su SHA-256 es lo que se certifica y se ancla | Un cambio en el archivo *o* en un metadato cambia el hash anclado |
| **Avalanche es la única blockchain del MVP** (testnet Fuji) | Una cadena alcanza para demostrar el anclaje |
| **Soporte inicial limitado**: GeoTIFF/COG (`.tif`, `.tiff`), hasta 200 MB | Un archivo autocontenido, formato de distribución habitual, validable sin librerías |
| En la blockchain solo hashes, nunca archivos ni datos personales | Costo, privacidad e irreversibilidad |
| Subida como cuerpo crudo `image/tiff`, no multipart | Conserva la protección CSRF sin dependencias |
| Hash v2 con orden de claves fijo, sin decimales; columna `hashVersion`; v1 intacto | Determinismo sin librería de canonicalización; lo anclado no se migra |
| Contrato propio mínimo, solo-owner, un anclaje por hash | Idempotencia en la cadena; presencia = emitido por SpaceProof |
| `viem` (backend) y Hardhat (paquete aislado `contracts/`) como únicas dependencias nuevas | Firmar y enviar transacciones EVM; compilar, probar y verificar el contrato |
| Anclaje dentro del backend, con tabla `Anchor` de estados; `spaceproof_app` con `UPDATE` solo en columnas mutables de `Anchor` | Sin procesos ni roles nuevos; modifica la decisión «solo `SELECT` e `INSERT`» únicamente para esa tabla |
| La verificación lee la cadena en vivo; si no puede, responde «no comprobable», nunca «válido» | No depender de la base para lo que la cadena debe probar |
| **SpaceProof NO conserva los archivos originales** (D2, confirmada el 2026-11-13). Los bytes solo pasan por memoria mientras se calcula el hash: nunca van a PostgreSQL, disco, volúmenes, temporales ni backups. El usuario conserva su original y lo vuelve a subir para verificar | Verificar no requiere una copia; sin copia no hay nada que sustituir, almacenar ni respaldar |
| **Emisión en una única operación**: `POST /api/certificates` con el archivo como cuerpo y los metadatos en una cabecera. Sin tabla intermedia ni `fileId` | No queda estado entre «subir» y «certificar»: no hay registros huérfanos, ni caducidades, ni referencias reutilizables |
| **Solo se comprueba la firma TIFF**, y se llama así. No se afirma que el archivo sea un GeoTIFF/COG válido | Validar el formato de verdad exige interpretar el archivo; la integridad no depende de eso |
| **Promesa del producto acotada** (sección 4): el archivo y los metadatos coinciden con lo certificado y anclado. No se promete procedencia, veracidad de los metadatos ni autoría | No presentar como implementado lo que el sistema no puede probar |

---

## 3. Limitaciones y riesgos conocidos

| # | Problema | Qué podría suceder | Afecta a | Acción necesaria |
|---|---|---|---|---|
| R1 | El hash vive en la misma base que los datos, sin anclaje externo | Quien controle la base (owner o superusuario) cambia datos y recalcula el hash, y la verificación da `valid:true`. **El producto todavía no prueba nada frente a ese actor** | Ambos | Anclaje en Avalanche (F5, F6) |
| R2 | `docker-compose.prod.yml` no está adaptado a los roles | Un `git pull` seguido de `migrate` falla (no hay `MIGRATION_DATABASE_URL`, y las migraciones nuevas exigen roles inexistentes). Prisma puede dejar una migración marcada como fallida | Producción | Adaptar producción (P1) |
| R3 | El healthcheck de PostgreSQL en producción usa el socket | En una instalación nueva, `migrate` o `backend` podrían arrancar antes de que existan los roles (carrera medida en desarrollo) | Producción | `pg_isready -h 127.0.0.1` al adaptar producción (P1) |
| R4 | El backend de producción todavía se conectaría como superusuario | Un fallo en la app tendría privilegios totales sobre la base | Producción | Usar la URL de `spaceproof_app` (P1) |
| R5 | **Todo el trabajo desde la fase 3B está sin commit** (36 rutas; el único commit es el inicial) | Una limpieza del working tree o un fallo de disco pierde el hardening, las migraciones nuevas y las pruebas | Ambos | **RESUELTO** (S13): commit `15cb52c` con push |
| R6 | El CI nunca corrió en GitHub | Algo puede diferir en los runners (descarga de motores de Prisma, Docker), y nadie se entera hasta el primer push | Ambos | **RESUELTO** (S14): primera ejecución exitosa |
| R7 | ~~Sin versión de hash almacenada; `verify()` asume v1~~ | — | — | **RESUELTO** (S16, S17): columna `hashVersion`, especificación escrita y verificación por versión |
| R8 | `txHash` es un único campo que solo se completa una vez | Una transacción fallida o reemplazada deja el certificado asociado para siempre a un `txHash` incorrecto | MVP | Tabla `Anchor` con estados (F6) |
| R9 | ~~La interfaz no permite verificar~~ | — | — | **RESUELTO** en F4 para el archivo y el registro (S19). La evidencia del anclaje es F7 |
| R10 | Un rol con `INSERT` puede guardar un hash arbitrario (aceptado) | Un registro inconsistente se guarda sin error; la verificación lo marca `valid:false` | Ambos (bajo) | Aceptado. El anclaje solo debe registrar hashes calculados por el servidor |
| R11 | El owner puede `DROP TABLE`/`DROP SCHEMA`; `prisma migrate reset` borra desarrollo | Un comando equivocado con la credencial owner pierde datos | Ambos | Documentado. En producción: credencial owner solo en el contenedor `migrate`, y backup antes de migrar |
| R12 | Backups: cifrado, copia externa y retención solo documentados | Un dump sin cifrar en el servidor expone datos personales; sin copia externa, perder el servidor es perder los datos | Producción | Automatizar backup cifrado y externo (I1) |
| R13 | Autenticación única compartida (basic auth de Caddy) y sin identidad de emisor | Cualquiera con la credencial emite certificados, y no queda registro de quién lo hizo | Ambos | Aceptado para el MVP como demo cerrada; identidad de emisores POSTERGADA (sección 7) |
| R14 | Sin rate limiting ni paginación | Con la credencial se puede llenar la base (y los certificados no se pueden borrar); el listado devuelve todos los nombres | Producción | Limitar escrituras y paginar (I3) |
| R15 | Sin logs de acceso (Caddy sin `log`, backend sin línea por solicitud) | No se puede reconstruir un incidente | Producción | `log` en Caddy (I2) |
| R16 | El superusuario puede entrar por TCP (`pg_hba host all all all`) | Una contraseña de administrador filtrada sirve desde la red interna de Docker | Producción | Restringir el superusuario al socket local (I4) |
| R17 | ~~Se aceptan caracteres de control o de bidireccionalidad~~ | — | — | **RESUELTO** en F3 (I5): el DTO rechaza controles, formato bidireccional y sustitutos sueltos en todos los textos. Otros caracteres invisibles (espacio de ancho cero, U+200B–U+200D) se siguen aceptando: algunos sistemas de escritura los necesitan |
| R18 | ~~El hash cubre solo metadatos: no certifica archivos~~ | — | — | **RESUELTO** en F3 (S18) |
| R19 | La comprobación de `Origin` de las Server Actions no tiene prueba automatizada | Una actualización de Next.js podría cambiarla sin que nadie lo note | Ambos (bajo) | Prueba automatizada del frontend (postergado) |
| R20 | ~~Subida de hasta 200 MB a través de Caddy y del proxy de Next sin probar~~ | El riesgo **se materializó** y se corrigió: `rewrites()` de Next copia el cuerpo en memoria y lo corta a los 10 MB (una subida de 11 MB fallaba con 500); la suposición sobre `proxy.ts` era incorrecta. Además, `fetch` retiene una segunda copia del cuerpo salvo con `redirect: "error"` y `window: null` (199 MB retenidos frente a ~15 MB) | — | **RESUELTO** en local (sección 8): Route Handler en flujo en lugar de `rewrites()`. Falta repetir la medición en el stack de producción real (P1) |
| R21 | Fondos de prueba en Fuji | El faucet oficial puede exigir saldo en mainnet o un cupón; sin AVAX de prueba no hay anclaje ni demo | MVP | Conseguir fondos **ya** (próximo paso 2), antes de escribir el contrato |
| R22 | La clave privada que firma los anclajes vive en una variable de entorno del backend | Un compromiso del backend permite anclar hashes arbitrarios en nombre de SpaceProof | Ambos | Aceptado para el MVP: clave exclusiva de Fuji, sin fondos reales, nunca en Git. Custodia de claves postergada |
| R23 | Dependencia del RPC público de Fuji | Si el RPC no responde, el anclaje queda pendiente y la verificación no puede confirmar la cadena | MVP | La verificación responde «no se pudo comprobar» (nunca «válido»); el anclaje reintenta. Aceptado |
| R24 | Los metadatos los declara quien emite; no se extraen del archivo ni se contrastan con nada | El certificado prueba que *estos* metadatos quedaron ligados a *este* archivo, no que sean verdaderos, ni que el archivo venga de un satélite, ni quién lo produjo | MVP | Aceptado. Se documenta en «Qué demuestra y qué no» (sección 4), en la interfaz y en el README |
| R25 | El servidor no conserva el archivo (D2, confirmada) | Quien pierde el original no puede volver a verificarlo; SpaceProof no es un repositorio ni un backup | MVP | Aceptado por diseño; se informa al emitir |
| R26 | Solo se comprueba la firma TIFF (4 bytes) | Se puede certificar un TIFF que no sea GeoTIFF, o uno corrupto. No afecta a la integridad: el hash cubre los bytes tal cual | MVP (bajo) | Aceptado. La interfaz y la API dicen «firma TIFF», nunca «GeoTIFF validado». Validación real postergada |
| R27 | El tiempo máximo de solicitud de Node (`requestTimeout`, 5 minutos por defecto) corta las subidas lentas. **Medido** en la validación final | Una subida de 200 MB que dura 240 s termina bien; una de 340 s se corta a los ~326 s con `408`, tanto directa al backend como a través de Next. 200 MB exigen unos 5,5 Mbit/s sostenidos de subida. El corte no deja ningún registro y la interfaz lo explica | MVP (medio) | **Pendiente de decisión.** Subir `requestTimeout` solo en el backend no alcanza: el servidor de Next aplica el mismo límite y su modo standalone no ofrece una opción documentada para cambiarlo. Alternativas: un servidor propio para Next, o que Caddy enrute las dos rutas de archivo directo al backend (cambia producción) y subir ahí el límite. Para la demo (archivo chico) no afecta |
| R28 | Si la respuesta de una emisión se pierde después de crear el certificado, reintentar crea un segundo certificado del mismo archivo | Dos certificados válidos para un mismo archivo (cada uno con su `id` y su anclaje) | MVP (bajo) | Aceptado: ambos son verdaderos. La interfaz desactiva el botón mientras envía |
| R29 | Los metadatos viajan en la cabecera `X-SpaceProof-Metadata` (base64url, no cifrado) | Cualquier intermediario que registre cabeceras guarda título, destinatario y nombre de archivo. Caddy registra las cabeceras de la solicitud cuando se activa `log` | Producción | Al hacer I2, excluir esa cabecera del log de Caddy (filtro de formato). El backend y Next no la registran (probado en el backend) |
| R30 | El adaptador de cuerpo de Next (`NodeNextRequest.stream()`) no aplica contrapresión | Si el backend leyera más lento que el cliente, Next acumularía la diferencia en memoria. No se observó: el backend solo calcula un hash y es más rápido que cualquier subida real | MVP (bajo) | Aceptado. La alternativa ya prevista sigue disponible: que Caddy enrute las dos rutas de archivo directo al backend (cambia la configuración de producción) |
| R31 | Un rechazo temprano hace que el servidor siga leyendo y descartando hasta 5 s antes de cerrar | Ancho de banda desperdiciado durante ese lapso; memoria constante | Ambos (bajo) | Aceptado: sin esa espera el cliente y el proxy ven un corte de conexión en lugar del error real (medido) |
| R32 | Con una versión de hash desconocida, verificar responde `500` | No hay hoy ninguna forma de crear esa fila (`CHECK` de la base), pero el mensaje al usuario sería genérico | Ambos (bajo) | Aceptado; decisión de F1 («no confundir no comprobable con alterado») |
| R33 | La fecha de adquisición declarada puede ser futura | Metadato inverosímil certificado tal cual | MVP (bajo) | Aceptado: los metadatos son declarados (R24) |
| R34 | La prueba e2e de memoria (RSS < 100 MB con 200 MB) depende del recolector de Node | Podría fallar de forma intermitente en otro entorno | Ambos (bajo) | Pasó en todas las ejecuciones: en Windows y 3 veces seguidas en un contenedor Linux con Node 22, como el CI. Falta verla en un runner real de GitHub |

---

## 4. Arquitectura del MVP (planificada el 2026-11-13; **implementada hasta F4**, ver sección 8)

Lo relativo a Avalanche (anclaje, tabla `Anchor`, apartado D, estados `VALID`/`PENDING` reales, evidencia en la interfaz) **no está implementado**. Donde este plan y la sección 8 difieran, vale la sección 8.

### Qué demuestra SpaceProof y qué no

**Demuestra:** que un archivo y sus metadatos coinciden, bit a bit, con lo que se certificó, y que el hash de ese certificado quedó registrado en Avalanche en una fecha determinada.

**No demuestra por sí mismo:**

- que el archivo provenga realmente de un satélite;
- que los metadatos declarados sean verdaderos;
- quién produjo originalmente la imagen.

Estas tres capacidades **no están implementadas ni planificadas** en el MVP, y ni la interfaz, ni el README, ni la demo deben sugerirlas. Tampoco se afirma que el archivo sea un GeoTIFF válido: solo que tiene firma TIFF.

### Flujo definitivo

```
Emisión — una sola solicitud
  navegador ── POST /api/certificates ──▶ backend
                 Content-Type: image/tiff
                 X-SpaceProof-Metadata: base64url(JSON con metadatos y nombre del archivo)
                 cuerpo = bytes del archivo
    1. Antes de leer el cuerpo: valida metadatos y Content-Length (≤ 200 MB). Si falla, 400/413.
    2. Lee el cuerpo en streaming: comprueba la firma TIFF en los primeros 4 bytes,
       actualiza el SHA-256 y cuenta los bytes. Cada bloque se descarta al procesarlo.
    3. Al terminar: arma el manifiesto v2, calcula contentHash e inserta
       Certificate + Anchor(PENDING) en una transacción. Responde 201.
    4. Anclaje: anchor(contentHash) en el contrato de Avalanche Fuji.
       Anchor: PENDING → SUBMITTED (txHash) → CONFIRMED (bloque).

Verificación — el usuario vuelve a subir su archivo
  navegador ── POST /api/certificates/:id/verify-file  [cuerpo = bytes] ──▶ backend
    a) SHA-256 del archivo recibido (en streaming, sin guardarlo) == fileSha256 certificado
    b) manifiesto recalculado desde la base == contentHash guardado
    c) contrato.anchoredAt(contentHash), leído en vivo de la cadena, ≠ 0
```

Lo único que se conserva de un archivo: su SHA-256, su tamaño, su nombre y los metadatos declarados.

### Sin almacenamiento de archivos (D2 — RESUELTA el 2026-11-13)

**SpaceProof no conserva los archivos originales.** El usuario es responsable de guardar su original y debe volver a subirlo cuando quiera verificarlo.

| Regla | Cómo se cumple |
|---|---|
| Los bytes no se guardan en ningún lado | El cuerpo de la solicitud se procesa como flujo: cada bloque pasa por el hash y se descarta. No hay escritura a disco, ni directorio temporal, ni columna binaria, ni volumen para el backend |
| Sin temporales persistentes | No se usa ningún componente que acumule el cuerpo (ni analizador multipart, ni buffer completo en memoria). Memoria constante, independiente del tamaño |
| Sin bytes en backups | Los backups son de PostgreSQL, que solo contiene hash, tamaño, nombre y metadatos |
| Sin contenido en logs | Se mantiene la regla actual: no se registran cuerpos. Tampoco el valor de la cabecera de metadatos ni el nombre del archivo (son datos del usuario). Sí se pueden registrar `requestId`, tamaño y resultado |
| Los intermediarios tampoco guardan | Caddy y el proxy de Next deben reenviar el cuerpo en flujo; se comprueba en F3 (R20) |
| Carga interrumpida | El certificado se inserta **solo** cuando el cuerpo terminó completo. Si la conexión se corta antes, el estado parcial del hash se descarta y no queda **nada**: ni fila, ni archivo, ni anclaje. El usuario reintenta desde cero. Sin subidas reanudables |
| La verificación no depende de una copia | Compara el archivo que presenta el usuario con el hash certificado y con la cadena. Un tercero puede hacer lo mismo sin SpaceProof (sección D) |
| Sustitución del archivo | No hay copia en el servidor que alguien pueda reemplazar. La referencia es el hash, en una fila inmutable y en la cadena |

### Vinculación entre carga y certificado: una única operación

Se evaluaron dos alternativas; ninguna guarda el archivo.

| | Registro temporal de carga (`/api/files` → `fileId` → `/api/certificates`) | **Emisión en una única operación (elegida)** |
|---|---|---|
| Estado intermedio | Una tabla extra con hash, tamaño y nombre, más sus triggers, permisos y pruebas | Ninguno |
| Cargas abandonadas | Dejan filas huérfanas; hace falta caducidad o limpieza | No dejan nada |
| Referencia reutilizable | El `fileId` es una credencial al portador: hay que decidir si se usa una vez, cuánto dura y quién puede usarlo | No existe |
| Atomicidad | Dos solicitudes; la segunda puede fallar o no llegar nunca | Un `INSERT` en una transacción, o nada |
| Error en los metadatos | Se detecta después de haber subido el archivo | Se detecta **antes** de leer el cuerpo: las cabeceras llegan primero |
| Costo | — | Los metadatos viajan en una cabecera, no en el cuerpo |

**Por qué una cabecera.** El cuerpo es el archivo. Las alternativas para los metadatos son peores: en la URL quedarían datos personales en logs e historial; con multipart haría falta un analizador en streaming y se perdería la protección CSRF (multipart es un tipo «simple»). La cabecera lleva el JSON en base64url (admite cualquier carácter Unicode), ocupa menos de 2 KB con los límites de longitud del DTO, y al ser una cabecera propia obliga al navegador a hacer preflight, igual que `image/tiff`. Una vez decodificada, se valida con el mismo DTO y las mismas reglas que hoy.

Consecuencia: el cliente nunca envía un hash ni una referencia a una carga previa; el servidor solo certifica bytes que acaba de leer él mismo.

### A. Archivos

| Tema | Decisión |
|---|---|
| Formato admitido | **GeoTIFF / COG** (`.tif`, `.tiff`), TIFF clásico y BigTIFF. Es un único archivo autocontenido (la georreferencia va dentro), es el formato de distribución habitual de Landsat, Sentinel-2 (COG) y proveedores comerciales. Se descartan para el MVP: SAFE/ZIP (varios archivos, gigabytes), JPEG 2000, NetCDF/HDF5 |
| Qué se comprueba | **La firma TIFF**: extensión + primeros 4 bytes (`49 49 2A 00`, `4D 4D 00 2A`, `49 49 2B 00`, `4D 4D 00 2B`). Es un filtro de entrada, **no una validación del formato**: no confirma que el archivo sea un TIFF íntegro, ni que tenga georreferencia, ni que sea un COG. Así se nombra en el código, la API y la interfaz («firma TIFF»); en ningún lado se dice «GeoTIFF válido» |
| Por qué no se valida de verdad | Exigiría interpretar el archivo (directorios IFD, etiquetas GeoKey), que en un TIFF clásico pueden estar al final: obligaría a guardar el archivo o a sumar una librería. La integridad no lo necesita: el hash cubre los bytes sean lo que sean. Postergado (sección 7) |
| Tamaño | Máximo **200 MB**. Se rechaza con 413 por `Content-Length` antes de leer, y también durante el streaming si se supera. Se rechaza el archivo vacío. La demo usa un archivo chico (< 20 MB) |
| Transporte | Cuerpo crudo con `Content-Type: image/tiff`, **no multipart**. `image/tiff` no es un tipo «simple» de CORS: exige preflight igual que JSON, así que se conserva la protección CSRF actual. `requireJsonWrites` admite `image/tiff` solo en las dos rutas de archivo (`POST /api/certificates` y `verify-file`). Sin dependencias nuevas (`node:crypto` + streams) |
| Hash | SHA-256 en streaming en el servidor, memoria constante. El cliente nunca envía un hash |
| Subida desde la UI | `fetch` del navegador a `/api/certificates` (mismo origen) y redirección a la página del certificado. Ya no pasa por la Server Action (límite de cuerpo de 1 MB), que deja de usarse para emitir |
| Certificados v1 | Los existentes se conservan y siguen verificando. Deja de ser posible emitir certificados sin archivo |

### B. Metadatos y manifiesto (hash v2)

Manifiesto canónico v2 — JSON con **orden de claves fijo**, construido por código (misma técnica que v1, sin dependencia de canonicalización):

```json
{"v":2,"id":"<uuid>","createdAt":"<ISO UTC ms>",
 "file":{"sha256":"<64 hex>","sizeBytes":123},
 "metadata":{"title":"…","recipient":"…","satellite":"…","sensor":null,"sceneId":null,"acquiredAt":"<ISO UTC ms>"}}
```

- `contentHash = SHA-256(UTF-8 del manifiesto)`. Es lo que se ancla.
- Textos en NFC y sin espacios extremos; fechas ISO-8601 UTC con milisegundos; `sizeBytes` entero; opcionales ausentes = `null` (la clave siempre está). **Sin números decimales** (por eso no hay coordenadas en v2): evita la única parte difícil de la serialización determinista.
- El nombre del archivo se guarda como dato informativo, **fuera** del manifiesto: renombrar el original no invalida el certificado.
- El `id` (UUID aleatorio) dentro del manifiesto actúa como sal: el hash publicado en la cadena no permite adivinar los datos personales por fuerza bruta.
- Versionado: columna `hashVersion` (1 para los existentes, 2 para los nuevos); `verify()` elige la función por versión. v1 no se toca y sus pruebas se conservan. Un formato futuro (coordenadas, varios archivos) es v3, sin migrar lo anclado.
- El manifiesto no se guarda: se reconstruye desde las columnas (como hoy v1) y se expone en `GET /api/certificates/:id/manifest` para que un tercero lo re-hashee por su cuenta.
- Especificación escrita con vectores de prueba: [manifiesto-v2.md](manifiesto-v2.md) (hecha en F1). Es la referencia normativa; este resumen no la sustituye.

### C. Base de datos

| Elemento | Plan |
|---|---|
| `Certificate` (columnas nuevas) | `hashVersion INT NOT NULL DEFAULT 1`, `fileSha256 CHAR(64)`, `fileSizeBytes BIGINT`, `fileName`, `satellite`, `sensor`, `sceneId`, `acquiredAt` (todas nulas en v1). **Ninguna columna binaria.** La función `certificate_prevent_tampering` se reemplaza para cubrirlas. `CHECK`: v2 exige hash y tamaño de archivo, satélite y fecha. No hay tabla de archivos ni de cargas |
| `Certificate.txHash` | Deja de usarse; la columna queda (no se borra ni se edita una migración aplicada). La UI lee de `Anchor` |
| `Anchor` (nueva) | `id`, `certificateId` **UNIQUE**, `chainId` (43113), `contractAddress`, `status`, `txHash`, `blockNumber`, `anchoredAt`, `attempts`, `lastError`, `createdAt`, `updatedAt` |
| Estados del anclaje | `PENDING` → `SUBMITTED` → `CONFIRMED`; `FAILED` tras 5 intentos |
| Estado del certificado | **Derivado, no almacenado**: sin fila `Anchor` = v1 heredado; si no, el estado del anclaje |
| Permisos | `spaceproof_app` recibe `UPDATE` **solo sobre las columnas mutables de `Anchor`** (`status`, `txHash`, `blockNumber`, `anchoredAt`, `attempts`, `lastError`, `updatedAt`). Sigue sin `UPDATE` en `Certificate`. No se crea un rol nuevo: exigiría otro proceso y otra conexión sin beneficio para el MVP. Trigger: `CONFIRMED` es final; `certificateId`, `chainId` y `contractAddress` inmutables |
| Idempotencia | `certificateId` único + la cadena como fuente de verdad: antes de enviar se lee `anchoredAt(hash)`; si ya existe, se marca `CONFIRMED` sin reenviar. El contrato rechaza duplicados |
| Migraciones | Dos, aditivas: (1) columnas de `Certificate` (F2); (2) `Anchor` (F6). Cada una con sus `GRANT` explícitos; se actualizan T11 y las pruebas de privilegios |

### D. Avalanche

| Tema | Decisión |
|---|---|
| Red | **Fuji C-Chain** (testnet), chain ID 43113. RPC público y explorador: confirmar las URL vigentes al implementar |
| Mecanismo | Contrato propio mínimo `SpaceProofAnchor`: `mapping(bytes32 => uint64) anchoredAt`, `anchor(bytes32)` **solo el owner** y solo una vez por hash, evento `Anchored(hash, timestamp)`. Sin OpenZeppelin, sin proxy, sin datos personales. Owner-only: que un hash esté en el contrato significa que lo emitió la clave de SpaceProof |
| Herramientas | Paquete aislado `contracts/` con **Hardhat** (compilar, probar en red local, desplegar, verificar el código en el explorador). No toca los lockfiles de backend ni frontend. Se versionan ABI y dirección desplegada |
| Cliente | **`viem`** en el backend: única dependencia nueva de ejecución; tipada y liviana. Necesaria: no hay forma razonable de firmar y enviar transacciones EVM con la biblioteca estándar |
| Envío y seguimiento | Servicio dentro del backend (una sola instancia, una sola billetera → nonces en serie). Se dispara al crear el certificado y un barrido periódico (`setInterval`) retoma `PENDING`/`SUBMITTED` tras un reinicio |
| Confirmaciones | Recibo exitoso + 1 confirmación (la finalidad de Avalanche es de segundos). Se guardan `txHash`, `blockNumber` y el timestamp del contrato |
| Fallos | Recibo revertido o tiempo agotado: se relee `anchoredAt(hash)`; si no está, se reintenta (hasta 5) y luego `FAILED` con `lastError`. Reintento manual: postergado |
| Configuración | `ANCHOR_RPC_URL`, `ANCHOR_PRIVATE_KEY`, `ANCHOR_CONTRACT_ADDRESS` en `.env`. En pruebas se sustituye el cliente de cadena por uno falso (override de proveedor de Nest): **ni los e2e ni el CI tocan Fuji** |
| Verificación independiente | Cualquiera puede: (1) `sha256sum archivo.tif`; (2) descargar el manifiesto, comprobar que contiene ese hash y calcular su SHA-256; (3) consultar `anchoredAt(hash)` o la transacción en el explorador. Sin confiar en SpaceProof |

### E. Verificación

`GET /api/certificates/:id/verify` (registro + cadena) y `POST /api/certificates/:id/verify-file` (además, el archivo). Respuesta con un `status` y las comprobaciones individuales:

| `status` | Cuándo | Mensaje al usuario |
|---|---|---|
| `VALID` | Archivo, registro y cadena coinciden | «Archivo auténtico. Registrado en Avalanche el …» |
| `INVALID` / `FILE_MISMATCH` | El SHA-256 del archivo no es el certificado | «Este archivo no es el certificado: fue modificado o es otro» |
| `INVALID` / `RECORD_MISMATCH` | El manifiesto recalculado no da `contentHash` | «Los datos del certificado fueron alterados» |
| `INVALID` / `NOT_ANCHORED` | Anclaje `CONFIRMED` en la base pero el hash no está en la cadena | «El registro no coincide con la blockchain» |
| `PENDING` | Archivo y registro correctos; anclaje sin confirmar | «Coincide; el registro en Avalanche está en curso» |
| `UNVERIFIABLE` | No se pudo consultar la cadena | «No se pudo comprobar la blockchain; reintentá» |

La cadena se lee **en vivo** en cada verificación; la fila `Anchor` solo aporta el enlace a la transacción.

### F. Interfaz

- **Emitir**: el formulario actual suma selector de archivo `.tif` y los metadatos nuevos; muestra el progreso de la subida y avisa: «SpaceProof no guarda tu archivo: conservá el original para poder verificarlo».
- **Certificado**: estado grande (Registrado en Avalanche / Registro en curso / Falló), metadatos, hash del archivo, hash del manifiesto, y evidencia: enlace a la transacción en el explorador, bloque, dirección del contrato. Se actualiza sola mientras está pendiente.
- **Verificar** (en la página del certificado): soltar un archivo → resultado en verde o rojo con una frase clara; el detalle técnico (hashes comparados) plegado.
- **«Verificalo vos mismo»**: los tres pasos de la verificación independiente y la descarga del manifiesto.
- **«Qué prueba este certificado»**: texto breve con la promesa y sus tres límites (procedencia, veracidad de los metadatos, autoría), visible en la página del certificado.
- Sin dashboards, estadísticas ni vistas que no sean emitir, ver y verificar. Sin descarga del archivo: no existe.

---

## 5. Fases de implementación

F5 no depende de F1–F4 y puede avanzar en paralelo. Todo lo demás es secuencial.

| Fase | Objetivo | Módulos | Qué se implementa | Pruebas | Terminada cuando | Riesgos / decisiones |
|---|---|---|---|---|---|---|
| **F0** (hecha) | Base limpia | Git | Fusionar `checkpoint/phase-3b-3d` en `main` (PR con CI en verde) | CI | `main` contiene las fases 3B–3D | — |
| **F1** (hecha) | Hash v2 especificado | `certificate-hash.ts`, `docs/manifiesto-v2.md` | Función pura del manifiesto v2 junto a v1; selector por versión | Unitarias con vectores calculados fuera del código (`sha256sum`); las de v1 intactas | Los vectores pasan y la especificación permite reimplementar el hash sin leer el código | Congelar la lista de metadatos antes de empezar: una vez anclado, v2 no cambia |
| **F2** (hecha) | Esquema para archivos | `schema.prisma`, migración nueva, `db-privileges.e2e-spec.ts` | Columnas de `Certificate` (hash, tamaño y nombre del archivo, metadatos, `hashVersion`); trigger actualizado; `CHECK` | e2e de inmutabilidad ampliados a las columnas nuevas; `migrate diff` sin diferencias; certificados v1 existentes siguen verificando | e2e en verde sobre base nueva y sobre la de desarrollo migrada in-place | Migración aditiva: no editar las aplicadas |
| **F3** (hecha) | Emitir y verificar con archivo (sin cadena) | `app.setup.ts`, `certificates.controller.ts`, `certificates.service.ts`, DTO | `POST /certificates` en una operación (cuerpo en streaming + cabecera de metadatos); `GET /manifest`; `verify` y `verify-file` (comprobaciones a y b) | e2e: emisión válida; metadatos inválidos → 400 **sin leer el cuerpo**; sin firma TIFF → 415; vacío → 400; > 200 MB → 413; **carga interrumpida → ninguna fila nueva**; **original → coincide; un byte cambiado → `FILE_MISMATCH`**; registro inconsistente → `RECORD_MISMATCH`; CSRF: multipart, `text/plain` y JSON siguen rechazados en la ruta de emisión; los logs no contienen metadatos ni nombre de archivo | Los e2e pasan por HTTP; un archivo de 200 MB sube por Caddy + Next con memoria estable y **sin que aparezca ningún archivo** en los contenedores | R20, R27 |
| **F4** (hecha) | Demo local sin cadena | `certificate-form.tsx`, `actions.ts`, `lib/api.ts`, `certificates/[id]/page.tsx` | Subida con `fetch` (sustituye la Server Action de emisión), certificado, verificación, aviso de no conservación y «Qué prueba este certificado» | Manual en navegador real (primera vez: hoy no está comprobado) + lint y build | Una persona emite y ve «válido» / «modificado» sin usar la API | — |
| **F5** | Contrato en Fuji | `contracts/` (nuevo) | `SpaceProofAnchor`, pruebas, script de despliegue, verificación del código en el explorador | Hardhat en red local: ancla; rechaza duplicado; rechaza a quien no es owner; emite evento | Contrato desplegado y verificado en Fuji; dirección y ABI versionadas; un `anchor()` manual visible en el explorador | R21 (fondos) |
| **F6** | Anclaje automático | Migración `Anchor`, módulo `anchoring` nuevo, `certificates.service.ts` | Tabla y permisos; servicio de envío, seguimiento y barrido; comprobación c en `verify` | Unitarias con cliente de cadena falso: camino feliz, reinicio entre envío y confirmación, hash ya anclado (no reenvía), revert, RPC caído → `UNVERIFIABLE`; e2e de privilegios de `Anchor`; una prueba manual contra Fuji | Un certificado nuevo llega solo a `CONFIRMED` en Fuji; matar el backend a mitad del anclaje no produce ni duplicados ni un certificado atascado | R22, R23 |
| **F7** | Evidencia en la UI | `certificates/[id]/page.tsx`, `certificate-list.tsx` | Estado del anclaje, enlace al explorador, actualización mientras está pendiente, «Verificalo vos mismo» | Manual en navegador; lint y build | Desde la página del certificado se llega a la transacción en el explorador con un clic | — |
| **F8** | Entrega | `README.md`, este documento, guion de demo | README al día, con la promesa del producto y sus límites; ensayo completo de la demo (original → válido, modificado → inválido, transacción en el explorador); verificación independiente hecha a mano una vez | Ensayo cronometrado dos veces seguidas | La demo sale completa sin intervención manual y ningún texto promete procedencia, veracidad o autoría | Si se publica en un servidor: P1 antes |

---

## 6. Pendientes

Solo lo necesario para terminar el MVP. Lo excluido está en la sección 7 y **no** es un pendiente.

### Decisiones de diseño

No queda ninguna decisión abierta: el diseño está cerrado.

| # | Estado | Decisión | Resultado |
|---|---|---|---|
| D1 | RESUELTO (2026-11-13) | ¿Archivos o solo metadatos? | Archivos completos + metadatos vinculados |
| D2 | RESUELTO (2026-11-13) | ¿El servidor conserva el archivo subido? | **No.** Solo hash, nombre, tamaño y metadatos |
| D3 | RESUELTO (2026-11-13) | ¿Cómo se vincula la carga con el certificado? | Emisión en una única operación, sin registro intermedio |

**Lista de metadatos: congelada en F1.** `title`, `recipient`, `satellite`, `acquiredAt` (obligatorios) y `sensor`, `sceneId` (opcionales). Cualquier cambio es una versión 3 del manifiesto.

Decisiones técnicas tomadas al implementar F1 y F2 (ninguna cambia el diseño):

| Decisión | Motivo |
|---|---|
| Un texto vacío en un opcional **no** equivale a `null` (da otro hash); la emisión guardará `null` | Una sola representación de «ausente» |
| La función de hash rechaza valores sin forma canónica (hash de archivo que no sea 64 hex en minúsculas, tamaño no entero o menor que 1, fecha inválida) | Hashear un valor ambiguo produciría un certificado que nadie puede reproducir |
| Una versión desconocida o un v2 incompleto es un **error** de verificación, no un «inválido» | No confundir «no se pudo comprobar» con «fue alterado» |
| `CHECK`: un certificado v1 no puede llevar datos de archivo ni de satélite | Su hash no los cubriría: serían datos sin protección en una fila «verificada» |
| `CHECK`: `fileSha256` en minúsculas y `fileSizeBytes` > 0, igual que exige el manifiesto | La base no admite lo que el hash rechazaría |
| `fileName` puede ser nulo en v2 | Es informativo y está fuera del manifiesto |
| La API devuelve `fileSizeBytes` como número (la columna es `BIGINT`) | JSON no representa `bigint`; sin esto, listar un certificado v2 daba error 500 (detectado por los e2e) |
| Sin `GRANT` nuevos: `spaceproof_app` conserva solo `SELECT` e `INSERT` | Los permisos de tabla ya cubren las columnas nuevas |
| Migración `20261113100000_certificate_file_manifest`, numerada después de la última aplicada | Prisma la generó con una marca horaria anterior a `…090000_revoke_public_execute`; se renombró antes de aplicarla para no dejar migraciones fuera de orden |
| La tabla `Anchor` **no** entró en F2 | Está planificada para F6, junto con el servicio que la usa |

### Pendientes del MVP

| # | Estado | Pendiente | Resuelve |
|---|---|---|---|
| F5 | **CRÍTICO** | Contrato desplegado en Fuji | R1 |
| F6 | **CRÍTICO** | Modelo `Anchor` y anclaje automático con recuperación | R1, R8 |
| F7 | IMPORTANTE | Evidencia del anclaje en la interfaz | R9 |
| F8 | IMPORTANTE | README, ensayo de demo | — |

Ninguno de estos está implementado. F0 a F4 están en «Resueltos». **Siguiente: F5** (contrato en Fuji), que no depende de nada anterior; antes hay que fusionar el pull request de F3 y F4 con el CI en verde.

### Antes de publicar en un servidor (no bloquean la demo local)

| # | Estado | Pendiente | Resuelve |
|---|---|---|---|
| P1 | IMPORTANTE | Adaptar producción a los roles: URLs separadas (owner solo en `migrate`, app en `backend`), montaje y variables del bootstrap, `pg_isready` por TCP, healthcheck del backend en `/api/health/ready`, variables `ANCHOR_*`, `.env.production.example`, repetir la subida de 200 MB en el stack real midiendo memoria y disco (R20), y despliegue en orden con backup previo, bootstrap, `migrate deploy`, verificación de permisos y `verify:certificates` | R2, R3, R4 |
| I1 | IMPORTANTE | Backup automático, cifrado y externo, con retención y simulacro periódico | R12 |
| I2 | IMPORTANTE | Logs de acceso en Caddy, **sin** la cabecera `X-SpaceProof-Metadata` | R15, R29 |
| I3 | IMPORTANTE | Rate limiting de escrituras (incluidas las subidas) y paginación del listado | R14 |
| I4 | IMPORTANTE | Superusuario limitado al socket local en `pg_hba` | R16 |

P1 pasó de CRÍTICO a IMPORTANTE: bloquea la publicación, no el funcionamiento ni la integridad del producto. Si la entrega exige una URL pública, se hace antes de F8.

### Resueltos (implementados y verificados)

| # | Estado | Qué | Evidencia |
|---|---|---|---|
| S1 | RESUELTO | La app no se conecta como superusuario ni es propietaria de las tablas | T1–T6, T11; sesión de NestJS en dev solo como `spaceproof_app` |
| S2 | RESUELTO | No se pueden desactivar triggers con el rol de la app | T3, T4 |
| S3 | RESUELTO | `DELETE`/`TRUNCATE` bloqueados | T7, T10 |
| S4 | RESUELTO | Los e2e no pueden operar sobre desarrollo ni sobre otro host o rol (incluido el bypass con `?host=`/`?user=`) | `test-env.e2e-spec.ts`; ejecución real abortada |
| S5 | RESUELTO | Permisos innecesarios de `PUBLIC` y de la app sobre bases y funciones | T14, T15 |
| S6 | RESUELTO | CSRF por formulario contra la API | `csrf.e2e-spec.ts` |
| S7 | RESUELTO | Healthcheck real de base de datos en el backend (el compose de producción todavía no lo usa: P1) | `observability.e2e-spec.ts` |
| S8 | RESUELTO | Logs útiles de errores de base de datos sin datos personales | `observability.e2e-spec.ts` |
| S9 | RESUELTO | Verificación masiva de hashes | `certificate-audit` (unit y e2e) y simulacro de restauración |
| S10 | RESUELTO | Procedimiento de backup y restauración documentado y ensayado (en local, no en producción) | [backups.md](backups.md), simulacro |
| S11 | RESUELTO | Bootstrap en volumen nuevo y carrera del healthcheck en desarrollo | Servidor descartable; medición en `initdb` |
| S12 | RESUELTO | README con afirmaciones de integridad correctas y documentación de entornos y riesgos | Revisión de fase 3D |
| S13 | RESUELTO | Trabajo de las fases 3B–3D con commit y push (antes P0, R5) | Commit `15cb52c` en `origin/checkpoint/phase-3b-3d` |
| S14 | RESUELTO | Primera ejecución del CI en GitHub (antes P0, R6) | Ejecución de `pull_request` del 2026-11-13 sobre `checkpoint/phase-3b-3d`: exitosa |
| S15 | RESUELTO | **F0** — checkpoint 3B–3D y planificación fusionados en `main` | PR #1 fusionado con merge commit `51d1d4d`; CI en verde sobre el PR (`4504b58`) y sobre `main` |
| S16 | RESUELTO | **F1** — manifiesto v2: función, selección por versión y especificación con vectores (R7) | [manifiesto-v2.md](manifiesto-v2.md); unit `certificate-hash.spec.ts` |
| S17 | RESUELTO | **F2** — esquema y migración para certificados de archivo, compatibles con v1 (R7) | e2e T16–T20; 97/97 e2e en base nueva y en servidor nuevo; ensayo de migración sobre certificados v1; base de desarrollo migrada sin diferencias |
| S18 | RESUELTO | **F3** — emisión y verificación de archivos en el backend, sin almacenamiento (R18, R17/I5, R20) | Sección 8; 179 unitarias y 169 e2e |
| S19 | RESUELTO | **F4** — interfaz de emisión y verificación (R9) | Sección 8; lint, build y 33 comprobaciones en navegador real |

---

## 7. Fuera del alcance del MVP — POSTERGADO

**Nada de esta sección es un pendiente.** No se implementa, no se planifica y no vuelve a la sección 6 sin una decisión explícita que lo saque de aquí.

### Excluido por decisión de alcance (2026-11-13)

| Estado | Elemento | Por qué no ahora |
|---|---|---|
| POSTERGADO | Soporte para múltiples blockchains | Una sola cadena demuestra el anclaje; cada cadena extra multiplica contratos, claves y pruebas sin mejorar la demo |
| POSTERGADO | Tokens, criptomoneda propia o economía de tokens | No aporta a certificar ni a verificar; suma riesgo legal y de complejidad |
| POSTERGADO | Inteligencia artificial o análisis automático de imágenes | El producto prueba integridad, no interpreta contenido |
| POSTERGADO | Marketplace de imágenes satelitales | Es otro producto; requiere pagos, catálogo y usuarios |
| POSTERGADO | Sistemas complejos de usuarios, roles y permisos | La demo funciona con la autenticación compartida actual (R13 aceptado) |
| POSTERGADO | Compatibilidad con todos los formatos satelitales | El hash no depende del formato; admitir solo GeoTIFF acota validación y pruebas |
| POSTERGADO | Procesamiento avanzado de imágenes, clasificación o análisis geoespacial | Exigiría GDAL o similares; no interviene en la integridad |
| POSTERGADO | Integraciones con múltiples proveedores de almacenamiento | El MVP no almacena archivos (D2): no hay nada que integrar |
| POSTERGADO | Funcionalidades empresariales no necesarias para el objetivo central | Sin usuario que las pida; desvían tiempo de la demo |
| POSTERGADO | Dashboards, estadísticas o vistas que no aporten a certificar y verificar | La interfaz se limita a emitir, ver y verificar |

### Derivado del plan técnico

- **Conservar, almacenar o descargar el archivo original** desde SpaceProof (excluido por D2).
- **Validación real de GeoTIFF/COG** (estructura, georreferencia, disposición COG); hoy solo la firma TIFF.
- **Prueba de procedencia o autoría** (firma del productor, cadena de custodia desde el satélite) y **contraste de los metadatos** con el contenido o con catálogos externos.
- **Subidas reanudables** o por partes.
- **Extracción automática de metadatos** del GeoTIFF (etiquetas, georreferencia) y **coordenadas / bounding box** en el manifiesto (sería hash v3).
- **Productos de varios archivos** (SAFE, bandas separadas) en un solo certificado.
- **Búsqueda de un certificado a partir de un archivo** (sin conocer el id).
- **Reintento manual de anclajes `FAILED`** desde la interfaz.
- **Custodia de la clave de anclaje** (KMS, multisig) y **despliegue en mainnet**.
- **Rol de base de datos separado para el anclaje.**
- **Eliminar la columna `Certificate.txHash`.**

### Postergado desde fases anteriores

- **Identidad de emisores y cuentas de usuario** (sustituir la autenticación básica compartida).
- **Revocación de certificados** como registro aparte (sin borrado).
- **Procedimiento de borrado por solicitudes legales o de privacidad** (pospuesto por decisión).
- **Verificación pública sin credenciales** (por hash o por id).
- **Tests del frontend**. (La comprobación de `Origin` de las Server Actions, R19, dejó de aplicar: desde F4 no queda ninguna Server Action.)
- **Event trigger que bloquee `DROP`** sobre `Certificate` en producción.
- **Logs de acceso del backend** con trazabilidad por solicitud (el `requestId` ya existe).
- **Eliminar `/api` "Hello World"** cuando producción use `/api/health/ready`.
- **Backend de desarrollo escuchando solo en `127.0.0.1`** (hoy escucha en `0.0.0.0`).
- **`CHECK` de formato en `contentHash`**.
- **Cancelar la consulta** cuando `/api/health/ready` vence (hoy solo deja de esperarla).
- **Formato CRLF** en checkouts de Windows (`prettier --check` lo marca; no afecta al CI en Linux).
- **7 avisos moderados de `npm audit`** en dependencias de desarrollo del frontend (ESLint).

---

## 8. F3 y F4 — registro de implementación y auditoría (2026-11-13)

Estado real: **F3 terminada** y **F4 terminada**, con sus criterios de aceptación cumplidos **en local**. Nada de esto se probó en producción; el CI de GitHub corre con el pull request.

### Qué se implementó

**F3 (backend)**

- `POST /api/certificates`: archivo como cuerpo crudo `image/tiff` y metadatos en `X-SpaceProof-Metadata` (base64url). Orden: tipo de contenido → metadatos → `Content-Length` → cuerpo en flujo (firma TIFF, SHA-256, conteo de bytes) → manifiesto v2 → un único `INSERT`.
- `POST /api/certificates/:id/verify-file`, `GET /api/certificates/:id/verify` ampliado con `status`, `reason` y `checks` (conserva `valid`), y `GET /api/certificates/:id/manifest`.
- Puerto de solo lectura `AnchorReader` con una única implementación, `UnconfiguredAnchorReader`, que responde «no configurado».
- Validación de metadatos con rechazo de caracteres de control, bidireccionales y sustitutos sueltos (I5).
- Cierre diferido tras un rechazo temprano (5 s leyendo y descartando).

**F4 (frontend)**

- Formulario de emisión: archivo, metadatos del manifiesto v2, validación previa (campos, tamaño, extensión, firma TIFF), progreso, cancelación, errores en castellano y redirección al certificado.
- Página del certificado: datos emitidos, identificador, verificación de archivo con tres resultados visibles (verde «Integridad verificada», rojo «Archivo alterado o distinto» / «Manifiesto alterado», ámbar «No verificable en Avalanche»), y «Qué prueba este certificado» con sus tres límites.
- Proxy `/api/*` como Route Handler en flujo, en lugar de `rewrites()`.

### Archivos

| | Archivos |
|---|---|
| Backend, nuevos | `src/certificates/file-upload.ts`, `metadata-header.ts`, `anchor-reader.ts`, `dto/issue-certificate.dto.ts`; pruebas `file-upload.spec.ts`, `metadata-header.spec.ts`; `test/files.ts` |
| Backend, modificados | `src/app.setup.ts`, `src/certificates/certificates.controller.ts`, `certificates.service.ts`, `certificates.module.ts`, `certificate-hash.ts`; pruebas `certificates.service.spec.ts`, `test/certificates.e2e-spec.ts`, `csrf.e2e-spec.ts`, `observability.e2e-spec.ts`, `db-privileges.e2e-spec.ts` |
| Backend, eliminado | `src/certificates/dto/create-certificate.dto.ts` |
| Frontend, nuevos | `app/api/[...path]/route.ts`, `app/certificates/[id]/verify-file.tsx`, `app/upload-progress.tsx`, `lib/certificates.ts`, `lib/upload.ts` |
| Frontend, modificados | `app/certificate-form.tsx`, `app/certificates/[id]/page.tsx`, `app/certificate-list.tsx`, `app/layout.tsx`, `lib/api.ts`, `next.config.ts`, `README.md` |
| Frontend, eliminado | `app/actions.ts` |
| Documentación | `docs/API_EMISION_VERIFICACION.md` (nuevo), este documento, `README.md` (solo las líneas que habían quedado falsas; la revisión completa es F8) |

Sin cambios: `docker-compose.prod.yml`, `Caddyfile`, `.env*`, Dockerfiles, CI, esquema de Prisma y migraciones. Sin dependencias nuevas.

### Decisiones técnicas

| Decisión | Motivo |
|---|---|
| **Sin tabla `Anchor` ni «registro pendiente» en F3**: se inserta solo el certificado | La tabla está planificada para F6 junto con el servicio que la usa. Un certificado sin anclaje es, de hecho, el registro pendiente |
| **Sin integración, `status` es `UNVERIFIABLE`**, con `checks.file` y `checks.record` en `MATCH` | Cumple «no comprobable, nunca válido» sin ocultar que las comprobaciones locales pasaron. Hoy `VALID` y `PENDING` solo se alcanzan en pruebas, con un lector falso |
| La cadena responde «no está» → `PENDING` | Sin tabla `Anchor` no se puede distinguir «todavía no» de «debería estar»; F6 separa `INVALID`/`NOT_ANCHORED` |
| Solo el lado de lectura del anclaje | El de escritura no tendría quién lo llame hasta F6 |
| `verify-file` **no** exige firma TIFF | Un archivo alterado en sus primeros bytes debe dar «alterado», no un rechazo |
| `fileName` obligatorio al emitir, con extensión `.tif`/`.tiff` | El plan comprueba «extensión + firma»; la columna sigue admitiendo nulo |
| Fecha de adquisición: instante con segundos y zona explícita | Sin zona, la fecha dependería del huso del servidor. La interfaz la pide en UTC |
| `POST /api/certificates` con JSON → `415`; desaparece la emisión v1 | Decisión del plan: no se emiten certificados sin archivo |
| `GET …/verify` conserva `valid` (= el registro es consistente), marcado obsoleto | Compatibilidad; `verify-file` no lo incluye, para que nadie lea `valid: true` junto a un archivo alterado |
| Route Handler en flujo en lugar de `rewrites()` (R20) | Mantiene «origen único» sin tocar producción. Alternativa del plan, no usada: enrutar desde Caddy |
| Subida con `XMLHttpRequest`, no `fetch` | Es lo que informa el progreso de la subida |
| `BACKEND_URL` se lee al ejecutar, no al construir | Consecuencia del Route Handler. El compose de producción ya la define en ambos momentos |

### Validación final (2026-11-13)

Hecha después de la auditoría, sin agregar funcionalidades. Única corrección: la interfaz mostraba un error genérico ante un `408`; ahora explica que la subida superó los cinco minutos (`frontend/lib/upload.ts`), y el contrato documenta ese estado.

#### Pruebas ejecutadas y aprobadas

| Prueba | Entorno | Resultado |
|---|---|---|
| Backend, unitarias (`pnpm test`) | Windows y contenedor Linux | 179/179 en ambos |
| Backend, e2e (`pnpm test:e2e`) | Windows, base `spaceproof_test` del servidor de desarrollo | 169/169 |
| Backend, e2e sobre **PostgreSQL nuevo** | Contenedor Linux + `postgres:17-alpine` con volumen nuevo, descartado al terminar | 169/169, tres ejecuciones seguidas |
| Bootstrap de roles en `initdb` y repetido (idempotente); `migrate deploy` de las 6 migraciones; `migrate status`; `migrate diff` contra la base y contra las migraciones | Ídem | Sin errores ni diferencias |
| Prueba e2e de memoria (200 MB, RSS < 100 MB) en condiciones similares al CI | Linux, Node 22, pnpm 10.27.0 | Aprobada en las tres ejecuciones |
| Backend, lint como en CI (sin `--fix`) y build | Windows y contenedor Linux | Sin errores |
| `verify:certificates` | Contenedor Linux | Ejecuta sin errores (base vacía, como en el CI) |
| Frontend, `npm ci`, lint y build sin backend | Windows y contenedor Linux | Sin errores |
| `git diff --check`; búsqueda de secretos, artefactos de prueba y caracteres invisibles en los archivos tocados | — | Sin hallazgos |
| Correspondencia contrato ↔ frontend (cabeceras, campos de metadatos, límites, estados HTTP, campos de `Certificate` y `Verification`, los seis resultados de verificación) | Revisión del código contra `API_EMISION_VERIFICACION.md` | Coinciden; faltaba el `408`, agregado |
| Interfaz en navegador real (Edge sin interfaz gráfica) | Script fuera del repositorio | 33/33 |
| 200 MB por Caddy → Next → backend | Caddy 2.11 descartable + procesos locales | `201`, hash correcto, memoria estable, sin archivos |
| Subida lenta de 200 MB en 240 s | Directa al backend y a través de Next | `201`, hash correcto |
| Subida lenta de 200 MB en 340 s | Ídem | Cortada a los ~326 s con `408`; ningún registro creado. Es el comportamiento documentado en R27, **no un éxito** |

La reproducción del CI copia exactamente lo que contendría un commit del árbol de trabajo y ejecuta los pasos de `.github/workflows/ci.yml` (jobs `backend`, `e2e` y `frontend`). No es el CI.

#### Pruebas no ejecutadas

| Prueba | Motivo |
|---|---|
| CI de GitHub Actions | Corre sobre el pull request de `feat/f3-f4-certification`; su resultado no figura en este documento, que se escribió antes |
| Job `compose` del CI (`docker compose config` de producción) | Los archivos que valida no cambiaron |
| Stack de producción real (imágenes Docker, TLS, `docker-compose.prod.yml`) | No se modifica ni se levanta producción |
| Subida de 200 MB por una red real (no loopback) y desde un navegador con Caddy delante | Sin entorno; lo más cercano es la prueba con Caddy descartable |
| Pruebas automatizadas del frontend | No existen en el repositorio (postergado). El proxy en flujo y sus dos opciones de `fetch` no tienen prueba de regresión |
| Pruebas de mutación | No se hicieron |

#### Riesgos pendientes

R27 (límite de cinco minutos, medido, pendiente de decisión), R29 (cabecera de metadatos en futuros logs de Caddy), R30 (sin contrapresión en el adaptador de Next), R34 (prueba de memoria en un runner real) y los ya conocidos de producción (P1, I1–I4). Detalle en la sección 3.

#### Criterios de aceptación

| Fase | Criterio (sección 5) | Estado |
|---|---|---|
| F3 | Los e2e pasan por HTTP: emisión válida; metadatos inválidos → 400 sin leer el cuerpo; sin firma TIFF → 415; vacío → 400; > 200 MB → 413; carga interrumpida → ninguna fila; original → coincide; un byte cambiado → `FILE_MISMATCH`; registro inconsistente → `RECORD_MISMATCH`; CSRF; logs sin metadatos ni nombre de archivo | **Cumplido** |
| F3 | Un archivo de 200 MB sube por Caddy + Next con memoria estable y sin que aparezca ningún archivo en los contenedores | **Cumplido en local** con Caddy descartable y Next y backend como procesos; pendiente de repetir en el stack real (P1) |
| F4 | Una persona emite y ve «coincide» / «modificado» sin usar la API; lint y build | **Cumplido** (navegador real manejado por script). Hoy el original se muestra como «No verificable en Avalanche», nunca como válido: no hay cadena |

#### Confirmaciones de arquitectura

- El certificado se inserta **solo después** de recibir el archivo completo: el controlador espera el resumen del cuerpo entero antes de llamar al servicio, y la única escritura de toda la aplicación es ese `INSERT`.
- **No se persisten bytes originales**: el código no usa el sistema de archivos ni temporales; el esquema no tiene columnas binarias; lo único que se acumula del archivo son sus 4 primeros bytes, para la firma.
- **No existe una tabla `Anchor`**: el esquema tiene un solo modelo y no hay migraciones nuevas.
- **F6 debe** crear `Anchor(PENDING)` y el certificado en una misma transacción (hoy es un único `INSERT`; F6 lo convierte en una transacción con dos).
- Sin Avalanche el resultado es `UNVERIFIABLE`, nunca `VALID`; un error de RPC, también.
- Los certificados **v1 siguen siendo verificables** (`GET …/verify` y `verify:certificates`).
- **No se modificó producción**: `docker-compose.prod.yml`, `Caddyfile`, `.env*`, Dockerfiles, CI, esquema, migraciones y lockfiles sin cambios.

### Auditoría

| Severidad | Hallazgo | Estado |
|---|---|---|
| Crítico | — | Ninguno |
| Alto | El proxy `rewrites()` de Next cortaba toda subida de más de 10 MB y copiaba el cuerpo en memoria | Corregido |
| Alto | `fetch` en el proxy retenía en memoria el archivo completo durante la subida | Corregido |
| Medio | Un rechazo temprano llegaba al cliente y al proxy como corte de conexión o `502`, sin el error real | Corregido (cierre diferido) |
| Medio | Quedaron caracteres de control bidireccionales **literales** en el código fuente (expresión regular del DTO y una prueba) en lugar de escapes | Corregido; se revisaron todos los archivos tocados |
| Medio | Tiempo máximo de solicitud de 5 minutos en dos servidores Node | **Pendiente** (R27); medido en la validación final. La interfaz ahora explica el corte |
| Medio | La cabecera de metadatos quedaría en los logs de acceso de Caddy cuando se activen | **Pendiente** (R29, I2) |
| Bajo | Una prueba unitaria de memoria no probaba nada (reutilizaba el mismo bloque) | Eliminada; la evidencia es la prueba e2e con 200 MB y las mediciones |
| Bajo | La prueba de «no se abre ningún archivo para escritura» reemplazaba `fs.open` en vez de observarlo | Corregida |
| Bajo | La hora de adquisición se mostraba en formato de 12 horas | Corregido (24 h, UTC) |
| Bajo | README con instrucciones que ya no eran ciertas | Corregidas esas líneas |
| Bajo | R30 a R34 | Aceptados, documentados |

Comprobado en la auditoría, sin hallazgos: el hash del archivo y del manifiesto se calculan solo en el servidor; el cliente no puede enviar `id`, fechas, hashes ni tamaño; una fila solo existe si el cuerpo llegó completo; v1 intacto; ningún texto de la interfaz ni de la API afirma autenticidad, procedencia o autoría; ningún cambio en producción.

### Qué falta para F5 y F6

- **F5**: conseguir AVAX de prueba en Fuji (R21, sigue sin hacerse); paquete `contracts/` con Hardhat; contrato `SpaceProofAnchor`, pruebas, despliegue y verificación en el explorador; versionar ABI y dirección. No depende de F3 ni F4.
- **F6**: migración `Anchor` con permisos y trigger; dependencia `viem`; implementación real de `AnchorReader` (reemplaza a `UnconfiguredAnchorReader` en `certificates.module.ts`); servicio de envío, seguimiento y barrido; insertar `Anchor(PENDING)` en la misma transacción que el certificado; distinguir `PENDING` de `INVALID`/`NOT_ANCHORED`; variables `ANCHOR_*`.
- **F7**: en la página del certificado, reemplazar «Integración pendiente» por el estado real del anclaje y el enlace al explorador; «Verificalo vos mismo» con la descarga del manifiesto (la ruta ya existe).
