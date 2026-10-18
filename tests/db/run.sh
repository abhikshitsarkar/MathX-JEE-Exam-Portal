#!/usr/bin/env bash
# Spins up a throwaway local PostgreSQL, applies the Neon stub, then every
# migration and the seed AS A NON-SUPERUSER OWNER (like neondb_owner on Neon),
# and finally runs the SQL test suite.
# Usage: bash tests/db/run.sh            (needs PostgreSQL 15+ binaries)
set -euo pipefail
cd "$(dirname "$0")/../.."

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54329}"
DATA="$(mktemp -d)"
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/log" start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -f tests/db/neon_stub.sql
"${PSQL[@]}" <<'SQL'
create role neondb_owner login createrole;
grant create on database postgres to neondb_owner;
alter schema public owner to neondb_owner;
grant usage on schema auth to neondb_owner;
grant authenticated, anonymous to neondb_owner with admin option;
SQL
OWNER=(psql -X -q -v ON_ERROR_STOP=1 -U neondb_owner)
for f in db/migrations/*.sql; do
  echo "migrate: $(basename "$f")"
  "${OWNER[@]}" -f "$f"
done
echo "seed: db/seed.sql"
"${OWNER[@]}" -f db/seed.sql
"${OWNER[@]}" -f db/seed.sql   # must be idempotent

status=0
for t in tests/db/test_*.sql; do
  echo "test: $(basename "$t")"
  if ! "${PSQL[@]}" -f "$t"; then status=1; fi
done
exit $status
