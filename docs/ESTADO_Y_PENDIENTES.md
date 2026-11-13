# SpaceProof — Estado y pendientes

Última actualización: 2026-11-13, al cierre de la fase 3D.

Este documento registra qué está hecho y comprobado, qué se decidió, qué riesgos se conocen y qué falta para terminar el MVP. Detalle operativo en el [README](../README.md) y en [backups.md](backups.md).

**Alcance de las comprobaciones.** Todo lo marcado como verificado se probó **en local** (Windows + Docker Desktop): en el PostgreSQL de desarrollo, en la base `spaceproof_test` y en un servidor PostgreSQL descartable con volumen nuevo. **Nada se validó en producción** (ni siquiera se inspeccionó el servidor) **ni en GitHub Actions** (el workflow nunca se ejecutó allí).

Objetivo del MVP, según el README: emitir certificados y verificar su integridad mediante un hash SHA-256 calculado por el servidor, con el hash anclado en blockchain (Avalanche) para que la verificación no dependa de confiar en la base de datos.

---

## 1. Estado actual

### Funciona y está cubierto por pruebas automatizadas

| Funcionalidad | Evidencia |
|---|---|
| Crear, listar y consultar certificados (API y UI) | e2e `certificates.e2e-spec.ts`; prueba manual de fase 1 por HTTP (sin navegador) |
| Hash SHA-256 canónico v1 (`id`, `title`, `recipient`, `createdAt`; NFC) calculado solo en el servidor | Unit `certificate-hash.spec.ts` (vector conocido calculado con `sha256sum`); e2e rechaza `contentHash`/`id`/`txHash` enviados por el cliente |
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

Últimos resultados: **31/31 unitarios** y **75/75 e2e** (en el servidor de desarrollo y en uno nuevo).

### Comprobado solo manualmente

- **Server Actions frente a otro `Origin`**: Next.js abortó la acción con `Origin` ajeno y la ejecutó con el propio (probado con el formulario real y datos vacíos). No hay prueba automatizada.
- **Proxy `/api/*` del frontend**: probado con `curl` (415 para formularios, 400 por validación con JSON vacío).

### Validado solo de forma estática

- **`.github/workflows/ci.yml`**: pasa `actionlint` (con shellcheck), y sus pasos se reprodujeron localmente. **Nunca corrió en GitHub.**
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

---

## 3. Limitaciones y riesgos conocidos

| # | Problema | Qué podría suceder | Afecta a | Acción necesaria |
|---|---|---|---|---|
| R1 | El hash vive en la misma base que los datos, sin anclaje externo | Quien controle la base (owner o superusuario) cambia datos y recalcula el hash, y la verificación da `valid:true`. **El producto todavía no prueba nada frente a ese actor** | Ambos | Anclaje en Avalanche (pendiente P2–P4) |
| R2 | `docker-compose.prod.yml` no está adaptado a los roles | Un `git pull` seguido de `migrate` falla (no hay `MIGRATION_DATABASE_URL`, y las migraciones nuevas exigen roles inexistentes). Prisma puede dejar una migración marcada como fallida | Producción | Adaptar producción (P1) |
| R3 | El healthcheck de PostgreSQL en producción usa el socket | En una instalación nueva, `migrate` o `backend` podrían arrancar antes de que existan los roles (carrera medida en desarrollo) | Producción | `pg_isready -h 127.0.0.1` al adaptar producción (P1) |
| R4 | El backend de producción todavía se conectaría como superusuario | Un fallo en la app tendría privilegios totales sobre la base | Producción | Usar la URL de `spaceproof_app` (P1) |
| R5 | **Todo el trabajo desde la fase 3B está sin commit** (36 rutas; el único commit es el inicial) | Una limpieza del working tree o un fallo de disco pierde el hardening, las migraciones nuevas y las pruebas | Ambos | Commit en una rama y revisión (P0) |
| R6 | El CI nunca corrió en GitHub | Algo puede diferir en los runners (descarga de motores de Prisma, Docker), y nadie se entera hasta el primer push | Ambos | Push a una rama y revisar la primera ejecución (P0) |
| R7 | Sin versión de hash almacenada; `verify()` asume v1 | Al introducir un formato nuevo (p. ej. con hash de archivo), los certificados existentes o los nuevos dejarían de verificar. Un hash anclado es permanente | MVP | Columna `hashVersion` y especificación escrita, antes de anclar (P2) |
| R8 | `txHash` es un único campo que solo se completa una vez | Una transacción fallida o reemplazada deja el certificado asociado para siempre a un `txHash` incorrecto | MVP | Modelo de anclaje con estados antes de integrar Avalanche (P3) |
| R9 | La interfaz no permite verificar | Un usuario no puede comprobar un certificado sin usar la API | MVP | Mostrar el resultado de `/verify` en la página de detalle (P5) |
| R10 | Un rol con `INSERT` puede guardar un hash arbitrario (aceptado) | Un registro inconsistente se guarda sin error; la verificación lo marca `valid:false` | Ambos (bajo) | Aceptado. El anclaje solo debe registrar hashes calculados por el servidor |
| R11 | El owner puede `DROP TABLE`/`DROP SCHEMA`; `prisma migrate reset` borra desarrollo | Un comando equivocado con la credencial owner pierde datos | Ambos | Documentado. En producción: credencial owner solo en el contenedor `migrate`, y backup antes de migrar |
| R12 | Backups: cifrado, copia externa y retención solo documentados | Un dump sin cifrar en el servidor expone datos personales; sin copia externa, perder el servidor es perder los datos | Producción | Automatizar backup cifrado y externo (I1) |
| R13 | Autenticación única compartida (basic auth de Caddy) y sin identidad de emisor | Cualquiera con la credencial emite certificados, y no queda registro de quién lo hizo | Ambos | Aceptable para el MVP como demo cerrada; identidad de emisores postergada |
| R14 | Sin rate limiting ni paginación | Con la credencial se puede llenar la base (y los certificados no se pueden borrar); el listado devuelve todos los nombres | Producción | Limitar escrituras y paginar (I3) |
| R15 | Sin logs de acceso (Caddy sin `log`, backend sin línea por solicitud) | No se puede reconstruir un incidente | Producción | `log` en Caddy (I2) |
| R16 | El superusuario puede entrar por TCP (`pg_hba host all all all`) | Una contraseña de administrador filtrada sirve desde la red interna de Docker | Producción | Restringir el superusuario al socket local (I4) |
| R17 | Se aceptan caracteres de control o de bidireccionalidad en `title`/`recipient` | Un certificado puede mostrar un texto distinto del que contiene | Ambos (bajo) | Rechazarlos en el DTO (I5) |
| R18 | El hash cubre solo metadatos: no certifica archivos | Si el objetivo incluye datos satelitales, el certificado no dice nada sobre su contenido | MVP, **a definir** | Decidir si el MVP certifica archivos (D1) |
| R19 | La comprobación de `Origin` de las Server Actions no tiene prueba automatizada | Una actualización de Next.js podría cambiarla sin que nadie lo note | Ambos (bajo) | Prueba automatizada del frontend (postergado) |

---

## 4. Pendientes para terminar el MVP

### Decisión previa

| # | Decisión | Por qué ahora |
|---|---|---|
| D1 | **¿El MVP certifica archivos (datos satelitales) o solo metadatos?** No está decidido | Cambia el formato del hash (P2). Si los archivos entran después, la versión de hash lo permite sin rehacer nada. Si entran en el MVP, P2 debe incluir su hash desde el principio |

### Pendientes

| # | Estado | Pendiente | Resuelve |
|---|---|---|---|
| P0 | **CRÍTICO** | Commit del trabajo de las fases 3B–3D en una rama, push y primera ejecución del CI en GitHub | R5, R6 |
| P1 | **CRÍTICO** | Adaptar producción a los roles: URLs separadas (owner solo en `migrate`, app en `backend`), montaje y variables del bootstrap, `pg_isready` por TCP, healthcheck del backend en `/api/health/ready`, `.env.production.example`, y despliegue en orden con backup previo, bootstrap, `migrate deploy`, verificación de permisos y `verify:certificates` | R2, R3, R4 |
| P2 | **CRÍTICO** | Versión de hash almacenada (`hashVersion`, v1 para los existentes) y especificación escrita del formato canónico con vectores de prueba. Antes de anclar nada | R7 |
| P3 | **CRÍTICO** | Modelo de anclaje mínimo: tabla de anclajes con estado (pendiente, enviado, confirmado, fallido), red, `txHash` y bloque, más el rol que lo actualiza. Sustituye el uso de `Certificate.txHash` | R8 |
| P4 | **CRÍTICO** | Integración con Avalanche en testnet (Fuji): contrato mínimo que registra el hash (sin datos personales), envío y seguimiento de transacciones sin duplicados, y verificación que compare el hash recalculado con el anclado | R1 |
| P5 | IMPORTANTE | Verificación visible en la interfaz (detalle del certificado), incluido el estado del anclaje cuando exista | R9 |

Todos los pendientes de esta sección están abiertos: **ninguno está implementado**.

### Antes de producción (no bloquean el desarrollo del MVP)

| # | Estado | Pendiente | Resuelve |
|---|---|---|---|
| I1 | IMPORTANTE | Backup automático, cifrado y externo, con retención y simulacro periódico | R12 |
| I2 | IMPORTANTE | Logs de acceso en Caddy | R15 |
| I3 | IMPORTANTE | Rate limiting de escrituras y paginación del listado | R14 |
| I4 | IMPORTANTE | Superusuario limitado al socket local en `pg_hba` | R16 |
| I5 | IMPORTANTE | Rechazar caracteres de control y de bidireccionalidad en el DTO | R17 |

### Resueltos (implementados y verificados localmente)

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

---

## 5. Mejoras postergadas

No forman parte del alcance actual. Se registran para no perderlas, no para hacerlas ahora.

- **Identidad de emisores y cuentas de usuario** (sustituir la autenticación básica compartida).
- **Revocación de certificados** como registro aparte (sin borrado).
- **Procedimiento de borrado por solicitudes legales o de privacidad** (pospuesto por decisión).
- **Verificación pública sin credenciales** (por hash o por id).
- **Certificación de archivos satelitales**, si D1 la deja fuera del MVP: hash del contenido, manifiesto para productos de varios archivos, almacenamiento externo, subida fuera de Server Actions.
- **Tests del frontend**, incluida la comprobación de `Origin` de las Server Actions (R19).
- **Event trigger que bloquee `DROP`** sobre `Certificate` en producción.
- **Logs de acceso del backend** con trazabilidad por solicitud (el `requestId` ya existe).
- **Eliminar `/api` "Hello World"** cuando producción use `/api/health/ready`.
- **Backend de desarrollo escuchando solo en `127.0.0.1`** (hoy escucha en `0.0.0.0`).
- **`CHECK` de formato en `contentHash`**.
- **Cancelar la consulta** cuando `/api/health/ready` vence (hoy solo deja de esperarla).
- **Formato CRLF** en checkouts de Windows (`prettier --check` lo marca; no afecta al CI en Linux).
- **7 avisos moderados de `npm audit`** en dependencias de desarrollo del frontend (ESLint).
