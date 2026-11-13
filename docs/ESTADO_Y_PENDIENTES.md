# SpaceProof — Estado y pendientes

Última actualización: 2026-11-13, con **F5 desplegada, verificada y validada en Avalanche Fuji** (secciones 9 y 10). Fases F0 a F4 terminadas y fusionadas en `main` (PR #3, CI en verde): se puede emitir el certificado de un archivo y verificarlo, por API y desde la interfaz. El contrato `SpaceProofAnchor` está en Fuji en `0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF`, con el código fuente verificado y dos anclajes de prueba. **El backend ya lee la cadena en vivo** cuando se configuran `ANCHOR_RPC_URL` y `ANCHOR_CONTRACT_ADDRESS`: un certificado cuyo hash está en el contrato verifica como «válido» (comprobado contra Fuji con un certificado sintético). **El backend todavía no ancla por sí mismo** (F6): hoy un certificado nuevo queda en «pendiente» —o en «no verificable en Avalanche» si las variables no están configuradas— hasta que alguien lo ancle a mano. El trabajo de F5 está en la rama `feat/f5-avalanche-contract`, fusionada en `main` (PR #4, commit de fusión `db43fef`, CI en verde): **F5 está cerrada.** De F6 están hechas en la rama local `feat/f6-anchoring`, sin push ni CI de GitHub: la migración `Anchor` (F6.1), el firmante con su validación de arranque (F6.2) y la creación del certificado junto con su anclaje `PENDING` (F6.3). **El backend sigue sin enviar anclajes** (F6.4). Detalle en la sección 11.

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
| **Lectura del anclaje en Avalanche Fuji** (`AvalancheAnchorReader`): `anchoredAt(hash)` en vivo; exige chain ID 43113; RPC caído, otra cadena, dirección sin contrato o respuesta inválida → `UNVERIFIABLE`; configuración parcial o malformada → el backend no arranca | Unit `avalanche-anchor-reader.spec.ts` (RPC falso, sin red; firma comparada con el ABI versionado). **Además, manual contra Fuji** (sección 10): `VALID`, `PENDING`, `UNVERIFIABLE` y fallo de arranque |
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
| R21 | Fondos de prueba en Fuji | El faucet oficial puede exigir saldo en mainnet o un cupón; sin AVAX de prueba no hay anclaje ni demo | MVP | **RESUELTO** para F5: el owner recibió 0,5 AVAX de prueba y quedan ~0,4999 tras el despliegue y dos anclajes (~45 700 gas por anclaje). Alcanza de sobra para F6 y la demo; vigilar el saldo |
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
| **F5** (hecha: desplegada y verificada en Fuji, sección 10) | Contrato en Fuji | `contracts/` (nuevo) | `SpaceProofAnchor`, pruebas, script de despliegue, verificación del código en el explorador | Hardhat en red local: ancla; rechaza duplicado; rechaza a quien no es owner; emite evento | Contrato desplegado y verificado en Fuji; dirección y ABI versionadas; un `anchor()` manual visible en el explorador | R21 (fondos) |
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
| F5 | **RESUELTO** | Contrato desplegado y verificado en Fuji (`0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF`), anclajes de prueba y lectura en vivo desde el backend (sección 10). Sin commit todavía | R21 |
| F6 | **CRÍTICO** | Modelo `Anchor` y anclaje automático con recuperación | R1, R8 |
| F7 | IMPORTANTE | Evidencia del anclaje en la interfaz | R9 |
| F8 | IMPORTANTE | README, ensayo de demo | — |

F0 a F5 están resueltas (F5 sin commit ni CI de GitHub todavía). F6 a F8 no están implementadas. **Siguiente: F6** (el backend ancla solo); la lista exacta de lo que falta está en la sección 10, «Qué falta para F6». R1 sigue abierto hasta F6: mientras el anclaje sea manual, un certificado nuevo no llega a «válido» por sí solo.

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

---

## 9. F5 — contrato de anclaje (2026-11-13)

**Actualización:** el contrato **se desplegó y se verificó en Fuji** después de escribir esta sección, y el criterio de F5 está cumplido: ver la bitácora de la sección 10. Lo que sigue es el registro de la implementación tal como quedó antes del despliegue.

Estado al escribir esta sección (ya superado): **contrato implementado y probado en red local; NO desplegado en Fuji.** El criterio de F5 («contrato desplegado y verificado en Fuji; dirección y ABI versionadas; un `anchor()` manual visible en el explorador») **no está cumplido**: no existe `contracts/deployments/fuji.json`, ni dirección, ni transacción.

### Qué se implementó

- `contracts/` — paquete aislado con Hardhat 3.22 y viem, con su propio `package.json` y lockfile. No toca los de `backend/` ni `frontend/`.
- `SpaceProofAnchor.sol` (Solidity 0.8.28, EVM `cancun`, optimizador activado), tal como estaba decidido en la sección 4.D:
  - `owner` inmutable: la cuenta que despliega. Sin transferencia.
  - `anchoredAt(bytes32) → uint64`, consulta pública: marca de tiempo del bloque, o `0`.
  - `anchor(bytes32)`: solo el owner; rechaza el hash cero y los duplicados; emite `Anchored(hash, timestamp)`.
  - Errores `NotOwner()`, `EmptyHash()`, `AlreadyAnchored(hash, anchoredAt)`.
  - Sin OpenZeppelin, proxy, roles, tokens ni forma de borrar o cambiar una entrada.
- Pruebas (`test/SpaceProofAnchor.ts`), script de exportación del ABI, script de despliegue y script de comprobación contra la cadena.
- `abi/SpaceProofAnchor.json` versionado; una prueba y el CI fallan si difiere del contrato compilado.
- Job `contracts` en el CI: build, ABI al día, tipos y pruebas. No usa clave ni toca Fuji.

### Decisiones técnicas

| Decisión | Motivo |
|---|---|
| Hardhat 3 con viem y el ejecutor de pruebas de Node | Es la versión vigente; viem es el mismo cliente que usará el backend |
| El rechazo del hash cero se agregó al diseño | `0` es el valor de «no anclado»: un hash cero nunca es un SHA-256 real y anclarlo sería un error del llamador |
| Una sola configuración del compilador para pruebas y despliegue | Lo que se prueba es exactamente lo que se despliega |
| La clave se llama `ANCHOR_PRIVATE_KEY`, igual que en el backend | Quien despliega es el owner, la única cuenta que puede anclar: es la misma clave |
| No hay red de mainnet configurada, y los scripts exigen el chain ID 43113 | Imposible desplegar en mainnet por error |
| El despliegue se niega si ya existe `deployments/fuji.json` | Un segundo despliegue crearía un segundo registro, vacío |
| Script propio en lugar de Hardhat Ignition | Deja el hash de la transacción y el bloque a la vista y en un archivo simple |

### Pruebas ejecutadas

| Prueba | Resultado |
|---|---|
| `npm test` en `contracts/` (red local de Hardhat) | 12/12: owner, hash desconocido → 0, anclaje con marca de tiempo y evento, hash del vector A del manifiesto, independencia entre hashes, duplicado rechazado, no-owner rechazado, hash cero rechazado, lectura pública, superficie del contrato, ABI versionado |
| Mutaciones del contrato (quitar el control de owner, de duplicado, de hash cero, alterar la marca de tiempo, quitar el evento) | Las cinco hacen fallar las pruebas |
| `npm run build` y `npm run typecheck` | Sin errores |
| Ensayo de `deploy:fuji` y `check:fuji` contra un **nodo local** de Hardhat con chain ID 43113 | Despliega, registra y verifica; se niega a un segundo despliegue; detecta un registro alterado. **No es Fuji**: el registro del ensayo se borró |
| RPC público de Fuji, solo lectura | Responde chain ID 43113 |

No ejecutado: despliegue en Fuji, verificación del código en el explorador, un `anchor()` real, el job nuevo del CI en GitHub.

El ensayo local encontró y corrigió un defecto: el script esperaba 2 confirmaciones; ahora espera 1 (como define la sección 4.D) e imprime el hash de la transacción antes de esperar.

### Qué faltaba para cerrar F5 — RESUELTO (sección 10)

Los cinco puntos están hechos y comprobados en la sección 10. Se conservan como registro.

1. Una clave exclusiva de Fuji en `contracts/.env` (`ANCHOR_PRIVATE_KEY`), con AVAX de prueba (R21, sigue abierto).
2. `npm run deploy:fuji` y `npm run check:fuji`.
3. Verificar el código fuente (`npx hardhat verify sourcify --network fuji <dirección>`).
4. Versionar `deployments/fuji.json` y registrar aquí dirección, transacción y enlace al explorador.
5. Un `anchor()` manual de prueba, visible en el explorador.

### Qué queda para F6

Lista escrita antes del despliegue. La dependencia `viem`, las variables de lectura y la implementación real de `AnchorReader` **ya están hechas**; la lista vigente y exacta es «Qué falta para F6», en la sección 10.

- Dependencia `viem` en el backend; variables `ANCHOR_RPC_URL`, `ANCHOR_PRIVATE_KEY`, `ANCHOR_CONTRACT_ADDRESS`.
- Leer la dirección de `contracts/deployments/fuji.json` y el ABI de `contracts/abi/SpaceProofAnchor.json` (decidir cómo llegan a la imagen Docker del backend: hoy su contexto de build es `backend/`).
- Implementación real de `AnchorReader` con `readContract(anchoredAt)`: `0` → `NOT_ANCHORED`; otro valor → `ANCHORED` con esa fecha; error de RPC → excepción (`UNVERIFIABLE`).
- Migración `Anchor`; `Anchor(PENDING)` y el certificado en una misma transacción; servicio de envío (`writeContract(anchor)`), seguimiento y barrido. `AlreadyAnchored` debe tratarse como éxito (idempotencia).
- El contrato guarda segundos (`uint64`); el backend los convierte a fecha.

---

## 10. Ejecución de F5 en Fuji — bitácora (2026-11-13)

Registro del despliegue real, actualizado durante la ejecución. Estados: PENDIENTE, EN PROGRESO, RESUELTO, BLOQUEADO. No contiene claves ni secretos: la clave de despliegue vive solo en `contracts/.env`, ignorado por Git.

### Datos públicos del despliegue

| Dato | Valor |
|---|---|
| Red | Avalanche Fuji C-Chain, chain ID 43113 |
| Contrato `SpaceProofAnchor` | `0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF` |
| Owner (única cuenta que puede anclar) | `0x1bBB9Ad2350a5E7e377f5D825039f0b964B0D78a` |
| Transacción de despliegue | `0xf356719551f1ac5b2ab69c2779bea1b056103ca8c2b03af7d131a88ce8b8a997` (bloque 61002732, 2026-11-13 12:08:01 UTC, 178 763 gas) |
| Explorador | https://testnet.snowtrace.io/address/0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF |
| Código verificado | https://sourcify.dev/server/repo-ui/43113/0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF |
| Anclaje de prueba | Hash `0xb448887edc056387c4f2602464db2b7d378338d355b757b61ec4bfa04b70540b`, transacción `0x580dc9f4cc735be60e09f0164c41fe6dad445f0a26b5943d28b2d6224dc941e2` (bloque 61002828, 2026-11-13 12:10:51 UTC, 45 730 gas) |
| Segundo anclaje de prueba (certificado sintético del backend) | Hash `0xf9d131329a24371e0020a6953ea926b08984ef93a92eb916c2368df98c7dab9c`, transacción `0x2179a2b47a557c7db0e99f2f258a591403c0378a033fc5400f0286ffa8d5dd22` (nonce 2, bloque 61003076, 2026-11-13 12:18:25 UTC, 45 718 gas) |

El segundo hash es el `contentHash` del certificado `df955315-eca6-4c2e-8384-d607554fbd3e` de la base `spaceproof_test` («Prueba de integración F5»: un TIFF sintético de 68 bytes, `prueba-f5.tif`, emitido a las 12:18:10 UTC). Se ancló a mano para probar el lector del backend de punta a punta y **no se había registrado aquí en su momento**: la discrepancia se detectó al retomar el trabajo, porque el nonce del owner en la cadena era 3 y no 2. Comprobado por RPC al registrarlo: transacción del owner al contrato, recibo `success`, un único evento `Anchored` con ese hash y marca 1794572305, igual a la del bloque y a `anchoredAt(hash)`. No contiene datos de usuarios.

El hash de prueba es el SHA-256 del texto UTF-8 `SpaceProof F5 Fuji anchor test 2026-11-13` (sin salto de línea): `printf '%s' 'SpaceProof F5 Fuji anchor test 2026-11-13' | sha256sum`. No corresponde a ningún archivo ni certificado.

### Pasos

| Paso | Estado | Resultado |
|---|---|---|
| Inicio de la ejecución | RESUELTO | Autorizada por el responsable del proyecto, solo con AVAX de prueba. Rama `feat/f5-avalanche-contract` |
| Comprobaciones previas | RESUELTO | La clave configurada deriva la dirección del owner; RPC en chain ID 43113; saldo 0,5 AVAX de prueba, nonce 0; compilación sin errores; ABI sincronizado; 12/12 pruebas |
| Despliegue en Fuji | RESUELTO | Comprobado por RPC, no por la salida del comando: recibo `success`, 582 bytes de código **idénticos byte a byte** al contrato compilado (salvo el owner inmutable), `owner()` correcto. Registrado en `contracts/deployments/fuji.json`. **Incidente:** `npm run deploy:fuji` falló *después* de enviar la transacción, porque el RPC público todavía no la mostraba cuando Hardhat la consultó; la transacción ya estaba confirmada. No se reenvió nada: se corrigió el script (ya no depende de esa consulta) y se registró el despliegue a partir de su transacción (`DEPLOY_TX`) |
| Verificación del código en el explorador | RESUELTO | Sourcify: coincidencia exacta de creación y de ejecución (`exact_match`), solc 0.8.28, optimizador 200, EVM `cancun`, sin argumentos de constructor; no requirió clave de API. La fuente publicada es idéntica al archivo local. Snowtrace (Routescan) también lo muestra verificado |
| Anclaje real de prueba | RESUELTO | `anchor()` confirmado; un único evento `Anchored` con el hash esperado y marca de tiempo 1794571851 |
| Consultas on-chain | RESUELTO | Por RPC directo, sin Hardhat: `anchoredAt(hash de prueba)` = 1794571851 = marca del bloque = valor del evento; un hash distinto y el mismo hash con un bit cambiado → 0; duplicado simulado → `AlreadyAnchored`; llamada simulada desde otra cuenta → `NotOwner`; hash cero → `EmptyHash`. Nonce del owner en ese momento: 2 (despliegue + un anclaje). **Corrección posterior:** el nonce actual es **3** (`latest` y `pending`), por el segundo anclaje de prueba; las tres transacciones del owner son el despliegue (nonce 0) y los dos anclajes (nonces 1 y 2), sin ninguna pendiente |
| Integración del backend | RESUELTO (lectura) | `AvalancheAnchorReader` conectado en `certificates.module.ts` por `ANCHOR_RPC_URL` y `ANCHOR_CONTRACT_ADDRESS`; comprobado en vivo contra Fuji (apartado «Prueba en vivo»). Sin esas variables, F3/F4 se comportan igual que antes. La **escritura** de anclajes desde el backend no existe: es F6 (PENDIENTE, ver «Qué falta para F6») |
| Pruebas | RESUELTO | Todas las suites locales en verde (apartado «Pruebas ejecutadas»). El CI de GitHub con el job nuevo `contracts` no corrió: no hay commit ni push (PENDIENTE) |

### Prueba en vivo del backend contra Fuji (2026-11-13)

Instancia independiente del backend en el puerto **3101** (compilada en un directorio aparte, `backend/.tmp/`, para no tocar el `dist` del servidor de desarrollo de :3001, que siguió funcionando sin cambios), conectada solo a `spaceproof_test` como `spaceproof_app`, con `ANCHOR_RPC_URL` (RPC público de Fuji) y `ANCHOR_CONTRACT_ADDRESS`. **Sin clave privada**: el lector no firma. No se envió ninguna transacción. Se ejecutó **antes** de los e2e, que reconstruyen `spaceproof_test` y eliminan el certificado; el anclaje permanece en la cadena y la evidencia queda aquí.

Certificado sintético usado: `df955315-eca6-4c2e-8384-d607554fbd3e`, `createdAt` `2026-11-13T12:18:10.620Z`, `hashVersion` 2, `contentHash` `f9d131329a24371e0020a6953ea926b08984ef93a92eb916c2368df98c7dab9c`. Su manifiesto (respuesta exacta de `GET …/manifest`, sin salto de línea final):

```json
{"v":2,"id":"df955315-eca6-4c2e-8384-d607554fbd3e","createdAt":"2026-11-13T12:18:10.620Z","file":{"sha256":"d61c7e5fdda1938b05568b55028fc4d5fda2e4ca265634b0345a08b3f7111678","sizeBytes":68},"metadata":{"title":"Prueba de integración F5","recipient":"SpaceProof (prueba)","satellite":"Ninguno (dato de prueba)","sensor":null,"sceneId":null,"acquiredAt":"2026-11-13T12:00:00.000Z"}}
```

Cualquiera puede repetir la comprobación sin SpaceProof: el SHA-256 de ese texto (UTF-8) es el hash anclado, y `anchoredAt(0xf9d1…ab9c)` en el contrato devuelve `0x6af70011` = 1794572305 = 2026-11-13T12:18:25Z.

| Comprobación | Esperado | Obtenido |
|---|---|---|
| `GET /verify` del certificado anclado | `VALID` | `status: VALID`, `reason: null`, `checks: {file: NOT_CHECKED, record: MATCH, anchor: ANCHORED}`, `anchoredAt: 2026-11-13T12:18:25.000Z` |
| `anchoredAt` contra la cadena | 12:18:25Z | Igual a `eth_call anchoredAt` directo (1794572305), a la marca del bloque 61003076 y al evento `Anchored` |
| Hash del manifiesto | = hash anclado | `sha256sum` del cuerpo de `GET /manifest` = `f9d13132…7dab9c` = `storedHash` = `computedHash` = hash de la transacción |
| `GET /verify` de un certificado v2 sin anclaje (`3ed7431c-…`, hash `fc6db150…90d8`) | `PENDING`, nunca `VALID` | `PENDING` / `NOT_ANCHORED`, `anchoredAt: null`; `eth_call` directo para ese hash → 0 |
| `GET /verify` de un certificado v1 sin anclaje | `PENDING` | `PENDING` / `NOT_ANCHORED` |
| `POST /verify-file` del certificado anclado con otro archivo TIFF | `INVALID` | `INVALID` / `FILE_MISMATCH`; la cadena ni se consulta (`anchor: NOT_CHECKED`) |
| RPC caído (`ANCHOR_RPC_URL=http://127.0.0.1:9`), certificado anclado | `UNVERIFIABLE` | `UNVERIFIABLE` / `ANCHOR_UNAVAILABLE`, `anchoredAt: null`, en ~0,2 s (sin colgarse), dos veces seguidas; lo mismo para el no anclado. `health/ready` sigue `ok` |
| Solo `ANCHOR_RPC_URL`, o solo `ANCHOR_CONTRACT_ADDRESS` | Falla al iniciar | El proceso termina con código 1: `ANCHOR_RPC_URL and ANCHOR_CONTRACT_ADDRESS must be set together`; no escucha en el puerto |
| `ANCHOR_RPC_URL` que no es http(s), con credenciales en la URL | Falla al iniciar sin mostrar el valor | Código 1: `ANCHOR_RPC_URL must be an http(s) URL`; el valor no aparece en la salida |
| Sin variables de anclaje | Igual que F3/F4 | `UNVERIFIABLE` / `ANCHOR_NOT_CONFIGURED` para el certificado anclado y para uno v1 |

El campo `valid` de `GET /verify` es el de compatibilidad con v1 (el registro coincide con su hash) y no depende de la cadena; el resultado es `status`.

Después de la prueba: instancia de :3101 detenida; :3001 intacto (mismo proceso, `health/live` ok); `spaceproof_test` con sus 54 certificados; base `spaceproof` sin tocar; nonce del owner sigue en 3.

### Pruebas ejecutadas (cierre, 2026-11-13)

Todas después de la prueba en vivo y con el código tal como queda en el árbol de trabajo.

| Suite | Resultado |
|---|---|
| `npm run check:fuji` con el hash de prueba (`b448887e…540b`) | Código en la cadena: 582 bytes idénticos a esta compilación; chain ID 43113; owner y transacción de despliegue coinciden con `deployments/fuji.json`; hash anclado el 2026-11-13T12:10:51Z |
| `npm run check:fuji` con el hash del certificado sintético (`f9d13132…7dab9c`) | Ídem; anclado el 2026-11-13T12:18:25Z |
| `npm run check:fuji` con un hash no anclado (`877b3ddc0045c7dbb066370e9a6f6633bdbfd141f1e15d2fa3c7c4b0c6f55828`, SHA-256 del texto `SpaceProof F5 Fuji hash NOT anchored 2026-11-13`) | Ídem; «not anchored» |
| contracts: `npm run build` (y otra vez con `hardhat build --force`) | Compila con solc 0.8.28, EVM `cancun`; `abi/SpaceProofAnchor.json` sin cambios (mismo SHA-256 antes y después) |
| contracts: `npm run typecheck`, `npm test` | Sin errores; 12/12 |
| backend: ESLint sin `--fix` (el comando del CI) | Sin errores |
| backend: compilación | Sin errores. Se compiló con `tsc -p tsconfig.build.json` hacia `backend/.tmp/` y no con `pnpm build`, que borra y reescribe el `dist` desde el que corre el servidor de desarrollo de :3001. Mismo compilador y misma configuración; el CI ejecuta `pnpm build`. **Después:** `pnpm build` literal ejecutado sin errores en una copia limpia dentro de un contenedor Linux (sección 11.3) |
| backend: `pnpm test` | **202/202** en 9 suites (las 179 anteriores más las del lector de Avalanche) |
| backend: `pnpm test:e2e` (`spaceproof_test`, reconstruida) | **169/169** en 7 suites, la misma cantidad que en F3/F4. Ninguna toca Fuji |
| backend: `verify:certificates` | Sobre la base de desarrollo (solo lectura, como en el CI): 0 certificados, código 0. Sobre `spaceproof_test` después de los e2e: 53 certificados, 48 válidos y 5 inválidos, que son registros que los e2e insertan inconsistentes a propósito (código 1, esperado). **Después:** los cinco se identificaron y comprobaron uno por uno (sección 11.2) |
| frontend: `npm run lint`, `npm run build` con `BACKEND_URL=http://127.0.0.1:9` | Sin errores (regresión; el frontend no se modificó) |
| `actionlint` 1.7.7 sobre `.github/workflows/ci.yml` | Sin hallazgos |

No ejecutado: el CI en GitHub Actions (requiere push), y por lo tanto el job `contracts` en un runner real.

### Bloqueos y pendientes del cierre de F5

| Tema | Estado | Detalle |
|---|---|---|
| Commit, push y CI de GitHub de la rama `feat/f5-avalanche-contract` | PENDIENTE | Por indicación expresa no se hizo commit ni push. Hay que versionar `contracts/` (incluidos `abi/` y `deployments/fuji.json`; `contracts/.env` está ignorado), el lector y su spec |
| Certificado sintético de la prueba en vivo | RESUELTO | Los e2e lo eliminaron al reconstruir `spaceproof_test`, como estaba previsto. Su anclaje es permanente y su manifiesto está copiado arriba |
| Entradas de prueba en el contrato | Aceptado | Los dos hashes de prueba quedan para siempre en el registro de Fuji. No corresponden a datos de usuarios |
| Bloqueos | Ninguno | — |

### Qué falta para F6 (lista exacta, nada de esto está implementado)

Lo que F6 **ya recibe hecho**: contrato desplegado y verificado; ABI y dirección versionados; `viem` 2.57.19 en el backend; `AvalancheAnchorReader` (lectura en vivo, chain ID, timeout de 5 s, un reintento) conectado al proveedor `AnchorReader`; `ANCHOR_RPC_URL` y `ANCHOR_CONTRACT_ADDRESS`; la clave del owner en `contracts/.env` con ~0,4999 AVAX de prueba.

1. **Migración `Anchor`** (aditiva, sin editar las aplicadas): una fila por certificado, con estado (`PENDING`, `SUBMITTED`, `CONFIRMED`, `FAILED`), `txHash`, `blockNumber`, marca de tiempo del contrato, intentos y `lastError`. Permisos explícitos: `spaceproof_app` con `SELECT`, `INSERT` y `UPDATE` **solo** de las columnas mutables; trigger que impide cambiar el certificado asociado y volver atrás desde `CONFIRMED`; sin `DELETE`. e2e de privilegios nuevos en `db-privileges.e2e-spec.ts`.
2. **Firmante**: variable `ANCHOR_PRIVATE_KEY` en el backend (la misma clave del owner; nunca en logs ni en mensajes de error) y un cliente de escritura de viem. Al arrancar, comprobar que la dirección derivada es el `owner()` del contrato y que el chain ID es 43113. Las tres variables se configuran juntas, o solo las dos de lectura.
3. **Servicio de anclaje** (módulo `anchoring`): `writeContract(anchor)` con nonces en serie (una instancia, una billetera); antes de enviar, leer `anchoredAt(hash)` y, si ya está, marcar `CONFIRMED` sin enviar; tratar el revert `AlreadyAnchored` como éxito; esperar el recibo **consultando de nuevo** (un «no encontrada» inmediato no es un fallo: ver «Hallazgos para F6»); recibo exitoso + 1 confirmación → `CONFIRMED` con `txHash`, bloque y marca de tiempo; revert o tiempo agotado → releer la cadena y reintentar hasta 5 veces, luego `FAILED`. No recorrer eventos (`eth_getLogs` acepta 100 bloques como máximo).
4. **Emisión**: insertar `Anchor(PENDING)` en la **misma transacción** que el certificado (`certificates.service.ts`, `issue`) y disparar el anclaje después de responder.
5. **Barrido periódico** que retome `PENDING` y `SUBMITTED` tras un reinicio, sin duplicar envíos.
6. **Verificación** (`check` en `certificates.service.ts`): usar la fila `Anchor` para distinguir «todavía no anclado» (`PENDING`) de «la base dice `CONFIRMED` y la cadena no lo tiene» (`INVALID` / `NOT_ANCHORED`). Hoy cualquier hash ausente da `PENDING`. Exponer el `txHash` del anclaje en la respuesta para la interfaz (F7), y actualizar [API_EMISION_VERIFICACION.md](API_EMISION_VERIFICACION.md).
7. **Pruebas**: unitarias con un cliente de cadena falso (camino feliz, reinicio entre envío y confirmación, hash ya anclado, revert, RPC caído → `UNVERIFIABLE`); e2e sin tocar Fuji; una prueba manual contra Fuji: un certificado nuevo llega solo a `CONFIRMED`, y matar el backend a mitad del anclaje no deja duplicados ni un certificado atascado.
8. **Distribución de ABI y dirección**: el lector usa hoy una firma escrita en el código (comparada por una prueba con el ABI versionado) y la dirección llega por variable. Para escribir hacen falta la firma de `anchor` y la de los errores: decidir si se sigue ese patrón o si el ABI se copia a la imagen (el contexto de build del backend es `backend/`).
9. **Certificados anteriores a F6** (sin fila `Anchor`): decidir si se anclan con un barrido inicial o se muestran como «emitido antes del anclaje».

Fuera de F6, para entregar SpaceProof: **F7** (estado del anclaje y enlace al explorador en la interfaz; hoy la página del certificado todavía contiene el texto «Integración pendiente»), **F8** (README, guion y ensayo de la demo) y, solo si se publica en un servidor, **P1** (incluye llevar las variables `ANCHOR_*` a `docker-compose.prod.yml` y `.env.production.example`, que en este cierre no se tocaron).

### Hallazgos para F6

- El RPC público de Fuji acepta **como máximo 100 bloques por consulta de eventos** (`eth_getLogs`). El backend no debe depender de recorrer eventos: `anchoredAt(hash)` responde lo mismo con una sola llamada.
- El RPC público puede tardar un instante en mostrar una transacción recién aceptada. Después de enviar, hay que esperar el recibo consultando de nuevo, no tratar un «no encontrada» inmediato como fallo.

---

## 11. Auditoría de F5 y plan de F6 (2026-11-13)

Auditoría de solo lectura hecha después del cierre de la sección 10. No se modificó código, no se envió ninguna transacción (nonce del owner: 3), no hubo commit ni push, y no se tocó el servidor de :3001 ni ninguna base de datos. **F6 no está implementada**: lo que sigue es un plan.

### 11.1 Cambios de F5 pendientes de commit

Aclaración sobre el informe de cierre: decía «no toqué código» y era cierto solo para esa sesión (que modificó este documento y `contracts/README.md`). **La rama sí contiene código de F5 sin commit**, escrito en las sesiones anteriores del mismo día. Todo lo que sigue está sin versionar.

| Archivo | Qué contiene | ¿Es de F5? | ¿Necesario hoy? | Veredicto |
|---|---|---|---|---|
| `contracts/` (15 archivos versionables) | Contrato, pruebas, scripts de despliegue, comprobación y anclaje manual, ABI, `deployments/fuji.json`, configuración de Hardhat, lockfile | Sí: es el entregable de F5 | Sí | Conservar |
| `.github/workflows/ci.yml` | Job nuevo `contracts` (build, ABI al día, tipos, pruebas en red local). Los demás jobs no cambian | Sí | Sí, para que el CI cubra el contrato | Conservar |
| `backend/src/certificates/avalanche-anchor-reader.ts` y `.spec.ts` | Lector de solo lectura de `anchoredAt` y 23 pruebas con RPC falso | Es la parte de lectura de F6, adelantada para cumplir «el backend se comunica con el contrato» del cierre de F5 | No para F3/F4; sí para que alguna verificación llegue a `VALID` | Conservar |
| `backend/src/certificates/certificates.module.ts` | El proveedor `AnchorReader` pasa de la clase fija `UnconfiguredAnchorReader` a una fábrica que lee el entorno | Ídem | Ídem | Conservar |
| `backend/package.json`, `backend/pnpm-lock.yaml` | Dependencia `viem` 2.57.19 (versión exacta) y sus 11 transitivas; 138 líneas agregadas al lockfile, ninguna quitada | Ídem. `viem` es la dependencia prevista en la sección 4.D | Sí, para el lector | Conservar; ver el hallazgo de versiones |
| `backend/.env.example` | Dos variables de lectura, comentadas | Sí | No (documentación) | Conservar |
| `docs/ESTADO_Y_PENDIENTES.md`, `contracts/README.md` | Registro de F5 | Sí | — | Conservar |

Comprobaciones:

- **Secretos:** `contracts/.env` (la clave), `backend/.env` y `backend/.env.test` están ignorados por Git. El valor de la clave se buscó en todos los archivos versionados y versionables: no aparece en ninguno. Los únicos valores hexadecimales de 32 bytes en el diff son hashes y transacciones públicas.
- **Compatibilidad con F3/F4:** sin variables `ANCHOR_*` la fábrica devuelve el mismo `UnconfiguredAnchorReader` de antes; los 169 e2e pasan sin cambios. No hay migraciones nuevas ni cambios en el frontend, Docker, Caddy o producción.
- **Cambios accidentales o ajenos:** ninguno encontrado.

Hallazgos (ninguno bloqueaba el CI). **A1 y A2 quedaron RESUELTOS después de la auditoría, antes del commit de F5:** `viem` pasó a 2.57.16 (backend y `contracts/`) y `hardhat` a 3.21.2, con los lockfiles regenerados; el contrato recompilado es idéntico al desplegado (`check:fuji`: 582 bytes iguales), ABI sin cambios, 12/12 pruebas del contrato, 202/202 unitarias y 169/169 e2e del backend. Para A2, la prueba unitaria limpia las variables `ANCHOR_*` y `loadTestEnv` las elimina en los e2e; ambas suites pasan con una variable `ANCHOR_RPC_URL` exportada en la terminal. Las menciones anteriores a `viem` 2.57.19 y Hardhat 3.22 en este documento describen lo instalado en su momento.

| # | Hallazgo | Impacto | Qué hacer |
|---|---|---|---|
| A1 | `viem` 2.57.19 y `hardhat` 3.22.0 se publicaron el 2026-11-12, un día antes de instalarlas | Una versión con horas de publicada no tuvo tiempo de revisión pública; `viem` es la biblioteca que en F6 va a manejar la clave privada | Decidir antes de F6: fijar `viem` 2.57.16 (2026-11-03) y `hardhat` 3.21.2 (2026-10-29), las más nuevas con siete días o más, o aceptar las actuales. Cambiar Hardhat no altera el contrato desplegado (el bytecode depende de solc 0.8.28 y de su configuración), pero exige repetir `check:fuji` |
| A2 | La prueba unitaria «uses the unconfigured reader by default» (`certificates.service.spec.ts`) y los e2e que esperan `ANCHOR_NOT_CONFIGURED` dependen de que el entorno no tenga variables `ANCHOR_*` | Con una sola variable exportada en la terminal la prueba falla (reproducido); con las dos, las pruebas consultarían Fuji de verdad. En el CI no ocurre: no define esas variables, y Jest no carga `backend/.env` | En F6, que agrega una tercera variable: las pruebas deben fijar su propio entorno de anclaje (vacío) en lugar de heredarlo |
| A3 | El lector adelanta trabajo de F6 dentro de la rama de F5 | Ninguno funcional. Con las variables configuradas y sin F6, un certificado nuevo verifica como `PENDING` hasta que alguien lo ancle a mano | Documentado; por eso las variables quedan comentadas en `.env.example` |

### 11.2 Los cinco certificados inválidos de `spaceproof_test`

Resuelto, con los datos todavía presentes. El verificador (`certificate-audit.ts`) recalcula el hash de cada certificado con la función de su `hashVersion` y lo compara con `contentHash`, en una transacción de solo lectura; cuenta como `invalid` el que no coincide y como `error` el que no se puede calcular. Resultado sobre `spaceproof_test`: 53 certificados (20 v1 y 33 v2), 48 válidos, 5 inválidos, 0 errores.

Los cinco son registros que las pruebas e2e insertan **a propósito** con un hash calculado para otro valor, para comprobar que la verificación los detecta. Se confirmó uno por uno: tal como están no coinciden, y al reponer el valor original el hash recalculado es exactamente el almacenado.

| Certificado | Versión | Campo alterado → valor con el que se calculó el hash | Prueba que lo inserta |
|---|---|---|---|
| `ed20745c-2455-4d01-a584-f51ddf74125c` | 2 | `satellite`: «Forged satellite» → «Sentinel-2A» | `certificates.e2e-spec.ts`, «detects a record whose metadata do not match its hash» |
| `47834754-3beb-4a31-8908-0a8030c062a9` | 1 | `title`: «Forged title» → «Original title» | `certificates.e2e-spec.ts`, «report a tampered record as invalid» |
| `1eec256f-9ed8-49dd-807b-18941188fe51` | 1 | `title`: «Forged title» → «Original title» | `db-privileges.e2e-spec.ts`, T13 |
| `a86ae2e6-e184-4416-8f05-e64c89519362` | 2 | `satellite`: «Forged» → «Sentinel-2A» | `db-privileges.e2e-spec.ts`, T17 |
| `4c328eea-e010-4ef2-97b3-2976652e6aba` | 1 | `title`: «Audit forged» → «Audit original» | `certificate-audit.e2e-spec.ts` |

Conclusión: no hay inconsistencias reales ni errores del verificador; el resultado es el esperado y es coherente con v1 y v2 (tres casos v1 y dos v2, cada uno verificado con la función de su versión). No afecta a certificados reales: la base de desarrollo `spaceproof` tiene 0 certificados y da 0/0 con código 0. Los ids cambian en cada ejecución de los e2e; los cinco casos se repiten.

### 11.3 Validación para el CI

Reproducción de los jobs `contracts` y `backend` del CI en un contenedor Linux (`node:22-bookworm`, pnpm 10.27.0), sobre una **copia limpia** con exactamente los archivos que se versionarían (sin `.env`, sin `node_modules`, sin `dist`, finales de línea LF), sin clave privada y con un RPC inválido en el entorno durante las pruebas del contrato:

| Paso | Resultado |
|---|---|
| contracts: `npm ci` (lockfile generado en Windows, instalado en Linux) | Sin errores |
| contracts: `npm run build` (descarga solc 0.8.28) y `git diff --exit-code -- abi` | Compila; el ABI versionado no cambia |
| contracts: `npm run typecheck`, `npm test` | Sin errores; 12/12, sin clave y sin tocar Fuji |
| backend: `pnpm install --frozen-lockfile` | Sin errores: el lockfile corresponde al `package.json` |
| backend: ESLint (comando del CI) | Sin errores |
| backend: **`pnpm build` literal** | Sin errores; genera `dist/main.js` y el lector. Cierra la salvedad de la sección 10 sin tocar el `dist` local del servidor de :3001 |
| backend: `pnpm test` | 202/202 |
| Árbol de trabajo después de todo | Sin cambios |

No reproducido en Linux en esta auditoría: el job `e2e` (pasó 169/169 en Windows con este mismo código; su infraestructura no cambió desde F3/F4) y los jobs `frontend` y `compose` (sin cambios respecto de `main`).

**Estado del CI al terminar la auditoría: no ejecutado en GitHub.** **Después (11.6):** pull request #4 abierto y los 5 jobs en verde.

Qué falta para integrar F5:

1. Decidir A1 (versiones de `viem` y `hardhat`).
2. Commit de los archivos de 11.1 (confirmando antes con `git status` que no entra ningún `.env`), push y pull request.
3. CI de GitHub en verde, incluido el job nuevo `contracts` por primera vez en un runner real. Riesgo que solo puede aparecer allí: la descarga de solc o de paquetes desde el runner.
4. Fusión en `main`.

Hasta entonces F5 está **desplegada y validada, pero no cerrada formalmente**: sin commit, sin CI de GitHub.

### 11.4 Plan de F6 (propuesto; nada implementado)

Alcance: exactamente los puntos de «Qué falta para F6» (sección 10) y el diseño de las secciones 4.C, 4.D y 4.E. Sin cambios en el contrato, sin transacciones de despliegue, sin F7, F8 ni P1.

Dos decisiones que F6 necesita, con la opción recomendada (la de menor alcance):

| Decisión | Recomendación | Motivo |
|---|---|---|
| Cómo llegan el ABI y la dirección al backend (punto 9) | Seguir el patrón del lector: las firmas de `anchor`, `anchoredAt`, `owner` y de los tres errores escritas en el código, con una prueba que las compara con `contracts/abi/SpaceProofAnchor.json`; la dirección, por `ANCHOR_CONTRACT_ADDRESS` | No toca el `Dockerfile` ni el contexto de build (eso sería P1); el CI detecta cualquier diferencia con el contrato |
| Certificados anteriores a F6, sin fila `Anchor` (punto 10) | No anclarlos automáticamente. Se siguen verificando contra la cadena en vivo como hoy; la sección 4.C ya define «sin fila `Anchor`» como certificado heredado | La base de desarrollo tiene 0 certificados y no hay producción comprobada: un barrido inicial sería código sin datos sobre los que actuar |

Subtareas, en orden. F6.1 y F6.2 no dependen entre sí y pueden hacerse en paralelo; F6.3 y F6.6 solo necesitan F6.1; F6.4 necesita F6.1 y F6.2; F6.5 necesita F6.4; F6.7 va al final.

| # | Subtarea (puntos de la sección 10) | Archivos | Cambios | Depende de | Pruebas | Riesgos | Criterio de aceptación |
|---|---|---|---|---|---|---|---|
| F6.0 | Integrar F5 | Los de 11.1 | Commit, push, PR, CI | — | CI de GitHub | 11.3 | F5 fusionada en `main` con el CI en verde |
| F6.1 | Migración `Anchor` (punto 1) | `prisma/schema.prisma`, migración nueva, `test/db-privileges.e2e-spec.ts` | Modelo `Anchor` con las columnas de la sección 4.C y `certificateId` único; estados `PENDING`, `SUBMITTED`, `CONFIRMED`, `FAILED`; `GRANT` explícitos: `spaceproof_app` con `SELECT`, `INSERT` y `UPDATE` solo de `status`, `txHash`, `blockNumber`, `anchoredAt`, `attempts`, `lastError`, `updatedAt`; trigger: `CONFIRMED` es final, `certificateId`, `chainId` y `contractAddress` inmutables; `DELETE` y `TRUNCATE` bloqueados. Ninguna migración aplicada se edita; `Certificate` no cambia | — | e2e nuevos de privilegios y de trigger; T11 actualizado; `migrate diff` sin diferencias; ensayo sobre una base con certificados existentes | Una migración fallida en una base con datos; un permiso de más | Los e2e muestran que la app no puede tocar columnas inmutables, salir de `CONFIRMED` ni borrar; los certificados existentes siguen verificando igual |
| F6.2 | Firmante y validación de arranque (puntos 2, 3 y 9) | `avalanche-anchor-reader.ts` o un archivo vecino, módulo `anchoring` nuevo, `.env.example` | Puerto de escritura (como `AnchorReader`) con implementación viem; `ANCHOR_PRIVATE_KEY` opcional: sin ella el backend queda en solo lectura, como hoy. Al arrancar con clave: chain ID 43113 y dirección derivada igual a `owner()`; si no, el backend no arranca. La clave nunca aparece en logs ni en errores | Decisión del ABI; A1 | Unitarias con RPC falso: clave que no es el owner, otra cadena, clave malformada, configuración parcial, y que ningún mensaje contiene la clave | Fuga de la clave en un log o error (R22); arranque bloqueado si el RPC está caído | Con una clave equivocada o en otra cadena el backend se niega a arrancar; sin clave se comporta como en F5 |
| F6.3 | `Anchor(PENDING)` al emitir (punto 5) | `certificates.service.ts` (`issue`) y su spec | El certificado y su fila `Anchor` se insertan en una misma transacción | F6.1 | Unitarias y e2e: toda emisión crea las dos filas; si falla una, no queda ninguna; las cargas rechazadas o interrumpidas siguen sin dejar filas | Romper la garantía de F3 «un fallo no deja nada» | Nunca existe un certificado v2 nuevo sin fila `Anchor`, ni una fila `Anchor` sin certificado |
| F6.4 | Servicio de anclaje (punto 4) | Módulo `anchoring` | Cola en serie (una transacción por vez, una billetera); antes de enviar, leer `anchoredAt`: si ya está, `CONFIRMED` sin enviar; enviar y guardar `SUBMITTED` con `txHash` de inmediato; esperar el recibo reconsultando; éxito + 1 confirmación → `CONFIRMED` con `txHash`, bloque y marca del contrato; `AlreadyAnchored` → éxito; revert o tiempo agotado → releer la cadena, reintentar, y `FAILED` con `lastError` al quinto intento. `lastError` guarda solo el tipo de error. Sin `eth_getLogs` | F6.1, F6.2 | Unitarias con cadena falsa: camino feliz, hash ya anclado (no envía), `AlreadyAnchored`, revert, recibo que tarda, RPC caído, cinco fallos → `FAILED`, dos certificados a la vez → envíos en serie | Dos envíos del mismo hash (el contrato rechaza el segundo; cuesta gas de prueba); un anclaje confirmado por lectura queda sin `txHash` | Un certificado nuevo llega solo a `CONFIRMED`; ningún caso de las unitarias deja un estado incorrecto ni un envío duplicado |
| F6.5 | Barrido (punto 6) | Módulo `anchoring` | Al arrancar y con `setInterval`, retomar `PENDING` y `SUBMITTED` por el mismo camino de F6.4; el intervalo se cancela al cerrar la aplicación | F6.4 | Unitarias: reinicio entre envío y confirmación, reinicio antes de enviar; los e2e terminan sin procesos colgados | Solaparse con un anclaje en curso | Matar el backend a mitad de un anclaje y reiniciarlo termina en `CONFIRMED`, con una sola entrada en el contrato |
| F6.6 | Verificación con `Anchor` (punto 7) | `certificates.service.ts` (`check`), su spec, `docs/API_EMISION_VERIFICACION.md` | La cadena se sigue leyendo en vivo. Hash ausente en la cadena: `INVALID` / `NOT_ANCHORED` si la fila dice `CONFIRMED`; `PENDING` en otro caso. La respuesta expone el estado y el `txHash` de la fila. `VALID` sigue exigiendo la respuesta positiva de la cadena | F6.1 | Unitarias de cada combinación de fila y cadena; e2e con lector falso; v1 y certificados sin fila se comportan como hoy | Cambiar el contrato de la API que usa el frontend (solo se agregan campos) | La tabla de la sección 4.E se cumple caso por caso, y ningún caso devuelve `VALID` sin la cadena |
| F6.7 | Pruebas de cierre (punto 8) y A2 | Specs y e2e, este documento | Las pruebas fijan su propio entorno de anclaje; prueba manual contra Fuji | Todo lo anterior | Suites completas; manual: emitir un certificado → `CONFIRMED` solo → `VALID`; matar el backend a mitad del anclaje | Gasta AVAX de prueba (~45 700 gas por anclaje; hay ~0,4999) | El criterio de F6 de la sección 5, con evidencia registrada aquí |

Punto abierto menor, a confirmar al implementar F6.6: la sección 4.E no dice qué `status` devuelve la verificación cuando la fila está en `FAILED` y el hash no está en la cadena. Propuesta sin valores nuevos: `PENDING`, con el estado `FAILED` de la fila visible en la respuesta.

### 11.5 Riesgos reales

- F5 sin commit: todo el trabajo del contrato y del lector vive solo en este disco (más la copia de resguardo local del cierre).
- A1: dependencias con un día de publicadas, una de las cuales manejará la clave.
- R22 pasa a ser efectivo en F6: la clave del owner estará en el entorno del backend.
- R23: el anclaje y la verificación dependen del RPC público de Fuji; la demo también.
- R1 sigue abierto hasta que F6 funcione: hoy un certificado nuevo no llega a «válido» por sí solo.
- La interfaz (F7) todavía dice «Integración pendiente» aunque el backend responda `VALID`: sin F7 la demo no muestra el anclaje.

### 11.6 Sprint del 2026-11-13: A1, A2, integración de F5, F6.1 y F6.2

Sin transacciones (nonce del owner: 3), sin despliegues, sin tocar el servidor de :3001 ni producción. La base `spaceproof_test` se reconstruyó con los e2e, como siempre; la de desarrollo no se tocó (la migración `Anchor` **no** está aplicada en ella).

| Tarea | Estado | Evidencia |
|---|---|---|
| A1: `viem` 2.57.16 y `hardhat` 3.21.2 | COMPLETA | Ver 11.1. Incluida en el commit de F5 |
| A2: pruebas sin variables `ANCHOR_*` heredadas | COMPLETA | Ver 11.1. Incluida en el commit de F5 |
| Integración de F5 | **PARCIAL** | Commit `943336a` en `feat/f5-avalanche-contract`, push y pull request #4 (https://github.com/null61637/spaceproof/pull/4). Antes del commit se comprobó que no entra ningún `.env` y que la clave no aparece en lo versionado. **CI de GitHub en verde, los 5 jobs**, incluido `contracts` por primera vez en un runner real. **Después:** fusionado en `main` (`db43fef`) |
| F6.1: migración `Anchor` | COMPLETA en local, sin commit | Detalle abajo |
| F6.2: firmante y validación de arranque | COMPLETA en local, sin commit | Detalle abajo |
| F6.3 a F6.7 | PENDIENTE | No se empezaron |

F6.1 y F6.2 están en la rama local `feat/f6-anchoring` (creada sobre el commit de F5), **sin commit ni push**, y no pasaron por el CI de GitHub.

**F6.1 — migración `20261113150000_anchor`** (aditiva; `Certificate` y las migraciones anteriores no cambian):

- Tabla `Anchor` con las columnas de la sección 4.C, `certificateId` único con clave foránea, y el tipo `AnchorStatus` (`PENDING`, `SUBMITTED`, `CONFIRMED`, `FAILED`).
- `CHECK`: solo chain ID 43113; forma de la dirección y del hash de transacción; `SUBMITTED` exige `txHash`; `CONFIRMED` exige `anchoredAt` (puede no tener `txHash`: hash que ya estaba en la cadena).
- Trigger `anchor_guard`, también para el owner: una fila nace `PENDING` y vacía; `id`, `certificateId`, `chainId`, `contractAddress` y `createdAt` no cambian; `CONFIRMED` es final. Triggers contra `DELETE` y `TRUNCATE`.
- Permisos de `spaceproof_app`: `SELECT`, `INSERT`, y `UPDATE` solo de `status`, `txHash`, `blockNumber`, `anchoredAt`, `attempts`, `lastError`, `updatedAt`. Sigue sin `UPDATE` en `Certificate`.
- e2e `db-privileges.e2e-spec.ts`: T21 a T28 nuevos (25 casos), y T11, T15 y T20 actualizados con la tabla, sus privilegios por columna y sus dos funciones. **Cambio en una prueba de F3/F4, justificado:** T10 comprobaba que `TRUNCATE "Certificate"` lo frena el trigger; como `Anchor` ahora referencia esa tabla, PostgreSQL lo rechaza antes (error `0A000`). T10 comprueba las dos cosas: el rechazo de PostgreSQL y el del trigger con `TRUNCATE … CASCADE`. El truncado sigue siendo imposible.
- Resultado: **194/194 e2e** (169 anteriores + 25); `prisma migrate diff` sin diferencias contra la base de pruebas y contra las migraciones.
- No hecho: ensayo de la migración sobre una base con certificados previos (la de desarrollo tiene 0), y aplicarla en desarrollo.

**F6.2 — firmante** (`backend/src/anchoring/anchor-signer.ts`, `anchoring.module.ts`, registrado en `app.module.ts`; variable documentada en `backend/.env.example`):

- `ANCHOR_PRIVATE_KEY` es opcional. Sin ella no hay firmante y el backend se comporta como en F5. Con ella exige las dos variables de lectura y una clave bien formada; si no, no arranca, y ningún mensaje contiene un valor configurado.
- Al arrancar comprueba, solo con lecturas, que el RPC es la cadena 43113 y que la cuenta de la clave es el `owner()` del contrato. Si alguna de las dos cosas es falsa, el backend **no arranca**. Si el RPC no responde, arranca con una advertencia (solo el nombre del error) y el firmante queda sin habilitar: vuelve a comprobar antes de usarse. Se eligió así para que una caída del RPC no deje sin servicio la emisión y la verificación.
- La clave queda dentro de la cuenta de viem, en un campo privado: no aparece al registrar ni serializar el firmante.
- **El firmante todavía no envía nada**: no tiene método de envío. Eso es F6.4.
- Decisión del ABI aplicada (11.4): firmas de `owner`, `anchor` y los tres errores en el código, comparadas por una prueba con el ABI versionado.
- Pruebas: 28 unitarias nuevas con RPC falso (**230/230** en total), ESLint y compilación sin errores.
- Comprobación en vivo, solo lectura, con una instancia aparte en el puerto 3101 contra `spaceproof_test`: con la clave real del owner → «Anchor signer ready» y la clave no aparece en la salida; con una clave pública de desarrollo → el proceso termina con «not the owner of the anchor contract»; con el RPC caído → arranca con la advertencia; con la clave y sin las otras variables → no arranca. Nonce del owner después: 3.

Qué sigue: fusionar el PR #4; commit de F6.1 y F6.2 y su CI; después F6.3 y F6.6 (solo necesitan F6.1) y F6.4.

### 11.7 Continuación de F6: base actualizada, auditoría de F6.1/F6.2 y F6.3 (2026-11-13)

**Diagnóstico y preservación.** El PR #4 se fusionó en `main` con un commit de fusión, `db43fef` (padres `52d519d` y `943336a`, el commit de F5); su contenido es idéntico al de `943336a`. La rama local `feat/f6-anchoring` estaba en `943336a`, un commit detrás de `origin/main`, con F6.1 y F6.2 sin commit: 5 archivos modificados y 4 nuevos. Antes de tocar la rama se hicieron dos respaldos, comprobados: fuera del repositorio, un parche de los archivos con seguimiento y un archivo con los nuevos; y dentro, una entrada de `git stash` creada sin modificar el árbol de trabajo (`stash@{0}`, solo archivos con seguimiento; **sigue ahí y se puede eliminar** cuando se considere seguro).

**Actualización de la base.** `git merge --ff-only origin/main`: avance rápido a `db43fef`, sin conflictos (la fusión no cambia ningún archivo). El diff del árbol de trabajo después es idéntico byte a byte al respaldo, y los archivos nuevos siguen presentes. No se usó ni restauró el stash.

**Auditoría de F6.1 y F6.2**, sobre la base nueva. Sin hallazgos que corregir.

| Punto | Resultado |
|---|---|
| Estados y transiciones | La base impone: nace `PENDING` y vacío; `SUBMITTED` exige `txHash`; `CONFIRMED` exige `anchoredAt` y es final. Quedan permitidas, a propósito, `PENDING` ↔ `SUBMITTED` (reintento tras un tiempo agotado), `PENDING` → `CONFIRMED` (hash que ya estaba en la cadena) y la salida de `FAILED` (el reintento manual está postergado, y no exige otra migración). El orden fino lo decide el servicio de F6.4 |
| Chain ID | `CHECK ("chainId" = 43113)`; e2e T26 |
| Un anclaje por certificado | Índice único en `certificateId` y clave foránea; e2e T25 |
| Inmutabilidad y borrado | Trigger `Anchor_guard` y triggers contra `DELETE` y `TRUNCATE`, también para el owner; e2e T22, T23, T27 |
| Permisos de la aplicación | Leídos del catálogo de `spaceproof_test`: `SELECT` e `INSERT` sobre `Anchor`; `UPDATE` solo de `status`, `txHash`, `blockNumber`, `anchoredAt`, `attempts`, `lastError`, `updatedAt`; `Certificate` sigue con `SELECT` e `INSERT` únicamente (e2e T11, T28) |
| PostgreSQL y Prisma | `migrate diff` sin diferencias contra la base de pruebas y contra las migraciones; `migrate status` al día |
| `ANCHOR_PRIVATE_KEY` opcional | Sin ella no hay firmante; e2e y unitarias |
| Cadena y `owner()` antes de habilitar | `assertReady()`; si alguna es falsa, el backend no arranca |
| RPC no disponible | El backend arranca, el firmante queda sin habilitar y `assertReady()` vuelve a consultar en cada uso hasta que pasa. **Todo código que firme (F6.4) debe llamar antes a `assertReady()`**: hoy no existe ningún código que firme |
| Clave nunca expuesta | Campo privado; la cuenta de viem tampoco la contiene como propiedad (comprobado); mensajes de error sin valores configurados; logs con dirección pública y nombre de error |
| Ninguna transacción | El firmante no tiene método de envío. Nonce del owner: 3 |

Pruebas de la auditoría: ESLint y compilación sin errores, 230/230 unitarias, 194/194 e2e.

**Commit de F6.1 y F6.2:** `18d331b` en `feat/f6-anchoring`, local, sin push. Antes del commit se comprobó que no entra ningún `.env` ni la clave. Una corrección posterior a ese commit va junto con F6.3: un tipo demasiado estricto en `anchor-signer.spec.ts`, que solo se ve al comprobar tipos incluyendo las pruebas (la compilación del CI las excluye, y la prueba pasaba).

#### F6.3 — el certificado y su `Anchor(PENDING)` se crean juntos

Estado: **implementada y probada en local.** No se envió ninguna transacción (nonce del owner: 3), no se tocó el contrato y no se implementó F6.4.

Qué hace: al emitir un certificado en un entorno con contrato configurado, se crea en la misma transacción de PostgreSQL su fila `Anchor`, que nace `PENDING` y vacía. Si falla cualquiera de las dos inserciones, no queda ninguna fila. Sin contrato configurado, la emisión es exactamente la de antes: un certificado, ninguna fila `Anchor`.

| Archivo | Cambio |
|---|---|
| `src/certificates/certificates.service.ts` | `issue` usa una escritura anidada de Prisma (certificado + anclaje en una transacción). Solo envía `chainId` y `contractAddress`: el estado y lo demás los pone la base |
| `src/certificates/anchor-reader.ts` | Tipo `AnchorTarget` (cadena y contrato) y su token de inyección |
| `src/certificates/avalanche-anchor-reader.ts` | `anchorTargetFromEnv`, que comparte la validación de configuración con el lector |
| `src/certificates/certificates.module.ts` | Proveedor del destino de anclaje |
| Pruebas | `certificates.service.spec.ts`, `avalanche-anchor-reader.spec.ts`, `test/certificates.e2e-spec.ts`; corrección de tipo en `anchor-signer.spec.ts` |

Sin migraciones nuevas ni cambios en el esquema, el contrato, el frontend o la respuesta de la API: `POST /api/certificates` devuelve lo mismo que antes, y el manifiesto y su hash no incluyen nada del anclaje.

Decisiones técnicas:

| Decisión | Motivo |
|---|---|
| «Requiere anclaje» = hay contrato configurado (`ANCHOR_RPC_URL` y `ANCHOR_CONTRACT_ADDRESS`), **con o sin clave** | Son las mismas variables con las que la verificación consulta ese contrato; la fila registra en qué contrato debe anclarse. Con contrato y sin clave, la fila espera en `PENDING` hasta que haya firmante (F6.4/F6.5) o se ancle a mano. **Requiere confirmación** (alternativa: crearla solo si además hay clave) |
| Escritura anidada de Prisma, no una transacción interactiva | Una sola llamada: no hay forma de crear una fila sin la otra, y no cambia el manejo de errores existente |
| La aplicación no escribe `status`, `txHash`, `attempts` ni fechas | Los valores iniciales los fija la base, y el trigger de F6.1 rechaza cualquier otra cosa: un anclaje no puede nacer confirmado |
| La dirección se guarda con su forma de checksum | Una sola representación por contrato |
| La verificación no se tocó | Sigue leyendo la cadena en vivo; la fila `Anchor` no confirma nada (F6.6 la usará para distinguir `PENDING` de `INVALID`) |

Pruebas:

| Prueba | Resultado |
|---|---|
| Unitarias (`pnpm test`) | **237/237** (230 + 7): una sola escritura con las dos filas; solo `chainId` y `contractAddress`; mismo certificado y mismo hash que sin contrato; sin contrato no hay anclaje; el destino existe exactamente cuando hay lector |
| e2e (`pnpm test:e2e`, `spaceproof_test`) | **203/203** (194 + 9): certificado + un único `Anchor` `PENDING`; misma respuesta y mismo hash; cinco emisiones simultáneas → un anclaje cada una; segundo anclaje del mismo certificado rechazado (único); **falla el anclaje → no queda el certificado**; **falla el certificado → no queda ninguna fila**; cargas rechazadas no dejan filas; anclaje deshabilitado → sin fila, como antes; la verificación sigue dependiendo solo de la cadena y la fila queda `PENDING` aunque la cadena responda «anclado» |
| ESLint; tipos con y sin pruebas; compilación en directorio aparte | Sin errores |
| `prisma migrate diff` contra la base de pruebas y contra las migraciones | Sin diferencias |
| `verify:certificates` | Desarrollo (solo lectura): 0 certificados, código 0. `spaceproof_test`: 91 válidos de 96; los 5 inválidos son los registros alterados a propósito por los e2e (11.2) |
| En vivo, instancia aparte en :3101 contra `spaceproof_test`, leyendo Fuji, **sin clave** | Emisión real por HTTP de un archivo sintético → `201`; fila `Anchor` `PENDING`, cadena 43113, contrato correcto, sin `txHash`, 0 intentos; `GET /verify` → `PENDING` / `NOT_ANCHORED` (la cadena no tiene ese hash) |
| Contrato | Sin cambios; sus pruebas no se repitieron |

Cómo se provocaron los fallos en los e2e: para el anclaje, un destino con otro chain ID, que el `CHECK` de la base rechaza después de insertado el certificado; para el certificado, un trigger temporal creado por el owner en `spaceproof_test` y eliminado al terminar (comprobado: no queda). No aplica el aislamiento entre inquilinos: el modelo de SpaceProof no tiene inquilinos ni cuentas.

Riesgos y limitaciones:

- **La base de desarrollo `spaceproof` no tiene la migración `Anchor`** (sigue con 6 migraciones; no se aplicó por no estar autorizado). Con este código, un backend que apunte a esa base y tenga las variables `ANCHOR_*` configuradas falla al emitir. Sin esas variables funciona como antes. Antes de usar el anclaje en desarrollo hay que ejecutar `prisma migrate deploy` allí.
- Hasta F6.4 nadie envía los anclajes: las filas quedan en `PENDING` y la verificación responde `PENDING`.
- Los certificados emitidos sin contrato configurado no tienen fila `Anchor` (decisión de 11.4: no se anclan automáticamente).
- F6.1 a F6.3 no pasaron por el CI de GitHub: la rama no se subió.

Pendiente para F6.4 (no implementado; requisitos):

1. Método de envío en el firmante, que llame siempre a `assertReady()` antes de firmar.
2. Servicio que tome las filas `PENDING` del contrato configurado, de a una (nonces en serie).
3. Antes de enviar, leer `anchoredAt(hash)`: si ya está, `CONFIRMED` con la fecha del contrato y sin `txHash`.
4. Enviar y guardar `SUBMITTED` con el `txHash` de inmediato; esperar el recibo reconsultando.
5. Recibo exitoso + 1 confirmación → `CONFIRMED` con `txHash`, bloque y fecha del contrato; `AlreadyAnchored` → éxito.
6. Revert o tiempo agotado → releer la cadena, sumar un intento; al quinto, `FAILED` con el nombre del error.
7. Dispararlo después de responder la emisión, sin bloquearla; el barrido tras reinicios es F6.5.
8. Pruebas unitarias con cadena falsa; ninguna prueba automática envía transacciones. La prueba manual contra Fuji consume AVAX de prueba y nonce: necesita autorización expresa.
