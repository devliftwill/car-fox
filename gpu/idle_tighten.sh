#!/usr/bin/env bash
# Cost: shorten the idle tail. Was: check every 5min, 3 strikes + 15min uptime
# guard => the box billed ~15-20 idle minutes after every call (measured as ~5x
# the cost of the conversation itself). Now: check every 60s, 3 strikes => ~3min
# idle tail, with a 4min uptime guard (enough for boot + model load).
set -eu
sudo sed -i 's/^OnBootSec=.*/OnBootSec=90s/;s/^OnUnitActiveSec=.*/OnUnitActiveSec=60s/' /etc/systemd/system/fox-idle.timer
sudo sed -i 's/if \[ "\$UPTIME_S" -lt 900 \]/if [ "$UPTIME_S" -lt 240 ]/' /usr/local/bin/fox-idle-check.sh
sudo sed -i 's/^# Stops this VM after ~15 minutes.*/# Stops this VM after ~3 minutes with zero activity (cost: the idle tail used to dominate)./' /usr/local/bin/fox-idle-check.sh
sudo systemctl daemon-reload
sudo systemctl restart fox-idle.timer
echo "--- timer ---"; systemctl cat fox-idle.timer | grep -E "OnBootSec|OnUnitActiveSec"
echo "--- guard ---"; grep -n "UPTIME_S" /usr/local/bin/fox-idle-check.sh | head -3
echo "--- strikes ---"; grep -n 'COUNT" -ge' /usr/local/bin/fox-idle-check.sh
