#!/usr/bin/env bash
# voltax-restore <backup.db>
# Stop the hub, put a verified backup in place, start again and wait for health.
# The current DB (and its -wal/-shm) is kept aside as hub.db.before-restore-<time>.
set -euo pipefail
source /usr/local/lib/voltax/lib.sh
require_root

src=${1:?usage: voltax-restore <backup.db>}
[ -f "$src" ] || die "no such file: $src"
[ "$(sqlite3 "$src" 'PRAGMA integrity_check;')" = "ok" ] || die "$src fails integrity check, refusing to restore"

dbdir=$VOLTAX_DATA/hub
ts=$(date -u +%Y%m%dT%H%M%SZ)
log "stopping hub"
compose stop voltax-hub

for f in hub.db hub.db-wal hub.db-shm; do
  [ -f "$dbdir/$f" ] && mv "$dbdir/$f" "$dbdir/$f.before-restore-$ts"
done
install -o $HUB_UID -g $HUB_UID -m 600 "$src" "$dbdir/hub.db"

log "starting hub"
compose up -d voltax-hub
for _ in $(seq 1 60); do
  if hub_health >/dev/null 2>&1; then log "restored from $src, hub healthy"; exit 0; fi
  sleep 2
done
die "hub not healthy after restore; previous DB kept as $dbdir/hub.db.before-restore-$ts"
