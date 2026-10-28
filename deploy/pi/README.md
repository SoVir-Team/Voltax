# deploy/pi

Everything that turns a Raspberry Pi into a VOLTEX hub. How to use it:
[pi-setup](../../docs/runbooks/pi-setup.md), [update/rollback](../../docs/runbooks/pi-update-rollback.md),
[recovery](../../docs/runbooks/pi-recovery.md).

```
pi/
├── provision.sh            One-time, idempotent Pi setup (run with sudo on the Pi)
├── make-dev-ca.sh          Installer PC: create the dev VOLTEX Hub CA in .secrets/ (git-ignored)
├── issue-hub-cert.sh       Installer PC: sign a hub's CSR
├── compose.yaml            mosquitto + voltax-hub (hardened; images filled in per release)
├── hub.env.example         Hub settings template (real file: /etc/voltax/hub.env, generated)
├── mosquitto/              Broker config + per-device ACL template
├── systemd/                hub, health timer, nightly backup, boot-time update check
├── scripts/                Installed to /usr/local/bin: voltax-update, voltax-backup, voltax-restore,
│                           voltax-health, voltax-hubctl, add-device, remove-device, ...
├── avahi/                  mDNS advertisement (_voltax._tcp)
├── docker-daemon.json      Log rotation, live-restore
├── journald.conf           Persistent, size-capped journal
└── tests/                  tls-test.sh (passes on PC; not yet run against a Pi)
```

Not yet written: `keys/voltax-release.pub` (needs the release signing key) and the on-Pi
tests `mqtt-acl-test.sh`, `recovery-test.sh`, `backup-restore-test.sh`, `perm-test.sh`.
