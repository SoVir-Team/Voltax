#!/usr/bin/env bash
# Provision a Raspberry Pi (Raspberry Pi OS Lite 64-bit) as a VOLTEX hub. Idempotent.
#
#   scp -r deploy/pi voltax-admin@voltax-hub-001.local:~/voltax-deploy
#   ssh voltax-admin@voltax-hub-001.local
#   sudo ~/voltax-deploy/provision.sh --hub-id voltax-hub-001 --hub-name "My Home"
#
# What it does: OS updates, Docker Engine + Compose (official repo), log limits, hardware
# watchdog, SSH key-only login, LAN-only firewall, service users/dirs/permissions, broker
# credentials + ACL, an on-device TLS key + CSR, mDNS advertisement, systemd units.
# It never prints secrets. It does NOT install a hub release; run voltax-update for that.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
HUB_ID=""
HUB_NAME="My Home"
LAN_CIDR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-id) HUB_ID=$2; shift 2 ;;
    --hub-name) HUB_NAME=$2; shift 2 ;;
    --lan) LAN_CIDR=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

# lib.sh is not installed yet: load it from this checkout.
# shellcheck source=scripts/lib.sh
source "$HERE/scripts/lib.sh"
require_root
valid_id "$HUB_ID" || die "--hub-id is required (3-40 chars: lowercase letters, digits, dashes)"
[[ "$HUB_NAME" =~ ^[A-Za-z0-9\ \'._-]{1,40}$ ]] || die "--hub-name: letters, digits, spaces, . _ - ' only"
[ "$(uname -m)" = aarch64 ] || die "64-bit Raspberry Pi OS (aarch64) required, got $(uname -m)"
ADMIN=${SUDO_USER:-}
[ -n "$ADMIN" ] && [ "$ADMIN" != root ] || die "run with sudo from the admin account (e.g. voltax-admin)"

# ---------------------------------------------------------------- packages
log "updating the OS (this can take a while)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -q -y -o Dpkg::Options::=--force-confold full-upgrade
apt-get -q -y install ca-certificates curl gnupg jq sqlite3 openssl minisign avahi-daemon ufw qrencode

if ! command -v docker >/dev/null; then
  log "installing Docker Engine from Docker's official repository"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -q -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
install -m 644 "$HERE/docker-daemon.json" /etc/docker/daemon.json
systemctl enable docker >/dev/null
systemctl restart docker

# ---------------------------------------------------------------- logs, watchdog, time
install -d /etc/systemd/journald.conf.d
install -m 644 "$HERE/journald.conf" /etc/systemd/journald.conf.d/voltax.conf
systemctl restart systemd-journald

reboot_needed=0
cfg=/boot/firmware/config.txt
if [ -f "$cfg" ] && ! grep -q '^dtparam=watchdog=on' "$cfg"; then
  echo 'dtparam=watchdog=on' >>"$cfg"; reboot_needed=1
fi
install -d /etc/systemd/system.conf.d
printf '[Manager]\nRuntimeWatchdogSec=15\nRebootWatchdogSec=2min\n' >/etc/systemd/system.conf.d/voltax-watchdog.conf
timedatectl set-ntp true || true
timedatectl set-timezone Asia/Kolkata || true

# ---------------------------------------------------------------- SSH: keys only
keys="/home/$ADMIN/.ssh/authorized_keys"
if [ -s "$keys" ]; then
  cat >/etc/ssh/sshd_config.d/10-voltax.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $ADMIN
EOF
  sshd -t && systemctl reload ssh
  log "SSH: key-only login for $ADMIN"
else
  log "WARNING: $keys is empty; NOT disabling password login (would lock you out)"
fi

# ---------------------------------------------------------------- firewall (LAN only)
if [ -z "$LAN_CIDR" ]; then
  iface=$(ip route show default | awk '{print $5; exit}')
  LAN_CIDR=$(ip -o -f inet addr show "$iface" | awk '{print $4; exit}')
  # normalise e.g. 192.168.1.23/24 -> 192.168.1.0/24
  LAN_CIDR=$(python3 -c "import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)" "$LAN_CIDR")
fi
log "firewall: allowing $LAN_CIDR only"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow from "$LAN_CIDR" to any port 22 proto tcp comment 'ssh' >/dev/null
ufw allow from "$LAN_CIDR" to any port 8443 proto tcp comment 'voltax local api' >/dev/null
ufw allow from "$LAN_CIDR" to any port 1883 proto tcp comment 'mqtt (esp32)' >/dev/null
ufw allow from "$LAN_CIDR" to any port 5353 proto udp comment 'mdns' >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------- directories + permissions
install -d -m 755 "$VOLTAX_OPT" "$VOLTAX_OPT/releases"
install -d -m 755 "$VOLTAX_DATA"
install -d -m 700 -o $HUB_UID -g $HUB_UID "$VOLTAX_DATA/hub"
install -d -m 770 -o root -g $HUB_UID "$VOLTAX_DATA/backups"
install -d -m 700 -o $MQTT_UID -g $MQTT_UID "$VOLTAX_DATA/mosquitto"
install -d -m 755 "$VOLTAX_ETC"
install -d -m 750 -o $MQTT_UID -g $MQTT_UID "$VOLTAX_ETC/mosquitto"
install -d -m 750 -o root -g $HUB_UID "$VOLTAX_ETC/tls"

# ---------------------------------------------------------------- secrets + broker users
umask 077
if [ ! -f "$VOLTAX_ETC/hub.env" ]; then
  hubpass=$(random_secret)
  sed -e "s|^HUB_ID=.*|HUB_ID=$HUB_ID|" -e "s|^HUB_NAME=.*|HUB_NAME=$HUB_NAME|" \
      -e "s|^MQTT_PASSWORD=.*|MQTT_PASSWORD=$hubpass|" "$HERE/hub.env.example" >"$VOLTAX_ETC/hub.env"
  healthpass=$(random_secret)
  echo "MQTT_HEALTH_PASS=$healthpass" >"$VOLTAX_ETC/mosquitto-health.env"
  docker pull -q "$(mosquitto_image)" >/dev/null
  touch "$VOLTAX_ETC/mosquitto/passwd"
  chown $MQTT_UID:$MQTT_UID "$VOLTAX_ETC/mosquitto/passwd"
  mosquitto_passwd -b /m/passwd hub "$hubpass"
  mosquitto_passwd -b /m/passwd healthcheck "$healthpass"
  log "generated hub + healthcheck broker credentials"
else
  [ "$(hub_id)" = "$HUB_ID" ] || die "this Pi is already provisioned as $(hub_id)"
fi
chmod 600 "$VOLTAX_ETC/hub.env" "$VOLTAX_ETC/mosquitto-health.env"
install -m 644 -o $MQTT_UID -g $MQTT_UID "$HERE/mosquitto/mosquitto.conf" "$VOLTAX_ETC/mosquitto/mosquitto.conf"
sed "s/__HUB_ID__/$HUB_ID/g" "$HERE/mosquitto/acl.template" >"$VOLTAX_ETC/mosquitto/acl"
chown $MQTT_UID:$MQTT_UID "$VOLTAX_ETC/mosquitto/acl" "$VOLTAX_ETC/mosquitto/passwd"
chmod 600 "$VOLTAX_ETC/mosquitto/acl" "$VOLTAX_ETC/mosquitto/passwd"

# ---------------------------------------------------------------- TLS: key generated ON the device
tls=$VOLTAX_ETC/tls
if [ ! -f "$tls/hub.key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$tls/hub.key"
  log "generated hub TLS private key (never leaves this Pi)"
fi
chown root:$HUB_UID "$tls/hub.key" && chmod 440 "$tls/hub.key"
openssl req -new -key "$tls/hub.key" -subj "/O=VOLTEX/CN=$HUB_ID.hub.voltax.internal" -out "$tls/hub.csr"
chmod 644 "$tls/hub.csr"
umask 022

# ---------------------------------------------------------------- discovery
sed "s/__HUB_ID__/$HUB_ID/g" "$HERE/avahi/voltax.service" >/etc/avahi/services/voltax.service
systemctl enable --now avahi-daemon >/dev/null
systemctl reload avahi-daemon || true

# ---------------------------------------------------------------- scripts, release key, units
install -d /usr/local/lib/voltax
install -m 644 "$HERE/scripts/lib.sh" /usr/local/lib/voltax/lib.sh
for pair in voltax-update:voltax-update.sh voltax-boot-check:voltax-boot-check.sh voltax-backup:backup.sh \
            voltax-restore:restore.sh voltax-health:voltax-health.sh voltax-hubctl:voltax-hubctl.sh \
            add-device:add-device.sh remove-device:remove-device.sh; do
  install -m 755 "$HERE/scripts/${pair#*:}" "/usr/local/bin/${pair%%:*}"
done
if [ -f "$HERE/keys/voltax-release.pub" ]; then
  install -m 644 "$HERE/keys/voltax-release.pub" "$VOLTAX_ETC/release.pub"
else
  log "WARNING: deploy/pi/keys/voltax-release.pub missing: voltax-update will refuse every release until it is installed"
fi
for unit in "$HERE"/systemd/*; do install -m 644 "$unit" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable voltax-boot-check.service voltax-hub.service voltax-health.timer voltax-backup.timer >/dev/null
systemctl start voltax-health.timer voltax-backup.timer

cat <<EOF

VOLTEX hub $HUB_ID provisioned.
Next steps (see docs/runbooks/pi-setup.md):
  1. On the installer PC, sign the CSR:   deploy/pi/issue-hub-cert.sh <copy of $tls/hub.csr> $HUB_ID
     then copy hub.crt and ca.crt into $tls/ (root:$HUB_UID, 0444).
  2. Put a read-only GitHub token in $VOLTAX_ETC/github.token (0600), or use --from-dir.
  3. Install the first release:           sudo voltax-update <version>
  4. Create the owner's pairing code:     sudo voltax-hubctl pairing-code --role owner
$( [ $reboot_needed = 1 ] && echo "  Reboot once to enable the hardware watchdog: sudo reboot" )
EOF
