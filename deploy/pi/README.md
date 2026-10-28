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
├── keys/                   Release signing public key (README: how to create it)
└── tests/                  Acceptance tests, see below
```

## Tests

Run on the Pi as root from the copied folder, e.g. `sudo ~/voltax-deploy/tests/perm-test.sh`.
Each prints PASS/FAIL per check and exits non-zero on any failure.

| Script | Checks | Disruptive? |
|---|---|---|
| `perm-test.sh` | container users, capabilities, read-only FS, host file modes, SSH/firewall | no |
| `mqtt-acl-test.sh` | wrong/anonymous login refused; each device limited to its own topics (with positive controls) | no (temporary test users) |
| `recovery-test.sh` | broker/hub crash, frozen hub, Docker restart: all recover on their own | yes, ~10 min |
| `backup-restore-test.sh` | backup under write load, restore, data matches | yes: restores the DB (**test hub only**) |
| `tls-test.sh` | run from a LAN PC: hub TLS accepted only with the VOLTEX CA + right name | no |

Status: `tls-test.sh` passed on a PC against a local hub. **The other four have not been run yet;
they need a provisioned Pi.** Not created yet: `keys/voltax-release.pub` (see `keys/README.md`).
