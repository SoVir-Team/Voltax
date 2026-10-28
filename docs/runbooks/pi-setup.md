# Runbook: set up a new hub

Steps marked **[MANUAL]** need a person or physical hardware. Nothing here has been run on a real
Pi yet; record results in [milestone-1-results.md](milestone-1-results.md).

## 1. Flash the SD card [MANUAL]

Raspberry Pi Imager → Raspberry Pi 4 → **Raspberry Pi OS Lite (64-bit)**. In OS customisation:

| Setting | Value |
|---|---|
| Hostname | `voltax-hub-001` (one per home) |
| User | `voltax-admin` |
| SSH | public-key only; paste the installer PC's public key |
| Time zone | Asia/Kolkata |
| Wi-Fi | only if Ethernet is impossible (Ethernet preferred) |

Use an A2 endurance card and the official 5.1 V / 3 A supply. Boot on Ethernet.

## 2. Check the Pi

```bash
ssh voltax-admin@voltax-hub-001.local
cat /etc/os-release; uname -m; vcgencmd get_throttled   # expect aarch64 and throttled=0x0
```

## 3. Provision

From the repository on the installer PC:

```bash
scp -r deploy/pi voltax-admin@voltax-hub-001.local:~/voltax-deploy
ssh voltax-admin@voltax-hub-001.local 'sudo bash ~/voltax-deploy/provision.sh --hub-id voltax-hub-001 --hub-name "My Home"'
```

It installs Docker, the watchdog, key-only SSH, a LAN-only firewall (22, 8443, 1883, 5353), service
users and directories, broker credentials, an on-device TLS key + CSR, mDNS and systemd units. Reboot
once if it asks (hardware watchdog).

## 4. Hub certificate

On the installer PC (first time only: `deploy/pi/make-dev-ca.sh`):

```bash
scp voltax-admin@voltax-hub-001.local:/etc/voltax/tls/hub.csr /tmp/hub.csr
deploy/pi/issue-hub-cert.sh /tmp/hub.csr voltax-hub-001
scp .secrets/hubs/voltax-hub-001/{hub.crt,ca.crt} voltax-admin@voltax-hub-001.local:/tmp/
ssh voltax-admin@voltax-hub-001.local 'sudo install -o root -g 10001 -m 444 /tmp/hub.crt /tmp/ca.crt /etc/voltax/tls/'
```

## 5. Install the hub software

See [pi-update-rollback.md](pi-update-rollback.md) (`sudo voltax-update <version>`).

## 6. Add the first device

```bash
sudo add-device esp-relay-01          # prints the device's MQTT password ONCE
```

Put it in `firmware/esphome/secrets.yaml` on the installer PC, then flash: see
[firmware/esphome/README.md](../../firmware/esphome/README.md). **[MANUAL]** wire a low-voltage test load only.

## 7. Pair the owner's phone

```bash
sudo voltax-hubctl pairing-code --role owner     # single use, valid 10 minutes
```

Open the app, enter the code. Check: `deploy/pi/tests/tls-test.sh voltax-hub-001 <pi-ip> .secrets/ca/ca.crt`.
