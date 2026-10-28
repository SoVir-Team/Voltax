#!/usr/bin/env bash
# Backup/restore test (plan §6.4). Run ON A TEST HUB: it restores the database, so anything
# written during the test window is rolled back.
#   sudo bash ~/voltax-deploy/tests/backup-restore-test.sh [--yes]
# 1. Device "bkptest" reports states while voltax-backup runs (backup taken under write load).
# 2. Device "bkptest-after" appears only after the backup.
# 3. voltax-restore: the hub comes back healthy with bkptest, without bkptest-after, every backed-up
#    event present, and integrity_check ok.
set -uo pipefail
# shellcheck source=lib-test.sh
source "$(dirname "$0")/lib-test.sh"

if [ "${1:-}" != "--yes" ]; then
  read -r -p "This restores the hub database from a fresh backup (hub restarts). Continue? [y/N] " answer
  [ "$answer" = y ] || exit 1
fi

HUB=$(hub_id)
HUBPASS=$(hub_password)
DB=$VOLTAX_DATA/hub/hub.db
BACKUPS=$VOLTAX_DATA/backups
TAG=bkptest

# Test devices are removed afterwards. The test backups are kept (latest.db points at the newest).
cleanup() {
  for dev in bkptest bkptest-after; do
    docker exec "$(container_id voltax-hub)" node dist/cli.js remove-device "$dev" >/dev/null 2>&1
  done
}
trap cleanup EXIT

# Publish device states as the hub account (it may write any topic of this hub); not retained.
states() { # deviceId count
  compose exec -T mosquitto sh -c '
    i=0; while [ $i -lt "$4" ]; do
      if [ $((i % 2)) -eq 0 ]; then v=ON; else v=OFF; fi
      mosquitto_pub -h 127.0.0.1 -u hub -P "$1" -t "voltax/$2/$3/switch/load/state" -m $v
      i=$((i + 1))
    done' _ "$HUBPASS" "$HUB" "$1" "$2"
}
q() { sqlite3 -readonly "$DB" "$1"; }
has_device() { [ "$(q "SELECT count(*) FROM devices WHERE device_id = '$1';")" = 1 ]; }
no_post_backup_device() { ! has_device bkptest-after; }
all_events_present() { # every event in the backup (by unique id) exists in the live DB
  [ "$(q "ATTACH '$backup' AS b; SELECT count(*) FROM b.events WHERE id NOT IN (SELECT id FROM main.events);")" = 0 ]
}
old_db_kept() { compgen -G "$VOLTAX_DATA/hub/hub.db.before-restore-*" >/dev/null; }

echo "Backup/restore test on hub $HUB"
check "starting point: hub API ok" hub_ok

states bkptest 20
check "test device recorded before the backup" wait_for 15 has_device bkptest

# Backup while the hub is writing
states bkptest 300 &
writer=$!
check "voltax-backup succeeds under write load (integrity verified)" /usr/local/bin/voltax-backup "$TAG"
wait "$writer"
backup=$(ls -t "$BACKUPS/$TAG"-*.db 2>/dev/null | head -n1)
check "backup file created" test -s "$backup"
check "backup passes integrity_check" test "$(sqlite3 "$backup" 'PRAGMA integrity_check;')" = ok
backup_events=$(sqlite3 "$backup" 'SELECT count(*) FROM events;')

# Change the live database after the backup
states bkptest-after 5
check "post-backup device exists before restore" wait_for 15 has_device bkptest-after

# Restore
check "voltax-restore brings the hub back healthy" /usr/local/bin/voltax-restore "$backup"
check "hub API ok after restore" wait_for 60 hub_ok
check "restored DB passes integrity_check" test "$(q 'PRAGMA integrity_check;')" = ok
check "device from before the backup is present" has_device bkptest
check "device created after the backup is gone" no_post_backup_device
check "every backed-up event is in the restored DB ($backup_events events)" all_events_present
check "previous DB kept aside" old_db_kept
echo "Test backup kept: $backup"

summary
