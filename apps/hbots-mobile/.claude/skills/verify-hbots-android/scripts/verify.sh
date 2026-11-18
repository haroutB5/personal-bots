#!/usr/bin/env bash
# One command: install an x86_64 APK on a throwaway emulator, pair it with a throwaway server, drive the daily-use flows, keep evidence.
# Usage: bash verify.sh <x86_64.apk> [label] [--only 1,2]    Exit 0 = every flow PASS, 1 = a flow FAILED, 2 = setup, device or doctor failed.
# The whole run holds ONE heavy-job slot. The wait for that slot is reported apart from work. The last line is the RESULT line, printed after
# the slot is released and checked.
# Env: HBOTS_VERIFY_DEVICE=laptop skips the rig. HBOTS_VERIFY_EVIDENCE=<dir> puts the evidence folder there.
#      VERIFY_ADB_PORT, VERIFY_EMU_PORT, VERIFY_AVD, VERIFY_SERVER_PORT, VERIFY_RELEASE.
# Every run keeps its own state file, logs and tunnel unit inside its evidence folder, so a second run never stops what a first run started.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
. "$HERE/env.sh"
APK=${1:?usage: verify.sh <x86_64.apk> [label] [--only 1,2]}; LABEL=${2:-run}; ONLY=""
[[ "${3:-}" == --only ]] && ONLY=${4:-}
APK=$(realpath -m "$APK")
if [[ -z "${VERIFY_INNER:-}" ]]; then
  T0=$(date +%s); RUN_ID="r$(date -u +%Y%m%dT%H%M%S)-$$"; INFO="$S/run-$RUN_ID"
  env -u NODE_ENV bash "$HEAVY" --label "hbots verify android" --work-dir "$ROOT" --wait-seconds 10800 -- \
    env VERIFY_INNER=1 VERIFY_T0="$T0" VERIFY_RUN_ID="$RUN_ID" bash "$HERE/verify.sh" "$APK" "$LABEL" ${ONLY:+--only "$ONLY"} &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null' TERM INT
  wait "$child"; rc=$?
  trap - TERM INT
  [[ $rc -gt 128 ]] && wait "$child" 2>/dev/null
  inner=$(grep -E '^PID=' "$INFO.info" 2>/dev/null | cut -d= -f2-); slot=$(grep -E '^SLOT=' "$INFO.info" 2>/dev/null | cut -d= -f2-); ev=$(grep -E '^EV=' "$INFO.info" 2>/dev/null | cut -d= -f2-)
  mine=(); other=()
  if [[ -n "$slot" ]]; then
    for pid in $(lslocks -n -o PID,PATH 2>/dev/null | awk -v s="$slot" '$2 == s {print $1}'); do
      if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "VERIFY_RUN_ID=$RUN_ID"; then mine+=("$pid"); else other+=("$pid"); fi
    done
    line="heavy slot after the run: $(basename "$slot") used by pid ${inner:-?}, now $([[ ${#mine[@]} -eq 0 ]] && echo "released, none of this run's processes holds it" || echo "STILL HELD by this run's pids ${mine[*]}")$([[ ${#other[@]} -gt 0 ]] && echo "; another job (pid ${other[*]}) holds it now, not this run")"
  else
    line="heavy slot after the run: no slot was recorded (the run ended before it started)"
  fi
  echo "$line"; [[ -n "$ev" && -d "$ev" ]] && echo "$line" >> "$ev/run.log"
  [[ ${#mine[@]} -eq 0 ]] || rc=2
  if [[ -s "$INFO.result" ]]; then cat "$INFO.result"; else echo "RESULT SETUP-FAIL (the run ended without a result, exit $rc) in $(( $(date +%s) - T0 ))s total"; [[ $rc -eq 0 ]] && rc=2; fi
  rm -f "$INFO.info" "$INFO.result"
  exit "$rc"
fi
INFO="$S/run-$VERIFY_RUN_ID"
GOT=$(date +%s); QUEUE=$(( GOT - ${VERIFY_T0:-$GOT} ))
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
EV="${HBOTS_VERIFY_EVIDENCE:-$S/evidence}/$LABEL-$STAMP"; mkdir -p "$EV"
export VERIFY_STATE="$EV/state.env" VERIFY_LOGS="$EV" VERIFY_OWNER_PID=$$
STATE="$VERIFY_STATE"; LOGS="$VERIFY_LOGS"; : > "$STATE"
SLOT=$(readlink "/proc/$$/fd/9" 2>/dev/null)
printf 'PID=%s\nSLOT=%s\nEV=%s\n' "$$" "$SLOT" "$EV" > "$INFO.info"
cleanup() {
  bash "$HERE/cleanup.sh" "$EV" 2>&1 | tee -a "$EV/run.log"
  echo "heavy slot held during the run: $(lslocks -n -o PID,PATH -p $$ 2>/dev/null | awk '{print $2}' | xargs -r -n1 basename | paste -sd' ') by pid $$ (this run), freed when it exits" | tee -a "$EV/run.log"
}
trap cleanup EXIT
fail() {
  local total=$(( $(date +%s) - ${VERIFY_T0:-$GOT} ))
  local line="RESULT SETUP-FAIL ($2) in ${total}s total, ${QUEUE}s waiting for a heavy-job slot, evidence $EV"
  echo "$line" >> "$EV/run.log"; echo "$line" > "$INFO.result"
  exit "$1"
}
{
  echo "verify-hbots-android $(git -C "$ROOT" rev-parse --short=12 HEAD) $(date -u +%FT%TZ) label $LABEL, run $VERIFY_RUN_ID, queue wait ${QUEUE}s"
  bash "$HERE/doctor.sh" --pre "$APK"
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
line="RESULT $([[ $drive -eq 0 ]] && echo PASS || { [[ $drive -eq 2 ]] && echo SETUP-FAIL || echo FAIL; }) in $timing, device $DEVICE_MODE, evidence $EV"
echo "$line" >> "$EV/run.log"; echo "$line" > "$INFO.result"
exit "$drive"
