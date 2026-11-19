# 1.67.38: double tap to select text, smoother streaming redraw, far less idle data

Based on 1.67.37 (`9b4be0babfcb`, trunk `2de6ac218f`). Branch `rc/1.67.38` is cut from `fix/select-polish` (head `7858b952d5`), which sits 11 commits ahead of trunk, so trunk fast-forwards to the release. The schema stays at 160. A new Android native module (`hbots-textselect`) is added, so this release ships a new APK.

Not included: `feat/live-streaming` (`541cf8a801`) is held and is not merged.

## Why

Harout selects text in bot replies on the phone. The old Select text view needed a long press and a menu, long replies redrew every paragraph on each streamed chunk, and the phone downloaded about 42 KB every 5 seconds just to prove the server was alive.

## What changed

- **Smoother redraw of long replies** (`3070b2609a`). The phone redraws only the paragraph that is growing while a reply streams.
- **Double tap to select** (`7922db2f95` to `4e77ac94ad`). A double tap on a bot message opens Select text with the tapped word selected, with handles and a toolbar. Select text reads through a selectable reader and the native module `hbots-textselect`. Back clears the selection first, then closes the view.
- **One Back after Copy** (`19d3a6d8c3`). After Copy, one Back closes the Select text view.
- **Less data while open** (`7858b952d5`). The phone's 5 second liveness probe sends `server.probe` instead of `server.getConfig`. Measured idle download went from 31.9 MB per hour to 0.74 MB per hour.
- **Test only** (`f974055c1a`). A double tap rejects a second tap that lands too far above or below.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.38.

## Release notes for the phone

- Double tap a bot message to select text.
- One Back closes after Copy.
- Uses far less data while hbots is open.
- Smoother redraw of long replies.

## Migration

None. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Verifier PASS on `7858b952d5`, defects Low only. Records `qa/hbots-streaming/RECHECK.md` and `qa/hbots-streaming/VERIFY.md` (slices 2 and 3), build records `qa/hbots-streaming/slice2/BUILD.md`, `slice3/BUILD.md` and `select-polish/BUILD-D7.md`. These records live on the previous laptop and were not copied to this host.
- The release check runs with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects. The runner's `prepare` must seal before arming.

## Rollback

Binary rollback to `9b4be0babfcb` (1.67.37). No data change, so no data restore.

## Gate evidence

<!-- gate-evidence:begin sha=6e7bc80a84ea13d9e56dfba71c48a5fc1d4609bd release=6e7bc80a84ea json-sha256=d66d137db76682ccab71f92880dd4fe8be7b3e08af466815ad9ec09bbed99f49 result=PASS -->

- server-tests: SKIPPED, skip: no changed path is an input of server-tests: apps/server, packages, scripts/personal/adblock, scripts/personal/dsh-runtime, scripts/personal/updates, scripts/personal/sync, scripts/personal/testing (not packages/personal-client/, packages/client-runtime/)
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: SKIPPED, skip: no changed path is an input of e2e: apps/server, apps/web, packages, scripts/personal/e2e, scripts/personal/node/e2e-smoke.mjs, scripts/personal/testing
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner
- hbots-mobile-kotlin: PASS, selected: hbots-mobile-kotlin inputs changed: apps/hbots-mobile/modules/hbots-textselect/android/build.gradle, apps/hbots-mobile/modules/hbots-textselect/android/src/main/java/expo/modules/hbotstextselect/Dismissal.kt, apps/hbots-mobile/modules/hbots-textselect/android/src/main/java/expo/modules/hbotstextselect/HbotsTextSelectModule.kt, apps/hbots-mobile/modules/hbots-textselect/android/src/test/java/expo/modules/hbotstextselect/DismissalTest.kt, ...; selected 1 Gradle tasks

<!-- gate-evidence:end -->
