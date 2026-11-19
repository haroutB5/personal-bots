#!/usr/bin/env bash
# build-apk.sh <out.apk> [--arch x86_64]: throwaway-signed x86_64 APK of THIS checkout, for the emulator.
# Run it under heavy-job.sh with HEAVY_JOB_MEMORY_MAX=7G HEAVY_JOB_SWAP_MAX=8G. Never uses ~/.config/hbots-android.
set -euo pipefail
# The new laptop has no android.conf, so a bare shell has no SDK path (Gradle: "SDK location not found"). Same fallback as env.sh.
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk} ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}
out=${1:?usage: build-apk.sh <out.apk>}
root=$(git rev-parse --show-toplevel)
app=$root/apps/hbots-mobile
case $(realpath -m "$out") in "$HOME"/.config/*) echo "refuse: output under ~/.config" >&2; exit 2;; esac
unset NODE_ENV HBOTS_KEYSTORE_PATH HBOTS_KEYSTORE_PASSWORD HBOTS_KEY_PASSWORD HBOTS_KEY_ALIAS HBOTS_GOOGLE_SERVICES_JSON
keydir=$(mktemp -d "${TMPDIR:-/tmp}/hbots-verify-key.XXXXXX")
trap 'rm -f "$keydir/throwaway.jks"; rmdir "$keydir" 2>/dev/null' EXIT
pass=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
keytool -genkeypair -keystore "$keydir/throwaway.jks" -storetype pkcs12 -alias verify -keyalg RSA -keysize 2048 \
  -validity 30 -dname "CN=hbots verify throwaway" -storepass "$pass" -keypass "$pass" >/dev/null 2>&1
export HBOTS_KEYSTORE_PATH=$keydir/throwaway.jks HBOTS_KEYSTORE_PASSWORD=$pass HBOTS_KEY_PASSWORD=$pass HBOTS_KEY_ALIAS=verify HBOTS_KEYSTORE_TYPE=pkcs12
unset pass
cd "$root"
[ -d node_modules ] || pnpm install --frozen-lockfile --filter '@hbots/mobile...'
cd "$app"
EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android
(cd android && ./gradlew assembleRelease --no-daemon --console=plain --max-workers=2 -x lintVitalRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease -PreactNativeArchitectures=x86_64)
apk=$app/android/app/build/outputs/apk/release/app-release.apk
[ -f "$apk" ] || { echo "no APK at $apk" >&2; exit 1; }
abis=$(unzip -Z1 "$apk" | sed -n 's|^lib/\([^/]*\)/.*|\1|p' | sort -u | paste -sd,)
[ "$abis" = x86_64 ] || { echo "expected x86_64 only, got: $abis" >&2; exit 1; }
mkdir -p "$(dirname "$out")"; cp "$apk" "$out"
echo "apk=$out sha256=$(sha256sum "$out" | cut -c1-16) commit=$(git rev-parse --short=12 HEAD) version=$(cat "$root/scripts/personal/app-version.txt")"
