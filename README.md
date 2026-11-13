# SpaceProof

SpaceProof es una aplicación web para emitir y verificar certificados. Cada certificado se guarda en PostgreSQL junto con un **hash SHA-256 generado por el servidor** a partir de sus datos, y la base de datos impide modificarlo después de creado. Cualquier alteración posterior se puede detectar recalculando el hash.

> Estado: MVP. El registro del hash en blockchain (Avalanche) está previsto pero **todavía no está integrado**; el campo `txHash` queda vacío hasta entonces.

## Funcionalidades

- Crear certificados (título y destinatario).
- Listar certificados y ver el detalle de cada uno.
- Verificar la integridad de un certificado (`/api/certificates/:id/verify`).
- Protección de integridad en PostgreSQL: un trigger rechaza cualquier `UPDATE` de los datos del certificado; solo permite completar `txHash` una única vez.

## Arquitectura

```
Navegador ──HTTPS──▶ Caddy ──▶ Frontend (Next.js) ──HTTP──▶ Backend (NestJS) ──▶ PostgreSQL
                    (TLS +      UI + Server Actions          API REST /api        (red interna,
                   basic auth)  proxy de /api/*              Prisma 7             sin puertos públicos)
```

- **Frontend** (`frontend/`): Next.js con App Router. Las páginas se renderizan en el servidor y consultan al backend por HTTP; el formulario usa Server Actions. Además, `next.config.ts` reenvía `/api/*` al backend.
- **Backend** (`backend/`): API REST en NestJS bajo el prefijo `/api`. Accede a PostgreSQL con Prisma ORM 7 mediante el adaptador `@prisma/adapter-pg`.
- **Base de datos**: PostgreSQL 17, con migraciones de Prisma.
- **Producción**: Docker Compose con Caddy como proxy inverso (HTTPS automático y autenticación básica).

### Integridad de los certificados

Al crear un certificado, el backend genera el `id` y la fecha de emisión y calcula el hash en el mismo `INSERT`, sobre una serialización canónica versionada:

```json
{"v":1,"id":"…","title":"…","recipient":"…","createdAt":"2026-01-02T03:04:05.006Z"}
```

Los textos se normalizan a Unicode NFC. El cliente nunca envía el hash. La lógica está en `backend/src/certificates/certificate-hash.ts`.

## Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, TypeScript |
| Backend | NestJS 11, class-validator, TypeScript |
| Datos | PostgreSQL 17, Prisma ORM 7 (`prisma-client`, `@prisma/adapter-pg`) |
| Producción | Docker Compose, Caddy 2.11 |
| Gestores de paquetes | pnpm (backend), npm (frontend y raíz) |

## Estructura del repositorio

```
.
├── backend/                 API NestJS + Prisma
│   ├── prisma/              schema.prisma y migraciones
│   ├── src/                 código fuente
│   └── test/                tests e2e
├── frontend/                aplicación Next.js
├── docker-compose.prod.yml  stack de producción
├── Caddyfile                proxy inverso, TLS y autenticación básica
├── .env.production.example  variables de producción (plantilla)
└── package.json             scripts para ejecutar ambas apps en desarrollo
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api` | Healthcheck |
| `POST` | `/api/certificates` | Crea un certificado. Body: `{ "title": string, "recipient": string }` (máx. 200 caracteres cada uno) |
| `GET` | `/api/certificates` | Lista certificados, del más reciente al más antiguo |
| `GET` | `/api/certificates/:id` | Detalle (404 si no existe, 400 si el id no es un UUID) |
| `GET` | `/api/certificates/:id/verify` | Recalcula el hash y devuelve `{ valid, storedHash, computedHash }` |

## Requisitos

- Node.js 22
- pnpm 10 (backend) y npm (frontend)
- PostgreSQL 17, instalado localmente o mediante Docker
- Docker Engine con el plugin Compose (opcional en desarrollo; necesario para producción)

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
```

Editá `backend/.env` con los datos de tu PostgreSQL. **Nunca subas archivos `.env` al repositorio.**

| Variable (`backend/.env`) | Uso |
|---|---|
| `DATABASE_URL` | Conexión de Prisma y NestJS, p. ej. `postgresql://usuario:contraseña@localhost:5432/spaceproof?schema=public` |
| `PORT` | Puerto del backend (por defecto `3001`) |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Solo para el PostgreSQL de desarrollo con Docker (`backend/docker-compose.yml`); deben coincidir con `DATABASE_URL` |

El frontend no necesita archivo `.env` en desarrollo: usa `BACKEND_URL`, que por defecto es `http://localhost:3001`.

### 3. Base de datos

Si no tenés PostgreSQL instalado, podés levantar uno con Docker:

```bash
cd backend
pnpm db:up             # docker compose up -d (PostgreSQL 17 en el puerto 5432)
```

### 4. Migraciones de Prisma

```bash
cd backend
pnpm prisma:migrate    # prisma migrate dev: aplica las migraciones pendientes
```

- En **desarrollo**, `prisma migrate dev` aplica las migraciones y crea nuevas cuando cambia `prisma/schema.prisma`.
- En **producción** se usa únicamente `prisma migrate deploy` (ver más abajo), que aplica las pendientes y nunca borra datos.
- No edites migraciones ya aplicadas: creá una nueva.

### 5. Ejecutar

Desde la raíz:

```bash
npm run dev
```

- Frontend: <http://localhost:3000>
- Backend: <http://localhost:3001/api>

### Tests

```bash
cd backend
pnpm test        # unitarios
pnpm test:e2e    # e2e contra la base de DATABASE_URL
```

> Los tests e2e crean y borran registros en la base configurada en `DATABASE_URL`. **Nunca los ejecutes contra producción.**

## Despliegue con Docker Compose y Caddy

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

- La aplicación no tiene cuentas de usuario: en producción, el acceso se protege con la autenticación básica de Caddy.
- PostgreSQL no publica puertos; solo es accesible desde la red interna de Docker.
- Los secretos viven únicamente en archivos `.env`, que están excluidos de Git y de las imágenes Docker.
