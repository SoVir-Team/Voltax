#!/usr/bin/env bash
# Restart any VOLTEX container that Docker marks unhealthy (Docker alone only restarts crashed ones).
# Installed as /usr/local/bin/voltax-health, run every minute by voltax-health.timer.
set -euo pipefail

mapfile -t unhealthy < <(docker ps --filter label=com.docker.compose.project=voltax --filter health=unhealthy --format '{{.Names}}')
for c in "${unhealthy[@]}"; do
  [ -n "$c" ] || continue
  echo "voltax-health: restarting unhealthy container $c"
  docker restart "$c" >/dev/null
done
