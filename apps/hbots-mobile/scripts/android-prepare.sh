# Sourced by build-android.sh and the verify skill's build-apk.sh (Faster releases step 4,
# Harout's guard 4, 22 Nov 2026). Run from the app dir with the build's environment set
# (Firebase, HBOTS_QA_X86), because both are part of the native fingerprint.
#
# hbots_android_prepare: regenerate android/ with `expo prebuild --clean` only when the native
#   fingerprint (scripts/nativeFingerprint.ts) differs from android/.hbots-native-fingerprint.
#   Otherwise keep android/ and its Gradle outputs and only set the release version in
#   build.gradle. HBOTS_PREBUILD=always forces the old clean prebuild.
#   The release builds two flavours in one checkout: the arm64 release APK (Firebase on) and the
#   x86_64 QA APK (Firebase off, HBOTS_QA_X86), whose fingerprints differ. So that one does not
#   wipe the other's android/ (1.67.52: arm64 207 s after the x86 build against 69 s warm), the
#   tree of the fingerprint being replaced is moved aside to <checkout>/../.<checkout>.android-alt
#   (outside the repo, so git clean, the gates and Metro never see it) and moved back when its
#   fingerprint is wanted again. A rename on the same filesystem only; HBOTS_ANDROID_ALT=off (or
#   another filesystem) keeps the old behaviour.
# hbots_gradle_args: the shared Gradle flags. The build cache is on. The daemon is off:
#   a daemon outlives the build, holds 2-4 GB on a laptop with a suspected RAM fault, and
#   counts as busy for the release idle gate (measured: the warm build meets the 2 min
#   target without it; qa/faster-releases/TIMINGS.md). Heap -Xmx2g and 2 workers (guard 4).
#   GRADLE_USER_HOME is the default ~/.gradle, which every checkout shares already.

# The parked android/ of the other flavour, or nothing when parking is off or would copy.
hbots_android_alt() {
  [[ ${HBOTS_ANDROID_ALT:-on} != off ]] || return 0
  local top parent
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  parent=$(dirname -- "$top")
  [[ -w $parent && $(stat -c %d -- "$parent") == "$(stat -c %d -- "$PWD")" ]] || return 0
  printf '%s/.%s.android-alt\n' "$parent" "$(basename -- "$top")"
}

# Swap android/ and the parked tree (either may be missing). Three renames; a swap cut short
# leaves <alt>.swap, which the next run puts back first.
hbots_android_swap() {
  local alt=$1
  [[ -d android ]] && mv -T android "$alt.swap"
  [[ -d $alt ]] && mv -T "$alt" android
  [[ -d $alt.swap ]] && mv -T "$alt.swap" "$alt"
  return 0
}

hbots_android_prepare() {
  local stamp=android/.hbots-native-fingerprint want have="" alt altfp=""
  want=$(node scripts/nativeFingerprint.ts hash)
  alt=$(hbots_android_alt)
  if [[ -n $alt && -d $alt.swap ]]; then
    if [[ -d android ]]; then [[ -d $alt ]] || mv -T "$alt.swap" "$alt"; else mv -T "$alt.swap" android; fi
  fi
  [[ -f $stamp ]] && have=$(<"$stamp")
  [[ -n $alt && -f $alt/.hbots-native-fingerprint ]] && altfp=$(<"$alt/.hbots-native-fingerprint")
  if [[ ${HBOTS_PREBUILD:-auto} != always && $have != "$want" && -n $altfp && $altfp == "$want" ]]; then
    hbots_android_swap "$alt"
    echo "build-android: android/ for ${want:0:12} moved back from $alt (${have:-none} parked there)"
    have=$want
  fi
  if [[ ${HBOTS_PREBUILD:-auto} != always && -n $have && $have == "$want" && -f android/app/build.gradle ]] &&
    node scripts/nativeFingerprint.ts version android/app/build.gradle; then
    echo "build-android: native fingerprint unchanged (${want:0:12}); prebuild skipped, version set"
    return 0
  fi
  if [[ -n $have ]]; then
    echo "build-android: native fingerprint changed (${have:0:12} -> ${want:0:12}); running expo prebuild --clean"
    # Park this tree for its own flavour's next build; prebuild --clean then replaces what was
    # parked before (the older tree), not this one.
    if [[ -n $alt && $have != "$want" && -d android ]]; then
      hbots_android_swap "$alt"
      echo "build-android: android/ for ${have:0:12} parked in $alt"
    fi
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
