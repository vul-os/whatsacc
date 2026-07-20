#!/usr/bin/env bash
# Drops the local Postgres `lintel` database, re-applies all migrations,
# and re-grants the schema permissions lintel_internal needs (the public
# schema GRANTs are wiped by the reset since DROP SCHEMA CASCADE removes them).
#
# Prereqs (one-time):
#   sudo -u postgres psql -c "CREATE ROLE lintel_app LOGIN PASSWORD 'local_dev_only';"
#   sudo -u postgres psql -c "CREATE ROLE lintel_internal NOLOGIN BYPASSRLS;"
#   sudo -u postgres psql -c "GRANT lintel_internal TO lintel_app;"
#   sudo -u postgres psql -c "CREATE DATABASE lintel OWNER lintel_app;"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.deno/bin:$PATH"

cd "$REPO_ROOT/backend"
deno run -A --env-file=../.env cmd/migrate/main.ts reset

PGPASSWORD=local_dev_only psql -U lintel_app -h 127.0.0.1 -d lintel -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO lintel_internal;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lintel_internal;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lintel_internal;
ALTER DEFAULT PRIVILEGES FOR ROLE lintel_app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lintel_internal;
ALTER DEFAULT PRIVILEGES FOR ROLE lintel_app IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lintel_internal;
SQL

echo "✓ DB reset complete"
