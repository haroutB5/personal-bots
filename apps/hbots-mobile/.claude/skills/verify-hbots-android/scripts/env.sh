# Sourced by every verify-hbots-android script. Paths, ports, toolchain. Never prints a secret.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKILL=$(cd "$HERE/.." && pwd)
ROOT=$(git -C "$SKILL" rev-parse --show-toplevel)
S="$SKILL/.scratch"
STATE="${VERIFY_STATE:-$S/state.env}"
LOGS="${VERIFY_LOGS:-$S/logs}"
LIVE_DEV=/home/harout/.personal-bots/dev
under_live_dev() {
  local p; p=$(realpath -m -- "$1" 2>/dev/null) || p=$1
  [[ "$p" == "$LIVE_DEV" || "$p" == "$LIVE_DEV"/* ]]
}
PKG=com.haroutb5.hbots
DEV_TEAM=/home/harout/Claude/AI/dev-team
HEAVY="$DEV_TEAM/tools/heavy-job.sh"
RIG="$DEV_TEAM/tools/rig.sh"
# shellcheck disable=SC1091
. /home/harout/.config/environment.d/android.conf 2>/dev/null || true
# The new laptop (19 Nov) has no android.conf: fall back to the SDK and AVD folders the Android Studio install uses.
ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}; ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$ANDROID_HOME}; ANDROID_AVD_HOME=${ANDROID_AVD_HOME:-$HOME/.android/avd}
export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT ANDROID_AVD_HOME
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin"
export ADB_MDNS_AUTO_CONNECT=0
export TMPDIR="$S/tmp" ANDROID_TMP="$S/tmp"
refuse() { VERIFY_WHY="$1"; echo "env: $1. Refusing." >&2; exit 2; }
for _p in "$ROOT" "$SKILL" "$S" "${HBOTS_VERIFY_EVIDENCE:-$S/evidence}" "${TMPDIR:-}" "$STATE" "$LOGS"; do
  if [[ -n "$_p" ]] && under_live_dev "$_p"; then refuse "$_p is inside ~/.personal-bots/dev, the live hbots"; fi
done
mkdir -p "$LOGS" "$S/tmp" "$S/evidence"
VERIFY_ADB_PORT=${VERIFY_ADB_PORT:-5171}
VERIFY_EMU_PORT=${VERIFY_EMU_PORT:-5672}
VERIFY_AVD=${VERIFY_AVD:-FindX9Pro-QA}
VERIFY_SERVER_PORT=${VERIFY_SERVER_PORT:-34671}
[ "$VERIFY_SERVER_PORT" != 38472 ] || refuse "38472 is the live server port"
VERIFY_RELEASE=${VERIFY_RELEASE:-$(tr -d '[:space:]' < /home/harout/.personal-bots/releases/current.txt 2>/dev/null)}
export VERIFY_RELEASE VERIFY_SERVER_PORT VERIFY_ADB_PORT VERIFY_EMU_PORT VERIFY_AVD
