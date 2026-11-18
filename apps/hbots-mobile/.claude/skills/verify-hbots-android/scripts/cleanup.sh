#!/usr/bin/env bash
# cleanup.sh [evidence dir]: stop exactly what this skill started. Never by name, never removes evidence.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
. "$HERE/env.sh"
EV=${1:-}
if [[ -n "$EV" && -f "$EV/srv/srv.json" ]]; then
  VERIFY_RELEASE="$VERIFY_RELEASE" node "$HERE/srv.mjs" stop "$EV/srv"
  cp "$EV/srv/server.log" "$EV/server.log" 2>/dev/null
  cp "$EV/srv/fake-pids/fake-claude.log" "$EV/fake-claude.log" 2>/dev/null
fi
ADBP=$(grep -E '^ADB_PREFIX=' "$STATE" 2>/dev/null | tail -1 | cut -d= -f2-)
[[ -n "$ADBP" ]] && $ADBP uninstall "$PKG" >/dev/null 2>&1
bash "$HERE/tunnel.sh" down
cp "$S"/logs/*.log "$EV/" 2>/dev/null
bash "$HERE/device.sh" down
echo "listeners on $VERIFY_SERVER_PORT, $VERIFY_ADB_PORT, $VERIFY_EMU_PORT: $(ss -ltn | grep -c -E ":($VERIFY_SERVER_PORT|$VERIFY_ADB_PORT|$VERIFY_EMU_PORT) ")"
echo "heavy slots held by this process tree's parent only:"; lslocks | grep omarchy-heavy || echo "none held"
