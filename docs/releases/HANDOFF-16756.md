# 1.67.56: faster emulator QA

Based on 1.67.55 (trunk `d5caa70309`). Branch `speed-emulator-qa`, built in release slot 1. **No migration** (schema stays 161). **Server-only track:** nothing the phone app is built from changes (the emulator skill lives under `apps/hbots-mobile/.claude/`, and `apps/hbots-mobile/package.json` changes only its version), so no APK is built or published and `latest.json` stays at 1.67.55. The release changes gate and release tools, so it runs the full (untiered) gates before release.

## Why

Opusito, 23 Nov 2026: the emulator QA step of a phone release took about 10 minutes (596-658 s). Goal: under 4 minutes before release, without weakening what a release proves. Also fix the fake Claude CLI test (`cli.test.mjs` hung and had a failing test) and make a gate run it.

## What changed

- **Measured first** (`957889c900`): drive.json now records each flow's time split into screen dumps, adb, sleeps and host work. Baseline on the 1.67.55 APK: 721 s, of which 402 s was 190 `uiautomator dump` calls at 2.1 s each.
- **Persistent screen dumper** (`8cb2d1d072`): `uidump/Dumper.java` runs uiautomator.jar's own dumper in one process that stays connected (idle 300 ms). 2.12 s to 0.05 s per dump. Kill switch `VERIFY_FAST_DUMP=0`.
- **Flow 10's 2-minute auto-decline wait is filled** (`fddbc03446`, `63f9339034`): flow 10's timeout leg starts first (on Researcher), flows 1, 7, 9, 3, 2, 11, 13 and 12 run inside its wait, and flow 10 then checks the decline and runs its Developer legs. The checks are the same (a decline before 110 s still fails). Kill switch `VERIFY_F10_OVERLAP=0`. Flow 11 polls the server log instead of a fixed sleep; flow 12 waits and scrolls instead of fixed sleeps.
- **Selection by diff** (`b46eb0d451`): `select-flows.mjs` puts the core (setup, flow 1 chat send, flow 8 every tab with a clean logcat) plus the flows the diff touches before the release. Any shared or unsure change (migration, nav, shell, contracts, native module, build, lockfile, the skill or the release tools) runs all 14. `verify.sh --tier blocking|async --base <sha>`. Tests: `select-flows.test.mjs` (also runs `test_drive.py`).
- **Async tier runs the rest** (`6f440f2585`): `hbots-release-finish.sh --emulator-apk <x86 apk>` makes `hbots-async-gates.mjs` run the deferred flows against the live release before the APK is published. A failed flow is retried once; only a flow failing twice may roll back, under the same guards (liveVersion equals testedVersion); a setup or link failure never does.
- **Fake Claude CLI test** (`88d36fd113`): `cli.test.mjs` uses the SDK's `mcp_set_servers` subtype and kills its child on every path, so it no longer hangs. The release-tools gate now runs it and `select-flows.test.mjs` (`ef120b4439`).
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.56`.

## Timings (lab, same 1.67.55 x86 APK)

| Run                                          | Flows | Total |
| -------------------------------------------- | ----- | ----- |
| Before (main)                                | 14/14 | 721 s |
| After, all 14 flows                          | 14/14 | 263 s |
| After, typical small change (core + flow 12) | 3/3   | 97 s  |

Per-flow tables: `dev-team/qa/hbots-16756/TIMINGS.md`.

## Release notes for the phone

None (server-only track; the phone keeps 1.67.55).

## Verification

- **Full gates (`dev-team/qa/hbots-16756/gates.log`):** PASS on `4ead074d47b9`, 502 s wall at CPU budget 5, untiered (the release changes gate tools). release-tools 491 s (selected, 18 test files, now including `cli.test.mjs` and `select-flows.test.mjs`), e2e 279 s (12 journeys), server-tests 185 s, hbots-mobile 92 s, parity 12 s, preflight 7 s. The 1.67.55 evidence listed `cli.test.mjs` as "not run by any gate"; this one has no such line.
- **Unit tests:** `cli.test.mjs` 10 pass (no hang); `select-flows.test.mjs` 9 pass; `test_drive.py` 19 pass; hbots-release tests 479 pass; dev-team `tools.test.mjs` 46 pass (5 new for the emulator async tier).
- **Emulator QA (`dev-team/qa/hbots-16756/emulator/hbots-16756-release-20261123T191833Z/`):** the 1.67.55 x86 QA APK against the staged release `4ead074d47b9`, `--tier blocking --base 092716264138`. The selector chose all 14 flows (the change includes the selector itself). 14/14 PASS in 253 s (was 658 s for 1.67.55), dark mode at 1080x2355, 480 dpi (360x785 at DPR 3). Flow 10's timeout leg auto-declined after about 121 s with flows 1, 7, 9, 3, 2, 11, 12 and 13 run inside the wait. No emulator was left running.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.55 (`092716264138`). No schema change, so the rollback is clean.

## Gate evidence

<!-- gate-evidence:begin sha=4ead074d47b9cb24d85dcd61548094508b03b015 release=4ead074d47b9 json-sha256=c204614e7de5d5cd756af38c2ad776c919e8fd17ccd69eb76fb78b98dc732920 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: scripts/personal/testing/fake-claude/cli.test.mjs; selected 27 test files
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: scripts/personal/testing/fake-claude/cli.test.mjs; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: PASS, selected: release-tools inputs changed: apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/drive.py, apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/select-flows.mjs, apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/select-flows.test.mjs, apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/test_drive.py, ...; selected 18 test files

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 498 s wall, 1066 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 21864 MB, swap growth 0 MB, peak load 4
  preflight            guards   start    0 s      7 s   1 job  PASS  |#
  server-tests         selected start    7 s    185 s   1 job  PASS  | ######################
  server-tsc           skip     start    0 s      0 s   0 jobs SKIP  |
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  selected start   92 s    279 s   1 job  PASS  |           ##################################
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start    0 s     92 s   1 job  PASS  |###########
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start   92 s     12 s   1 job  PASS  |           #
  release-tools        selected start    7 s    491 s   1 job  PASS  | ###########################################################
```

<!-- gate-timing:end -->
