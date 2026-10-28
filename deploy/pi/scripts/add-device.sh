#!/usr/bin/env bash
# add-device <deviceId> [--rotate]
# Creates (or rotates) the per-device MQTT credential. Username = deviceId, so the ACL
# limits the device to voltax/<hubId>/<deviceId>/... Only the PBKDF2 hash is stored.
# The password is printed ONCE for the installer's git-ignored secrets.<deviceId>.yaml.
set -euo pipefail
source /usr/local/lib/voltax/lib.sh
require_root

id=${1:?usage: add-device <deviceId> [--rotate]}
rotate=${2:-}
valid_id "$id" || die "deviceId must be 3-40 chars: lowercase letters, digits, dashes"
case "$id" in hub|healthcheck) die "'$id' is reserved";; esac

passwd_file=$VOLTAX_ETC/mosquitto/passwd
if grep -q "^$id:" "$passwd_file" && [ "$rotate" != "--rotate" ]; then
  die "$id already exists (use --rotate to issue a new password)"
fi

pass=$(random_secret)
mosquitto_passwd -b /m/passwd "$id" "$pass"
chown $MQTT_UID:$MQTT_UID "$passwd_file" && chmod 600 "$passwd_file"

# Mosquitto re-reads users on SIGHUP. A rotation restarts it so old sessions drop.
if [ "$rotate" = "--rotate" ]; then compose restart mosquitto >/dev/null; else compose kill -s SIGHUP mosquitto >/dev/null; fi

cat <<EOF
Device '$id' can now connect to this hub's broker.
Put these lines in firmware/esphome/secrets.$id.yaml on the installer PC (never commit it):

  hub_id: "$(hub_id)"
  device_id: "$id"
  mqtt_username: "$id"
  mqtt_password: "$pass"

This password is not stored in readable form and will not be shown again.
EOF
