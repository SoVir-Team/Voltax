# Shared helpers for VOLTEX hub scripts. Installed as /usr/local/lib/voltax/lib.sh.
# shellcheck shell=bash

VOLTAX_ETC=/etc/voltax
VOLTAX_DATA=/var/lib/voltax
VOLTAX_OPT=/opt/voltax
HUB_UID=10001
MQTT_UID=1883
COMPOSE_PROJECT=voltax

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$VOLTAX_OPT/current/compose.yaml" "$@"
}

# Hub id from hub.env (single source of truth on the device).
hub_id() {
  sed -n 's/^HUB_ID=//p' "$VOLTAX_ETC/hub.env" | head -n1
}

valid_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]]; }

# Random secret: 32 chars, [A-Za-z0-9] only (safe in env files and YAML).
random_secret() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32; }

# The mosquitto image recorded for the current release (used for mosquitto_passwd).
mosquitto_image() {
  local img=""
  [ -f "$VOLTAX_OPT/current/compose.yaml" ] && img=$(sed -n 's/^ *image: *\(.*mosquitto.*\)$/\1/p' "$VOLTAX_OPT/current/compose.yaml" | head -n1)
  echo "${img:-eclipse-mosquitto:2}" # before the first release is installed
}

# Run mosquitto_passwd as uid 1883 against the real password file.
mosquitto_passwd() {
  docker run --rm --network none --user "$MQTT_UID:$MQTT_UID" \
    -v "$VOLTAX_ETC/mosquitto:/m" "$(mosquitto_image)" mosquitto_passwd "$@"
}

hub_health() {
  curl -fsS --max-time 5 --cacert "$VOLTAX_ETC/tls/ca.crt" \
    --resolve "$(hub_id).hub.voltax.internal:8443:127.0.0.1" \
    "https://$(hub_id).hub.voltax.internal:8443/api/v1/health"
}

# Consistent SQLite copy (safe while the hub is writing; works in WAL mode).
sqlite_backup() {
  local src=$1 dest=$2
  sqlite3 "$src" ".backup '$dest'"
  [ "$(sqlite3 "$dest" 'PRAGMA integrity_check;')" = "ok" ] || die "backup $dest failed integrity check"
}
