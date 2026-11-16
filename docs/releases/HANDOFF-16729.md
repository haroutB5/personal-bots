# 1.67.29: a Work question also shows when the answer finished after you left the chat, and faster release checks from the next release on

Based on 1.67.28 (`6bc353268a03`, trunk `01a278438e`). Branch `rc/1.67.29` merges two reviewed branches over trunk, clean, no squash. There is no migration, so the schema stays at 159. A new Android APK ships with this release so every version number agrees. The APK has no phone code change.

## Why

A Work question card was hidden when the reply finished after the owner had left the chat, so the question never showed. The release tool also ran every test in every check, about 22 minutes a release. Harout asked for scoped checks on 15 Nov.

## What changed

- **Work question card** (`fix/work-card-finished-after-leave`, `3d8d8dda73`). A question on the Work tab now also appears when the answer finished after you left the chat. This is a server rule only, two files. It reads existing columns (`updated_at`, `created_at`, `is_streaming`).
- **Scoped release checks** (`feat/scoped-checks`, `9c1a446e48`). The release tool picks the tests inside each check from the changed files. This is scripts only, 16 files under `scripts/`. It cannot change the running app. This release still runs every check in full with the installed tool and the old gates file. The new tool is installed after this release is live, and the next release plans from the changed files.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.29. The parity snapshot is unchanged by both branches.

## Migration

None. Measured: no migration, schema or contracts file in the diff. Params use `--migration-before 159 --migration-after 159`, so the runner logs a skipped backup.

## Verification

- Scoped checks: reviews 4 and 5 PASS (`dev-team/qa/hbots-scoped-checks/verify4/VERIFY4-scoped-checks.md`, `verify5/VERIFY5-bootstrap.md`). The review 5 follow-up V5-1 is fixed on the branch at `9c1a446e48` (`dev-team/qa/hbots-scoped-checks/v5-1/`).
- Work card fix: red on trunk code 2 of 30 failed, green 12 server test files and 257 tests (`dev-team/qa/hbots-fixes-1116/f2/BUILD.md`). Accepted on builder proof, small fix.
- All nine gates run in full on the release commit by the installed tool with `scripts/personal/node/gates-linux.json`, byte-identical to trunk. No check runs the tool's own tests, so the 17 release-tool test files were run by hand on the release tree inside heavy-job (see the gate evidence section).
- Release and dev-team tool tests, run by hand on the release tree `fc56dd8285cf` inside heavy-job, 17 files: 170 of 170 pass, 0 fail, exit 0, 14:03 to 14:08 GMT (`dev-team/qa/hbots-16729/ship/release-tools.log`). The installed tool has no such check, so this is the proof for the scripts this release carries.
- Known caveat (inferred by the builder from code): on turns with image embeds the provider re-emits the finished answer a few seconds later, so a seen card can return once.

## Rollback

Binary rollback to `6bc353268a03` (1.67.28) plus its APK. The database is unchanged by this release.

## Gate evidence

<!-- gate-evidence:begin sha=fc56dd8285cf4713232c1698e568cbb2ac10b73e release=fc56dd8285cf json-sha256=e8458a7fae764f01f36a3d98685dce208bcaf52d6b6975dcf49cbc3fd47dc9a7 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0

<!-- gate-evidence:end -->
