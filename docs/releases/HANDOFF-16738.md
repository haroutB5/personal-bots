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
