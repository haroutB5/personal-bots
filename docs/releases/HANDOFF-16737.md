# 1.67.37: a queued photo or file survives a failed open

Based on 1.67.36 (`9d4f27071759`, trunk `e21acd1948`). Branch `rc/1.67.37` is cut from trunk and holds two separate no-ff merges, in this order: `feat/check-followups` (head `5bd3bf9c16`), then `fix/keep-queued-attachment` (head `f2ebebabdb`). The schema stays at 160. The Android secure module changes, so this release ships a new APK.

## Why

A photo or file waiting to send was deleted when opening it failed for a reason that says nothing about the file, such as low memory or a busy key store or a full disk. The only copy was gone and the message stayed stuck. The fix deletes the sealed file only when its content is bad.

## What changed

- **Keep the queued attachment.** `CacheCrypto.kt` `FileCrypto.decryptFile` deletes the source only for a bad tag or a missing header. Any other failure, and an out of memory error, delete only the partial copy and report failure. The file stays queued for another try.
- **Check tooling follow-ups (not user facing).** The commit reader splits on NUL, so any commit body parses. The gate tool reads the live release's gate commands and names any gate the change edits. `docs/personal/REVIEW.md` gains R12.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.37.

## Release notes for the phone

- A photo or file waiting to send is no longer lost if the phone runs short of memory or storage while sending it.

## Migration

None. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Merge 1. Verifier PASS in `dev-team/qa/verification-article/followups/review/REVIEW.md`. The tree planner and the installed planner give the same plan (R03).
- Merge 2. Builder proof in `dev-team/qa/hbots-cachecrypto-oom/BUILD.md`. Red was 2 of 34 failing, green was 31 of 31 CacheCryptoTest.
- The release check runs with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects. The runner's `prepare` must seal before arming.

## Rollback

Binary rollback to `9d4f27071759` (1.67.36). No data change, so no data restore.

## Gate evidence

<!-- gate-evidence:begin sha=9b4be0babfcb631cd0e07f3a7c3262a7fd09ebc9 release=9b4be0babfcb json-sha256=ac074641510728d50af82b58b0ae649f9fe796a0e2e4604ba6a99097053bcaa6 result=PASS -->

- server-tests: SKIPPED, skip: no changed path is an input of server-tests: apps/server, packages, scripts/personal/adblock, scripts/personal/dsh-runtime, scripts/personal/updates, scripts/personal/sync, scripts/personal/testing (not packages/personal-client/, packages/client-runtime/)
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: SKIPPED, skip: no changed path is an input of e2e: apps/server, apps/web, packages, scripts/personal/e2e, scripts/personal/node/e2e-smoke.mjs, scripts/personal/testing
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, selected: hbots-mobile-kotlin inputs changed: apps/hbots-mobile/modules/hbots-secure/android/src/main/java/expo/modules/hbotssecure/CacheCrypto.kt, apps/hbots-mobile/modules/hbots-secure/android/src/test/java/expo/modules/hbotssecure/CacheCryptoTest.kt; selected 1 Gradle tasks
- parity: PASS, exit 0
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/dev-team-tools/gate-common.mjs, scripts/personal/linux/dev-team-tools/gate-evidence.mjs, scripts/personal/linux/dev-team-tools/tools.test.mjs, scripts/personal/linux/hbots-release/lib/gateScope.mjs, ...; selected 15 test files

<!-- gate-evidence:end -->
