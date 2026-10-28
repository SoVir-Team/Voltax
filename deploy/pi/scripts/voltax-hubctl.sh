#!/usr/bin/env bash
# voltax-hubctl <command> ...  — installer CLI on the Pi (runs inside the hub container).
#   pairing-code [--role owner|member]   one-time code, 10 min (owner) / 5 min (member), printed here only
#   clients                              list paired apps
#   revoke <clientId> [--force]          revoke an app (--force allows the last owner)
#   remove-device <deviceId>             forget a device in the DB (use remove-device to also drop its credential)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

out=$(docker exec voltax-voltax-hub-1 node dist/cli.js "$@")
printf '%s\n' "$out" | grep -v '^voltax://' || true

# Pairing: show the voltax:// link as a QR code for the app to scan, if qrencode is installed.
link=$(printf '%s\n' "$out" | grep '^voltax://' || true)
if [ -n "$link" ]; then
  if command -v qrencode >/dev/null; then qrencode -t ansiutf8 "$link"; else echo "$link"; fi
fi
