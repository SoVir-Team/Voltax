#!/usr/bin/env bash
# Tests the root-side update hand-off (voltax-update-request) in a throwaway Debian container:
#   npm run test:host            (from the repository root; needs Docker)
# voltax-update itself is replaced by a stub; this checks the decisions around it: input
# validation, downgrade refusal, injection attempts, and the result reported to the hub.
# Not a Raspberry Pi test: systemd path activation and real releases are covered on the Pi.
set -uo pipefail
SRC=${SRC:-/src}

pass=0 fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

install -d /usr/local/lib/voltax /usr/local/bin /opt/voltax/releases /var/lib/voltax/update-request
install -m 644 "$SRC/scripts/lib.sh" /usr/local/lib/voltax/lib.sh
install -m 755 "$SRC/scripts/voltax-update-request.sh" /usr/local/bin/voltax-update-request

# Stub updater: switches to the version unless STUB_FAIL is set (then it "rolls back" = no switch).
cat >/usr/local/bin/voltax-update <<'EOF'
#!/usr/bin/env bash
echo "stub voltax-update $*" >>/tmp/update-calls
[ -n "${STUB_FAIL:-}" ] && { echo "health check failed, rolled back"; exit 1; }
mkdir -p "/opt/voltax/releases/$1" && ln -sfn "/opt/voltax/releases/$1" /opt/voltax/current
EOF
chmod 755 /usr/local/bin/voltax-update

DIR=/var/lib/voltax/update-request
mkdir -p /opt/voltax/releases/1.2.0 && ln -sfn /opt/voltax/releases/1.2.0 /opt/voltax/current

run() { # request-json -> runs the unit's script
  printf '%s' "$1" >"$DIR/request.json"
  rm -f /tmp/update-calls
  /usr/local/bin/voltax-update-request
}
state() { jq -r .state "$DIR/result.json"; }
msg() { jq -r '.message // ""' "$DIR/result.json"; }
current() { basename "$(readlink -f /opt/voltax/current)"; }
not_called() { [ ! -f /tmp/update-calls ]; }

run '{"version":"1.2.3; touch /tmp/pwned"}'
check "injection in version is refused" [ "$(state)" = failed ]
check "injected command did not run" [ ! -e /tmp/pwned ]
check "request was consumed (no loop)" [ ! -e "$DIR/request.json" ]
check "updater not called for a bad request" not_called

run 'not json at all'
check "garbage request is refused" [ "$(state)" = failed ]

run '{"version":"1.2.0"}'
check "same version is a no-op" [ "$(state)" = done ]
check "updater not called for the running version" not_called

run '{"version":"1.1.9","rolloutId":"r-7"}'
check "downgrade is refused" [ "$(state)" = failed ]
check "downgrade message explains why" grep -q "refusing to downgrade" <<<"$(msg)"
check "updater not called for a downgrade" not_called
check "rollout id is reported back" [ "$(jq -r .rolloutId "$DIR/result.json")" = r-7 ]

run '{"version":"1.3.0","rolloutId":"r-8"}'
check "upgrade succeeds" [ "$(state)" = done ]
check "now running 1.3.0" [ "$(current)" = 1.3.0 ]
check "result readable by the hub user" [ "$(stat -c '%u %a' "$DIR/result.json")" = "10001 644" ]

STUB_FAIL=1 run '{"version":"1.4.0"}'
check "failed update is reported as rolled back" [ "$(state)" = rolled_back ]
check "still running 1.3.0 after the failed update" [ "$(current)" = 1.3.0 ]

/usr/local/bin/voltax-update-request
check "no request file: nothing happens" [ "$(state)" = rolled_back ]

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
