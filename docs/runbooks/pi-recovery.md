# Runbook: recovery

## Automatic recovery (no action needed)

| Problem | Handled by |
|---|---|
| Container crashes | Docker `restart: unless-stopped` |
| Container stuck "unhealthy" | `voltax-health.timer` restarts it (every 60 s) |
| Docker daemon stops | systemd |
| Kernel hangs | hardware watchdog reboots the Pi |
| Power cut | services start at boot; SQLite WAL + `synchronous=FULL` keeps committed data |
| Power cut during an update | `voltax-boot-check` rolls back |

## Backups

Nightly at 03:15 (`voltax-backup.timer`), kept 7 days, in `/var/lib/voltax/backups/`. A backup holds
the DB (SQLite online backup, integrity-checked) plus `/etc/voltax` (secrets: root only). Manual:

```bash
sudo voltax-backup before-maintenance
```

Never copy `hub.db` by hand: that misses the `-wal` file.

## Restore the database

```bash
ls /var/lib/voltax/backups/
sudo voltax-restore /var/lib/voltax/backups/<name>.db
```

It stops the hub, keeps the current DB aside as `hub.db.before-restore-<time>`, restores, starts the
hub and waits for health.

## Lost SSH access [MANUAL]

Connect HDMI + keyboard, or take out the SD card and add a public key to
`/home/voltax-admin/.ssh/authorized_keys` on the root partition. Keep a second, offline break-glass key.

## Corrupted SD card [MANUAL]

1. Flash a new card and run `provision.sh` with the **same** `--hub-id` ([pi-setup.md](pi-setup.md)).
2. Restore `/etc/voltax` from the backup tarball and the DB with `voltax-restore`.
3. Reinstall the release with `voltax-update`.

Until off-device backups exist (Milestone 2), copy `/var/lib/voltax/backups/` off the Pi regularly.
For production, boot from a USB SSD.

## Useful commands

```bash
docker compose -p voltax logs --tail 100
journalctl -u voltax-hub -u voltax-boot-check --since today
curl --cacert /etc/voltax/tls/ca.crt --resolve voltax-hub-001.hub.voltax.internal:8443:127.0.0.1 \
  https://voltax-hub-001.hub.voltax.internal:8443/api/v1/health
```
