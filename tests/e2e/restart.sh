#!/usr/bin/env bash
# Fresh stack: stop, then start detached and wait until ready.
cd "$(dirname "$0")"
bash stop.sh >/dev/null 2>&1
setsid nohup bash start.sh > "$E2E_WORK/start.log" 2>&1 < /dev/null &
for i in $(seq 1 90); do grep -q "stack ready\|failed" "$E2E_WORK/start.log" 2>/dev/null && break; sleep 2; done
tail -1 "$E2E_WORK/start.log"
