#!/usr/bin/env bash
# device.sh up | down | adb <args>: the emulator this skill drives.
#   up    gaming PC rig first when HBOTS_VERIFY_DEVICE is auto (default) and rig.sh free says yes, else a laptop emulator
#         on our own adb server and ports. The laptop emulator runs only inside a heavy-job slot (verify.sh holds one).
#   down  stops exactly what up started, by recorded pid or rig.sh down. Never by name.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
touch "$STATE"
get() { grep -E "^$1=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { { grep -vE "^$1=" "$STATE" 2>/dev/null; echo "$1=$2"; } > "$STATE.new"; mv "$STATE.new" "$STATE"; }
ADBP=$(get ADB_PREFIX)
cmd=${1:-}; shift || true
case "$cmd" in
adb) exec $ADBP "$@" ;;
up)
  [[ -z "$(get DEVICE_MODE)" ]] || { echo "device: an earlier run is not cleaned up (state.env). Run scripts/cleanup.sh first."; exit 2; }
  mode=laptop; reason="HBOTS_VERIFY_DEVICE=laptop"
  if [[ "${HBOTS_VERIFY_DEVICE:-auto}" != laptop ]]; then
    reason=$(bash "$RIG" free 2>&1); rc=$?
    if [[ $rc -eq 0 ]]; then
      if RIG_WHO="Verifier: verify-hbots-android" bash "$RIG" up FindX9Pro-Rig --max-minutes 25 --owner $$ >"$S/logs/rig-up.log" 2>&1; then mode=rig; reason="rig free"
      else reason="rig up failed (logs/rig-up.log)"; fi
    else reason="rig refused (exit $rc): $reason"; fi
  fi
  echo "device: mode=$mode ($reason)"
  put DEVICE_REASON "$(printf '%s' "$reason" | tr '\n=' '  ' | cut -c1-200)"
  if [[ $mode == rig ]]; then
    put DEVICE_MODE rig; put ADB_PREFIX "adb -P 5091 -s emulator-5592"
  else
    for p in "$VERIFY_ADB_PORT" "$VERIFY_EMU_PORT" $((VERIFY_EMU_PORT + 1)); do
      ss -ltn 2>/dev/null | grep -q "[:.]$p " && { echo "device: port $p is taken, set VERIFY_ADB_PORT / VERIFY_EMU_PORT"; exit 2; }
    done
    kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
    [[ $kb -ge 3145728 ]] || { echo "device: only $((kb / 1024)) MB free, an emulator needs about 3 GB. Stop something or wait."; exit 2; }
    export ANDROID_ADB_SERVER_PORT=$VERIFY_ADB_PORT
    setsid nohup emulator -avd "$VERIFY_AVD" -port "$VERIFY_EMU_PORT" -read-only -no-snapshot -no-window -no-audio -no-boot-anim \
      -gpu swiftshader_indirect -memory 2048 -accel on > "$S/logs/emulator.log" 2>&1 < /dev/null &
    put DEVICE_MODE laptop; put EMU_PID "$!"; put ADB_PREFIX "adb -P $VERIFY_ADB_PORT -s emulator-$VERIFY_EMU_PORT"
  fi
  ADBP=$(get ADB_PREFIX)
  t0=$SECONDS
  $ADBP wait-for-device
  until [[ "$($ADBP shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
    [[ $((SECONDS - t0)) -lt 240 ]] || { echo "device: no boot in 240 s (see logs/emulator.log)"; exit 2; }
    sleep 2
  done
  $ADBP shell wm size 1080x2355 >/dev/null; $ADBP shell wm density 480 >/dev/null
  $ADBP shell cmd uimode night yes >/dev/null 2>&1
  for k in window_animation_scale transition_animation_scale animator_duration_scale; do $ADBP shell settings put global $k 0; done
  $ADBP shell settings put system font_scale 1.0
  $ADBP shell input keyevent KEYCODE_WAKEUP; $ADBP shell wm dismiss-keyguard >/dev/null 2>&1
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
