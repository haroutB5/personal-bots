# 1.67.30: faster cold start, chat loads on press, calmer update checks, and a crash fix

Based on 1.67.29 (`fc56dd8285cf`, trunk `6d93978648`). Branch `rc/1.67.30` is cut from `perf/cold-start` at `55222391ad`, which already contains trunk `6d93978648` as a merge commit, so trunk fast-forwards to the release commit. There is no migration, so the schema stays at 159. This is the first release checked by the scoped release tool on a phone-code change.

## Why

Harout asked for a faster app and for release checks that do not take 22 minutes. The app start path, the chat open path and the update check were each measured and tuned on lab devices. One defect found in that work, a crash when a chat's saved copy could not be read, is fixed here.

## What changed

- **Chat open.** The chat request starts when you press the row. Kill switch `android-preload-chat`.
- **Update check.** After a lost connection the app checks for an update at most once a minute, behind `android-update-on-reconnect`. After a failed download it waits 5, then 15, then 60 minutes.
- **Crash fix.** A failure in the press path never stops a chat opening. Before, a chat tap with an unreadable saved copy closed the app.
- **Cold start.** Start marks, per-file icon imports and inline requires (`bedfdfd8b7`, kept by the lead's ruling, revert that one commit alone to remove it). The bundle is 595,920 B smaller (builder's number).
- **Merge with 1.67.29.** One conflict, `AttachSheet.tsx`, resolved as trunk's file plus the icon import path.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.30.

## Release notes for the phone

- The app opens a little faster from cold, and a chat starts loading the moment you press it.
- After a lost connection the app checks for an update at most once a minute, and waits longer after a failed download.
- Fixed a crash when a chat was tapped while its saved copy could not be read.

## Migration

None. Measured: `Migrations.ts` has no diff against trunk and the highest id stays 159. Params use `--migration-before 159 --migration-after 159`, so the runner skips the backup.

## Verification

- Device proof on the gaming PC emulator, `dev-team/qa/hbots-optimise/cold-start/verify/VERIFY-cold-start.md`: items 1 to 7 PASS. Tap to cached list p50 2669 ms old, 2524 ms merged, faster in 18 of 21 pairs, median 177 ms. Warm start p50 141 to 129 ms. The trunk-merged APK also passed (cold p50 2535 ms against 2627 ms old, "Add 2 photos" works).
- Merge proof `dev-team/qa/hbots-optimise/cold-start/merge/BUILD.md`: 12 planner commands exit 0.
- Chat open lab proof `dev-team/qa/hbots-optimise/chat-open/verify/VERIFY-chat-open.md` (network path p50 449 to 363 ms). Update check proof `dev-team/qa/hbots-optimise/update/verify/VERIFY-update.md`.
- Not covered by any proof: light mode (the app is dark only), sign-in screen icons, update banner, avatar picker, goals, memory and routines sheets, voice, notifications, a real arm64 phone. The 12 e2e journeys on the merge run only as the gate selects them.
- Release checks run with the installed scoped tool and `gates-linux.scoped.json`. The tool selects the tests inside each check from the changed files.

## Rollback

Binary rollback to `fc56dd8285cf` (1.67.29) plus its APK. The database is unchanged by this release.

## Gate evidence

<!-- gate-evidence:begin sha=250e2e23c6352fe1155a169c9be45d33ab5d9d62 release=250e2e23c635 json-sha256=889732ff49165c3dbb6d627e7b9af4f37d33178a1695078c777303b4a405424c result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/personal/clientCompat/clientCompatRoute.test.ts, apps/server/src/personal/clientCompat/clientCompatRoute.ts, apps/server/src/personal/perfFlags.test.ts, apps/server/src/personal/perfFlags.ts, ...; selected 371 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/personal/clientCompat/clientCompatRoute.test.ts, apps/server/src/personal/clientCompat/clientCompatRoute.ts, apps/server/src/personal/perfFlags.test.ts, apps/server/src/personal/perfFlags.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-

<!-- gate-evidence:end -->
