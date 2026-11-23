# Sourced by build-android.sh and the verify skill's build-apk.sh (Faster releases step 4,
# Harout's guard 4, 22 Nov 2026). Run from the app dir with the build's environment set
# (Firebase, HBOTS_QA_X86), because both are part of the native fingerprint.
#
# hbots_android_prepare: regenerate android/ with `expo prebuild --clean` only when the native
#   fingerprint (scripts/nativeFingerprint.ts) differs from android/.hbots-native-fingerprint.
#   Otherwise keep android/ and its Gradle outputs and only set the release version in
#   build.gradle. HBOTS_PREBUILD=always forces the old clean prebuild.
# hbots_gradle_args: the shared Gradle flags. The build cache is on. The daemon is off:
#   a daemon outlives the build, holds 2-4 GB on a laptop with a suspected RAM fault, and
#   counts as busy for the release idle gate (measured: the warm build meets the 2 min
#   target without it; qa/faster-releases/TIMINGS.md). Heap -Xmx2g and 2 workers (guard 4).
#   GRADLE_USER_HOME is the default ~/.gradle, which every checkout shares already.

hbots_android_prepare() {
  local stamp=android/.hbots-native-fingerprint want have=""
  want=$(node scripts/nativeFingerprint.ts hash)
  [[ -f $stamp ]] && have=$(<"$stamp")
  if [[ ${HBOTS_PREBUILD:-auto} != always && -n $have && $have == "$want" && -f android/app/build.gradle ]] &&
    node scripts/nativeFingerprint.ts version android/app/build.gradle; then
    echo "build-android: native fingerprint unchanged (${want:0:12}); prebuild skipped, version set"
    return 0
  fi
  if [[ -n $have ]]; then
    echo "build-android: native fingerprint changed (${have:0:12} -> ${want:0:12}); running expo prebuild --clean"
  else
    echo "build-android: native fingerprint new (${want:0:12}); running expo prebuild --clean"
  fi
  rm -f "$stamp"
  EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android
  printf '%s\n' "$want" >"$stamp"
}

hbots_gradle_args=(
  --no-daemon
  --build-cache
  --console=plain
  --max-workers=2
  "-Dorg.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=512m"
)
