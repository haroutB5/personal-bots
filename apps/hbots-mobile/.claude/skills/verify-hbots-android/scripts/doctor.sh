#!/usr/bin/env bash
# doctor.sh --pre <apk>: before booting anything. doctor.sh: with the emulator up. Read only. Exit 0 = worth driving.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
. "$HERE/env.sh"
bad=0; ok() { echo "doctor: ok   $*"; }; no() { echo "doctor: FAIL $*"; bad=1; }
armed=$(systemctl --user list-units 'hbots-release-run*' --no-legend --plain 2>/dev/null | grep -v '9\.9\.1' | grep -c .)
[[ "$armed" -eq 0 ]] && ok "no release armed" || no "a real hbots release is armed, wait for its landing notice"
[[ "$VERIFY_SERVER_PORT" != 38472 ]] && ok "server port $VERIFY_SERVER_PORT is not the live 38472" || no "server port is the live one"
ss -ltn | grep -q ":$VERIFY_SERVER_PORT " && no "port $VERIFY_SERVER_PORT already has a listener" || ok "port $VERIFY_SERVER_PORT free"
for t in "checkout $ROOT" "skill scratch $S" "evidence ${HBOTS_VERIFY_EVIDENCE:-$S/evidence}" "temp ${TMPDIR:-/tmp}" "run state $STATE"; do
  under_live_dev "${t#* }" && no "${t%% *} folder ${t#* } is inside ~/.personal-bots/dev, the live hbots" || ok "${t%% *} folder is not inside ~/.personal-bots/dev"
done
other=$(systemctl --user list-units 'pstack-hbots-verify-tunnel-*' --no-legend --plain 2>/dev/null | awk '{print $1}' | paste -sd' ')
[[ -z "$other" ]] || echo "doctor: info another run's tunnel is active and stays untouched: $other"
bin=/home/harout/.personal-bots/releases/$VERIFY_RELEASE/dist/bin.mjs
[[ -f "$bin" ]] && ok "server binary $VERIFY_RELEASE (read only)" || no "no server binary at $bin"
ver=$(cat "$ROOT/scripts/personal/app-version.txt" 2>/dev/null)
echo "doctor: info checkout version $ver at $(git -C "$ROOT" rev-parse --short=12 HEAD)"
[[ -f "$ROOT/scripts/personal/testing/fake-claude/cli.js" ]] && grep -q LATEQ "$ROOT/scripts/personal/testing/fake-claude/cli.js" && ok "fake claude has LATEQ" || no "fake claude lacks LATEQ (this checkout predates the skill)"
case "${HBOTS_VERIFY_DEVICE:-laptop}" in
laptop)
  if bash "$HERE/avd.sh" check >/dev/null 2>&1; then ok "AVD $VERIFY_AVD exists"
  elif [[ -d "$ANDROID_HOME/system-images/android-36/google_apis/x86_64" ]] && command -v avdmanager >/dev/null; then echo "doctor: info AVD $VERIFY_AVD is missing, device.sh up creates it (API 36, 1080x2355 at 480 dpi)"
  else no "AVD $VERIFY_AVD is missing and the API 36 x86_64 system image or avdmanager is not installed under $ANDROID_HOME"; fi ;;
rig) ok "device route: gaming PC rig (opt in, no heavy-job slot)" ;;
*) no "HBOTS_VERIFY_DEVICE must be laptop (default) or rig, got '${HBOTS_VERIFY_DEVICE}'" ;;
esac
for t in adb emulator python3 node; do command -v "$t" >/dev/null && ok "$t" || no "$t missing"; done
[[ -n "$(find "$ROOT" -maxdepth 1 -name ".env*" ! -name "*.example" ! -name "*.sample" ! -name "*.template" 2>/dev/null)" ]] && no ".env file in the checkout" || ok "no .env in the checkout"
if [[ "${1:-}" == --pre ]]; then
  apk=${2:-}
  [[ -f "$apk" ]] || no "no apk at '$apk'"
  if [[ -f "$apk" ]]; then
    abis=$(unzip -Z1 "$apk" | sed -n 's|^lib/\([^/]*\)/.*|\1|p' | sort -u | paste -sd,)
    [[ "$abis" == *x86_64* ]] && ok "apk has x86_64 libs ($abis)" || no "apk is not x86_64 ($abis): build one with scripts/build-apk.sh"
    apksigner=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)
    certs=$("$apksigner" verify --print-certs "$apk" 2>/dev/null)
    release_sha=$(tr -d '[:space:]' < "$ROOT/apps/hbots-mobile/release-cert.sha256")
    if ! grep -q "SHA-256 digest: " <<< "$certs"; then no "apksigner printed no signer for the apk, cannot tell whose key it is"
    elif [[ -z "$release_sha" ]]; then no "release-cert.sha256 is empty, cannot check the signer"
    elif grep -q "SHA-256 digest: $release_sha" <<< "$certs"; then no "apk is signed with the RELEASE key, use a throwaway build"
    else ok "apk is signed by a throwaway key, not the release key"; fi
  fi
  for p in "$VERIFY_ADB_PORT" "$VERIFY_EMU_PORT" $((VERIFY_EMU_PORT + 1)); do
    ss -ltn | grep -q ":$p " && no "port $p already has a listener, a run or an emulator is still up" || ok "port $p free"
  done
  [[ -z "$(grep -s '^DEVICE_MODE=.' "$S/state.env")" ]] && ok "no standalone device left behind" || no "a standalone device.sh run is not cleaned up: VERIFY_STATE=$S/state.env bash scripts/cleanup.sh"
else
  ADBP=$(grep -E '^ADB_PREFIX=' "$STATE" | tail -1 | cut -d= -f2-)
  [[ "$($ADBP get-state 2>/dev/null)" == device ]] && ok "device is ours ($ADBP)" || no "device not reachable"
  [[ "$($ADBP shell wm size 2>/dev/null | tr -d '\r')" == *1080x2355* ]] && ok "1080x2355 (360 x 785 CSS px at DPR 3)" || no "wrong screen size"
fi
exit $bad
