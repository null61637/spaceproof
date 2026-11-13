# SpaceProof — guía de instalación y operación

Detalle operativo: roles de PostgreSQL, variables de entorno, migraciones, pruebas, backups y despliegue con Docker Compose y Caddy. La presentación del proyecto está en el [README](../README.md); el estado, las decisiones y los pendientes, en [ESTADO_Y_PENDIENTES.md](ESTADO_Y_PENDIENTES.md); el anclaje en Avalanche, en [contracts/README.md](../contracts/README.md).

> Esta guía se escribió antes del anclaje en Avalanche. Las variables `ANCHOR_*` están documentadas en `backend/.env.example`. **El despliegue de producción (`docker-compose.prod.yml`) todavía no está adaptado** a los roles de la base ni a esas variables: ver el pendiente P1.

## Funcionalidades

- Certificar un archivo `.tif`/`.tiff` de hasta 200 MB junto con sus metadatos declarados. El archivo no se conserva: solo su SHA-256, tamaño y nombre. Solo se comprueba la firma TIFF.
- Verificar un archivo contra su certificado, desde la interfaz o por API: detecta cualquier cambio en el archivo o en los metadatos. **No prueba** la procedencia del archivo, la veracidad de los metadatos ni la autoría.
- Listar certificados y ver el detalle de cada uno.
- Verificar la integridad de un certificado por API (`GET /api/certificates/:id/verify`) o de todos a la vez (`pnpm verify:certificates`).
- Inmutabilidad en PostgreSQL: un trigger rechaza cualquier `UPDATE` de los datos del certificado (solo permite completar `txHash` una única vez), y `DELETE` y `TRUNCATE` están bloqueados por permisos y triggers.
- Privilegios mínimos: NestJS se conecta como `spaceproof_app` (solo `SELECT` e `INSERT`); las migraciones, como `spaceproof_owner`, propietario de las tablas.

## Arquitectura

```
Navegador ──HTTPS──▶ Caddy ──▶ Frontend (Next.js) ──HTTP──▶ Backend (NestJS) ──▶ PostgreSQL
                    (TLS +      UI                           API REST /api        (red interna,
                   basic auth)  proxy de /api/*              Prisma 7             sin puertos públicos)
```

- **Frontend** (`frontend/`): Next.js con App Router. Las páginas se renderizan en el servidor y consultan al backend por HTTP; el navegador envía los archivos a `/api/*`, que el Route Handler `app/api/[...path]/route.ts` reenvía al backend en flujo (sin `rewrites()`, que copia el cuerpo en memoria y lo corta a los 10 MB).
- **Backend** (`backend/`): API REST en NestJS bajo el prefijo `/api`. Accede a PostgreSQL con Prisma ORM 7 mediante el adaptador `@prisma/adapter-pg`.
- **Base de datos**: PostgreSQL 17, con migraciones de Prisma, roles separados (ver [Base de datos y roles](#base-de-datos-y-roles)) y triggers de inmutabilidad.
- **Producción**: Docker Compose con Caddy como proxy inverso (HTTPS automático y autenticación básica).

### Integridad de los certificados

Al emitir un certificado, el backend genera el `id` y la fecha de emisión y calcula el hash en el mismo `INSERT`, sobre una serialización canónica versionada. Los certificados de archivo usan el manifiesto v2 ([docs/manifiesto-v2.md](manifiesto-v2.md)); los emitidos antes (v1, solo título y destinatario) se siguen verificando con esta forma:

```json
{"v":1,"id":"…","title":"…","recipient":"…","createdAt":"2026-01-02T03:04:05.006Z"}
```

Los textos se normalizan a Unicode NFC. El cliente nunca envía el hash. La lógica está en `backend/src/certificates/certificate-hash.ts`.

| La verificación detecta | La verificación **no** detecta (todavía) |
|---|---|
| Un cambio en `id`, `title`, `recipient` o `createdAt` hecho sin recalcular el hash | Un cambio de datos **y** hash a la vez: el algoritmo es público y no hay anclaje externo |
| Un registro insertado con un hash que no corresponde a sus datos | Que la fecha `createdAt` sea la real (viene del reloj del servidor) |
| | Quién emitió el certificado (no hay identidad de emisor) |
| | El contenido de ningún archivo: el hash cubre solo esos cuatro campos |

Las protecciones de la base (permisos y triggers) frenan a la aplicación, pero no al propietario de las tablas ni al superusuario: ver [Riesgos de las credenciales](#riesgos-de-las-credenciales).

## Base de datos y roles

| Rol | Uso | Puede |
|---|---|---|
| `POSTGRES_USER` (p. ej. `spaceproof`) | Superusuario administrador. Solo ejecuta el bootstrap (`db/init/10-roles.sh`) y tareas de mantenimiento | Todo |
| `spaceproof_owner` | Propietario de bases, tablas y funciones. Ejecuta las migraciones (`MIGRATION_DATABASE_URL`) | Cambiar el esquema; no es superusuario ni puede crear bases o roles |
| `spaceproof_app` | NestJS en ejecución (`DATABASE_URL`) | `SELECT` e `INSERT` en `Certificate`; nada más |

`backend/db/init/10-roles.sh` crea los roles y las bases, transfiere al propietario los objetos existentes y revoca a `PUBLIC` el acceso a todas las bases (incluidas `postgres` y `template1`). Es idempotente: se puede repetir sin perder datos y aplica las contraseñas actuales de `.env`. En un volumen nuevo la imagen de PostgreSQL lo ejecuta sola; en uno existente, con `pnpm db:bootstrap`. Los permisos de tablas los conceden las migraciones; los tests de privilegios (`test/db-privileges.e2e-spec.ts`) comprueban el conjunto exacto.

### Riesgos de las credenciales

- **`spaceproof_owner`** puede desactivar triggers (`ALTER TABLE … DISABLE TRIGGER`), cambiar datos y recalcular hashes, y borrar tablas (`DROP TABLE` y `DROP SCHEMA` no disparan los triggers de borrado). Usala solo para migraciones: nunca en el backend ni en scripts de la aplicación.
- **El superusuario** puede todo, incluido saltarse los triggers con `session_replication_role`. Solo para el bootstrap y mantenimiento.
- En desarrollo, `backend/.env` contiene las dos URLs porque la Prisma CLI necesita la del propietario. NestJS solo lee `DATABASE_URL`.

## Entornos

| | Desarrollo | Tests e2e | Producción |
|---|---|---|---|
| Configuración | `backend/.env` | `backend/.env.test` (o `E2E_ENV_FILE`) | `.env` en la raíz del servidor |
| PostgreSQL | `backend/docker-compose.yml`, en `127.0.0.1:POSTGRES_PORT` | El mismo servidor que desarrollo | `docker-compose.prod.yml`, solo red interna |
| Base | `spaceproof` | `spaceproof_test`, **se reconstruye en cada ejecución** | `spaceproof` |
| Base shadow | `spaceproof_shadow` (solo `prisma migrate dev`) | — | — |
| Migraciones | `prisma migrate dev` / `deploy` como owner | `migrate deploy` automático antes de los tests | Solo `migrate deploy`, servicio `migrate` |
| Datos | Se conservan | Descartables | Se conservan; **sin certificados de prueba**: no se pueden borrar |

## Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, TypeScript |
| Backend | NestJS 11, class-validator, TypeScript |
| Datos | PostgreSQL 17, Prisma ORM 7 (`prisma-client`, `@prisma/adapter-pg`) |
| Producción | Docker Compose, Caddy 2.11 |
| CI | GitHub Actions (`.github/workflows/ci.yml`) |
| Gestores de paquetes | pnpm (backend), npm (frontend y raíz) |

## Estructura del repositorio

```
.
├── .github/workflows/ci.yml     CI: lint, build, tests, e2e, migraciones, Compose
├── backend/                     API NestJS + Prisma
│   ├── db/init/10-roles.sh      bootstrap de roles y bases de PostgreSQL
│   ├── prisma/                  schema.prisma y migraciones
│   ├── src/                     código fuente
│   │   └── scripts/             verify-certificates (verificación masiva)
│   ├── test/                    tests e2e
│   ├── docker-compose.yml       PostgreSQL de desarrollo
│   ├── .env.example             plantilla de backend/.env
│   └── .env.test.example        plantilla de backend/.env.test
├── frontend/                    aplicación Next.js
├── docs/backups.md              backups, restauración y verificación
├── docker-compose.prod.yml      stack de producción
├── Caddyfile                    proxy inverso, TLS y autenticación básica
├── .env.production.example      variables de producción (plantilla)
└── package.json                 scripts para ejecutar ambas apps en desarrollo
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api` | Responde `Hello World!` sin consultar la base. Se mantiene porque lo usa el healthcheck actual de producción |
| `GET` | `/api/health/live` | Liveness: el proceso responde. No consulta la base |
| `GET` | `/api/health/ready` | Readiness: `SELECT 1` en PostgreSQL (máx. 2 s). `200 {status, database}` o `503` |
| `POST` | `/api/certificates` | Emite el certificado de un archivo: cuerpo crudo `image/tiff` (hasta 200 MB) y metadatos en la cabecera `X-SpaceProof-Metadata`. Contrato: [docs/API_EMISION_VERIFICACION.md](API_EMISION_VERIFICACION.md) |
| `GET` | `/api/certificates` | Lista certificados, del más reciente al más antiguo |
| `GET` | `/api/certificates/:id` | Detalle (404 si no existe, 400 si el id no es un UUID) |
| `GET` | `/api/certificates/:id/verify` | Recalcula el hash del registro y consulta el anclaje. Devuelve `status`, `checks` y, por compatibilidad, `valid` |
| `POST` | `/api/certificates/:id/verify-file` | Verifica un archivo (cuerpo crudo `image/tiff`) contra el certificado |
| `GET` | `/api/certificates/:id/manifest` | Texto canónico exacto cuyo SHA-256 es el hash del certificado |

- **Tipo de contenido de las escrituras**: las dos rutas de archivo exigen `image/tiff`; cualquier otra escritura, `application/json`. En otro caso, `415`. Es la protección CSRF: otro sitio puede hacer que el navegador envíe formularios o `text/plain` con las credenciales guardadas (la autenticación básica de Caddy), pero no JSON ni `image/tiff` sin un *preflight* CORS, que la API nunca responde.
- **Anclaje**: la integración con Avalanche todavía no existe. Ninguna verificación devuelve `VALID`: el mejor resultado es `UNVERIFIABLE` con las comprobaciones de archivo y registro en `MATCH`.
- **`X-Request-Id`**: toda respuesta lo incluye (se reutiliza el recibido si es un identificador simple). Los errores 5xx lo devuelven en el cuerpo y lo registran en el log.
- **Errores**: `500` genérico, o `503` si PostgreSQL no está disponible. El log registra el código de Prisma, el SQLSTATE y el mensaje de PostgreSQL, nunca el cuerpo de la solicitud (contiene datos personales).

## Requisitos

- Node.js 22
- pnpm 10 (backend) y npm (frontend)
- Docker Engine con el plugin Compose (PostgreSQL de desarrollo y producción)

## Ejecución local

### 1. Instalar dependencias

```bash
npm install            # raíz: herramienta para ejecutar ambas apps a la vez
npm run install:all    # backend (pnpm) y frontend (npm)
```

La instalación del backend ejecuta `prisma generate` automáticamente.

### 2. Configurar variables de entorno

```bash
cp backend/.env.example backend/.env
cp backend/.env.test.example backend/.env.test
```

Editá ambos archivos: generá cada contraseña con `openssl rand -hex 32` y usá las mismas contraseñas de roles en los dos. **Nunca subas archivos `.env` al repositorio.**

| Variable (`backend/.env`) | Uso |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Superusuario administrador del PostgreSQL de desarrollo y puerto local. Ni la app ni Prisma lo usan |
| `SPACEPROOF_OWNER_PASSWORD`, `SPACEPROOF_APP_PASSWORD` | Contraseñas de `spaceproof_owner` y `spaceproof_app` (las aplica el bootstrap) |
| `DATABASE_URL` | NestJS y `verify:certificates`, como `spaceproof_app`, sobre `spaceproof` |
| `MIGRATION_DATABASE_URL` | Prisma CLI (migraciones), como `spaceproof_owner`, sobre `spaceproof` |
| `SHADOW_DATABASE_URL` | Base temporal de `prisma migrate dev`, como `spaceproof_owner`, sobre `spaceproof_shadow` |
| `PORT` | Puerto del backend (por defecto `3001`) |

`backend/.env.test` define `DATABASE_URL` (app) y `MIGRATION_DATABASE_URL` (owner) sobre `spaceproof_test`. El frontend no necesita `.env` en desarrollo: usa `BACKEND_URL`, que por defecto es `http://localhost:3001`.

### 3. Base de datos

```bash
cd backend
pnpm db:up             # docker compose up -d: PostgreSQL 17 en 127.0.0.1:POSTGRES_PORT
pnpm db:bootstrap      # solo en un volumen ya existente (en uno nuevo corre solo)
```

Crea `spaceproof`, `spaceproof_test` y `spaceproof_shadow`. Si cambiás una contraseña de rol en `.env`, volvé a ejecutar `pnpm db:bootstrap` (y recreá el contenedor con `pnpm db:up` para que reciba la variable nueva).

### 4. Migraciones de Prisma

```bash
cd backend
pnpm prisma:migrate    # prisma migrate dev, como spaceproof_owner
```

- Las migraciones requieren haber ejecutado el bootstrap: nombran a `spaceproof_app`.
- En **producción** se usa únicamente `prisma migrate deploy`: aplica las pendientes y nunca borra datos.
- No edites migraciones ya aplicadas: creá una nueva.
- Prisma no gestiona permisos: cada tabla nueva necesita su `GRANT` para `spaceproof_app` escrito en la migración (`prisma migrate dev --create-only` y editar el SQL). Los tests de privilegios fallan si falta o sobra alguno.

> ⚠️ **`prisma migrate reset` borra la base de desarrollo** (elimina el esquema y lo recrea), y `prisma migrate dev` **propone ese reset** cuando detecta que la base no coincide con el historial de migraciones. Los triggers de borrado no lo impiden: el propietario puede eliminar tablas. Ante esa propuesta, respondé que no y revisá la causa; para solo aplicar migraciones pendientes usá `pnpm exec prisma migrate deploy`. Hacé un backup antes (ver [docs/backups.md](backups.md)).

### 5. Ejecutar

Desde la raíz:

```bash
npm run dev
```

- Frontend: <http://localhost:3000>
- Backend: <http://localhost:3001/api>

## Tests

```bash
cd backend
pnpm test        # unitarios (sin base de datos)
pnpm test:e2e    # e2e contra spaceproof_test
```

Los tests e2e usan exclusivamente `backend/.env.test` (o el archivo indicado en `E2E_ENV_FILE`, p. ej. en CI). Antes de cada ejecución reconstruyen `spaceproof_test` como `spaceproof_owner`: borran su esquema `public` y aplican las migraciones. Para no operar nunca sobre otra base, se niegan a arrancar si:

- la base no es `spaceproof_test` o el host no es `localhost`/`127.0.0.1`;
- los roles no son `spaceproof_app` (`DATABASE_URL`) y `spaceproof_owner` (`MIGRATION_DATABASE_URL`);
- la URL tiene parámetros distintos de `schema` (node-postgres y Prisma permiten que `?host=` o `?user=` reemplacen los de la URL);
- la sesión real, ya conectada, no es la base y el rol esperados.

Incluyen pruebas de privilegios (T1–T15), CSRF, healthchecks y verificación masiva.

**CI** (`.github/workflows/ci.yml`): lint, build y tests unitarios del backend; e2e con un PostgreSQL nuevo (bootstrap en `initdb` y repetido, migraciones, comprobación de drift, verificación masiva); lint y build del frontend sin backend; y validación de `docker-compose.prod.yml` con valores ficticios. No usa secretos: genera contraseñas descartables en cada ejecución.

## Operación

- **Healthchecks**: `/api/health/live` (proceso) y `/api/health/ready` (PostgreSQL).
- **Logs**: texto en desarrollo y una línea JSON por evento en producción (`NODE_ENV=production`). Los errores incluyen `requestId`, método, ruta (el patrón, p. ej. `/api/certificates/:id`), código de Prisma y SQLSTATE; nunca contraseñas, URLs de conexión ni cuerpos de solicitud.
- **Verificación masiva**: `pnpm build && pnpm verify:certificates` recalcula el hash de todos los certificados en una transacción de solo lectura y muestra total, válidos, inválidos, errores y los ids afectados. Código de salida: `0` todo válido, `1` hay inválidos o ilegibles, `2` la verificación falló.
- **Backups y restauración**: [docs/backups.md](backups.md).

## Despliegue con Docker Compose y Caddy

> ⚠️ **Pendiente de adaptar a los roles de PostgreSQL.** `docker-compose.prod.yml` todavía no define `MIGRATION_DATABASE_URL` ni ejecuta el bootstrap de roles, y las migraciones desde `20261113060000_app_role_grants` requieren los roles `spaceproof_app` y `spaceproof_owner`. **No despliegues esta versión** hasta adaptar producción: el servicio `migrate` fallaría. Esta sección describe el stack actual.

El stack de producción (`docker-compose.prod.yml`) levanta:

| Servicio | Función | Puertos públicos |
|---|---|---|
| `caddy` | Proxy inverso, HTTPS automático (Let's Encrypt) y autenticación básica para todo el sitio, incluido `/api` | 80, 443 |
| `frontend` | Next.js en modo standalone | — |
| `backend` | API NestJS | — |
| `postgres` | PostgreSQL 17 con volumen persistente | — (solo red interna) |
| `migrate` | Tarea puntual: `prisma migrate deploy` | — |

Todos los contenedores se ejecutan sin privilegios de root y con `cap_drop: ALL`.

### Requisitos del servidor

- Linux con Docker Engine y el plugin Compose.
- Un dominio cuyo registro DNS `A` apunte al servidor.
- Puertos 80 y 443 abiertos; **no abras el 5432**.

### Variables de producción

En el servidor, desde la raíz del repositorio:

```bash
cp .env.production.example .env
chmod 600 .env
```

| Variable | Descripción |
|---|---|
| `DOMAIN` | Dominio público del sitio |
| `POSTGRES_USER`, `POSTGRES_DB` | Usuario y base (solo letras minúsculas, dígitos y `_`) |
| `POSTGRES_PASSWORD` | Generala con `openssl rand -hex 32` |
| `BASIC_AUTH_USER` | Usuario de la autenticación básica |
| `BASIC_AUTH_HASH` | Hash bcrypt generado con `docker run --rm -it caddy:2.11-alpine caddy hash-password`, **entre comillas simples** |

Si falta alguna variable, Compose se niega a arrancar.

### Primer despliegue

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml ps                  # esperar a que postgres esté "healthy"
docker compose -f docker-compose.prod.yml run --build --rm migrate
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f caddy       # confirmar la emisión del certificado TLS
```

### Actualizaciones

```bash
git pull
mkdir -p ~/backups
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/backups/spaceproof-$(date +%F-%H%M).dump
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --build --rm migrate
docker compose -f docker-compose.prod.yml up -d
```

Ejecutá siempre las migraciones con `--build`: `migrate` está en un *profile* y un `build` normal no lo reconstruye.

> ⚠️ `docker compose -f docker-compose.prod.yml down -v` **elimina los volúmenes**: todos los datos de PostgreSQL y los certificados TLS. Para detener el stack conservando los datos, usá `down` sin `-v`.

## Seguridad

- La aplicación no tiene cuentas de usuario: en producción, el acceso se protege con la autenticación básica de Caddy (una credencial compartida).
- PostgreSQL no publica puertos en producción; en desarrollo solo escucha en `127.0.0.1`.
- El backend se conecta con un rol sin privilegios de administración que no puede modificar ni borrar certificados.
- Escrituras de la API solo en JSON (protección CSRF; ver [API](#api)).
- Los secretos viven únicamente en archivos `.env`, que están excluidos de Git y de las imágenes Docker. Los backups contienen datos personales: ver [docs/backups.md](backups.md).
