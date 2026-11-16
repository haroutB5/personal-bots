# 1.67.27: each goal names the chat that runs it, chats show their goals, camera photos clean up

Based on 1.67.26 (`9a251eb0b91b`, trunk `47d06bcf89`). Branch `rc/1.67.27` merges two verified branches over trunk, both clean. There is no migration, so the schema stays at 159. A new Android APK ships with this release because the camera cleanup is native Kotlin.

## Why

Harout could not keep up with which goal runs in which chat. He asked to know which bot chat orchestrates each goal, and for chats to say which goal they serve. He also did not want sent camera photos to pile up in the app cache, and a photo a pending record points at must never be pruned.

## What changed

- **Goal owner chat and tags** (`feat/goals-owner-chat`, `7f67608a48`, which contains `feat/goals-tags` and `feat/goals-answer`). Each goal card on Tasks, Work shows one line under its title with the lead bot and the chat that runs it. A tap opens that chat. The goal sheet shows the same line first. A chat row shows the goals it serves as tags, with a count of goals done in the last 7 days, and a chat shows its goal as a pill under the status line. Goal questions show answer buttons in Needs you, and some answers ask to confirm before they send. The goals list gains an optional `chats` field on the server and contracts. An old server does not send it, and the phone then falls back to the goal's own chat.
- **Camera cleanup** (`fix/camera-prune`, `5e6b306021`). The 24 hour camera prune compares canonical paths, so it never deletes the photo a pending record points at. A camera draft copy leaves `cacheDir/camera-drafts` when its draft is sent or removed, and old copies are pruned at app start.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.27.

## Migration

None. Measured: no migration file in either branch diff and none in the merged diff. Params use `--migration-before 159 --migration-after 159`, so the runner logs a skipped backup.

## Verification

- Goals S4 answer buttons: Verifier PASS, 13 of 13 items (`dev-team/qa/hbots-goals-view/verify-s4/VERIFY-S4.md`).
- Goals S6 tags and pill: 16 of 17 items, the failing item fixed by round 2 (`dev-team/qa/hbots-goals-view/verify-s6/VERIFY-S6.md`).
- Goals owner chat line: Verifier device pass PASS, items 1 to 11 and 13, with the new server and the 1.67.25 and 1.67.22 servers (`dev-team/qa/hbots-goals-view/verify-owner-chat/VERIFY-owner-chat.md`). Observations O1, O2 and O3 are low and are held for Harout.
- Camera r7: Verifier 2 PASS on the emulator, 7 items plus 42 of 42 Kotlin tests (`dev-team/qa/hbots-projects-camera/camera/verify-r7/VERIFY-camera-r7.md`). Item 5, "sends after restart", cannot be proven by design.
- Full gates run on the release commit.

## Rollback

Binary rollback to `9a251eb0b91b` (1.67.26) plus its APK. The database is unchanged by this release.
