#!/usr/bin/env bash
# voltax-update <version> [--from-dir DIR]   install a signed, tested release
# voltax-update --rollback                    go back to the previous release
# voltax-update --boot-check                  (systemd) undo an update cut off by power loss
#
# A release = release.json + release.json.minisig + compose.yaml (GitHub release "hub-v<version>").
# release.json pins image DIGESTS and the compose.yaml SHA-256; its minisign signature is checked
# against /etc/voltax/release.pub before anything is pulled or changed.
# Data in /var/lib/voltax and config in /etc/voltax are never touched, except that a failed
# update whose migration changed the schema restores the pre-update DB backup.
set -euo pipefail
source /usr/local/lib/voltax/lib.sh
require_root

REPO=${VOLTAX_REPO:-SoVir-Team/Voltax}
STATE=$VOLTAX_DATA/update.state
RELEASES=$VOLTAX_OPT/releases
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
KEEP_RELEASES=3

exec 9>/run/voltax-update.lock
flock -n 9 || die "another update is running"

write_state() { # atomic + fsync'd, so a power cut leaves either the old or the new file
  printf '%s\n' "$@" >"$STATE.tmp" && sync "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE" && sync "$VOLTAX_DATA"
}

switch_to() { # atomic symlink swap
  ln -sfn "$1" "$VOLTAX_OPT/current.tmp" && mv -Tf "$VOLTAX_OPT/current.tmp" "$VOLTAX_OPT/current" && sync "$VOLTAX_OPT"
}

schema_version() { [ -f "$VOLTAX_DATA/hub/hub.db" ] && sqlite3 "$VOLTAX_DATA/hub/hub.db" 'PRAGMA user_version;' || echo 0; }

wait_healthy() { # $1 = expected version
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) body
  while [ $SECONDS -lt $deadline ]; do
    if body=$(hub_health 2>/dev/null) &&
      [ "$(jq -r .version <<<"$body")" = "$1" ] && [ "$(jq -r .db <<<"$body")" = up ] && [ "$(jq -r .status <<<"$body")" = ok ]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

rollback() { # uses the state file written before the switch
  # shellcheck disable=SC1090
  source "$STATE"
  [ -n "${PREV:-}" ] && [ -d "$PREV" ] || die "no previous release to roll back to"
  log "rolling back to $(basename "$PREV")"
  compose down --timeout 20 || true
  switch_to "$PREV"
  if [ "$(schema_version)" != "${SCHEMA_BEFORE:-0}" ] && [ -f "${BACKUP:-}" ]; then
    log "schema changed during the failed update; restoring $BACKUP"
    for f in hub.db hub.db-wal hub.db-shm; do rm -f "$VOLTAX_DATA/hub/$f"; done
    install -o $HUB_UID -g $HUB_UID -m 600 "$BACKUP" "$VOLTAX_DATA/hub/hub.db"
  fi
  compose up -d --remove-orphans
  write_state "STATUS=rolled-back" "CURRENT=$PREV" "FAILED=${NEW:-}" "AT=$(date -u +%FT%TZ)"
  if wait_healthy "$(jq -r .version "$PREV/release.json")"; then log "rollback complete, hub healthy"; else die "rolled back but hub is not healthy: check 'journalctl -u voltax-hub' and 'docker compose -p voltax logs'"; fi
}

fetch_release() { # $1 version, $2 target dir
  local ver=$1 dir=$2 token rel url
  token=$(cat "$VOLTAX_ETC/github.token" 2>/dev/null) || die "missing $VOLTAX_ETC/github.token (read-only token), or use --from-dir"
  rel=$(curl -fsS -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO/releases/tags/hub-v$ver") || die "release hub-v$ver not found"
  for name in release.json release.json.minisig compose.yaml; do
    url=$(jq -r --arg n "$name" '.assets[] | select(.name == $n) | .url' <<<"$rel")
    [ -n "$url" ] || die "release hub-v$ver has no $name"
    curl -fsSL -H "Authorization: Bearer $token" -H 'Accept: application/octet-stream' "$url" -o "$dir/$name"
  done
}

install_release() { # $1 version, $2 optional source dir
  local ver=$1 src=${2:-} tmp new prev backup
  [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "version must look like 1.2.3"
  tmp=$(mktemp -d "$VOLTAX_DATA/tmp.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  if [ -n "$src" ]; then cp "$src"/release.json "$src"/release.json.minisig "$src"/compose.yaml "$tmp"/; else fetch_release "$ver" "$tmp"; fi

  log "verifying signature"
  minisign -Vm "$tmp/release.json" -p "$VOLTAX_ETC/release.pub" >/dev/null || die "SIGNATURE CHECK FAILED: refusing to install"
  [ "$(jq -r .version "$tmp/release.json")" = "$ver" ] || die "release.json is for a different version"
  [ "$(sha256sum "$tmp/compose.yaml" | cut -d' ' -f1)" = "$(jq -r .composeSha256 "$tmp/release.json")" ] || die "compose.yaml does not match the signed hash"
  local hub_img mq_img
  hub_img=$(jq -r .hubImage "$tmp/release.json")
  mq_img=$(jq -r .mosquittoImage "$tmp/release.json")
  [[ "$hub_img" == *@sha256:* && "$mq_img" == *@sha256:* ]] || die "images must be pinned by digest"

  log "pulling images"
  if [ -f "$VOLTAX_ETC/github.token" ]; then docker login ghcr.io -u voltax-hub --password-stdin <"$VOLTAX_ETC/github.token" >/dev/null; fi
  docker pull -q "$hub_img" >/dev/null
  docker pull -q "$mq_img" >/dev/null

  new=$RELEASES/$ver
  prev=$(readlink -f "$VOLTAX_OPT/current" 2>/dev/null || true)
  [ "$prev" != "$new" ] || die "$ver is already the current release"
  mkdir -p "$new"
  sed -e "s|__HUB_IMAGE__|$hub_img|" -e "s|__MOSQUITTO_IMAGE__|$mq_img|" "$tmp/compose.yaml" >"$new/compose.yaml"
  cp "$tmp/release.json" "$tmp/release.json.minisig" "$new/"

  log "backing up before update"
  /usr/local/bin/voltax-backup "pre-$ver" >/dev/null
  backup=$(readlink -f "$VOLTAX_DATA/backups/latest.db" 2>/dev/null || true)

  local schema_before
  schema_before=$(schema_version)
  write_state "STATUS=switching" "PREV=$prev" "NEW=$new" "BACKUP=$backup" "SCHEMA_BEFORE=$schema_before" "AT=$(date -u +%FT%TZ)"
  switch_to "$new"
  log "starting $ver"
  compose up -d --remove-orphans

  if wait_healthy "$ver"; then
    # Keep PREV/BACKUP/SCHEMA_BEFORE so a later manual --rollback can restore the matching DB.
    write_state "STATUS=done" "CURRENT=$new" "PREV=$prev" "NEW=$new" "BACKUP=$backup" "SCHEMA_BEFORE=$schema_before" "AT=$(date -u +%FT%TZ)"
    log "updated to $ver, hub healthy"
    # keep the newest releases (never the current or previous one)
    find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP_RELEASES + 1)) | cut -d' ' -f2- |
      while read -r d; do [ "$d" != "$new" ] && [ "$d" != "$prev" ] && rm -rf "$d"; done
  else
    log "$ver did not become healthy within ${HEALTH_TIMEOUT}s"
    [ -n "$prev" ] || die "first install failed and there is nothing to roll back to"
    rollback
    exit 1
  fi
}

case "${1:-}" in
  --rollback) rollback ;;
  --boot-check)
    if [ -f "$STATE" ] && grep -q '^STATUS=switching$' "$STATE"; then
      log "update was interrupted (power loss?)"; rollback
    fi ;;
  ''|-h|--help) sed -n '2,4p' "$0"; exit 1 ;;
  *)
    ver=$1; shift
    src=""
    if [ "${1:-}" = "--from-dir" ]; then src=${2:?--from-dir needs a directory}; fi
    install_release "$ver" "$src" ;;
esac
