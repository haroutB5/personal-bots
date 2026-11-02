#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(cd "$MODULE_DIR/../.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/../.." && pwd)"

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-36.0.0}"
AAPT2="$SDK/build-tools/$BUILD_TOOLS/aapt2"
ZIPALIGN="$SDK/build-tools/$BUILD_TOOLS/zipalign"
APKSIGNER="$SDK/build-tools/$BUILD_TOOLS/apksigner"
ANDROID_JAR="$SDK/platforms/android-36/android.jar"

WORK="${HBOTS_FIXTURE_WORK:-$REPO_DIR/.tmp/hbots-updater-fixtures}"
OUT="$MODULE_DIR/android/src/test/resources/apks"
PASSWORD="fixturepass"

for tool in "$AAPT2" "$ZIPALIGN" "$APKSIGNER" "$ANDROID_JAR"; do
  if [ ! -x "$tool" ] && [ ! -f "$tool" ]; then
    echo "missing: $tool" >&2
    exit 1
  fi
done

mkdir -p "$WORK" "$OUT"

for alias in a b; do
  if [ ! -f "$WORK/$alias.jks" ]; then
    keytool -genkeypair \
      -keystore "$WORK/$alias.jks" \
      -storetype PKCS12 \
      -storepass "$PASSWORD" \
      -keypass "$PASSWORD" \
      -alias "$alias" \
      -keyalg RSA \
      -keysize 2048 \
      -validity 10000 \
      -dname "CN=hbots fixture ${alias^^}"
  fi
done

build_apk() {
  local file="$1"
  local package_name="$2"
  local version_code="$3"
  local version_name="$4"
  local signer="$5"
  local manifest="$WORK/manifest-$file.xml"
  local unsigned="$WORK/$file.unsigned.apk"
  local aligned="$WORK/$file.aligned.apk"
  local signed="$WORK/$file.apk"

  cat >"$manifest" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="$package_name"
    android:versionCode="$version_code"
    android:versionName="$version_name">
  <uses-sdk android:minSdkVersion="26" />
  <application android:label="hbots fixture" />
</manifest>
EOF

  "$AAPT2" link -o "$unsigned" -I "$ANDROID_JAR" --manifest "$manifest"
  "$ZIPALIGN" -f 4 "$unsigned" "$aligned"

  if [ "$signer" = "two" ]; then
    "$APKSIGNER" sign \
      --min-sdk-version 26 \
      --v1-signing-enabled true \
      --v2-signing-enabled false \
      --v3-signing-enabled false \
      --ks "$WORK/a.jks" --ks-pass "pass:$PASSWORD" --key-pass "pass:$PASSWORD" \
      --next-signer \
      --ks "$WORK/b.jks" --ks-pass "pass:$PASSWORD" --key-pass "pass:$PASSWORD" \
      --out "$signed" "$aligned"
  else
    local keystore="$WORK/a.jks"
    if [ "$signer" = "b" ]; then keystore="$WORK/b.jks"; fi
    "$APKSIGNER" sign \
      --min-sdk-version 26 \
      --ks "$keystore" --ks-pass "pass:$PASSWORD" --key-pass "pass:$PASSWORD" \
      --out "$signed" "$aligned"
  fi

  cp "$signed" "$OUT/$file"
  printf '%s size=%s sha256=%s\n' \
    "$file" \
    "$(stat -c %s "$OUT/$file")" \
    "$(sha256sum "$OUT/$file" | cut -d' ' -f1)"
}

build_apk "good-1.66.112.apk" "com.haroutb5.hbots" 1066112 "1.66.112" "a"
build_apk "wrong-package.apk" "com.haroutb5.other" 1066112 "1.66.112" "a"
build_apk "wrong-version-code.apk" "com.haroutb5.hbots" 1066113 "1.66.112" "a"
build_apk "wrong-version-name.apk" "com.haroutb5.hbots" 1066112 "1.66.999" "a"
build_apk "wrong-signer.apk" "com.haroutb5.hbots" 1066112 "1.66.112" "b"
build_apk "two-signers.apk" "com.haroutb5.hbots" 1066112 "1.66.112" "two"

echo "certificate a:"
"$APKSIGNER" verify --print-certs "$OUT/good-1.66.112.apk" | grep -m1 "SHA-256 digest" | awk '{print $NF}'
echo "certificate b:"
"$APKSIGNER" verify --print-certs "$OUT/wrong-signer.apk" | grep -m1 "SHA-256 digest" | awk '{print $NF}'
