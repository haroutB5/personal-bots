# 1.67.53: Secret card errors + release pipeline follow-ups

Based on 1.67.52 (trunk `63863b53eb`). Branch `release/hbots-1.67.53`, built in release slot 1. Schema version unchanged. This release ships Android APK 1.67.53 and server 1.67.53, on the fast pipeline (slot, blocking tier before the release, async tier after it).

## Why

- The secret request card fix (`fix/hbots-secret-request-card`, `9656930b85`, 21 Nov) was never merged. The branches merged after it (`fix/hbots-mobile-audit-bugs`, `fix/pb-secret-forwarding`) touch none of its files, so it was still needed.
- Three release-tool follow-ups from 1.67.52 (Opusito, 23 Nov 2026).

## What changed

- **Secret request card (phone).** A failed save or decline now shows the server's message in the card's footer (`accessibilityRole="alert"`) instead of failing silently, and the access-rule check after a submit shows there too. Typing in the card clears the old error. The card scrolls its footer into view when a field gets focus. New `secretRequestCardModel.ts` with tests.
- **`hbots-release-finish.sh`: the finisher releases the slot lease** once latest.json is published (or the release is server-only) and trunk is pushed (`--slot-label`, default the label holding the slot when the run starts). Otherwise the lease is kept. `--check` reports the holder.
- **`hbots-async-gates.mjs`:** the repo copy now matches the live tool (Opusito's 1.67.52 fix), with regression tests in `tools.test.mjs`: a docs-only commit on top runs on the tested commit and restores HEAD and branch; a code commit on top is refused; collector exit 2 never rolls back; exit 1 with rollback allowed rolls back.
- **`android-prepare.sh`: the x86 QA build no longer wipes the arm64 build tree.** The two flavours have different native fingerprints, so every switch ran `expo prebuild --clean` and a cold Gradle build (1.67.52: arm64 207 s against 69 s warm). The replaced flavour's `android/` is now parked beside the checkout (`<parent>/.<checkout>.android-alt`) and moved back when its fingerprint is wanted again. `HBOTS_ANDROID_ALT=off` restores the old behaviour. The release also builds arm64 first.
- **`nativeFingerprint.ts`: the version bump no longer forces a clean prebuild.** The app `package.json` was hashed raw, so each release's version bump changed the native fingerprint and the first arm64 and x86 builds of every release ran `expo prebuild --clean`. Its `version` field is now left out (the native version comes from `app-version.txt`).
- **`gate-evidence.mjs`: gate commands no longer inherit `GATE_*`.** With `GATE_ANDROID_BUILD` exported for the background arm64 build, the release-tools tests' fixture collectors each started the real arm64 build (first blocking run of this release, stopped). The collector now drops `GATE_*` from gate environments, and `tools.test.mjs` clears them at load.
- **Verify skill flow 12: the secret card.** Save with no address must show the problem on screen just above the buttons; a valid address clears it and Save settles the card. It fails on the 1.67.52 APK and passes on 1.67.53.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.53`.

## Release notes for the phone

1. The secret request card shows why a save or decline failed

## Verification

- Secret card: `SecretRequestCard.test.ts` and `secretRequestCardModel.test.ts` (10 tests), mobile typecheck; emulator QA of the x86 build.
- Tools: `node --test tools.test.mjs` async gates 8/8 (the four new ones fail against the pre-fix tool) and the finisher lease test; `android-prepare.test.ts` 4 tests.
- **Blocking gate tier (`GATE_TIER=blocking`, `dev-team/qa/hbots-16753/gates.log`):** PASS on `c1ef49f837d9`. hbots-mobile 60 s; release-tools 453 s (16 test files selected because this release changes the release tools); parity deferred to the async tier after live; everything else skipped by scope. 454 s wall including the background arm64 build. Two earlier runs failed on test isolation and were fixed before this one: `GATE_*` leaking into fixture collectors (`1b4b207a17`) and the gate scope's `HEAVY_JOB_*` caps leaking into the heavy-job default-cap tests (`c1ef49f837`).
- **arm64 release APK (background, after hbots-mobile passed):** built after the x86 QA build of the same commit. `android-prepare.sh` moved the parked arm64 tree back and skipped prebuild (`native fingerprint unchanged (b56145544c4c)`). 117 s, against 207 s on 1.67.52. The signer check passed; sha256 `a9644722fd49e383ec494f9f29b822e9fced8bd2c9bd12dbde6b6ed8c10dc92b`.
- **x86 QA APK:** 112 s; it parked the arm64 tree instead of wiping it.
- **Emulator QA (`dev-team/qa/hbots-16753/emulator/`):** x86 QA APK of `c1ef49f837`, 12/12 flows PASS. Flow 12 (secret card problem) also fails on the 1.67.52 APK. Boot 8 s from the snapshot; `.env` was parked and restored. No emulator was left running.

## Migration

None. Schema unchanged.

## Rollback

Binary rollback to 1.67.52 (`9bcc378ea7ec`). No data change.

## Gate evidence

<!-- gate-evidence:begin sha=c1ef49f837d90cd52924316949dc4ce624001aeb release=c1ef49f837d9 json-sha256=88bc5fc2703db084495462a845f6caf9f7a2128367e7f87a6f5b05ff727af4f6 result=PASS -->

- server-tests: SKIPPED, skip: no changed path is an input of server-tests: apps/server, packages, scripts/personal/adblock, scripts/personal/dsh-runtime, scripts/personal/updates, scripts/personal/sync, scripts/personal/testing (not packages/personal-client/, packages/client-runtime/)
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: SKIPPED, skip: no changed path is an input of e2e: apps/server, apps/web, packages, scripts/personal/e2e, scripts/personal/node/e2e-smoke.mjs, scripts/personal/testing
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: DEFERRED, deferred: runs after the release (async tier): parity inputs changed: apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/drive.py, apps/hbots-mobile/scripts/android-prepare.sh, apps/hbots-mobile/scripts/android-prepare.test.ts, apps/hbots-mobile/scripts/native-fingerprint.test.ts, ...
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/dev-team-tools/gate-evidence.mjs, scripts/personal/linux/dev-team-tools/hbots-async-gates.mjs, scripts/personal/linux/dev-team-tools/hbots-release-finish.sh, scripts/personal/linux/dev-team-tools/tools.test.mjs; selected 16 test files

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 453 s wall, 512 s if serial; budget 7 of 12 cores, server lanes 4; min MemAvailable 20822 MB, swap growth 0 MB, peak load 10.1
  server-tests         skip     start    0 s      0 s   0 jobs SKIP  |
  server-tsc           skip     start    0 s      0 s   0 jobs SKIP  |
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  skip     start    0 s      0 s   0 jobs SKIP  |
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start    0 s     60 s   1 job  PASS  |########
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               deferred start    0 s      0 s   0 jobs DEFR  |
  release-tools        selected start    0 s    453 s   1 job  PASS  |############################################################
  arm64 build (bg)     android  start   60 s    117 s   1 job  PASS  |        ################
```

<!-- gate-timing:end -->
