#!/usr/bin/env bash
# cleanup.sh [evidence dir]: stop exactly what this run started, read from this run's own state file. Never by name, never removes evidence.
# With an evidence dir it reads <evidence>/state.env. Without one it reads .scratch/state.env (a standalone device.sh or tunnel.sh).
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
EV=${1:-}
[[ -n "$EV" && -z "${VERIFY_STATE:-}" ]] && export VERIFY_STATE="$EV/state.env"
# shellcheck disable=SC1091
. "$HERE/env.sh"
if [[ -n "$EV" && -f "$EV/srv/srv.json" ]]; then
  VERIFY_RELEASE="$VERIFY_RELEASE" node "$HERE/srv.mjs" stop "$EV/srv"
  cp "$EV/srv/server.log" "$EV/server.log" 2>/dev/null
  cp "$EV/srv/fake-pids/fake-claude.log" "$EV/fake-claude.log" 2>/dev/null
fi
ADBP=$(grep -E '^ADB_PREFIX=' "$STATE" 2>/dev/null | tail -1 | cut -d= -f2-)
[[ -n "$ADBP" ]] && $ADBP uninstall "$PKG" >/dev/null 2>&1
bash "$HERE/tunnel.sh" down
[[ -n "$EV" && "$LOGS" != "$EV" ]] && cp "$LOGS"/*.log "$EV/" 2>/dev/null
bash "$HERE/device.sh" down
echo "listeners on $VERIFY_SERVER_PORT, $VERIFY_ADB_PORT, $VERIFY_EMU_PORT: $(ss -ltn | grep -c -E ":($VERIFY_SERVER_PORT|$VERIFY_ADB_PORT|$VERIFY_EMU_PORT) ")"
echo "tunnel units of any run still active (other runs' are left alone): $(systemctl --user list-units 'pstack-hbots-verify-tunnel-*' --no-legend --plain 2>/dev/null | awk '{print $1}' | paste -sd' ' | grep . || echo none)"
