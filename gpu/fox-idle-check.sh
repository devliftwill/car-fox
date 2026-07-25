#!/usr/bin/env bash
# Stops this VM after ~3 minutes with zero activity (cost: the idle tail used to dominate).
# Activity = live sessions OR running/pending avatar-generation tasks.
set -u
STATE=/var/tmp/fox-idle-count  # reset-on-start handled by uptime guard writing 0

# Keep-awake lock, honoured only while FRESH (touched within 3 min). The demo
# page pings it so the box never sleeps mid-demo, and maintenance/benchmarks can
# hold it; a stale lock cannot pin the GPU on by accident.
LOCK=/var/tmp/fox-keep-awake
if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK") )) -lt 180 ]; then
  echo 0 > "$STATE"
  exit 0
fi

UPTIME_S=$(cut -d. -f1 /proc/uptime)
if [ "$UPTIME_S" -lt 240 ]; then
  echo 0 > "$STATE"
  exit 0
fi

PIPECAT_ACTIVE=$(curl -s -m 3 http://localhost:8012/health 2>/dev/null | grep -c '"active":true' || true)
ACTIVITY=$( (curl -s -m 5 http://localhost:8010/api/admin/sessions; echo '@@'; curl -s -m 5 http://localhost:8010/api/avatar/tasks) | python3 -c "
import json, sys
raw = sys.stdin.read().split('@@')
count = 0
try:
    d = json.loads(raw[0])
    s = d.get('data', d)
    if isinstance(s, dict):
        s = s.get('sessions', [])
    count += len(s)
except Exception:
    count = -99  # server not answering
try:
    t = json.loads(raw[1])['data']['tasks']
    count += sum(1 for x in t if x.get('status') in ('pending', 'running'))
except Exception:
    pass
print(count)
" 2>/dev/null || echo -99)

if { [ "$ACTIVITY" = "0" ] || [ "$ACTIVITY" = "-99" ]; } && [ "${PIPECAT_ACTIVE:-0}" = "0" ]; then
  COUNT=$(($(cat "$STATE" 2>/dev/null || echo 0) + 1))
else
  COUNT=0
fi
echo "$COUNT" > "$STATE"

if [ "$COUNT" -ge 3 ]; then
  logger -t fox-idle "no sessions/tasks for 3 checks — powering off"
  /usr/sbin/poweroff
fi
