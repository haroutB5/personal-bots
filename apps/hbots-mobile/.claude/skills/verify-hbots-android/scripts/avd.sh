#!/usr/bin/env bash
# avd.sh check | ensure: the throwaway AVD this skill drives ($VERIFY_AVD, default FindX9Pro-QA).
#   check   exit 0 when the AVD exists. Read only.
#   ensure  create it when missing: API 36 google_apis x86_64, 1080 x 2355 at 480 dpi (360 x 785 CSS px, DPR 3), 2 GB RAM, no audio.
#           Dark mode is set at boot by device.sh. Exit 2 when the system image or avdmanager is missing.
# It touches only its own AVD folder under $ANDROID_AVD_HOME and never another AVD.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
IMG="system-images;android-36;google_apis;x86_64"
have() { [[ -f "$ANDROID_AVD_HOME/$VERIFY_AVD.ini" && -d "$ANDROID_AVD_HOME/$VERIFY_AVD.avd" ]]; }
case "${1:-}" in
check) have && echo "avd: $VERIFY_AVD exists" || { echo "avd: $VERIFY_AVD is missing (device.sh up creates it)"; exit 1; } ;;
ensure)
  if have; then echo "avd: $VERIFY_AVD exists"; exit 0; fi
  [[ -d "$ANDROID_HOME/system-images/android-36/google_apis/x86_64" ]] || { echo "avd: system image $IMG is not installed under $ANDROID_HOME (sdkmanager \"$IMG\")"; exit 2; }
  command -v avdmanager >/dev/null || { echo "avd: avdmanager not found under $ANDROID_HOME/cmdline-tools/latest/bin"; exit 2; }
  mkdir -p "$ANDROID_AVD_HOME"
  echo no | avdmanager create avd --name "$VERIFY_AVD" --package "$IMG" --device pixel_6 --force >/dev/null 2>&1 || { echo "avd: avdmanager create failed"; exit 2; }
  cfg="$ANDROID_AVD_HOME/$VERIFY_AVD.avd/config.ini"
  [[ -f "$cfg" ]] || { echo "avd: no config.ini after create"; exit 2; }
  setcfg() { if grep -q "^$1=" "$cfg"; then sed -i "s|^$1=.*|$1=$2|" "$cfg"; else echo "$1=$2" >> "$cfg"; fi; }
  setcfg hw.lcd.width 1080; setcfg hw.lcd.height 2355; setcfg hw.lcd.density 480
  setcfg hw.ramSize 2048; setcfg hw.audioInput no; setcfg hw.audioOutput no; setcfg hw.gpu.mode swiftshader_indirect
  setcfg disk.dataPartition.size 4096M; setcfg showDeviceFrame no
  echo "avd: created $VERIFY_AVD (API 36 x86_64, 1080x2355 at 480 dpi)"
  ;;
*) echo "usage: avd.sh check|ensure"; exit 2 ;;
esac
