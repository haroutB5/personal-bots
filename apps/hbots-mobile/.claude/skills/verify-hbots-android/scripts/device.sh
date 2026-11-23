#!/usr/bin/env bash
# device.sh up | down | adb <args>: the emulator this skill drives.
#   up    the laptop emulator on our own adb server and ports (default). HBOTS_VERIFY_DEVICE=rig asks for the gaming PC rig instead:
#         rig.sh free, then up. A rig that is not free is a setup failure (exit 2), never a silent fall back to the laptop.
#         The laptop emulator runs only inside a heavy-job slot (verify.sh holds one). The rig route holds none.
#         The rig session is owned by VERIFY_OWNER_PID (verify.sh's own pid, alive until its cleanup ends). Without it
#         there is no owner and the 25 minute lease plus device.sh down end the session.
#   down  stops exactly what up started, by recorded pid or rig.sh down. Never by name.
#   snapshot  (laptop only, Faster releases step 7) boots the AVD once, writable, applies the QA presets (dark, 360x785
#         at DPR 3, animations off, font 1.0, airplane off) and saves quick-boot snapshot hbots-qa-base. `up` then loads it
#         with -no-snapshot-save -read-only (Harout's guard 3: the snapshot stays pristine) instead of a cold boot. A stamp
#         next to it holds SNAP_VERSION and the system image build; a mismatch means a cold boot until snapshot runs again.
#         HBOTS_VERIFY_SNAPSHOT=off forces the cold boot. App permissions are not in it: drive.py reinstalls the app
#         each run, runs pm clear, then grants them.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
touch "$STATE"
get() { grep -E "^$1=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { { grep -vE "^$1=" "$STATE" 2>/dev/null; echo "$1=$2"; } > "$STATE.new"; mv "$STATE.new" "$STATE"; }
ADBP=$(get ADB_PREFIX)
# The PC's sshd answers "Exceeded MaxStartups" to a share of new connections (5 of 14 measured, 18 Nov). rig.sh shows that as "PC unreachable"
# (exit 2) when its check is refused, or as "rig session ended early" with an empty log when the session link is refused (inferred). Only those two
# answers are retried, up to 5 attempts 4 s apart. Any other answer (busy, yielded to a game, not free) stands.
rig_try() {
  local out rc n
  for n in 1 2 3 4 5; do
    out=$(bash "$RIG" "$@" 2>&1); rc=$?
    if [[ $rc -ne 0 && ( "$out" == *"PC unreachable"* || "$out" == *"rig session ended early"* ) && $n -lt 5 ]]; then sleep 4; continue; fi
    break
  done
  printf '%s\n' "$out"; return $rc
}
SNAP=hbots-qa-base
SNAP_VERSION=1   # bump when the presets below change, so old snapshots are not loaded
SNAP_STAMP="$ANDROID_AVD_HOME/$VERIFY_AVD.avd/$SNAP.hbots-stamp"
IMG_DIR="$ANDROID_HOME/system-images/android-36/google_apis/x86_64"
image_build() { printf '%s/r%s' "$(sed -n 's/^ro.system.build.fingerprint=//p' "$IMG_DIR/build.prop" 2>/dev/null | head -1)" "$(sed -n 's/^Pkg.Revision=//p' "$IMG_DIR/source.properties" 2>/dev/null | head -1)"; }
snap_want() { printf 'version=%s image=%s\n' "$SNAP_VERSION" "$(image_build)"; }
snap_ok() {
  [[ ${HBOTS_VERIFY_SNAPSHOT:-on} != off && -f "$SNAP_STAMP" && -d "$ANDROID_AVD_HOME/$VERIFY_AVD.avd/snapshots/$SNAP" ]] &&
    [[ "$(cat "$SNAP_STAMP")" == "$(snap_want)" ]]
}
wait_boot() {
  local t0=$SECONDS
  timeout 120 $ADBP wait-for-device || { echo "device: adb did not see the emulator in 120 s (see emulator.log)"; exit 2; }
  until [[ "$($ADBP shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
    [[ $((SECONDS - t0)) -lt 240 ]] || { echo "device: no boot in 240 s (see emulator.log)"; exit 2; }
    sleep 1
  done
}
# The QA presets. Applied before the snapshot is saved and again after every boot (cheap and idempotent).
presets() {
  $ADBP shell wm size 1080x2355 >/dev/null; $ADBP shell wm density 480 >/dev/null
  $ADBP shell cmd uimode night yes >/dev/null 2>&1
  for k in window_animation_scale transition_animation_scale animator_duration_scale; do $ADBP shell settings put global $k 0; done
  $ADBP shell settings put system font_scale 1.0
  $ADBP shell input keyevent KEYCODE_WAKEUP; $ADBP shell wm dismiss-keyguard >/dev/null 2>&1
}
cmd=${1:-}; shift || true
case "$cmd" in
adb) exec $ADBP "$@" ;;
snapshot)
  [[ -z "$(get DEVICE_MODE)" ]] || { echo "device: an emulator from this state file is up; run device.sh down first"; exit 2; }
  for p in "$VERIFY_ADB_PORT" "$VERIFY_EMU_PORT" $((VERIFY_EMU_PORT + 1)); do
    ss -ltn 2>/dev/null | grep -q "[:.]$p " && { echo "device: port $p is taken"; exit 2; }
  done
  bash "$(dirname "${BASH_SOURCE[0]}")/avd.sh" ensure || exit 2
  export ANDROID_ADB_SERVER_PORT=$VERIFY_ADB_PORT
  ADBP="adb -P $VERIFY_ADB_PORT -s emulator-$VERIFY_EMU_PORT"
  rm -f "$SNAP_STAMP"
  t0=$SECONDS
  setsid nohup emulator -avd "$VERIFY_AVD" -port "$VERIFY_EMU_PORT" -no-snapshot-load -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -memory 2048 -accel on > "$LOGS/emulator-snapshot.log" 2>&1 < /dev/null &
  epid=$!
  stop_snap() { $ADBP emu kill >/dev/null 2>&1; for _ in $(seq 1 30); do kill -0 "$epid" 2>/dev/null || break; sleep 1; done
    kill -0 "$epid" 2>/dev/null && kill "$epid" 2>/dev/null; adb -P "$VERIFY_ADB_PORT" kill-server >/dev/null 2>&1; }
  trap stop_snap EXIT
  wait_boot
  presets
  if [[ "$($ADBP shell settings get global airplane_mode_on | tr -d '\r')" != 0 ]]; then
    $ADBP shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || $ADBP shell settings put global airplane_mode_on 0
  fi
  sleep 20   # let the first-boot jobs settle, so the snapshot is not taken mid-dexopt
  $ADBP emu avd snapshot save "$SNAP" | tr -d '\r' | grep -q OK || { echo "device: snapshot save failed"; exit 2; }
  snap_want > "$SNAP_STAMP"
  echo "device: saved snapshot $SNAP of $VERIFY_AVD in $((SECONDS - t0)) s ($(snap_want | tr -d '\n'))"
  ;;
up)
  [[ -z "$(get DEVICE_MODE)" ]] || { echo "device: an earlier run is not cleaned up (state.env). Run scripts/cleanup.sh first."; exit 2; }
  mode=laptop; reason="default device"
  case "${HBOTS_VERIFY_DEVICE:-laptop}" in
  laptop) ;;
  rig)
    owner=(); [[ -n "${VERIFY_OWNER_PID:-}" ]] && owner=(--owner "$VERIFY_OWNER_PID")
    reason=$(rig_try free); rc=$?
    [[ $rc -eq 0 ]] || { echo "device: HBOTS_VERIFY_DEVICE=rig but the rig refused (exit $rc): $reason"; exit 2; }
    RIG_WHO="${RIG_WHO:-Builder 2: verify-hbots-android}" rig_try up FindX9Pro-Rig --max-minutes 25 "${owner[@]}" >"$LOGS/rig-up.log" 2>&1 \
      || { echo "device: HBOTS_VERIFY_DEVICE=rig but rig up failed (rig-up.log)"; exit 2; }
    mode=rig; reason="rig free" ;;
  *) echo "device: HBOTS_VERIFY_DEVICE must be laptop (default) or rig, got '${HBOTS_VERIFY_DEVICE}'"; exit 2 ;;
  esac
  echo "device: mode=$mode ($reason)"
  put DEVICE_REASON "$(printf '%s' "$reason" | tr '\n=' '  ' | cut -c1-200)"
  if [[ $mode == rig ]]; then
    put DEVICE_MODE rig; put ADB_PREFIX "adb -P 5091 -s emulator-5592"
  else
    for p in "$VERIFY_ADB_PORT" "$VERIFY_EMU_PORT" $((VERIFY_EMU_PORT + 1)); do
      ss -ltn 2>/dev/null | grep -q "[:.]$p " && { echo "device: port $p is taken, set VERIFY_ADB_PORT / VERIFY_EMU_PORT"; exit 2; }
    done
    bash "$(dirname "${BASH_SOURCE[0]}")/avd.sh" ensure || { echo "device: no AVD $VERIFY_AVD and it could not be created"; exit 2; }
    kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
    [[ $kb -ge 3145728 ]] || { echo "device: only $((kb / 1024)) MB free, an emulator needs about 3 GB. Stop something or wait."; exit 2; }
    export ANDROID_ADB_SERVER_PORT=$VERIFY_ADB_PORT
    if snap_ok; then boot=(-snapshot "$SNAP" -no-snapshot-save); echo "device: quick boot from snapshot $SNAP"
    else boot=(-no-snapshot); echo "device: cold boot (no current snapshot $SNAP; device.sh snapshot makes one)"; fi
    setsid nohup emulator -avd "$VERIFY_AVD" -port "$VERIFY_EMU_PORT" -read-only "${boot[@]}" -no-window -no-audio -no-boot-anim \
      -gpu swiftshader_indirect -memory 2048 -accel on > "$LOGS/emulator.log" 2>&1 < /dev/null &
    put DEVICE_MODE laptop; put EMU_PID "$!"; put ADB_PREFIX "adb -P $VERIFY_ADB_PORT -s emulator-$VERIFY_EMU_PORT"
  fi
  ADBP=$(get ADB_PREFIX)
  t0=$SECONDS
  # An emulator that dies before adb sees it must not hang the run until the heavy-job limit: wait for the device at most 120 s.
  wait_boot
  presets
  # The rig emulator came up with airplane mode on and, after the size change, a "System UI isn't responding" box (18 Nov). Network on, box dismissed.
  if [[ "$($ADBP shell settings get global airplane_mode_on | tr -d '\r')" != 0 ]]; then
    $ADBP shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || { $ADBP shell settings put global airplane_mode_on 0; $ADBP shell am broadcast -a android.intent.action.AIRPLANE_MODE >/dev/null 2>&1; }
    echo "device: airplane mode was on, turned off"
  fi
  for _ in $(seq 1 20); do
    xml=$($ADBP exec-out "uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml" 2>/dev/null)
    grep -q "isn't responding" <<< "$xml" || break
    echo "device: dismissing an ANR box"
    b=$(grep -o 'text="Wait"[^>]*bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' <<< "$xml" | grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]' | head -1)
    if [[ -n "$b" ]]; then IFS=',][' read -r _ l t _ r bt _ <<< "$b"; $ADBP shell input tap $(( (l + r) / 2 )) $(( (t + bt) / 2 )); fi
    sleep 3
  done
  echo "device: booted in $((SECONDS - t0)) s, $($ADBP shell getprop ro.build.version.sdk | tr -d '\r') sdk, $($ADBP shell wm size | tr -d '\r' | tail -1), $($ADBP shell wm density | tr -d '\r' | tail -1)"
  ;;
down)
  mode=$(get DEVICE_MODE)
  if [[ $mode == rig ]]; then bash "$RIG" down 2>&1 | tail -2
  elif [[ $mode == laptop ]]; then
    epid=$(get EMU_PID)
    $ADBP emu kill >/dev/null 2>&1
    for _ in $(seq 1 20); do kill -0 "$epid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$epid" 2>/dev/null; then kill "$epid" 2>/dev/null; sleep 2; fi
    kill -0 "$epid" 2>/dev/null && { echo "device: emulator pid $epid still alive"; exit 1; }
    ANDROID_ADB_SERVER_PORT=$VERIFY_ADB_PORT adb kill-server >/dev/null 2>&1
    echo "device: emulator pid $epid stopped, adb server $VERIFY_ADB_PORT stopped"
  fi
  sed -i '/^DEVICE_MODE=/d;/^EMU_PID=/d;/^ADB_PREFIX=/d;/^DEVICE_REASON=/d' "$STATE"
  ;;
*) echo "usage: device.sh up|down|adb ..."; exit 2 ;;
esac
