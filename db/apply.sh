#!/usr/bin/env bash
# Applies every migration (and optionally the sample data) to a Neon database.
# Usage:  bash db/apply.sh "postgresql://neondb_owner:...@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" [--seed]
# Needs `psql` (PostgreSQL client). Run Neon Auth + Data API setup FIRST (see README).
set -euo pipefail
URL="${1:?pass the Neon connection string (owner role) as the first argument}"
cd "$(dirname "$0")"
for f in migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -f "$f"
done
if [ "${2:-}" = "--seed" ]; then
  echo "adding sample questions and test"
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -f seed.sql
fi
echo "done — now refresh the Data API schema cache (Console → Data API → Refresh, or: npx neonctl data-api refresh-schema)"
