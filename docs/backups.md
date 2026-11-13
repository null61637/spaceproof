# Backups, restauración y verificación

Los certificados no se pueden borrar ni modificar desde la aplicación, pero un backup sigue siendo la única defensa ante pérdida del volumen, un error de operación (`prisma migrate reset`, `down -v`, `DROP TABLE` con la credencial owner) o un servidor comprometido.

> Producción todavía no está adaptada a los roles de PostgreSQL (ver el README). Los comandos de producción de esta guía aplican una vez hecha esa adaptación; hasta entonces, el backup previo a cualquier cambio es el de la sección *Actualizaciones* del README.

## Qué incluye un backup

`pg_dump -Fc` de la base `spaceproof` contiene tablas, datos, funciones, triggers, propietarios (`OWNER TO spaceproof_owner`), permisos (`GRANT … TO spaceproof_app`), privilegios por defecto y el historial `_prisma_migrations`.

**No** incluye:

- **Los roles** (son globales del servidor). Se recrean con el bootstrap (`db/init/10-roles.sh`) y las contraseñas de `.env`; por eso no hace falta guardar `pg_dumpall --globals-only`, que además contiene los hashes de las contraseñas.
- **Los permisos a nivel de base** (`CONNECT`, revocación a `PUBLIC`). También los aplica el bootstrap, o el paso 2 de la restauración.

## Crear un backup

Desarrollo (desde `backend/`):

```bash
mkdir -p ~/backups
docker compose exec -T postgres pg_dump -U spaceproof -d spaceproof -Fc \
  > ~/backups/spaceproof-dev-$(date +%F-%H%M).dump
```

Producción (desde la raíz del repositorio):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > ~/backups/spaceproof-$(date +%F-%H%M).dump
```

Después de cada backup:

```bash
f=~/backups/spaceproof-AAAA-MM-DD-HHMM.dump
sha256sum "$f" > "$f.sha256"                                         # integridad del archivo
docker compose exec -T postgres pg_restore --list < "$f" > /dev/null  # el dump es legible
```

`pg_dump` toma una instantánea consistente sin bloquear la aplicación.

## Cifrado, almacenamiento externo y retención

Un dump contiene **datos personales** (nombres de destinatarios) sin cifrar. En producción:

- **Cifrar antes de sacarlo del servidor**, con una clave pública cuyo par privado **no** vive en el servidor. Por ejemplo, con [age](https://age-encryption.org):

  ```bash
  age -r age1…clave-publica… -o "$f.age" "$f" && shred -u "$f"
  ```

  Restaurar requiere la clave privada (guardada fuera de línea o en un gestor de secretos), así que un servidor comprometido no puede leer los backups antiguos.
- **Almacenamiento externo**: copiar el `.age` y su `.sha256` a un almacenamiento de objetos de otro proveedor o cuenta, con versionado y, si existe, bloqueo de objetos (*object lock* / WORM), para que una credencial robada del servidor no pueda borrar los backups.
- **Retención sugerida**: diarios durante 7 días, semanales durante 4 semanas y mensuales durante 12 meses. Ajustala a los requisitos legales sobre datos personales: un backup retenido sigue conteniendo esos datos.
- **Frecuencia**: al menos diaria, y siempre antes de migraciones o cambios de configuración de PostgreSQL.
- **Prueba periódica**: un backup que nunca se restauró no está probado. Repetí la restauración de abajo al menos una vez por trimestre.

## Restaurar

Nunca restaures sobre la base en uso, y **nunca uses `pg_restore --clean`** sobre `spaceproof` ni sobre producción: borra las tablas (`DROP` no dispara los triggers de borrado) antes de recrearlas, y si la restauración falla a mitad, los datos quedan perdidos.

Siempre en una **base nueva**, comparando antes de cambiar nada:

1. **Roles**: en un servidor nuevo, el bootstrap corre solo al crear el volumen; en uno existente, `pnpm db:bootstrap` (desarrollo).
2. **Base vacía** con los mismos permisos que aplica el bootstrap:

   ```bash
   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U spaceproof -d postgres <<'SQL'
   CREATE DATABASE spaceproof_restore OWNER spaceproof_owner;
   REVOKE ALL ON DATABASE spaceproof_restore FROM PUBLIC;
   GRANT CONNECT ON DATABASE spaceproof_restore TO spaceproof_app;
   SQL
   ```

3. **Restaurar** como administrador, todo o nada:

   ```bash
   docker compose exec -T postgres pg_restore -U spaceproof -d spaceproof_restore \
     --exit-on-error --single-transaction < backup.dump
   ```

   Los propietarios y permisos vienen del dump (los roles ya existen).
4. **Migraciones**: si el backup es anterior a la última migración, aplicá las pendientes como owner, con `MIGRATION_DATABASE_URL` apuntando a `spaceproof_restore`: `pnpm exec prisma migrate deploy`.
5. **Verificar los hashes** con el rol de la aplicación, apuntando a la base restaurada:

   ```bash
   pnpm build
   DATABASE_URL="postgresql://spaceproof_app:…@localhost:5432/spaceproof_restore?schema=public" \
     pnpm verify:certificates
   ```

   Compará `total`, `valid` e `invalid` con la misma verificación sobre el origen (si todavía existe) o con la última registrada.
6. **Cambiar de base** solo cuando todo coincide, con la aplicación detenida: apuntar `DATABASE_URL` y `MIGRATION_DATABASE_URL` a la base restaurada, o renombrar las bases (`ALTER DATABASE … RENAME`, como administrador y sin conexiones abiertas). Conservá la base anterior hasta confirmar que la restaurada funciona.

## Verificación masiva de hashes

```bash
cd backend
pnpm build
pnpm verify:certificates                # usa DATABASE_URL (spaceproof_app)
# producción: docker compose -f docker-compose.prod.yml exec backend node dist/scripts/verify-certificates.js
```

Recalcula el hash de cada certificado en una transacción `REPEATABLE READ, READ ONLY` (instantánea consistente, sin escrituras posibles) y muestra:

```json
{ "total": 21, "valid": 19, "invalid": 2, "errors": 0, "invalidIds": ["…"], "errorIds": [] }
```

Solo informa ids, nunca títulos ni destinatarios. Código de salida: `0` todo válido, `1` hay certificados inválidos o ilegibles, `2` la verificación no pudo ejecutarse.

Un certificado inválido significa que sus datos ya no coinciden con su hash (o que se insertó así): investigá con el `id`, sin modificar el registro.

## Simulacro realizado (desarrollo, fase 3D)

En un servidor PostgreSQL descartable (proyecto Compose aparte, volumen nuevo):

- El backup de `spaceproof` de desarrollo se restauró en una base nueva: tablas, propietarios, permisos, privilegios por defecto, triggers (habilitados), migraciones y datos idénticos al origen.
- Una base con 21 certificados (2 alterados a propósito por los tests) se restauró con datos idénticos (mismo resumen MD5), y la verificación masiva dio el mismo resultado en origen y copia: 21 total, 19 válidos, 2 inválidos, 0 errores.
