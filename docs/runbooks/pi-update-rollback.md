# Runbook: update and roll back a hub

## What a release is

A GitHub release tagged `hub-v<version>` with three files:

| File | Contents |
|---|---|
| `release.json` | `version`, `hubImage` and `mosquittoImage` **pinned by digest**, `composeSha256` |
| `release.json.minisig` | minisign signature of `release.json` |
| `compose.yaml` | `deploy/pi/compose.yaml` (images filled in on the Pi from `release.json`) |

The Pi refuses any release whose signature does not verify against `/etc/voltax/release.pub`
(installed from `deploy/pi/keys/voltax-release.pub`).

> **Not built yet:** the release workflow (`.github/workflows/hub-release.yml`) and the release key.
> **[MANUAL]** Create the key once, offline: `minisign -G -p voltax-release.pub -s voltax-release.key`.
> Commit only the `.pub` file to `deploy/pi/keys/`; keep the secret key out of the repo.

## Install or update

```bash
sudo voltax-update 0.1.1                    # from GitHub (needs /etc/voltax/github.token, read-only)
sudo voltax-update 0.1.1 --from-dir /tmp/r  # from copied release files (no internet needed)
```

In order, it:
1. Verifies the signature and the compose hash, and checks the images are pinned by digest.
2. Pulls the images.
3. Backs up the DB and `/etc/voltax`, and records the state with `STATUS=switching`.
4. Switches `/opt/voltax/current` atomically.
5. Waits up to 120 s for `/api/v1/health` to report the new version with status `ok`.

If the hub is not healthy in time, the update rolls back automatically. It restores the pre-update database only if a migration changed the schema.

## Roll back by hand

```bash
sudo voltax-update --rollback
```

## Power cut during an update

`voltax-boot-check.service` runs at boot. If the state file still says `switching`, it rolls back
before the hub starts. Data in `/var/lib/voltax` and config in `/etc/voltax` are never replaced by an update.

## Check

```bash
cat /var/lib/voltax/update.state
readlink -f /opt/voltax/current
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
```
