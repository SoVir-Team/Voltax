#!/usr/bin/env bash
# Runs at boot before voltax-hub.service. If power was lost in the middle of an update
# (state file still says "switching"), roll back to the previous release.
set -euo pipefail
exec /usr/local/bin/voltax-update --boot-check
