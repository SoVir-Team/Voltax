#!/usr/bin/env bash
# Run on the INSTALLER PC. Signs a hub's CSR (its private key never left the Pi).
#   deploy/pi/issue-hub-cert.sh <hub.csr> <hubId> [hostname]
# Output: .secrets/hubs/<hubId>/hub.crt + ca.crt, ready to copy to /etc/voltax/tls/ on the Pi.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep "/O=..." subjects intact
csr_in=${1:?usage: issue-hub-cert.sh <hub.csr> <hubId> [hostname]}
hub=${2:?hubId required}
host=${3:-$hub}
[[ "$hub" =~ ^[a-z0-9-]{3,40}$ && "$host" =~ ^[a-z0-9-]{1,63}$ ]] || { echo "invalid hubId/hostname" >&2; exit 1; }
[ -f "$csr_in" ] || { echo "no such CSR: $csr_in" >&2; exit 1; }

repo=$(cd "$(dirname "$0")/../.." && pwd)
out=.secrets/hubs/$hub
mkdir -p "$repo/$out"
cp "$csr_in" "$repo/$out/hub.csr"
cd "$repo" # from here on only relative paths, so Windows OpenSSL can open them too
ca=.secrets/ca
[ -f "$ca/ca.key" ] || { echo "no CA: run deploy/pi/make-dev-ca.sh first" >&2; exit 1; }
openssl req -in "$out/hub.csr" -noout -verify >/dev/null 2>&1 || { echo "CSR signature invalid" >&2; exit 1; }

cat >"$out/ext.cnf" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:$hub.hub.voltax.internal,DNS:$host.local
EOF
# 800 days: under iOS's 825-day limit for TLS certificates. Renew at half-life (M2: via cloud link).
openssl x509 -req -in "$out/hub.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" -CAcreateserial \
  -days 800 -sha256 -extfile "$out/ext.cnf" -out "$out/hub.crt" 2>/dev/null
rm -f "$out/ext.cnf"
cp "$ca/ca.crt" "$out/ca.crt"
openssl verify -CAfile "$out/ca.crt" "$out/hub.crt"
echo "Copy to the Pi:  scp $out/hub.crt $out/ca.crt <admin>@$host.local:/tmp/"
echo "Then on the Pi:  sudo install -o root -g 10001 -m 444 /tmp/hub.crt /tmp/ca.crt /etc/voltax/tls/"
