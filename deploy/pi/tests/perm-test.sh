#!/usr/bin/env bash
# Permissions and hardening test (plan §6.4). Read-only; safe to run on a live hub:
#   sudo ~/voltax-deploy/tests/perm-test.sh
# Checks container users, capabilities, read-only filesystems and the host file modes table.
set -uo pipefail
# shellcheck source=lib-test.sh
source "$(dirname "$0")/lib-test.sh"

inspect() { docker inspect -f "$2" "$(container_id "$1")"; }
is() { [ "$1" = "$2" ]; }
in_container() { compose exec -T "$1" sh -c "$2" 2>/dev/null; }
not_writable() { ! in_container "$1" "touch $2"; }

# mode <path> <uid:gid> <octal mode>
mode() {
  local got
  got=$(stat -c '%u:%g %a' "$1" 2>/dev/null)
  if [ "$got" = "$2 $3" ]; then ok "$1 is $2 $3"; else bad "$1 is ${got:-missing}, expected $2 $3"; fi
}

echo "Permission test on hub $(hub_id)"

for svc in mosquitto voltax-hub; do
  want_uid=$([ "$svc" = mosquitto ] && echo "$MQTT_UID" || echo "$HUB_UID")
  check "$svc: configured user $want_uid" is "$(inspect "$svc" '{{.Config.User}}')" "$want_uid:$want_uid"
  check "$svc: main process runs as uid $want_uid" is "$(in_container "$svc" 'id -u')" "$want_uid"
  check "$svc: all capabilities dropped" is "$(inspect "$svc" '{{.HostConfig.CapDrop}}')" "[ALL]"
  check "$svc: no capabilities added" is "$(inspect "$svc" '{{len .HostConfig.CapAdd}}')" "0"
  check "$svc: effective capabilities are zero" is "$(in_container "$svc" "awk '/^CapEff/ {print \$2}' /proc/1/status")" "0000000000000000"
  check "$svc: no-new-privileges" is "$(inspect "$svc" '{{range .HostConfig.SecurityOpt}}{{.}}{{end}}')" "no-new-privileges:true"
  check "$svc: not privileged" is "$(inspect "$svc" '{{.HostConfig.Privileged}}')" "false"
  check "$svc: read-only root filesystem" is "$(inspect "$svc" '{{.HostConfig.ReadonlyRootfs}}')" "true"
  check "$svc: writing to / is refused" not_writable "$svc" /permtest
  check "$svc: host network (firewall applies, no Docker NAT bypass)" is "$(inspect "$svc" '{{.HostConfig.NetworkMode}}')" "host"
done

check "hub can write its database directory" in_container voltax-hub 'touch /var/lib/voltax/hub/.permtest && rm /var/lib/voltax/hub/.permtest'
check "hub can read its TLS key" in_container voltax-hub 'test -r /etc/voltax/tls/hub.key'
check "hub cannot write its TLS directory" not_writable voltax-hub /etc/voltax/tls/permtest
check "hub cannot see broker passwords" not in_container voltax-hub 'test -e /etc/voltax/mosquitto/passwd'

echo "Host files"
mode "$VOLTAX_DATA/hub" "$HUB_UID:$HUB_UID" 700
mode "$VOLTAX_DATA/backups" "0:$HUB_UID" 770
mode "$VOLTAX_DATA/mosquitto" "$MQTT_UID:$MQTT_UID" 700
mode "$VOLTAX_ETC/hub.env" 0:0 600
mode "$VOLTAX_ETC/mosquitto-health.env" 0:0 600
mode "$VOLTAX_ETC/mosquitto/passwd" "$MQTT_UID:$MQTT_UID" 600
mode "$VOLTAX_ETC/mosquitto/acl" "$MQTT_UID:$MQTT_UID" 600
mode "$VOLTAX_ETC/tls" "0:$HUB_UID" 750
mode "$VOLTAX_ETC/tls/hub.key" "0:$HUB_UID" 440
mode "$VOLTAX_ETC/tls/hub.crt" "0:$HUB_UID" 444
mode "$VOLTAX_ETC/tls/ca.crt" "0:$HUB_UID" 444
check "hub.db owned by the hub user" is "$(stat -c %u "$VOLTAX_DATA/hub/hub.db")" "$HUB_UID"

echo "Host hardening"
check "SSH password login disabled" is "$(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}')" no
check "SSH root login disabled" is "$(sshd -T 2>/dev/null | awk '$1 == "permitrootlogin" {print $2}')" no
check "firewall active" sh -c 'ufw status | grep -q "^Status: active"'
check "Docker live-restore enabled" is "$(docker info -f '{{.LiveRestoreEnabled}}')" true

summary
