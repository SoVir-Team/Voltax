#!/usr/bin/env bash
# Local TLS acceptance test (§6.1). Run from any LAN machine with the hub CA:
#   deploy/pi/tests/tls-test.sh <hubId> <hub-ip> <ca.crt> [port]
# Proves the app-side rules: full validation against the Voltax Hub CA + the exact hub name,
# and that everything else is rejected (no CA, wrong name, other CA, old TLS).
set -uo pipefail
# --ssl-no-revoke: Windows (Schannel) curl otherwise demands a CRL the private CA does not publish; no-op on OpenSSL builds.
export MSYS_NO_PATHCONV=1
hub=${1:?hubId}; ip=${2:?hub ip}; ca=${3:?ca.crt}; port=${4:-8443}
name="$hub.hub.voltax.internal"
url="https://$name:$port/api/v1/health"
pass=0; fail=0
check() { # $1 description, $2 expected (ok|reject), rest = command
  local desc=$1 want=$2; shift 2
  if "$@" >/dev/null 2>&1; then got=ok; else got=reject; fi
  if [ "$got" = "$want" ]; then echo "PASS  $desc"; pass=$((pass+1)); else echo "FAIL  $desc (expected $want, got $got)"; fail=$((fail+1)); fi
}

check "valid: Voltax Hub CA + correct hub name" ok \
  curl -fsS --ssl-no-revoke --max-time 5 --cacert "$ca" --resolve "$name:$port:$ip" "$url"
check "no trust anchor (system store only) is rejected" reject \
  curl -fsS --ssl-no-revoke --max-time 5 --resolve "$name:$port:$ip" "$url"
check "wrong hub name (another home's hub) is rejected" reject \
  curl -fsS --ssl-no-revoke --max-time 5 --cacert "$ca" --resolve "other-hub.hub.voltax.internal:$port:$ip" "https://other-hub.hub.voltax.internal:$port/api/v1/health"
check "connecting by bare IP (no hub name) is rejected" reject \
  curl -fsS --ssl-no-revoke --max-time 5 --cacert "$ca" "https://$ip:$port/api/v1/health"

tmp=$(mktemp -d ./.tls-test.XXXXXX); trap 'rm -rf "$tmp"' EXIT
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$tmp/k" -out "$tmp/other-ca.crt" -days 1 -subj "/CN=Other CA" >/dev/null 2>&1
[ -s "$tmp/other-ca.crt" ] || { echo "could not create the test CA"; exit 2; }
check "a different CA is rejected" reject \
  curl -fsS --ssl-no-revoke --max-time 5 --cacert "$tmp/other-ca.crt" --resolve "$name:$port:$ip" "$url"
check "TLS 1.1 is refused by the hub" reject \
  sh -c "openssl s_client -connect $ip:$port -servername $name -tls1_1 -cipher DEFAULT@SECLEVEL=0 </dev/null 2>&1 | grep -q 'BEGIN CERTIFICATE'"

echo "---- $pass passed, $fail failed"
[ $fail -eq 0 ]
