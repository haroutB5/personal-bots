# Sourced by every verify-hbots-android script. Paths, ports, toolchain. Never prints a secret.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKILL=$(cd "$HERE/.." && pwd)
ROOT=$(git -C "$SKILL" rev-parse --show-toplevel)
S="$SKILL/.scratch"
STATE="$S/state.env"
PKG=com.haroutb5.hbots
DEV_TEAM=/home/harout/Claude/AI/dev-team
HEAVY="$DEV_TEAM/tools/heavy-job.sh"
RIG="$DEV_TEAM/tools/rig.sh"
# shellcheck disable=SC1091
. /home/harout/.config/environment.d/android.conf 2>/dev/null || true
export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT ANDROID_AVD_HOME
export PATH="$PATH:/home/harout/Android/Sdk/platform-tools:/home/harout/Android/Sdk/emulator"
export ADB_MDNS_AUTO_CONNECT=0
export TMPDIR="$S/tmp" ANDROID_TMP="$S/tmp"
mkdir -p "$S/logs" "$S/tmp" "$S/evidence"
VERIFY_ADB_PORT=${VERIFY_ADB_PORT:-5171}
VERIFY_EMU_PORT=${VERIFY_EMU_PORT:-5672}
VERIFY_AVD=${VERIFY_AVD:-FindX9Pro-QA}
VERIFY_SERVER_PORT=${VERIFY_SERVER_PORT:-34671}
[ "$VERIFY_SERVER_PORT" != 38472 ] || { echo "env: 38472 is the live server" >&2; return 2 2>/dev/null || exit 2; }
VERIFY_RELEASE=${VERIFY_RELEASE:-$(tr -d '[:space:]' < /home/harout/.personal-bots/releases/current.txt 2>/dev/null)}
export VERIFY_RELEASE VERIFY_SERVER_PORT VERIFY_ADB_PORT VERIFY_EMU_PORT VERIFY_AVD
