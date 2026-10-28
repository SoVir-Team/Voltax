# Release signing key

Every hub only installs releases whose `release.json` is signed by this key. `provision.sh` copies
`voltax-release.pub` from this folder to `/etc/voltax/release.pub` on the Pi.

**Status:** not created yet. Until `voltax-release.pub` exists here, the release workflow fails at
its first step and every hub refuses every release.

## Create the key once [MANUAL]

On a trusted machine (not a Pi, not CI), with [minisign](https://jedisct1.github.io/minisign/):

```bash
minisign -G -p voltax-release.pub -s voltax-release.key
```

Choose a strong password. Then:

1. Commit **only** `voltax-release.pub` to this folder (`*.key` is git-ignored).
2. In GitHub → repository → Settings → Secrets and variables → Actions, add:
   - `MINISIGN_SECRET_KEY`: the full contents of `voltax-release.key`
   - `MINISIGN_PASSWORD`: its password
3. Store `voltax-release.key` and its password offline (password manager + offline backup).
   Losing it means re-provisioning `release.pub` on every hub; leaking it means anyone could ship
   an update to every home.

## Publish a release

```bash
git tag hub-v0.1.0
git push origin hub-v0.1.0
```

`.github/workflows/hub-release.yml` then:
1. Runs the tests.
2. Builds the linux/arm64 hub image (with the web app) and pushes it to `ghcr.io/sovir-team/voltax-hub`.
3. Pins it and Mosquitto by digest in `release.json`.
4. Signs `release.json` and checks the signature against the `.pub` committed here.
5. Creates the GitHub release.

## Pi access to releases

The repository and image are private, so each hub needs a read-only token in
`/etc/voltax/github.token` (root, 0600). Use a fine-grained token with **Contents: read** on this
repository, plus `read:packages` for GHCR.

A hub without internet can be updated from a laptop:
1. Copy the three release files to the Pi.
2. Load both images, pulled by digest on a connected machine, with `docker save` on the laptop and `docker load` on the Pi.
3. Run `sudo voltax-update <version> --from-dir <dir>`.

`voltax-update` skips the pull when the pinned image is already present.

## Rotating the key

Generate a new pair, install the new `.pub` on every hub, then update both secrets. Hubs that
still have the old `.pub` reject releases signed with the new key, so update `release.pub` first.
