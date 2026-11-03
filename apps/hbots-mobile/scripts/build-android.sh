#!/usr/bin/env bash
# Builds the release-signed APK from the laptop keystore. Run it under
# heavy-job.sh. The password is read from the properties file into the
# environment; it is never an argument and never written to the project.
set -euo pipefail

app_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
keystore=${HBOTS_KEYSTORE_PATH:-$HOME/.config/hbots-android/hbots-release.jks}
properties=${HBOTS_SIGNING_PROPERTIES:-$HOME/.config/hbots-android/signing.properties}
key_alias=${HBOTS_KEY_ALIAS:-hbots-release}
apk=${HBOTS_APK_OUT:-$app_dir/android/app/build/outputs/apk/release/app-release.apk}

fail() {
  echo "build-android: $*" >&2
  exit 1
}

[[ -f $keystore ]] || fail "keystore missing at $keystore"
[[ -f $properties ]] || fail "signing properties missing at $properties"
[[ $(stat -Lc %a "$keystore") == 600 ]] || fail "keystore must be mode 0600"
[[ $(stat -Lc %a "$properties") == 600 ]] || fail "signing properties must be mode 0600"

store_password=$(sed -n 's/^storePassword=//p' "$properties" | head -n 1 | tr -d '\r')
key_password=$(sed -n 's/^keyPassword=//p' "$properties" | head -n 1 | tr -d '\r')
[[ -n $store_password && -n $key_password ]] ||
  fail "signing properties must set storePassword and keyPassword"

export HBOTS_KEYSTORE_PATH=$keystore
export HBOTS_KEY_ALIAS=$key_alias
export HBOTS_KEYSTORE_TYPE=pkcs12
export HBOTS_KEYSTORE_PASSWORD=$store_password
export HBOTS_KEY_PASSWORD=$key_password
unset store_password key_password

cd "$app_dir"
EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android
(cd android && ./gradlew assembleRelease --no-daemon --console=plain)

[[ -f $apk ]] || fail "no APK at $apk"

sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
apksigner=$(find "$sdk/build-tools" -mindepth 2 -maxdepth 2 -name apksigner -type f | sort -V | tail -n 1)
[[ -x $apksigner ]] || fail "apksigner not found under $sdk/build-tools"

signers=$("$apksigner" verify --print-certs "$apk" |
  sed -n 's/^Signer #\([0-9]*\) certificate SHA-256 digest: \(.*\)$/\1 \2/p')
[[ $(printf '%s\n' "$signers" | grep -c .) == 1 ]] || fail "expected one signer, got: $signers"
digest=$(printf '%s\n' "$signers" | cut -d' ' -f2)
pin=$(tr -d '[:space:]' <"$app_dir/release-cert.sha256")
[[ $digest == "$pin" ]] || fail "signer $digest does not match release-cert.sha256"

node "$app_dir/scripts/verify-apk.mjs" "$apk"

abis=$(unzip -Z1 "$apk" | sed -n 's|^lib/\([^/]*\)/.*|\1|p' | sort -u)
[[ $abis == "arm64-v8a" ]] || fail "expected only arm64-v8a, got: ${abis:-none}"

echo "apk=$apk"
echo "apk-bytes=$(stat -c %s "$apk")"
echo "apk-sha256=$(sha256sum "$apk" | cut -d' ' -f1)"
echo "signer-sha256=$digest"
