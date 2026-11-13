#!/bin/sh
# PostgreSQL bootstrap for SpaceProof, run as the admin superuser (POSTGRES_USER).
#
# - On a new volume, the postgres image runs it automatically (mounted into
#   /docker-entrypoint-initdb.d).
# - On an existing volume, run it by hand: `pnpm db:bootstrap`.
#
# Idempotent: every run (re)applies the same state and never deletes data.
#
#   spaceproof_owner  owns the databases and every object in schema public;
#                     runs the migrations. Not a superuser.
#   spaceproof_app    runtime role of the NestJS API. Gets only what the
#                     migrations grant it (SELECT, INSERT on "Certificate").
#
# Table privileges are granted by the Prisma migrations, not here.

# Subshell: the image's entrypoint sources non-executable scripts, so keep
# `set -u` and the helper function out of its shell.
(
  set -eu
  : "${SPACEPROOF_OWNER_PASSWORD:?SPACEPROOF_OWNER_PASSWORD is not set}"
  : "${SPACEPROOF_APP_PASSWORD:?SPACEPROOF_APP_PASSWORD is not set}"

  admin_psql() {
    psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet --username "$POSTGRES_USER" "$@"
  }

  # Roles. Passwords come from the environment (\getenv), never from argv.
  admin_psql --dbname postgres <<'SQL'
\getenv owner_password SPACEPROOF_OWNER_PASSWORD
\getenv app_password SPACEPROOF_APP_PASSWORD
SELECT 'CREATE ROLE spaceproof_owner'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spaceproof_owner') \gexec
SELECT 'CREATE ROLE spaceproof_app'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spaceproof_app') \gexec
ALTER ROLE spaceproof_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'owner_password';
ALTER ROLE spaceproof_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'app_password';
SQL

  # Maintenance databases: nobody but the admin needs them (by default PUBLIC
  # may connect, and create temporary tables in postgres).
  admin_psql --dbname postgres <<'SQL'
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE template1 FROM PUBLIC;
SQL

  # Databases: POSTGRES_DB plus, in development only, the E2E database
  # (SPACEPROOF_TEST_DATABASE) and the Prisma shadow database
  # (SPACEPROOF_SHADOW_DATABASE). The API connects to all but the shadow one.
  shadow_db="${SPACEPROOF_SHADOW_DATABASE:-}"
  for db in "$POSTGRES_DB" ${SPACEPROOF_TEST_DATABASE:-} $shadow_db; do
    if [ "$db" = "$shadow_db" ]; then app_connect=REVOKE; else app_connect=GRANT; fi
    admin_psql --dbname postgres --set db="$db" --set app_connect="$app_connect" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER spaceproof_owner', :'db')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO spaceproof_owner', :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT CASE :'app_connect'
         WHEN 'GRANT' THEN format('GRANT CONNECT ON DATABASE %I TO spaceproof_app', :'db')
         ELSE format('REVOKE ALL ON DATABASE %I FROM spaceproof_app', :'db')
       END \gexec
SQL

    # Objects created before this bootstrap (by the admin user) move to the
    # owner one by one: REASSIGN OWNED cannot be used on the bootstrap
    # superuser, which also owns the system catalogs. Indexes and triggers
    # follow their table; schema public belongs to the database owner.
    admin_psql --dbname "$db" <<'SQL'
SELECT format('ALTER TABLE %I.%I OWNER TO spaceproof_owner', n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND c.relowner <> 'spaceproof_owner'::regrole \gexec
SELECT format('ALTER ROUTINE %s OWNER TO spaceproof_owner', p.oid::regprocedure)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proowner <> 'spaceproof_owner'::regrole \gexec
SELECT format('ALTER TYPE %s OWNER TO spaceproof_owner', t.oid::regtype)
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') AND t.typrelid = 0
   AND t.typowner <> 'spaceproof_owner'::regrole \gexec
SQL
  done
)
