#!/usr/bin/env bash
# One command: install an x86_64 APK on a throwaway emulator, pair it with a throwaway server, drive the daily-use flows, keep evidence.
# Usage: bash verify.sh <x86_64.apk> [label] [--only 1,2]    Exit 0 = every flow PASS, 1 = a flow FAILED, 2 = setup, device or doctor failed.
# The laptop emulator runs in ONE heavy-job slot. The wait for that slot is reported apart from work.
# Env: HBOTS_VERIFY_DEVICE=laptop skips the rig. VERIFY_ADB_PORT, VERIFY_EMU_PORT, VERIFY_AVD, VERIFY_SERVER_PORT, VERIFY_RELEASE.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
. "$HERE/env.sh"
APK=${1:?usage: verify.sh <x86_64.apk> [label] [--only 1,2]}; LABEL=${2:-run}; ONLY=""
[[ "${3:-}" == --only ]] && ONLY=${4:-}
APK=$(realpath "$APK")
if [[ -z "${VERIFY_INNER:-}" ]]; then
  T0=$(date +%s)
  exec env -u NODE_ENV bash "$HEAVY" --label "hbots verify android" --work-dir "$ROOT" --wait-seconds 10800 -- \
    env VERIFY_INNER=1 VERIFY_T0="$T0" bash "$HERE/verify.sh" "$APK" "$LABEL" ${ONLY:+--only "$ONLY"}
fi
GOT=$(date +%s); QUEUE=$(( GOT - ${VERIFY_T0:-$GOT} ))
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
EV="${HBOTS_VERIFY_EVIDENCE:-$S/evidence}/$LABEL-$STAMP"; mkdir -p "$EV"
cleanup() { bash "$HERE/cleanup.sh" "$EV" 2>&1 | tee -a "$EV/run.log"; }
trap cleanup EXIT
fail() {
  local total=$(( $(date +%s) - ${VERIFY_T0:-$GOT} ))
  echo "RESULT SETUP-FAIL ($2) in ${total}s total, ${QUEUE}s waiting for a heavy-job slot, evidence $EV" | tee -a "$EV/run.log"
  exit "$1"
}
{
  echo "verify-hbots-android $(git -C "$ROOT" rev-parse --short=12 HEAD) $(date -u +%FT%TZ) label $LABEL, queue wait ${QUEUE}s"
  bash "$HERE/doctor.sh" --pre "$APK" || exit 2
} 2>&1 | tee "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "doctor --pre"
t=$SECONDS
{ bash "$HERE/device.sh" up; } 2>&1 | tee -a "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "device"
T_device=$((SECONDS - t))
ADB_PREFIX=$(grep -E '^ADB_PREFIX=' "$STATE" | tail -1 | cut -d= -f2-)
DEVICE_MODE=$(grep -E '^DEVICE_MODE=' "$STATE" | tail -1 | cut -d= -f2-)
SRV="$EV/srv"
VERIFY_RELEASE="$VERIFY_RELEASE" node "$HERE/srv.mjs" start "$SRV" 2>&1 | tee -a "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "server did not start"
bash "$HERE/tunnel.sh" up 2>&1 | tee -a "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "tunnel"
LINK_HOST=$(grep -E '^TUNNEL_URL=' "$STATE" | tail -1 | cut -d= -f2-)
t=$SECONDS
VERIFY_RELEASE="$VERIFY_RELEASE" VERIFY_SERVER_PORT="$VERIFY_SERVER_PORT" HBOTS_VERIFY_EVIDENCE="${HBOTS_VERIFY_EVIDENCE:-$S/evidence}" PYTHONDONTWRITEBYTECODE=1 \
  python3 -I "$HERE/drive.py" --apk "$APK" --adb "$ADB_PREFIX" --evidence "$EV" --srv "$SRV" --link-host "$LINK_HOST" ${ONLY:+--only "$ONLY"} 2>&1 | tee -a "$EV/run.log"
drive=${PIPESTATUS[0]}
T_drive=$((SECONDS - t))
total=$(( $(date +%s) - ${VERIFY_T0:-$GOT} )); work=$(( total - QUEUE ))
flows=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['flows_seconds'])" "$EV/drive.json" 2>/dev/null || echo "?")
timing="${total}s total, ${QUEUE}s waiting for a heavy-job slot, ${work}s of work (emulator boot ${T_device}s, setup+drive ${T_drive}s, flows ${flows}s)"
echo "RESULT $([[ $drive -eq 0 ]] && echo PASS || { [[ $drive -eq 2 ]] && echo SETUP-FAIL || echo FAIL; }) in $timing, device $DEVICE_MODE, evidence $EV" | tee -a "$EV/run.log"
exit "$drive"
