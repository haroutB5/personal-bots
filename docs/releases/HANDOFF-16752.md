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
- **Blocking gate tier (`GATE_TIER=blocking`, `dev-team/qa/hbots-16752/gates.log`):** hbots-mobile PASS in 64 s; every other gate skipped by scope; parity deferred to the async tier after live. 271 s wall including the background arm64 build. Track `full` (the phone app is built from `build-android.sh` and `android-prepare.sh`).
- **arm64 release APK (background, after hbots-mobile passed):** built with `ANDROID_HOME`, `ANDROID_SDK_ROOT` and `JAVA_HOME` unset and no java on PATH (fix 1 in a real build), 207 s, signer matches `release-cert.sha256`, sha256 `3ff07704d22a5f05f95db9c0c8d38a0a092ce85087e7729d6edffac76d8238ab`. The log printed `native fingerprint changed (607ba025064a -> c92d84c1f591)` once (fix 2).
- **Emulator QA (`dev-team/qa/hbots-16752/emulator/`):** x86 QA APK of `9bcc378ea7`, 11/11 flows PASS, boot 8 s from the snapshot, run in slot 1 with its `.env` in place: `verify.sh` parked it and restored it with the same sha and mode 600 (fix 3). No emulator left running.

## Migration

None. Schema unchanged.

## Rollback

Binary rollback to 1.67.51 (`5d43e754f325`). No data change.

## Gate evidence

<!-- gate-evidence:begin sha=9bcc378ea7ec20553966964138174042658473e9 release=9bcc378ea7ec json-sha256=7557c2faf86c1ae0db950de1f7f836e64634cbb67255923aa283b8dbe5ea4735 result=PASS -->

- server-tests: SKIPPED, skip: no changed path is an input of server-tests: apps/server, packages, scripts/personal/adblock, scripts/personal/dsh-runtime, scripts/personal/updates, scripts/personal/sync, scripts/personal/testing (not packages/personal-client/, packages/client-runtime/)
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: SKIPPED, skip: no changed path is an input of e2e: apps/server, apps/web, packages, scripts/personal/e2e, scripts/personal/node/e2e-smoke.mjs, scripts/personal/testing
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: DEFERRED, deferred: runs after the release (async tier): parity inputs changed: apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/build-apk.sh, apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/verify.sh, apps/hbots-mobile/scripts/android-prepare.sh, apps/hbots-mobile/scripts/build-android.sh
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 271 s wall, 64 s if serial; budget 7 of 12 cores, server lanes 4; min MemAvailable 12069 MB, swap growth 447 MB, peak load 19
  server-tests         skip     start    0 s      0 s   0 jobs SKIP  |
  server-tsc           skip     start    0 s      0 s   0 jobs SKIP  |
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  skip     start    0 s      0 s   0 jobs SKIP  |
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start    0 s     64 s   1 job  PASS  |##############
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               deferred start    0 s      0 s   0 jobs DEFR  |
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start   64 s    207 s   1 job  PASS  |              ##############################################
```

<!-- gate-timing:end -->
