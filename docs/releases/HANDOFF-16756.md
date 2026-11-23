# 1.67.56: faster emulator QA, and the Computer tab takes normal phone screenshots

Based on 1.67.55 (trunk `d5caa70309`). Branch `speed-emulator-qa`, built in release slot 1. **No migration** (schema stays 161). **Phone release:** the Computer tab screenshot fix changes the app, so an arm64 APK is built and published and `latest.json` moves to 1.67.56. The release changes gate and release tools, so it runs the full (untiered) gates before release, and the emulator QA runs all 14 flows before arming (no `--tier`, no async emulator tier).

## Why

Harout, 23 Nov 2026: the Computer tab blocked phone screenshots (FLAG_SECURE on the whole tab). "Just add it to 1.67.56 since that's not being released now." He wants normal phone screenshots of the Computer tab, nothing more, no in-app screenshot button.

Opusito, 23 Nov 2026: the emulator QA step of a phone release took about 10 minutes (596-658 s). Goal: under 4 minutes before release, without weakening what a release proves. Also fix the fake Claude CLI test (`cli.test.mjs` hung and had a failing test) and make a gate run it.

## What changed

- **Computer tab screenshots** (`8976d2c50f`): `ComputerScreen` no longer calls `useSecureScreen(true)`. The lock is `computerScreenSecure`: on only while the tab is focused and either the live view's hidden field is open for a password (`liveViewPasswordOpen`, reported by `ComputerLiveView` through `onPasswordField`, counted across the inline and full-screen views) or a sensitive-site pause (`SensitiveCard`) is shown. Files, Onboarding and the Login/Secret cards are unchanged. Tests: `computerScreenModel.test.ts` (both lock conditions, background tab, field kinds) and `secureSurfaces.test.ts` (ComputerScreen has no `useSecureScreen(true)` and wires both conditions).
- **Fable's review fixes** (cherry-picked from `fable-emuqa-review`, review in `dev-team/qa/hbots-16756/fable-review/REVIEW.md`): `33f06337ca` (from `4dd96081a7`) a message list change selects every chat flow; `7482859f75` (from `3b0174ee18`) flow 10 times the auto-decline from the fake CLI log, and a decline under 119 s fails.
- **Release QA runs all 14 flows before arming** (Opusito's decision P1 from the review): the selector and the async emulator path stay in the code but are parked. Releases run `verify.sh` with no `--tier` and `VERIFY_RELEASE` set to the staged release, and the finisher gets no `--emulator-apk`.

- **Measured first** (`957889c900`): drive.json now records each flow's time split into screen dumps, adb, sleeps and host work. Baseline on the 1.67.55 APK: 721 s, of which 402 s was 190 `uiautomator dump` calls at 2.1 s each.
- **Persistent screen dumper** (`8cb2d1d072`): `uidump/Dumper.java` runs uiautomator.jar's own dumper in one process that stays connected (idle 300 ms). 2.12 s to 0.05 s per dump. Kill switch `VERIFY_FAST_DUMP=0`.
- **Flow 10's 2-minute auto-decline wait is filled** (`fddbc03446`, `63f9339034`): flow 10's timeout leg starts first (on Researcher), flows 1, 7, 9, 3, 2, 11, 13 and 12 run inside its wait, and flow 10 then checks the decline and runs its Developer legs. The checks are the same (a decline before 110 s still fails). Kill switch `VERIFY_F10_OVERLAP=0`. Flow 11 polls the server log instead of a fixed sleep; flow 12 waits and scrolls instead of fixed sleeps.
- **Selection by diff** (`b46eb0d451`): `select-flows.mjs` puts the core (setup, flow 1 chat send, flow 8 every tab with a clean logcat) plus the flows the diff touches before the release. Any shared or unsure change (migration, nav, shell, contracts, native module, build, lockfile, the skill or the release tools) runs all 14. `verify.sh --tier blocking|async --base <sha>`. Tests: `select-flows.test.mjs` (also runs `test_drive.py`).
- **Async tier runs the rest** (`6f440f2585`): `hbots-release-finish.sh --emulator-apk <x86 apk>` makes `hbots-async-gates.mjs` run the deferred flows against the live release before the APK is published. A failed flow is retried once; only a flow failing twice may roll back, under the same guards (liveVersion equals testedVersion); a setup or link failure never does.
- **Fake Claude CLI test** (`88d36fd113`): `cli.test.mjs` uses the SDK's `mcp_set_servers` subtype and kills its child on every path, so it no longer hangs. Making the release-tools gate run it and `select-flows.test.mjs` (`ef120b4439`) is reverted for this release (`ba228c6cd5`): the installed runner seals with main's `gateScope.mjs`, and that change alters the release-tools plan for the very diff that ships it, so the seal refused ("gate release-tools args differ from the recomputed plan"). It ships next on its own (revert `ba228c6cd5`), whose diff touches neither prefix, so the old and new plans agree.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.56` (`4ead074d47`).

## Timings (lab, same 1.67.55 x86 APK)

| Run                                          | Flows | Total |
| -------------------------------------------- | ----- | ----- |
| Before (main)                                | 14/14 | 721 s |
| After, all 14 flows                          | 14/14 | 263 s |
| After, typical small change (core + flow 12) | 3/3   | 97 s  |

Per-flow tables: `dev-team/qa/hbots-16756/TIMINGS.md`.

## Release notes for the phone

The Computer tab can be screenshotted and screen-recorded again. It still blocks screenshots while you type into a password field on the live browser, and while a sensitive-site pause is shown.

## Verification

Rebuilt from scratch after the laptop's reboot at 21:58 on 23 Nov 2026 (an earlier run hit a RAM fault that flipped bits in cached files, so its builds and results were discarded). Before the rebuild, the Gradle build cache and the native `android/build` outputs written that day were moved aside, so both APKs were built from source with a clean prebuild.

- **Gates:** full (untiered) gates PASS in 791 s on release `9b001679d350` (block below). The arm64 release APK was built inside them in 416 s, sha256 `2098ada6af1bfb2ebbf53652b47268b9ef4ba484d929f3c89fa4bbeb470c1413`. It passes zip CRC and apksigner verification.
- **Emulator QA:** the staged release `9b001679d350` with the x86_64 QA APK of the same commit, all 14 flows (no `--tier`): 14/14 PASS, 221 s of flows, 254 s total (`dev-team/qa/hbots-16756/emulator/hbots-16756-release-qa3-20261123T222114Z`).
- **Computer tab screenshots** on the same staged release: FLAG_SECURE windows were 0 on the tab and 0 on a login page. With a password field open (IME inputType `0x80081`) the count was 1 and the screenshot was black. With the keyboard closed it was 0 again, and the screenshot rendered (`dev-team/qa/hbots-16756/emulator/hbots-16756-screenshot-release-20261123T221944Z`).

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.55 (`092716264138`). No schema change, so the rollback is clean.

## Gate evidence

<!-- gate-evidence:begin sha=9b001679d350731262a63a612896ef53b91f0d3b release=9b001679d350 json-sha256=6d321c32f688272871e15bb22d1c61d9da96cad90faa5bb48424064e6eaf3cb8 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: scripts/personal/testing/fake-claude/cli.test.mjs; selected 26 test files
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: scripts/personal/testing/fake-claude/cli.test.mjs; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/dev-team-tools/hbots-async-gates.mjs, scripts/personal/linux/dev-team-tools/hbots-release-finish.sh, scripts/personal/linux/dev-team-tools/tools.test.mjs; selected 16 test files
- not run by any gate: apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/select-flows.test.mjs
- not run by any gate: scripts/personal/testing/fake-claude/cli.test.mjs

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 787 s wall, 1061 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 19835 MB, swap growth 55 MB, peak load 13.1
  preflight            guards   start    0 s      7 s   1 job  PASS  |#
  server-tests         selected start    7 s    190 s   1 job  PASS  | ##############
  server-tsc           skip     start    0 s      0 s   0 jobs SKIP  |
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  selected start   94 s    278 s   1 job  PASS  |       #####################
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start    0 s     94 s   1 job  PASS  |#######
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start   94 s     11 s   1 job  PASS  |       #
  release-tools        selected start    7 s    481 s   1 job  PASS  | #####################################
  arm64 build (bg)     android  start  372 s    415 s   1 job  PASS  |                            ################################
```

<!-- gate-timing:end -->
