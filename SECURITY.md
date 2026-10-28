# Security

## Reporting a vulnerability

Do not open a public issue. Email the SoVir Technologies IT team with the details and steps to
reproduce. We aim to acknowledge reports within 3 working days.

## Rules for this repository

- Never commit secrets: Wi-Fi/MQTT/OTA passwords, CA or hub private keys, tokens, `.env` files.
  `.gitignore` blocks the common ones (`.secrets/`, `*.env`, `secrets.yaml`, `*.key`, `*.pem`); it is
  a safety net, not a substitute for checking `git status` before committing.
- Per-device MQTT passwords are generated on the hub by `deploy/pi/scripts/add-device.sh` and shown once.
- The hub's TLS private key is generated on the Pi and never leaves it.
- Release signing keys (minisign) and registry tokens live only in GitHub Actions secrets or an
  offline store, never in the repo.

## Known prototype limitations (Milestone 1)

- ESP32 to hub MQTT runs on port 1883 without TLS, reachable only from the home LAN (firewall).
  TLS on 8883, ESP32 flash encryption and secure boot are required before production.
- The development hub CA (`deploy/pi/make-dev-ca.sh`) is for prototypes only; production moves the
  issuing CA to the cloud.

Design details: [docs/architecture.md](docs/architecture.md).
