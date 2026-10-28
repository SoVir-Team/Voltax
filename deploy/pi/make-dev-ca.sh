#!/usr/bin/env bash
# Run on the INSTALLER PC (not the Pi). Creates the Milestone 1 "Voltax Hub CA" in .secrets/ca/
# (git-ignored). The CA is name-constrained: it can only issue hub names, so a leaked key
# cannot be used to impersonate any other website. Production moves this CA to the cloud (M5).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep "/O=..." subjects intact
cd "$(dirname "$0")/../.."
dir=.secrets/ca
[ -f "$dir/ca.key" ] && { echo "CA already exists in $dir"; exit 0; }
umask 077
mkdir -p "$dir"

openssl ecparam -name prime256v1 -genkey -noout -out "$dir/ca.key"
openssl req -x509 -new -key "$dir/ca.key" -sha256 -days 3650 -out "$dir/ca.crt" \
  -subj "/O=VOLTEX/CN=VOLTEX Hub CA (dev)" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "nameConstraints=critical,permitted;DNS:.hub.voltax.internal,permitted;DNS:.local"
chmod 644 "$dir/ca.crt"
echo "Created $dir/ca.crt (share freely) and $dir/ca.key (keep secret, never on a Pi)."
