#!/usr/bin/env bash
# Self-healing test (plan §6.4). Run ON THE PI; it disrupts the hub for several minutes:
#   sudo bash ~/voltax-deploy/tests/recovery-test.sh [--yes]
# 1. broker crash  -> Docker restarts it; the hub reconnects to MQTT on its own
# 2. hub crash     -> Docker restarts it
# 3. hub hangs     -> health check marks it unhealthy -> voltax-health.timer restarts it
# 4. Docker daemon restart -> containers keep running (live-restore) and stay healthy
# A crash is simulated with SIGKILL to the container's main process from the host (`docker kill`
# would count as a manual stop, which restart policies deliberately ignore).
set -uo pipefail
# shellcheck source=lib-test.sh
source "$(dirname "$0")/lib-test.sh"

if [ "${1:-}" != "--yes" ]; then
  read -r -p "This stops and restarts the hub services several times. Continue? [y/N] " answer
  [ "$answer" = y ] || exit 1
fi

main_pid() { docker inspect -f '{{.State.Pid}}' "$(container_id "$1")"; }
restarted_since() { [ "$(started_at "$1")" != "$2" ]; }
timed() { # description seconds command...
  local desc=$1 secs=$2 t0=$SECONDS
  shift 2
  if wait_for "$secs" "$@"; then ok "$desc ($((SECONDS - t0))s)"; else bad "$desc (not within ${secs}s)"; fi
}

echo "Recovery test on hub $(hub_id)"
check "starting point: broker healthy" healthy mosquitto
check "starting point: hub healthy" healthy voltax-hub
check "starting point: hub API ok" hub_ok
[ "$fail" -eq 0 ] || { summary; exit 1; }

# 1. broker crash
before=$(started_at mosquitto)
kill -9 "$(main_pid mosquitto)"
timed "broker restarted after crash" 60 restarted_since mosquitto "$before"
timed "broker healthy again" 120 healthy mosquitto
timed "hub reconnected to MQTT" 120 hub_ok

# 2. hub crash
before=$(started_at voltax-hub)
kill -9 "$(main_pid voltax-hub)"
timed "hub restarted after crash" 60 restarted_since voltax-hub "$before"
timed "hub healthy again" 120 healthy voltax-hub
timed "hub API ok again" 60 hub_ok

# 3. hub hangs (process frozen, not crashed): only the health check can notice.
# Worst case: 3 failed checks x 30 s, plus up to 60 s until the health timer, plus a 20 s stop.
before=$(started_at voltax-hub)
kill -STOP "$(main_pid voltax-hub)"
timed "frozen hub replaced by voltax-health" 300 restarted_since voltax-hub "$before"
timed "hub healthy after replacement" 120 healthy voltax-hub
timed "hub API ok after replacement" 60 hub_ok

# 4. Docker daemon restart
before_hub=$(started_at voltax-hub)
before_mq=$(started_at mosquitto)
systemctl restart docker
timed "hub API ok after Docker restart" 120 hub_ok
kept_running() { [ "$(started_at voltax-hub)" = "$before_hub" ] && [ "$(started_at mosquitto)" = "$before_mq" ]; }
check "containers kept running through the Docker restart (live-restore)" kept_running

summary
