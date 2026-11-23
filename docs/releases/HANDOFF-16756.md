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

Filled in after the gates and the emulator QA for this build.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.55 (`092716264138`). No schema change, so the rollback is clean.
