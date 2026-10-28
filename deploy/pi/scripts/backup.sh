#!/usr/bin/env bash
# voltax-backup [tag]   (default tag: manual)
# Consistent backup of the hub DB (SQLite online backup API, safe in WAL mode while the hub runs)
# plus /etc/voltax (secrets, TLS, broker users). Output: /var/lib/voltax/backups/<tag>-<UTC time>.*
# Nightly backups older than 7 days are deleted. Backups contain secrets: root only.
set -euo pipefail
source /usr/local/lib/voltax/lib.sh
require_root

tag=${1:-manual}
[[ "$tag" =~ ^[a-z0-9.-]+$ ]] || die "tag must match [a-z0-9.-]+"
dir=$VOLTAX_DATA/backups
ts=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
mkdir -p "$dir"

db=$VOLTAX_DATA/hub/hub.db
if [ -f "$db" ]; then
  sqlite_backup "$db" "$dir/$tag-$ts.db"
  ln -sfn "$tag-$ts.db" "$dir/latest.db"
  log "database -> $dir/$tag-$ts.db (integrity ok)"
else
  log "no database yet, skipping"
fi
tar -czf "$dir/$tag-$ts-etc.tar.gz" -C / etc/voltax
log "config   -> $dir/$tag-$ts-etc.tar.gz"
chown -R root:$HUB_UID "$dir" && chmod 770 "$dir"

if [ "$tag" = nightly ]; then
  find "$dir" -maxdepth 1 -name 'nightly-*' -mtime +7 -delete
fi
