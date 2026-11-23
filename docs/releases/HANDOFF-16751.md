# 1.67.51: Faster releases tooling, honest server-update banner (Android + server)

Based on 1.67.50 (trunk `bd24bccc1e`). Branch `perf/faster-releases` (commits `0a8da7d8c1`, `0f99512bdc`, `03b0408047`, `0409ca3c84`, the version commit `2f56ecd359`, and the scope-sweep fix `5d43e754f3`). Release `5d43e754f325`. Schema version unchanged. This release ships Android APK 1.67.51 and server 1.67.51.

## Why

Harout, 22 Nov 2026: "For the next releases moving forward, you and the team will do this new implementation." An hbots release took 30-50 minutes: about 23 minutes of gates that ran one after another, a cold APK build each time (`expo prebuild --clean` deletes android/), a cold emulator boot, and a full APK and emulator round even when only the server changed. Plan and guards: `dev-team/plans/faster-releases.md`. Before and after timings: `dev-team/qa/faster-releases/TIMINGS.md`.

This release changes the gate tools, so it is gated by the OLD full gates (every group, before the release). The new fast tier is used from the next release on, after the runner and its pins are reinstalled from this tree.

## What changed

- **Parallel gates (`scripts/personal/linux/dev-team-tools/gate-evidence.mjs`).**
  - Gates run concurrently within about 60% of the cores (a CPU quota on the heavy-job scope). Server tests are split into weight-balanced chunks over up to 4 lanes. The longest gate starts first.
  - New jobs hold back while MemAvailable is low or swap grew in the last 30 s.
  - Preflight guards run first. Over 100 selected server tests, the changed files behind the fan-out are logged.
  - Every run prints a timing waterfall, keeps it in the evidence, and stops leftover processes in its own scope at the end.
  - 1.67.49 replay: 864 s against 1380 s serial.
- **Tiered gates (`hbots-release/lib/gateScope.mjs` `tierPlans`, `lib/seal.mjs`; `dev-team-tools/hbots-async-gates.mjs`).**
  - `GATE_TIER=blocking` runs before the release: preflight, typechecks, unit tests, and the server tests within 1 import hop of the change (only those that import a changed file, depth 0, when that set is over 80 files).
  - e2e, parity, Kotlin and the far server tests are recorded as deferred.
  - After live, the finisher runs `hbots-async-gates.mjs` (`GATE_TIER=async`, a failed job is retried once) before it publishes anything.
  - On an async failure it posts the new notice outcomes `async_failed`, `async_rolled_back` or `async_rollback_failed`.
  - It rolls back only when the live release is still the tested one, no newer release is live, armed or running, and the diff has no DB migration. A migration or toolchain change is never tiered.
  - The seal accepts each tier and refuses a forged tier. 1.67.49 replay: blocking 345 s.
- **Server-only track (`gateScope.mjs` `releaseTrack`).**
  - No change to the phone app, its workspace packages, the lockfile or a dependency makes the release server-only.
  - The collector prints `release track:` with RUN/SKIP for the x86 QA build, the arm64 build, the emulator QA and the `latest.json` publish.
  - The finisher takes `--server-only` and refuses APK arguments. 1.67.36 replays as server-only.
- **Phone banner (`apps/hbots-mobile/src/shell/serverUpdateBannerModel.ts`, `ServerUpdateBanner.tsx`).** "Server updated to X. This app is on Y. Its update follows." The last sentence now shows only when the app updater has a newer target. A server-only release ships no APK.
- **Warm Android builds (`apps/hbots-mobile/scripts/nativeFingerprint.ts`, `android-prepare.sh`, `build-android.sh`, verify skill `build-apk.sh`).**
  - `expo prebuild --clean` runs only when the native fingerprint changes. The fingerprint covers the app config, plugins, assets, `modules/*/android`, lockfile, patches, the Firebase file and the QA arch.
  - Otherwise the build keeps android/ and rewrites only versionCode and versionName, which verify-apk checks.
  - Gradle runs with the build cache, 2 workers and `-Xmx2g`, and no daemon.
  - Measured: cold 242 s; a 1-line JS change 69 s.
- **Background arm64 build.** `GATE_ANDROID_BUILD` starts the APK build once preflight and hbots-mobile pass. Any failed gate stops it.
- **Release slots and lanes (`dev-team-tools/hbots-slot.sh`, `heavy-job.sh`, `hbots-release-finish.sh`).**
  - Slots: leases for `_wt/hbots-slot-1/2`, switched with `git switch`. `git clean -fd` (never `-x`) runs only on those two paths, and `.env` and build caches are kept. The finisher never removes a slot.
  - Lanes: heavy-job `--lane android` runs one Gradle build or emulator at a time beside the light lane.
- **Emulator quick boot (verify skill `device.sh`, `drive.py`).** `device.sh snapshot` saves a preset snapshot: dark, 1080x2355 at 480 dpi, animations off. `up` loads it with `-read-only -no-snapshot-save`. The driver runs `pm clear` after install. Boot: 24 s cold, 7 s from the snapshot.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.51`.

## Release notes for the phone

1. The server-updated banner only promises an app update when one is coming
2. Faster releases behind the scenes

## Verification

- **Unit tests:**
  - `tools.test.mjs` 36/36, including GATE_TIER blocking/async/retry, async rollback rules, slot leases and clean, the background build start and stop, and the scope sweep.
  - `gate-tier.test.mjs` 7/7, `compact.test.mjs` 7/7, `PersonalReleaseNoticeService.test.ts` 19/19, `serverUpdateBannerModel.test.ts` 4/4, `native-fingerprint.test.ts` 12/12.
  - hbots-mobile lint, typecheck and 1809 tests pass.
- **Replays** (`dev-team/qa/faster-releases/replay/`): full tier 864 s, blocking tier 345 s, async far server tests 321 s on the 1.67.49 diff. The 1.67.36 dry run is server-only.
- **Builds and boots** (`dev-team/qa/faster-releases/arm64/`, `boot/`): the timings above. No emulator was left running.
- **Release gates (OLD full collector, `dev-team/qa/hbots-16751/gates.log`):** run 3 on `5d43e754f325` passed preflight, server-tests (27 selected), server-tsc, e2e (12 selected), hbots-mobile, parity and release-tools (16 selected) in 12 min 49 s. web-tests, web-tsc, personal-client and Kotlin were skipped by scope (no input changed). The tree was clean.
  - Run 1 failed in hbots-mobile: `fork-hygiene.test.ts` scanned the emulator evidence left in the verify skill's `.scratch/`. The evidence now lives in `dev-team/qa/hbots-16751/emulator/`.
  - Run 2 failed in release-tools: the new collector's end-of-run scope sweep stopped the nested `tools.test.mjs` runner. Fixed in `5d43e754f3`: it sweeps only a scope it owns. tools.test 36/36 direct and nested.
- **Emulator QA (`dev-team/qa/hbots-16751/verify.out`):** x86 QA APK of `2f56ecd359`, 11/11 flows PASS, quick boot from the snapshot in 8 s. `5d43e754f3` touches only the dev-team tools, nothing the app is built from.

## Migration

None. Schema unchanged.

## Rollback

Binary rollback to 1.67.50 (`1b9b00877835`). No data change. Before the post-live reinstall, the tools in dev-team/tools stay as they were, so a rollback needs no tool change.

## Gate evidence

<!-- gate-evidence:begin sha=5d43e754f32581101c7fd835ab67b659bee91107 release=5d43e754f325 json-sha256=e9e804c9a25723492d7a8968b61c7f25da2e615ce5f630fdba2dab2e84d2abe6 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/personal/releaseNotices/PersonalReleaseNoticeService.test.ts, apps/server/src/personal/releaseNotices/PersonalReleaseNoticeService.ts; selected 27 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/src/personal/releaseNotices/PersonalReleaseNoticeService.test.ts, apps/server/src/personal/releaseNotices/PersonalReleaseNoticeService.ts; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/dev-team-tools/gate-common.mjs, scripts/personal/linux/dev-team-tools/gate-evidence.mjs, scripts/personal/linux/dev-team-tools/hbots-async-gates.mjs, scripts/personal/linux/dev-team-tools/hbots-release-finish.sh, ...; selected 16 test files

<!-- gate-evidence:end -->
