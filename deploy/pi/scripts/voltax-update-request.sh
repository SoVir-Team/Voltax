#!/usr/bin/env bash
# voltax-update-request   (systemd, root) apply an update the hub asked for.
#
# The hub process (uid 10001) can only drop {"version": "x.y.z"} into
# /var/lib/voltax/update-request/request.json, and only after the home owner's update policy
# allowed it. This root script does NOT trust that file: it accepts a plain version string,
# refuses downgrades, and runs voltax-update, which verifies the minisign signature of the
# release against /etc/voltax/release.pub before changing anything and rolls back on failure.
# The outcome is written to result.json for the hub to report.
set -uo pipefail
source /usr/local/lib/voltax/lib.sh
require_root

DIR=$VOLTAX_DATA/update-request
REQ=$DIR/request.json
RESULT=$DIR/result.json

[ -f "$REQ" ] || exit 0

result() { # state version [message]
  local tmp=$DIR/.result.json.tmp
  jq -n --arg state "$1" --arg version "$2" --arg message "${3:-}" --arg rollout "${rollout:-}" \
    '{state: $state, version: $version, at: (now * 1000 | floor)}
     + (if $message != "" then {message: $message} else {} end)
     + (if $rollout != "" then {rolloutId: $rollout} else {} end)' >"$tmp"
  chown "$HUB_UID:$HUB_UID" "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$RESULT"
}

# Read and consume the request first, so a bad request can never loop the path unit.
raw=$(head -c 4096 "$REQ")
rm -f "$REQ"
version=$(jq -r '.version // empty' <<<"$raw" 2>/dev/null || true)
rollout=$(jq -r '.rolloutId // empty' <<<"$raw" 2>/dev/null | tr -cd 'a-zA-Z0-9-' | head -c 64 || true)

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  result failed "${version:0:32}" "invalid version in request"
  exit 0
fi

current=$(basename "$(readlink -f "$VOLTAX_OPT/current" 2>/dev/null || echo none)")
if [ "$current" = "$version" ]; then
  result done "$version" "already running this version"
  exit 0
fi
if [ "$current" != none ] && [ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | head -n1)" = "$version" ]; then
  # Downgrades only through 'voltax-update --rollback' by someone at the hub, never remotely.
  result failed "$version" "refusing to downgrade from $current"
  exit 0
fi

result applying "$version"
if output=$(/usr/local/bin/voltax-update "$version" 2>&1); then
  result done "$version"
else
  now=$(basename "$(readlink -f "$VOLTAX_OPT/current" 2>/dev/null || echo none)")
  msg=$(tail -n 3 <<<"$output" | tr '\n' ' ' | head -c 400)
  if [ "$now" = "$current" ]; then result rolled_back "$version" "$msg"; else result failed "$version" "$msg"; fi
fi
