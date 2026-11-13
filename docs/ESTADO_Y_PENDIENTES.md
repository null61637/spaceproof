# SpaceProof — Estado y pendientes

Última actualización: 2026-11-13, al cierre de **F2**. Fases F0 (fusión en `main`), F1 (manifiesto v2) y F2 (esquema y migración) terminadas y verificadas en local. La sección 1 describe lo implementado; de las secciones 4 y 5, **F3 en adelante sigue sin implementar**: todavía no se puede emitir un certificado de archivo ni existe integración con Avalanche.

Este documento es la referencia central: qué está hecho y comprobado, qué se decidió, qué riesgos se conocen, qué falta para terminar el MVP y **qué quedó fuera** (sección 7). Detalle operativo en el [README](../README.md) y en [backups.md](backups.md).

**Alcance de las comprobaciones.** Todo lo marcado como verificado se probó **en local** (Windows + Docker Desktop): en el PostgreSQL de desarrollo, en la base `spaceproof_test` y en un servidor PostgreSQL descartable con volumen nuevo. **Nada se validó en producción** (ni siquiera se inspeccionó el servidor). El CI corrió una vez en GitHub Actions, con éxito.

**Objetivo del MVP:** certificar la integridad de un archivo satelital y de sus metadatos. El servidor calcula el SHA-256 del archivo, lo vincula con los metadatos en un manifiesto, ancla el hash del manifiesto en Avalanche y permite verificar después el original y detectar cualquier modificación. En la blockchain solo van hashes. Demo: original → válido; modificado → inválido; evidencia del anclaje.

Estados usados: **CRÍTICO** (bloquea el funcionamiento o la integridad), **IMPORTANTE** (necesario antes de la entrega o publicación), **POSTERGADO** (no se implementa en esta etapa), **RESUELTO** (implementado y comprobado).

---

## 1. Estado actual

### Funciona y está cubierto por pruebas automatizadas

| Funcionalidad | Evidencia |
|---|---|
| Crear, listar y consultar certificados (API y UI) | e2e `certificates.e2e-spec.ts`; prueba manual de fase 1 por HTTP (sin navegador) |
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
| Protección CSRF de la API: escrituras solo `application/json` (415 en otro caso), sin CORS | e2e `csrf.e2e-spec.ts`; la vulnerabilidad se reprodujo antes de corregirla (201 con formulario) |
| Healthchecks `/api/health/live` y `/api/health/ready` (`SELECT 1`, límite 2 s) | Unit `health.controller.spec.ts`; e2e `observability.e2e-spec.ts` |
| Logs de errores con `requestId`, código Prisma y SQLSTATE, sin cuerpos de solicitud | e2e `observability.e2e-spec.ts` (comprueba que no aparecen datos personales) |
| Verificación masiva de solo lectura (`pnpm verify:certificates`) | Unit y e2e `certificate-audit`; mismo resultado en origen y copia restaurada |
| Backup y restauración en base nueva | Simulacro en servidor descartable: catálogo, permisos, triggers, migraciones y datos idénticos |
| Migraciones sincronizadas con el schema | `prisma migrate status` y `migrate diff` (contra la base y contra la shadow) sin diferencias, en dev y en servidor nuevo |
| Lint y build de backend y frontend; build del frontend sin backend | Ejecutados localmente |

Últimos resultados (cierre de F2): **63/63 unitarios** y **97/97 e2e**, en la base de tests del servidor de desarrollo y en un servidor PostgreSQL nuevo (bootstrap de roles y las 6 migraciones desde cero). Lint y build del backend sin errores. La base de desarrollo quedó migrada in-place (`migrate status` y `migrate diff` sin diferencias).

### Comprobado solo manualmente

- **Server Actions frente a otro `Origin`**: Next.js abortó la acción con `Origin` ajeno y la ejecutó con el propio (probado con el formulario real y datos vacíos). No hay prueba automatizada.
- **Proxy `/api/*` del frontend**: probado con `curl` (415 para formularios, 400 por validación con JSON vacío).

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
| R9 | La interfaz no permite verificar | Un usuario no puede comprobar un certificado sin usar la API | MVP | Verificación y evidencia en la interfaz (F4, F7) |
| R10 | Un rol con `INSERT` puede guardar un hash arbitrario (aceptado) | Un registro inconsistente se guarda sin error; la verificación lo marca `valid:false` | Ambos (bajo) | Aceptado. El anclaje solo debe registrar hashes calculados por el servidor |
| R11 | El owner puede `DROP TABLE`/`DROP SCHEMA`; `prisma migrate reset` borra desarrollo | Un comando equivocado con la credencial owner pierde datos | Ambos | Documentado. En producción: credencial owner solo en el contenedor `migrate`, y backup antes de migrar |
| R12 | Backups: cifrado, copia externa y retención solo documentados | Un dump sin cifrar en el servidor expone datos personales; sin copia externa, perder el servidor es perder los datos | Producción | Automatizar backup cifrado y externo (I1) |
| R13 | Autenticación única compartida (basic auth de Caddy) y sin identidad de emisor | Cualquiera con la credencial emite certificados, y no queda registro de quién lo hizo | Ambos | Aceptado para el MVP como demo cerrada; identidad de emisores POSTERGADA (sección 7) |
| R14 | Sin rate limiting ni paginación | Con la credencial se puede llenar la base (y los certificados no se pueden borrar); el listado devuelve todos los nombres | Producción | Limitar escrituras y paginar (I3) |
| R15 | Sin logs de acceso (Caddy sin `log`, backend sin línea por solicitud) | No se puede reconstruir un incidente | Producción | `log` en Caddy (I2) |
| R16 | El superusuario puede entrar por TCP (`pg_hba host all all all`) | Una contraseña de administrador filtrada sirve desde la red interna de Docker | Producción | Restringir el superusuario al socket local (I4) |
| R17 | Se aceptan caracteres de control o de bidireccionalidad en `title`/`recipient` | Un certificado puede mostrar un texto distinto del que contiene | Ambos (bajo) | Rechazarlos en el DTO (I5) |
| R18 | El hash cubre solo metadatos: no certifica archivos | Si el objetivo incluye datos satelitales, el certificado no dice nada sobre su contenido | MVP | Decidido: el MVP certifica archivos (F1–F3) |
| R19 | La comprobación de `Origin` de las Server Actions no tiene prueba automatizada | Una actualización de Next.js podría cambiarla sin que nadie lo note | Ambos (bajo) | Prueba automatizada del frontend (postergado) |
| R20 | Subida de hasta 200 MB a través de Caddy y del proxy `/api/*` de Next.js sin probar | La subida podría cortarse, o un intermediario podría acumular el cuerpo en memoria o en disco (lo que rompería D2). La documentación local de Next 16 indica que el límite de 10 MB (`proxyClientMaxBodySize`) aplica solo cuando existe `proxy.ts`, que este proyecto no tiene; falta comprobarlo con un archivo real | MVP | Probar en F3 con un archivo de 200 MB midiendo memoria y disco de cada contenedor. Alternativa concreta si falla: que Caddy enrute `POST /api/certificates` y `/api/certificates/*/verify-file` directo al backend (mismo origen, sin CORS) |
| R21 | Fondos de prueba en Fuji | El faucet oficial puede exigir saldo en mainnet o un cupón; sin AVAX de prueba no hay anclaje ni demo | MVP | Conseguir fondos **ya** (próximo paso 2), antes de escribir el contrato |
| R22 | La clave privada que firma los anclajes vive en una variable de entorno del backend | Un compromiso del backend permite anclar hashes arbitrarios en nombre de SpaceProof | Ambos | Aceptado para el MVP: clave exclusiva de Fuji, sin fondos reales, nunca en Git. Custodia de claves postergada |
| R23 | Dependencia del RPC público de Fuji | Si el RPC no responde, el anclaje queda pendiente y la verificación no puede confirmar la cadena | MVP | La verificación responde «no se pudo comprobar» (nunca «válido»); el anclaje reintenta. Aceptado |
| R24 | Los metadatos los declara quien emite; no se extraen del archivo ni se contrastan con nada | El certificado prueba que *estos* metadatos quedaron ligados a *este* archivo, no que sean verdaderos, ni que el archivo venga de un satélite, ni quién lo produjo | MVP | Aceptado. Se documenta en «Qué demuestra y qué no» (sección 4), en la interfaz y en el README |
| R25 | El servidor no conserva el archivo (D2, confirmada) | Quien pierde el original no puede volver a verificarlo; SpaceProof no es un repositorio ni un backup | MVP | Aceptado por diseño; se informa al emitir |
| R26 | Solo se comprueba la firma TIFF (4 bytes) | Se puede certificar un TIFF que no sea GeoTIFF, o uno corrupto. No afecta a la integridad: el hash cubre los bytes tal cual | MVP (bajo) | Aceptado. La interfaz y la API dicen «firma TIFF», nunca «GeoTIFF validado». Validación real postergada |
| R27 | Una subida lenta puede superar el tiempo máximo de solicitud de Node (por defecto, 5 minutos) | 200 MB exigen unos 5,5 Mbit/s sostenidos; por debajo, la conexión se corta y hay que reintentar | MVP (bajo) | Medir en F3; ajustar el tiempo de espera del servidor solo si la prueba lo exige. La demo usa un archivo chico |
| R28 | Si la respuesta de una emisión se pierde después de crear el certificado, reintentar crea un segundo certificado del mismo archivo | Dos certificados válidos para un mismo archivo (cada uno con su `id` y su anclaje) | MVP (bajo) | Aceptado: ambos son verdaderos. La interfaz desactiva el botón mientras envía |

---

## 4. Arquitectura del MVP (planificada el 2026-11-13, **sin implementar**)

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
| **F3** | Emitir y verificar con archivo (sin cadena) | `app.setup.ts`, `certificates.controller.ts`, `certificates.service.ts`, DTO | `POST /certificates` en una operación (cuerpo en streaming + cabecera de metadatos); `GET /manifest`; `verify` y `verify-file` (comprobaciones a y b) | e2e: emisión válida; metadatos inválidos → 400 **sin leer el cuerpo**; sin firma TIFF → 415; vacío → 400; > 200 MB → 413; **carga interrumpida → ninguna fila nueva**; **original → coincide; un byte cambiado → `FILE_MISMATCH`**; registro inconsistente → `RECORD_MISMATCH`; CSRF: multipart, `text/plain` y JSON siguen rechazados en la ruta de emisión; los logs no contienen metadatos ni nombre de archivo | Los e2e pasan por HTTP; un archivo de 200 MB sube por Caddy + Next con memoria estable y **sin que aparezca ningún archivo** en los contenedores | R20, R27 |
| **F4** | Demo local sin cadena | `certificate-form.tsx`, `actions.ts`, `lib/api.ts`, `certificates/[id]/page.tsx` | Subida con `fetch` (sustituye la Server Action de emisión), certificado, verificación, aviso de no conservación y «Qué prueba este certificado» | Manual en navegador real (primera vez: hoy no está comprobado) + lint y build | Una persona emite y ve «válido» / «modificado» sin usar la API | — |
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
| F3 | **CRÍTICO** | Emisión en una operación y verificación de archivo, sin almacenamiento | R18 |
| F4 | **CRÍTICO** | Interfaz de emisión y verificación | R9 |
| F5 | **CRÍTICO** | Contrato desplegado en Fuji | R1 |
| F6 | **CRÍTICO** | Modelo `Anchor` y anclaje automático con recuperación | R1, R8 |
| F7 | IMPORTANTE | Evidencia del anclaje en la interfaz | R9 |
| F8 | IMPORTANTE | README, ensayo de demo | — |

Ninguno de estos está implementado. F0, F1 y F2 están en «Resueltos». **Siguiente: F3.**

### Antes de publicar en un servidor (no bloquean la demo local)

| # | Estado | Pendiente | Resuelve |
|---|---|---|---|
| P1 | IMPORTANTE | Adaptar producción a los roles: URLs separadas (owner solo en `migrate`, app en `backend`), montaje y variables del bootstrap, `pg_isready` por TCP, healthcheck del backend en `/api/health/ready`, variables `ANCHOR_*`, `.env.production.example`, y despliegue en orden con backup previo, bootstrap, `migrate deploy`, verificación de permisos y `verify:certificates` | R2, R3, R4 |
| I1 | IMPORTANTE | Backup automático, cifrado y externo, con retención y simulacro periódico | R12 |
| I2 | IMPORTANTE | Logs de acceso en Caddy | R15 |
| I3 | IMPORTANTE | Rate limiting de escrituras (incluidas las subidas) y paginación del listado | R14 |
| I4 | IMPORTANTE | Superusuario limitado al socket local en `pg_hba` | R16 |
| I5 | IMPORTANTE | Rechazar caracteres de control y de bidireccionalidad en el DTO (incluye los metadatos nuevos; conviene hacerlo dentro de F3) | R17 |

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
- **Tests del frontend**, incluida la comprobación de `Origin` de las Server Actions (R19).
- **Event trigger que bloquee `DROP`** sobre `Certificate` en producción.
- **Logs de acceso del backend** con trazabilidad por solicitud (el `requestId` ya existe).
- **Eliminar `/api` "Hello World"** cuando producción use `/api/health/ready`.
- **Backend de desarrollo escuchando solo en `127.0.0.1`** (hoy escucha en `0.0.0.0`).
- **`CHECK` de formato en `contentHash`**.
- **Cancelar la consulta** cuando `/api/health/ready` vence (hoy solo deja de esperarla).
- **Formato CRLF** en checkouts de Windows (`prettier --check` lo marca; no afecta al CI en Linux).
- **7 avisos moderados de `npm audit`** en dependencias de desarrollo del frontend (ESLint).
