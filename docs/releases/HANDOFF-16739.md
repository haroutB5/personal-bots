# 1.67.39: chats open faster, reopen survives background work, timing data for what is still slow

Based on 1.67.38 (`6e7bc80a84ea`, trunk `f4c31350ab`). Branch `rc/1.67.39` is cut from the integration head `250a315c23` (`origin/integ/1.67.39`), which is three `--no-ff` merges on top of trunk, so trunk fast-forwards to the release. The schema stays at 160. The Kotlin launcher module gains one function, so this release ships a new APK.

## Why

Harout opens chats from notifications, chips and the Tasks tab, and the chat request should start at the tap on every one of those paths. A personal task reopened while a bot still ran background work failed with `dispatch_failed`. The team also had no timing for the list commit or for the time from process start, so it could not tell what was still slow.

## What changed

- **Every way into a chat starts loading at the tap** (`7e75677be1`). Notification taps, chips and the Tasks tab send the chat request when the tap lands.
- **More timing fields** (`5a22df3301`, `0dfbc81e27`, `00b7a2baf1`). The open beacon carries `listMs` and `rows`, and cold starts and cold opens carry `processStartMs` and `processToOpenMs`. The server allowlist accepts them and an older server drops them without error. `hbots-launcher` gets a Kotlin `processStartUptimeMs`.
- **Reopen with background work** (`7dd262145f`, test support `e7c8b748e8`). A personal task reopen resumes its session while background work runs, instead of failing with `dispatch_failed`.
- **heavy-job** (`2f322dce2a`, `d675658ffa`). Four slots, and no new job starts while an hbots release is armed. Dev-team tooling only. The installed copy is already in use.
- **Desk panel Node lookup** (`854133d69a`). `hbots-desk-status` no longer calls a hard-coded mise Node version. It uses `HBOTS_NODE`, then `node` on PATH, then the newest mise install. Dev-team tooling only. The release-tools desk panel test was red on trunk since the pin moved to 24.22.3 and is green on this head (2 of 2).
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.39.

## Release notes for the phone

- Chats open faster from notifications, chips and the Tasks tab.
- Bots carry on reliably after the server restarts.
- Better timing data to find what is still slow.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Verifier PASS on the integration head `250a315c23`: `qa/hbots-16739/verify/REPORT.md` (all gates exit 0, 9 of 9 device flows, old-server fail-safe measured).
- Verifier PASS on the open-every-entry change: `qa/hbots-optimise/second-pass/verify-01/REPORT.md`.
- Verifier 2 PASS on the reopen fix: `qa/hbots-engine-faults-20261119/verify/RESULT.md`.
- Lead review of the desk panel fix `854133d69a` (small fix tier): red on `250a315c23`, green on the head, also green with only `/usr/bin` on PATH. Logs `qa/hbots-16739/ship/deskfix-*.log`.
- The release check runs with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects.

## Rollback

Binary rollback to `6e7bc80a84ea` (1.67.38). No data change, so no data restore.

## Gate evidence

<!-- gate-evidence:begin sha=0130b5adf7b18f633c17317f12eee39b35921db9 release=0130b5adf7b1 json-sha256=5adbd8bf16a347bc26139c657302e155548f5fe8bc4d2818c7510e04860ad891 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/personal/push/clientDiagRoute.test.ts, apps/server/src/personal/push/clientDiagRoute.ts, apps/server/src/personal/tasks/PersonalTaskService.test.ts, apps/server/src/personal/tasks/taskDispatch.ts, ...; selected 220 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/src/personal/push/clientDiagRoute.test.ts, apps/server/src/personal/push/clientDiagRoute.ts, apps/server/src/personal/tasks/PersonalTaskService.test.ts, apps/server/src/personal/tasks/taskDispatch.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, selected: hbots-mobile-kotlin inputs changed: apps/hbots-mobile/modules/hbots-launcher/android/src/main/java/expo/modules/hbotslauncher/HbotsLauncherModule.kt; selected 1 Gradle tasks
- parity: PASS, exit 0
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/dev-team-tools/heavy-job.sh, scripts/personal/linux/dev-team-tools/tools.test.mjs, scripts/personal/linux/hbots-release/hbots-desk-status; selected 15 test files
- not run by any gate: scripts/personal/testing/fake-claude/cli.test.mjs

<!-- gate-evidence:end -->
