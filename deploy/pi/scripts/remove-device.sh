#!/usr/bin/env bash
# remove-device <deviceId>
# Deletes the device's MQTT credential, restarts Mosquitto so any open session drops,
# clears its retained topics, and removes it from the hub database.
set -euo pipefail
source /usr/local/lib/voltax/lib.sh
require_root

id=${1:?usage: remove-device <deviceId>}
valid_id "$id" || die "invalid deviceId"
case "$id" in hub|healthcheck) die "'$id' is reserved";; esac

passwd_file=$VOLTAX_ETC/mosquitto/passwd
grep -q "^$id:" "$passwd_file" || die "$id has no credential on this hub"

mosquitto_passwd -D /m/passwd "$id"
compose restart mosquitto >/dev/null
log "credential removed; broker restarted"

# Clear retained state/status so a removed device leaves nothing behind.
hubpass=$(sed -n 's/^MQTT_PASSWORD=//p' "$VOLTAX_ETC/hub.env")
for _ in $(seq 1 15); do compose exec -T mosquitto true 2>/dev/null && break; sleep 1; done
compose exec -T mosquitto sh -c '
  mosquitto_sub -h 127.0.0.1 -u hub -P "$1" -t "voltax/$2/$3/#" -W 3 -F "%t" --retained-only 2>/dev/null |
  while read -r t; do mosquitto_pub -h 127.0.0.1 -u hub -P "$1" -t "$t" -r -n; done' _ "$hubpass" "$(hub_id)" "$id" || true

docker exec voltax-voltax-hub-1 node dist/cli.js remove-device "$id" || log "device was not in the hub database"
log "device $id removed"
