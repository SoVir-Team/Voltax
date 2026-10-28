#!/usr/bin/env bash
# MQTT least-privilege test (plan §6.2). Run ON THE PI against the real broker:
#   sudo ~/voltax-deploy/tests/mqtt-acl-test.sh
# Creates two throw-away device users (acltest-a, acltest-b), proves each can only use its own
# topics, then deletes them. Positive controls make sure "nothing delivered" is not a broken test.
set -uo pipefail
# shellcheck source=lib-test.sh
source "$(dirname "$0")/lib-test.sh"

HUB=$(hub_id)
HUBPASS=$(hub_password)
A=acltest-a
B=acltest-b
PA=$(random_secret)
PB=$(random_secret)
base=voltax/$HUB

cleanup() {
  mosquitto_passwd -D /m/passwd "$A" >/dev/null 2>&1
  mosquitto_passwd -D /m/passwd "$B" >/dev/null 2>&1
  compose kill -s SIGHUP mosquitto >/dev/null 2>&1
}
trap cleanup EXIT

mosquitto_passwd -b /m/passwd "$A" "$PA" || die "could not create test user $A"
mosquitto_passwd -b /m/passwd "$B" "$PB" || die "could not create test user $B"
chown "$MQTT_UID:$MQTT_UID" "$VOLTAX_ETC/mosquitto/passwd" && chmod 600 "$VOLTAX_ETC/mosquitto/passwd"
compose kill -s SIGHUP mosquitto >/dev/null
sleep 2

# Run the mosquitto clients that ship in the broker container.
pub() { # user pass topic message
  compose exec -T mosquitto mosquitto_pub -h 127.0.0.1 -p 1883 ${1:+-u "$1"} ${2:+-P "$2"} -q 1 -t "$3" -m "$4"
}

# reaches <sub-user> <sub-pass> <sub-filter> <pub-user> <pub-pass> <pub-topic>
# Succeeds if a unique message published as pub-user arrives at a subscriber logged in as sub-user.
reaches() {
  local token="acl-$RANDOM$RANDOM" out
  out=$(mktemp)
  compose exec -T mosquitto mosquitto_sub -h 127.0.0.1 -p 1883 -u "$1" -P "$2" -t "$3" -W 5 >"$out" 2>/dev/null &
  local sub=$!
  sleep 1.5
  pub "$4" "$5" "$6" "$token" >/dev/null 2>&1
  wait "$sub"
  grep -qx "$token" "$out"
  local found=$?
  rm -f "$out"
  return $found
}
refused() { not pub "$1" "$2" "$base/$A/status" x >/dev/null 2>&1; }

echo "Broker ACL test on hub $HUB"

# Authentication
check "wrong password is refused" refused "$A" wrong-password
check "anonymous client is refused" refused "" ""

# Positive controls: a device can do exactly its job
check "device publishes its own state (control)" reaches hub "$HUBPASS" "$base/$A/switch/acltest/state" "$A" "$PA" "$base/$A/switch/acltest/state"
check "device publishes its own status (control)" reaches hub "$HUBPASS" "$base/$A/status" "$A" "$PA" "$base/$A/status"
check "device receives its own commands (control)" reaches "$A" "$PA" "$base/$A/switch/acltest/command" hub "$HUBPASS" "$base/$A/switch/acltest/command"

# A device cannot act as another device or as the hub
check "device cannot publish another device's state" not reaches hub "$HUBPASS" "$base/$B/switch/acltest/state" "$A" "$PA" "$base/$B/switch/acltest/state"
check "device cannot publish commands (even its own)" not reaches hub "$HUBPASS" "$base/$A/switch/acltest/command" "$A" "$PA" "$base/$A/switch/acltest/command"
check "device cannot publish outside its topic layout" not reaches hub "$HUBPASS" "$base/$A/acltest" "$A" "$PA" "$base/$A/acltest"
check "device cannot publish into another hub's namespace" not reaches hub "$HUBPASS" "voltax/other-hub/$A/switch/acltest/state" "$A" "$PA" "voltax/other-hub/$A/switch/acltest/state"

# A device cannot read anything that is not its own command
check "device subscribed to # gets no other device's state" not reaches "$A" "$PA" "#" hub "$HUBPASS" "$base/$B/switch/acltest/state"
check "device cannot read another device's commands" not reaches "$A" "$PA" "$base/$B/switch/acltest/command" hub "$HUBPASS" "$base/$B/switch/acltest/command"

# The health-check account is read-only and limited to broker uptime
check "healthcheck account cannot publish device state" not reaches hub "$HUBPASS" "$base/$A/switch/acltest/state" healthcheck "$(sed -n 's/^MQTT_HEALTH_PASS=//p' "$VOLTAX_ETC/mosquitto-health.env")" "$base/$A/switch/acltest/state"

summary
