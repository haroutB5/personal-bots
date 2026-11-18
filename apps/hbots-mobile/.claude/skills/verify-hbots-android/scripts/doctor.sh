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
bin=/home/harout/.personal-bots/releases/$VERIFY_RELEASE/dist/bin.mjs
[[ -f "$bin" ]] && ok "server binary $VERIFY_RELEASE (read only)" || no "no server binary at $bin"
ver=$(cat "$ROOT/scripts/personal/app-version.txt" 2>/dev/null)
echo "doctor: info checkout version $ver at $(git -C "$ROOT" rev-parse --short=12 HEAD)"
[[ -f "$ROOT/scripts/personal/testing/fake-claude/cli.js" ]] && grep -q LATEQ "$ROOT/scripts/personal/testing/fake-claude/cli.js" && ok "fake claude has LATEQ" || no "fake claude lacks LATEQ (this checkout predates the skill)"
for t in adb emulator python3 node; do command -v "$t" >/dev/null && ok "$t" || no "$t missing"; done
[[ -n "$(find "$ROOT" -maxdepth 1 -name ".env*" ! -name "*.example" ! -name "*.sample" ! -name "*.template" 2>/dev/null)" ]] && no ".env file in the checkout" || ok "no .env in the checkout"
if [[ "${1:-}" == --pre ]]; then
  apk=${2:-}
  [[ -f "$apk" ]] || no "no apk at '$apk'"
  if [[ -f "$apk" ]]; then
    abis=$(unzip -Z1 "$apk" | sed -n 's|^lib/\([^/]*\)/.*|\1|p' | sort -u | paste -sd,)
    [[ "$abis" == *x86_64* ]] && ok "apk has x86_64 libs ($abis)" || no "apk is not x86_64 ($abis): build one with scripts/build-apk.sh"
    "$ANDROID_HOME"/build-tools/*/apksigner verify --print-certs "$apk" 2>/dev/null | grep -q "SHA-256 digest: $(tr -d '[:space:]' < "$ROOT/apps/hbots-mobile/release-cert.sha256")" \
      && no "apk is signed with the RELEASE key, use a throwaway build" || ok "apk is not signed with the release key"
  fi
  [[ ! -s "$STATE" ]] && ok "no earlier run left behind" || { grep -q '^DEVICE_MODE=.' "$STATE" && no "an earlier run is not cleaned up: bash scripts/cleanup.sh" || ok "no earlier run left behind"; }
else
  ADBP=$(grep -E '^ADB_PREFIX=' "$STATE" | tail -1 | cut -d= -f2-)
  [[ "$($ADBP get-state 2>/dev/null)" == device ]] && ok "device is ours ($ADBP)" || no "device not reachable"
  [[ "$($ADBP shell wm size 2>/dev/null | tr -d '\r')" == *1080x2355* ]] && ok "1080x2355 (360 x 785 CSS px at DPR 3)" || no "wrong screen size"
fi
exit $bad
