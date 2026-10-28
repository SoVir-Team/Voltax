# Shared helpers for the on-Pi acceptance tests (sourced, not run). Requires a provisioned hub
# with a release installed: /usr/local/lib/voltax/lib.sh, /opt/voltax/current, running containers.
# shellcheck shell=bash
# shellcheck source=../scripts/lib.sh
source /usr/local/lib/voltax/lib.sh
require_root

pass=0
fail=0
ok() { echo "PASS  $*"; pass=$((pass + 1)); }
bad() { echo "FAIL  $*"; fail=$((fail + 1)); }
# check "description" command...   (PASS if the command succeeds)
check() {
  local desc=$1
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}
not() { ! "$@"; }
summary() {
  echo "---- $pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

# wait_for <seconds> command...   retries every 3 s until the command succeeds
wait_for() {
  local deadline=$((SECONDS + $1))
  shift
  while [ $SECONDS -lt $deadline ]; do
    "$@" && return 0
    sleep 3
  done
  return 1
}

container_id() { compose ps -q "$1"; }
started_at() { docker inspect -f '{{.State.StartedAt}}' "$(container_id "$1")"; }
healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$(container_id "$1")" 2>/dev/null)" = healthy ]; }
hub_ok() { hub_health 2>/dev/null | jq -e '.status == "ok" and .db == "up" and .mqtt == "up"' >/dev/null; }
hub_password() { sed -n 's/^MQTT_PASSWORD=//p' "$VOLTAX_ETC/hub.env"; }
