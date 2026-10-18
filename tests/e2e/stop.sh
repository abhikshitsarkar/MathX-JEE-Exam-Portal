#!/usr/bin/env bash
# Stops everything start.sh launched.
WORK="${E2E_WORK:?}"
[ -f "$WORK/pids" ] && xargs -r kill < "$WORK/pids" 2>/dev/null
for pat in "vite preview --host 127.0.0.1 --port 4173" "fn-server.mjs" "gateway.mjs" "pgrst.conf" "moto_server -H 127.0.0.1 -p 5005"; do
  pgrep -f -- "$pat" | grep -vx "$$" | xargs -r kill 2>/dev/null
done
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
sudo -u claude "$PGBIN/pg_ctl" -D "$WORK/pgdata" -m immediate stop >/dev/null 2>&1 || true
echo stopped
