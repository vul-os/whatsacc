#!/usr/bin/env bash
# Drops the local Postgres `whatsacc` database, re-applies all migrations,
# and re-grants the schema permissions whatsacc_internal needs (the public
# schema GRANTs are wiped by the reset since DROP SCHEMA CASCADE removes them).
#
# Prereqs (one-time):
#   sudo -u postgres psql -c "CREATE ROLE whatsacc_app LOGIN PASSWORD 'local_dev_only';"
#   sudo -u postgres psql -c "CREATE ROLE whatsacc_internal NOLOGIN BYPASSRLS;"
#   sudo -u postgres psql -c "GRANT whatsacc_internal TO whatsacc_app;"
#   sudo -u postgres psql -c "CREATE DATABASE whatsacc OWNER whatsacc_app;"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.deno/bin:$PATH"

cd "$REPO_ROOT/backend"
deno run -A --env-file=../.env cmd/migrate/main.ts reset

PGPASSWORD=local_dev_only psql -U whatsacc_app -h 127.0.0.1 -d whatsacc -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO whatsacc_internal;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO whatsacc_internal;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO whatsacc_internal;
ALTER DEFAULT PRIVILEGES FOR ROLE whatsacc_app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO whatsacc_internal;
ALTER DEFAULT PRIVILEGES FOR ROLE whatsacc_app IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO whatsacc_internal;
SQL

echo "✓ DB reset complete"
