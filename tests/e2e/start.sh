#!/usr/bin/env bash
# Starts a local stand-in for the Neon stack for end-to-end tests:
#   Postgres (Neon stub + migrations + seed, as a non-superuser owner)
#   → gateway (Neon Auth stand-in + Data API proxy) → PostgREST (Data API)
#   → local S3 (moto) → the bundled `api` Neon Function → the built website.
# Requirements: PostgreSQL 15+ binaries, PostgREST (PGRST_BIN), Node 22+,
# Python with moto[server] and playwright.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${E2E_WORK:?set E2E_WORK to a scratch directory}"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
mkdir -p "$WORK"; chown claude:claude "$WORK" 2>/dev/null || true
: > "$WORK/pids"

# ---- Postgres
DATA="$WORK/pgdata"; rm -rf "$DATA"
sudo -u claude "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
sudo -u claude "$PGBIN/pg_ctl" -D "$DATA" -o "-p 54330 -k /tmp -c listen_addresses=127.0.0.1" -l "$WORK/pg.log" start >/dev/null
export PGHOST=127.0.0.1 PGPORT=54330 PGUSER=postgres PGDATABASE=postgres
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -f "$ROOT/tests/db/neon_stub.sql"
"${PSQL[@]}" <<'SQL'
create role neondb_owner login createrole;
grant create on database postgres to neondb_owner;
alter schema public owner to neondb_owner;
grant usage on schema auth to neondb_owner;
grant authenticated, anonymous to neondb_owner with admin option;
SQL
for f in "$ROOT"/db/migrations/*.sql; do "${PSQL[@]}" -U neondb_owner -f "$f"; done
"${PSQL[@]}" -U neondb_owner -f "$ROOT/db/seed.sql"
"${PSQL[@]}" -U neondb_owner -c "insert into app.admin_invites (email) values ('admin@example.com') on conflict do nothing;"

cat > "$WORK/users.json" <<'JSON'
{ "admin":   { "id": "e2e_admin_01",  "email": "admin@example.com", "name": "Asha Admin" },
  "student": { "id": "e2e_riya_02",   "email": "riya@example.com",  "name": "Riya Sharma" },
  "student2":{ "id": "e2e_arjun_03",  "email": "arjun@example.com", "name": "Arjun Mehta" } }
JSON

cd "$ROOT/tests/e2e"
# ---- gateway first: it creates the signing keys PostgREST needs
rm -f "$WORK/jwks.json"
E2E_USERS="$WORK/users.json" E2E_JWKS="$WORK/jwks.json" node gateway.mjs > "$WORK/gateway.log" 2>&1 &
echo $! >> "$WORK/pids"
for i in $(seq 1 20); do [ -s "$WORK/jwks.json" ] && break; sleep 0.5; done

JWKS=$(cat "$WORK/jwks.json" | sed 's/"/\\"/g')
cat > "$WORK/pgrst.conf" <<CONF
db-uri = "postgres://authenticator@127.0.0.1:54330/postgres"
db-schemas = "public"
db-anon-role = "anonymous"
db-extra-search-path = "public, extensions"
jwt-secret = "$JWKS"
server-port = 3001
CONF
"${PGRST_BIN:?}" "$WORK/pgrst.conf" > "$WORK/pgrst.log" 2>&1 &
echo $! >> "$WORK/pids"

# ---- local S3 for Neon Object Storage
moto_server -H 127.0.0.1 -p 5005 > "$WORK/s3.log" 2>&1 &
echo $! >> "$WORK/pids"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:5005/ >/dev/null 2>&1 && break; sleep 0.5; done
python3 - <<'PY'
import boto3
s3 = boto3.client('s3', endpoint_url='http://127.0.0.1:5005', aws_access_key_id='test', aws_secret_access_key='test', region_name='us-east-1')
for b in ('documents', 'question-images'):
    s3.create_bucket(Bucket=b)
PY

# ---- the api function (bundled exactly as for deployment)
(cd "$ROOT/functions" && npm run --silent build >/dev/null 2>&1)
NEON_AUTH_JWKS_URL=http://127.0.0.1:54321/auth/jwks NEON_AUTH_BASE_URL=http://127.0.0.1:54321/auth \
NEON_DATA_API_URL=http://127.0.0.1:54321/rest/v1 ALLOWED_ORIGINS=http://127.0.0.1:4173 \
AWS_ENDPOINT_URL_S3=http://127.0.0.1:5005 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  node fn-server.mjs > "$WORK/fn.log" 2>&1 &
echo $! >> "$WORK/pids"

# ---- website
(cd "$ROOT/web" && VITE_NEON_AUTH_URL=http://127.0.0.1:54321/auth VITE_NEON_DATA_API_URL=http://127.0.0.1:54321/rest/v1 \
  VITE_API_URL=http://127.0.0.1:8000 npx vite build --logLevel error >/dev/null \
  && npx vite preview --host 127.0.0.1 --port 4173 --strictPort > "$WORK/web.log" 2>&1) &
echo $! >> "$WORK/pids"

for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:4173 >/dev/null && curl -s -o /dev/null http://127.0.0.1:3001/ && curl -sf http://127.0.0.1:8000/health >/dev/null; then
    echo "stack ready"; exit 0
  fi
  sleep 1
done
echo "stack failed to start"; for f in "$WORK"/*.log; do echo "== $f"; tail -n 5 "$f"; done; exit 1
