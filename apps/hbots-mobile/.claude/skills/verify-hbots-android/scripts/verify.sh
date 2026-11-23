#!/usr/bin/env bash
# One command: install an x86_64 APK on a throwaway emulator, pair it with a throwaway server, drive the daily-use flows, keep evidence.
# Usage: bash verify.sh <x86_64.apk> [label] [--only 1,2 | --tier blocking|async --base <live release sha>]    Exit 0 = every flow PASS, 1 = a flow FAILED, 2 = setup, device, link or doctor failed.
# The last line is ALWAYS a RESULT line (PASS, FAIL or SETUP-FAIL), also after a refusal or a usage error.
# Laptop route (default): the whole run holds ONE heavy-job slot. The wait for that slot is reported apart from work.
# Rig route (HBOTS_VERIFY_DEVICE=rig): no heavy-job slot, because the emulator runs on the gaming PC. A rig that is not free is exit 2.
# Env: HBOTS_VERIFY_DEVICE=laptop|rig (default laptop). HBOTS_VERIFY_EVIDENCE=<dir> puts the evidence folder there.
#      VERIFY_ADB_PORT, VERIFY_EMU_PORT, VERIFY_AVD, VERIFY_SERVER_PORT, VERIFY_RELEASE.
# Every run keeps its own state file, logs and tunnel unit inside its evidence folder, so a second run never stops what a first run started.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VERIFY_WHY=""; RESULT_DONE=0; T_START=$(date +%s)
ENV_HOLD=""
# The doctor refuses a checkout with a .env (the throwaway QA server must not read live secrets),
# but a release slot keeps one for the gates. The outer run parks every .env* file the doctor
# looks for in a private folder beside the checkout and puts it back on exit: on success, on a
# failure and on TERM or INT. A hold left by a killed run is restored first; if the checkout has
# a .env again as well, the run refuses rather than overwrite either copy.
env_files() { find "$1" -maxdepth 1 -name ".env*" ! -name "*.example" ! -name "*.sample" ! -name "*.template" 2>/dev/null; }
env_restore() {
  [[ -n "$ENV_HOLD" && -d "$ENV_HOLD" ]] || return 0
  local f ok=1
  for f in "$ENV_HOLD"/.env*; do
    [[ -e "$f" ]] || continue
    if [[ -e "$ENV_ROOT/$(basename "$f")" ]]; then ok=0; echo "verify: NOT restoring $(basename "$f"): the checkout has one again; the parked copy stays in $ENV_HOLD" >&2
    else mv -n "$f" "$ENV_ROOT/" || ok=0; fi
  done
  [[ $ok -eq 1 ]] && rmdir "$ENV_HOLD" 2>/dev/null && echo "verify: .env restored to the checkout" >&2
  ENV_HOLD=""
}
if [[ -z "${VERIFY_INNER:-}" ]]; then
  # A refusal (env.sh exit 2), a usage error or any early stop still ends with a RESULT line.
  trap 'rc=$?; env_restore; [[ $RESULT_DONE -eq 1 ]] || echo "RESULT SETUP-FAIL (${VERIFY_WHY:-the script stopped early, exit $rc, see the lines above}) in $(( $(date +%s) - T_START ))s total"' EXIT
  trap 'exit 143' TERM; trap 'exit 130' INT
  ENV_ROOT=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null) || ENV_ROOT=""
  if [[ -n "$ENV_ROOT" ]]; then
    hold="$(dirname "$ENV_ROOT")/.$(basename "$ENV_ROOT").verify-env-hold"
    if [[ -d "$hold" ]]; then
      [[ -z "$(env_files "$ENV_ROOT")" ]] || { VERIFY_WHY="both the checkout and $hold have a .env; restore one by hand"; echo "verify: $VERIFY_WHY"; exit 2; }
      ENV_HOLD=$hold; env_restore
      [[ -d "$hold" ]] && { VERIFY_WHY="could not restore the .env left in $hold"; echo "verify: $VERIFY_WHY"; exit 2; }
    fi
    moved=$(env_files "$ENV_ROOT")
    if [[ -n "$moved" ]]; then
      mkdir -m 700 "$hold" || { VERIFY_WHY="cannot make $hold"; echo "verify: $VERIFY_WHY"; exit 2; }
      ENV_HOLD=$hold
      while IFS= read -r f; do mv -n "$f" "$hold/" || { VERIFY_WHY="cannot park $f"; echo "verify: $VERIFY_WHY"; exit 2; }; done <<< "$moved"
      echo "verify: parked $(wc -l <<< "$moved") .env file(s) beside the checkout for the run; they are put back on exit" >&2
    fi
  fi
fi
# shellcheck disable=SC1091
. "$HERE/env.sh"
APK=${1:-}
[[ -n "$APK" ]] || { VERIFY_WHY="usage: verify.sh <x86_64.apk> [label] [--only 1,2 | --tier blocking|async --base <live release sha>]"; echo "$VERIFY_WHY"; exit 2; }
LABEL=${2:-run}; ONLY=""; TIER=""; BASE=""
shift $(( $# < 2 ? $# : 2 ))
while (( $# )); do
  case "$1" in
    --only) ONLY=${2:-}; shift 2 || shift ;;
    --tier) TIER=${2:-}; shift 2 || shift ;;
    --base) BASE=${2:-}; shift 2 || shift ;;
    *) VERIFY_WHY="unknown argument '$1' (usage: verify.sh <apk> [label] [--only 1,2 | --tier blocking|async --base <live release sha>])"; echo "verify: $VERIFY_WHY"; exit 2 ;;
  esac
done
APK=$(realpath -m "$APK")
ROUTE=${HBOTS_VERIFY_DEVICE:-laptop}
case "$ROUTE" in laptop|rig) ;; *) VERIFY_WHY="HBOTS_VERIFY_DEVICE must be laptop (default) or rig, got '$ROUTE'"; echo "verify: $VERIFY_WHY"; exit 2 ;; esac
if [[ -z "${VERIFY_INNER:-}" ]]; then
  T0=$(date +%s); RUN_ID="r$(date -u +%Y%m%dT%H%M%S)-$$"; INFO="$S/run-$RUN_ID"
  # --tier: the flows this release's diff (live release..HEAD) puts before the release (blocking)
  # or after live (async), from select-flows.mjs. Every flow runs in one tier or the other.
  if [[ -n "$TIER" ]]; then
    [[ -z "$ONLY" ]] || { VERIFY_WHY="--tier and --only exclude each other"; echo "verify: $VERIFY_WHY"; exit 2; }
    [[ "$TIER" == blocking || "$TIER" == async ]] || { VERIFY_WHY="--tier must be blocking or async, got '$TIER'"; echo "verify: $VERIFY_WHY"; exit 2; }
    [[ -n "$BASE" ]] || { VERIFY_WHY="--tier needs --base <live release sha>"; echo "verify: $VERIFY_WHY"; exit 2; }
    sel=$(node "$HERE/select-flows.mjs" --repo "$ROOT" --base "$BASE" --head HEAD) || { VERIFY_WHY="select-flows.mjs failed for base $BASE"; echo "verify: $VERIFY_WHY"; exit 2; }
    ONLY=$(node "$HERE/select-flows.mjs" --repo "$ROOT" --base "$BASE" --head HEAD --list "$TIER") || { VERIFY_WHY="select-flows.mjs failed for base $BASE"; echo "verify: $VERIFY_WHY"; exit 2; }
    echo "$sel"
    export VERIFY_SELECTION="tier $TIER, base ${BASE:0:12}: flows ${ONLY:-none}"
    if [[ -z "$ONLY" ]]; then
      RESULT_DONE=1; echo "RESULT PASS (no flows in the $TIER tier) in $(( $(date +%s) - T0 ))s total, 0s waiting for a heavy-job slot, 0s of work"; exit 0
    fi
  fi
  runner=()
  # Gradle and the emulator share the one exclusive Android lane (Harout's guard 4).
  [[ "$ROUTE" == laptop ]] && runner=(env -u NODE_ENV bash "$HEAVY" --lane android --label "hbots verify android" --work-dir "$ROOT" --wait-seconds 10800 --)
  "${runner[@]}" env VERIFY_INNER=1 VERIFY_T0="$T0" VERIFY_RUN_ID="$RUN_ID" bash "$HERE/verify.sh" "$APK" "$LABEL" ${ONLY:+--only "$ONLY"} &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null' TERM INT
  wait "$child"; rc=$?
  trap 'exit 143' TERM; trap 'exit 130' INT
  [[ $rc -gt 128 ]] && wait "$child" 2>/dev/null
  inner=$(grep -E '^PID=' "$INFO.info" 2>/dev/null | cut -d= -f2-); slot=$(grep -E '^SLOT=' "$INFO.info" 2>/dev/null | cut -d= -f2-); ev=$(grep -E '^EV=' "$INFO.info" 2>/dev/null | cut -d= -f2-)
  mine=(); other=()
  for pid in $(lslocks -n -o PID,PATH 2>/dev/null | awk '$2 ~ /omarchy-heavy/ {print $1}' | sort -u); do
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "VERIFY_RUN_ID=$RUN_ID" && mine+=("$pid")
  done
  if [[ -n "$slot" ]]; then
    for pid in $(lslocks -n -o PID,PATH 2>/dev/null | awk -v s="$slot" '$2 == s {print $1}' | sort -u); do
      [[ " ${mine[*]:-} " == *" $pid "* ]] || other+=("$pid")
    done
  fi
  if [[ "$ROUTE" == rig ]]; then
    line="heavy slot after the run: none taken (rig route needs no slot), $([[ ${#mine[@]} -eq 0 ]] && echo "none of this run's processes holds a heavy lock" || echo "A HEAVY LOCK IS HELD by this run's pids ${mine[*]}")"
  elif [[ -n "$slot" ]]; then
    line="heavy slot after the run: $(basename "$slot") used by pid ${inner:-?}, now $([[ ${#mine[@]} -eq 0 ]] && echo "released, none of this run's processes holds it" || echo "STILL HELD by this run's pids ${mine[*]}")$([[ ${#other[@]} -gt 0 ]] && echo "; another job (pid ${other[*]}) holds it now, not this run")"
  else
    line="heavy slot after the run: no slot was recorded (the run ended before it started)"
  fi
  echo "$line"; [[ -n "$ev" && -d "$ev" ]] && echo "$line" >> "$ev/run.log"
  [[ ${#mine[@]} -eq 0 ]] || rc=2
  if [[ -s "$INFO.result" ]]; then cat "$INFO.result"; else echo "RESULT SETUP-FAIL (the run ended without a result, exit $rc) in $(( $(date +%s) - T0 ))s total"; [[ $rc -eq 0 ]] && rc=2; fi
  RESULT_DONE=1
  rm -f "$INFO.info" "$INFO.result"
  exit "$rc"
fi
INFO="$S/run-$VERIFY_RUN_ID"
GOT=$(date +%s); QUEUE=$(( GOT - ${VERIFY_T0:-$GOT} ))
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
EV="${HBOTS_VERIFY_EVIDENCE:-$S/evidence}/$LABEL-$STAMP"; mkdir -p "$EV"
export VERIFY_STATE="$EV/state.env" VERIFY_LOGS="$EV" VERIFY_OWNER_PID=$$
STATE="$VERIFY_STATE"; LOGS="$VERIFY_LOGS"; : > "$STATE"
SLOT=""; [[ "$ROUTE" == laptop ]] && SLOT=$(readlink "/proc/$$/fd/9" 2>/dev/null)
printf 'PID=%s\nSLOT=%s\nEV=%s\n' "$$" "$SLOT" "$EV" > "$INFO.info"
cleanup() {
  bash "$HERE/cleanup.sh" "$EV" 2>&1 | tee -a "$EV/run.log"
  if [[ -n "$SLOT" ]]; then echo "heavy slot held during the run: $(basename "$SLOT") by pid $$ (this run), freed when it exits" | tee -a "$EV/run.log"
  else echo "heavy slot held during the run: none (rig route needs no slot)" | tee -a "$EV/run.log"; fi
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
  [[ -n "${VERIFY_SELECTION:-}" ]] && echo "selection: $VERIFY_SELECTION"
  bash "$HERE/doctor.sh" --pre "$APK"
} 2>&1 | tee "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "doctor: $(grep -m1 '^doctor: FAIL' "$EV/run.log" | sed 's/^doctor: FAIL //' | cut -c1-160)"
t=$SECONDS
{ bash "$HERE/device.sh" up; } 2>&1 | tee -a "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "$(grep -E '^(device|avd):' "$EV/run.log" | tail -1 | cut -c1-180)"
T_device=$((SECONDS - t))
ADB_PREFIX=$(grep -E '^ADB_PREFIX=' "$STATE" | tail -1 | cut -d= -f2-)
DEVICE_MODE=$(grep -E '^DEVICE_MODE=' "$STATE" | tail -1 | cut -d= -f2-)
SRV="$EV/srv"
VERIFY_RELEASE="$VERIFY_RELEASE" node "$HERE/srv.mjs" start "$SRV" 2>&1 | tee -a "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "server did not start"
bash "$HERE/tunnel.sh" up 2>&1 | tee -a "$EV/run.log"
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail 2 "$(grep -E '^tunnel:' "$EV/run.log" | tail -1 | cut -c1-180)"
LINK_HOST=$(grep -E '^TUNNEL_URL=' "$STATE" | tail -1 | cut -d= -f2-)
t=$SECONDS
VERIFY_RELEASE="$VERIFY_RELEASE" VERIFY_SERVER_PORT="$VERIFY_SERVER_PORT" HBOTS_VERIFY_EVIDENCE="${HBOTS_VERIFY_EVIDENCE:-$S/evidence}" PYTHONDONTWRITEBYTECODE=1 VERIFY_STDOUT_TEED=1 \
  python3 -I "$HERE/drive.py" --apk "$APK" --adb "$ADB_PREFIX" --evidence "$EV" --srv "$SRV" --link-host "$LINK_HOST" --tunnel-unit "$(grep -E '^TUNNEL_UNIT=' "$STATE" | tail -1 | cut -d= -f2-)" --tunnel-log "$EV/tunnel.log" ${ONLY:+--only "$ONLY"} ${VERIFY_PROBE:+--probe "$VERIFY_PROBE"} 2>&1 | tee -a "$EV/run.log"
drive=${PIPESTATUS[0]}
T_drive=$((SECONDS - t))
total=$(( $(date +%s) - ${VERIFY_T0:-$GOT} )); work=$(( total - QUEUE ))
flows=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['flows_seconds'])" "$EV/drive.json" 2>/dev/null || echo "?")
[[ -n "${VERIFY_PROBE:-}" ]] && flows_txt="probe ${VERIFY_PROBE} ${flows}s, no flows judged" || flows_txt="flows ${flows}s"
timing="${total}s total, ${QUEUE}s waiting for a heavy-job slot, ${work}s of work (emulator boot ${T_device}s, setup+drive ${T_drive}s, ${flows_txt})"
why=""; [[ $drive -eq 2 ]] && why=" ($(cat "$EV/setup-reason.txt" 2>/dev/null | head -1 | cut -c1-260 || true))"
line="RESULT $([[ $drive -eq 0 ]] && echo PASS || { [[ $drive -eq 2 ]] && echo SETUP-FAIL || echo FAIL; })$why in $timing, device $DEVICE_MODE, evidence $EV"
echo "$line" >> "$EV/run.log"; echo "$line" > "$INFO.result"
exit "$drive"
