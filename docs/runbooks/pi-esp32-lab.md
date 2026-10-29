# Connect a Raspberry Pi and ESP32 for a real hardware test

Use a new Raspberry Pi OS Lite **64-bit** installation, with the hostname `voltax-hub-001`, an SSH-enabled user, and the Pi and installer computer on the same home LAN. These are setup instructions, not recorded hardware acceptance results. Use a low-voltage test load as required by the firmware instructions.

The hardware path is: **customer browser -> Raspberry Pi hub -> Pi Mosquitto -> ESP32**. The Windows persistent launcher is a separate local installation. Pairing with the Windows hub does not pair you with the Pi.

## 1. Connect to the Pi from Windows PowerShell

Replace the example variables with your actual SSH username and Pi LAN address; do not enter the angle-bracket placeholders literally.

```powershell
cd "D:\Voltax-Home-Automation"
$piUser = '<YOUR_PI_USERNAME>'
$piAddress = '<YOUR_PI_LAN_IP>'
ssh "$piUser@$piAddress"
```

## 2. Prepare the Pi (in the SSH terminal)

```bash
uname -m
# Must report aarch64.

sudo apt-get update
sudo apt-get install -y git
cd ~
git clone https://github.com/SoVir-Team/Voltax.git
cd ~/Voltax

sudo bash deploy/pi/provision.sh --hub-id voltax-hub-001 --hub-name "My Home"
sudo install -m 644 /etc/voltax/tls/hub.csr /tmp/voltax-hub.csr
```

The private GitHub repository requires an account with access. If `~/Voltax` already exists, use that checkout instead of cloning over it. Provisioning changes this Pi's OS packages, Docker, SSH/firewall, services and configuration; use the [setup runbook](pi-setup.md) before applying it to an existing installation. If it requests a reboot, reboot and reconnect first.

## 3. Sign the hub certificate on Windows

In a **second Windows PowerShell** terminal, with the same variables set:

```powershell
cd "D:\Voltax-Home-Automation"
$piUser = '<YOUR_PI_USERNAME>'
$piAddress = '<YOUR_PI_LAN_IP>'

scp "${piUser}@${piAddress}:/tmp/voltax-hub.csr" .\.secrets\voltax-hub.csr
& 'C:\Program Files\Git\bin\bash.exe' deploy/pi/make-dev-ca.sh
& 'C:\Program Files\Git\bin\bash.exe' deploy/pi/issue-hub-cert.sh .secrets/voltax-hub.csr voltax-hub-001

scp .\.secrets\hubs\voltax-hub-001\hub.crt .\.secrets\hubs\voltax-hub-001\ca.crt "${piUser}@${piAddress}:/tmp/"
ssh "${piUser}@${piAddress}" 'sudo install -o root -g 10001 -m 444 /tmp/hub.crt /tmp/ca.crt /etc/voltax/tls/'
```

This uses the project's prototype CA. The Pi keeps its own private hub key. The browser URL below requires the configured `voltax-hub-001.local` hostname to resolve. If the Pi has a different hostname, use the issuer's third hostname argument and the matching URL instead.

To let this Windows user's browser validate the hub certificate, explicitly trust the local prototype CA:

```powershell
Import-Certificate -FilePath .\.secrets\ca\ca.crt -CertStoreLocation Cert:\CurrentUser\Root
```

This adds that CA to your current Windows user's trusted roots. Protect its private key; this is prototype trust, not production CA provisioning.

## 4. Build and run the real hub on the Pi

In the **Pi SSH terminal**, from `~/Voltax`:

```bash
cd ~/Voltax
sudo docker build -t voltax-hub:local -f backend/hub/Dockerfile .

sed -e 's|__HUB_IMAGE__|voltax-hub:local|' \
    -e 's|__MOSQUITTO_IMAGE__|eclipse-mosquitto:2.0|' \
    deploy/pi/compose.yaml > /tmp/voltax-local-compose.yaml

sudo install -d -m 755 /opt/voltax/releases/local
sudo install -m 644 /tmp/voltax-local-compose.yaml /opt/voltax/releases/local/compose.yaml
sudo ln -sfn /opt/voltax/releases/local /opt/voltax/current
sudo systemctl start voltax-hub.service

sudo docker compose -p voltax -f /opt/voltax/current/compose.yaml ps
sudo docker compose -p voltax -f /opt/voltax/current/compose.yaml logs -f voltax-hub
```

This is a manually built lab image, not a signed production release. The symlink command selects this build as the active installation; do not use it to replace a live hub without its backup/update procedure. Ctrl+C exits log-following; it does not stop the containers.

In another Pi SSH session:

```bash
cd ~/Voltax
sudo add-device esp-relay-01
sudo voltax-hubctl pairing-code --role owner
```

Keep the printed device MQTT password private. Open **https://voltax-hub-001.local:8443** on Windows and pair using the Pi's owner code. Before firmware connects, an empty device list is expected.

## 5. Configure and flash the ESP32 from Windows

Create an isolated ESPHome environment under the ignored secrets directory:

```powershell
cd "D:\Voltax-Home-Automation"
py -m venv .secrets\esphome-venv
.\.secrets\esphome-venv\Scripts\python.exe -m pip install esphome

cd .\firmware\esphome
if (-not (Test-Path .\secrets.yaml)) {
  Copy-Item .\secrets.yaml.example .\secrets.yaml
}
notepad .\secrets.yaml
```

Fill the real values in `firmware/esphome/secrets.yaml`:

```yaml
wifi_ssid: "YOUR_WIFI_NAME"
wifi_password: "YOUR_WIFI_PASSWORD"
mqtt_broker: "YOUR_PI_LAN_IP"
mqtt_password: "PASSWORD_PRINTED_BY_ADD_DEVICE"
ota_password: "CHOOSE_A_PRIVATE_OTA_PASSWORD"
```

Check the substitutions in `relay-1ch.yaml`: `device_id: esp-relay-01` and `hub_id: voltax-hub-001` must match the Pi configuration. The existing template uses MQTT port 1883 on the Pi LAN. Do not point the ESP32 at the Windows launcher's loopback broker.

Connect the ESP32 with a USB data cable, then flash:

```powershell
cd "D:\Voltax-Home-Automation\firmware\esphome"
& '..\..\.secrets\esphome-venv\Scripts\esphome.exe' run .\relay-1ch.yaml
```

Select the actual USB serial port when ESPHome prompts. Once connected to Wi-Fi/MQTT and reporting state, its switch and BOOT-button sensor should appear in the Pi's customer app. Follow [firmware instructions](../../firmware/esphome/README.md) for the specified board and low-voltage wiring.

## 6. Optional frontend hot reload on the Windows computer

Keep the Pi hub running. In Windows PowerShell:

```powershell
cd "D:\Voltax-Home-Automation"
$env:HUB_URL = 'https://voltax-hub-001.local:8443'
$env:NODE_EXTRA_CA_CERTS = 'D:\Voltax-Home-Automation\.secrets\ca\ca.crt'
npm run dev:web
```

Open **http://localhost:3000**. This frontend talks to the real Pi API; its WebSocket connects to the Pi directly. It needs the Pi hostname and trusted certificate to work. Pair this browser origin using a fresh Pi pairing code if required; localStorage sessions are per origin.

For company-portal hot reload, stop the local launcher and restart it in its terminal with the matching browser origin:

```powershell
cd "D:\Voltax-Home-Automation"
$env:LOCAL_ADMIN_ORIGIN = 'http://localhost:3001'
node .\tools\run-local.mjs --admin-email joylan928@gmail.com
```

Then, in a separate Windows terminal:

```powershell
cd "D:\Voltax-Home-Automation"
$env:CLOUD_URL = 'http://localhost:8098'
npm run dev:admin
```

Open **http://localhost:3001** and sign in there. The explicit origin preserves the cloud's cross-origin write checks. For ordinary company use, remove `LOCAL_ADMIN_ORIGIN` in the launcher terminal and restart to use `http://localhost:8098` again.

## Company cloud connection is a separate configuration

The Pi steps above establish real **local hardware control**. They do not automatically register the Pi with the Windows company installation. Its cloud broker is loopback-only and initially authorizes the launcher-managed local hub. A Pi cloud link additionally requires an accessible secured broker, a registered hub credential/ACL, pinned command public key, trusted clock, and real notification configuration. Do not disable those gates to make a support session appear to work.

Use the [physical acceptance register](milestone-1-results.md) to record actual results after your hardware test. Software startup checks and the instructions on this page do not mark any physical test as passed.
