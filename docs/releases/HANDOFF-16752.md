# 1.67.52: Release follow-ups from 1.67.51 (Android build scripts + server)

Based on 1.67.51 (trunk `d857ccaaed`). Branch `release/hbots-1.67.52`, built in release slot 1. Schema version unchanged. This release ships Android APK 1.67.52 and server 1.67.52. It is the first release on the fast pipeline: a release slot, the blocking gate tier before the release, the async tier after it, and the warm arm64 build.

## Why

Three follow-ups found while shipping 1.67.51 (Opusito's decisions, 23 Nov 2026). Nothing in the app's own code changes: only the scripts that build the APK and run the emulator QA.

## What changed

- **`apps/hbots-mobile/scripts/build-android.sh`: toolchain defaults.** It now sets `ANDROID_HOME` and `ANDROID_SDK_ROOT` to `~/Android/Sdk` when unset, like the verify skill's `build-apk.sh`, and uses the fixed mise Temurin 21 (`~/.local/share/mise/installs/java/temurin-21`, the finisher's `JAVA_HOME`) when `JAVA_HOME` is unset or has no runnable java. `build-apk.sh` gets the same `JAVA_HOME` default. A bare shell (systemd, a fresh slot) no longer fails with "SDK location not found".
- **`apps/hbots-mobile/scripts/android-prepare.sh`: the fingerprint log line.** When the native fingerprint changed, the line printed `changed (old -> new)` followed by the whole old hash a second time. It now prints `changed (<old12> -> <new12>)` or `new (<new12>)` once.
- **Verify skill `verify.sh`: `.env` handled by the run itself.** The doctor refuses a checkout with a `.env`, and a release slot keeps one for the gates. `verify.sh` now parks the checkout's `.env*` files in a 0700 folder beside the checkout before the doctor and puts them back on every exit (pass, fail, TERM, INT). A hold left by a killed run is restored first; if the checkout has a `.env` again as well, it refuses and overwrites neither. The manual move step is gone from the Gotchas.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.52`.

## Release notes for the phone

1. Faster, more reliable releases behind the scenes

## Verification

- **Fix tests (`dev-team/qa/hbots-16752/tests/fix-tests.sh`):** 22/22. The fingerprint line for new, changed and unchanged (the old hash is no longer printed in full); both build scripts in an empty environment get the SDK and Java defaults, keep a caller's `ANDROID_HOME` and replace a broken `JAVA_HOME`; `verify.sh` parks `.env` during the run, restores it with its content and mode after a failure and after TERM, recovers a hold left by a killed run, refuses when both copies exist, and prints no secret.
- **Real runs:** the arm64 release APK is built with `ANDROID_HOME`, `ANDROID_SDK_ROOT` and `JAVA_HOME` unset, and the emulator QA runs in the slot with its `.env` in place (parked and restored by `verify.sh`). Results and timings: `dev-team/qa/hbots-16752/`.

## Migration

None. Schema unchanged.

## Rollback

Binary rollback to 1.67.51 (`5d43e754f325`). No data change.
