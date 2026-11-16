# 1.67.28: no goal strip in chat, Work questions clear once opened, several photos at once, no camera icon in the message field

Based on 1.67.27 (`ea030dbb756b`, trunk `269acfe846`). Branch `rc/1.67.28-fixes` merges one verified branch over trunk, clean. An earlier candidate `rc/1.67.28` that also held `feat/scoped-checks` was stopped at the gate and is abandoned. That branch ships in a later release. There is no migration, so the schema stays at 159. A new Android APK ships with this release because the photo picker and the message field are native and phone code.

## Why

Harout asked for four changes on 16 Nov. The goal status strip under the chat header took room and added little. A Work question should go away once he has opened that chat. Adding photos one at a time was slow. The camera icon inside the message field duplicated the camera entry under the plus button.

## What changed

- **Chat screen and Work questions** (`fix/chat-pill-work-read-multipick`, `124c833ebc`). The goal status strip is gone from the chat screen. Goals stay on the Work tab and as the tag in the chats list. A question card on the Work tab disappears once you open that chat, and "Mark unread" in the chat menu brings it back. The server rule reads two existing columns, `last_viewed_at` and `marked_unread_at`, and reaches old APKs too.
- **Photos and message field** (same branch). Plus, then photos: tap several, then "Add N photos". One photo is now three taps. The camera icon inside the message field is gone. Camera is under plus.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.28. The parity snapshot was refreshed on the fixes branch. The release scripts and gates file are unchanged from 1.67.27.

## Migration

None. Measured: no migration, schema or contracts file in the fixes diff. Params use `--migration-before 159 --migration-after 159`, so the runner logs a skipped backup.

## Verification

- Fixes branch: device proof PASS with follow-ups on the emulator, items 1 to 5, 7 and 8, no fatal exception in 155,850 log lines (`dev-team/qa/hbots-fixes-1116/verify/VERIFY-fixes-1116.md`). Item 6 (fallback picker on an image without the embedded picker) was not run.
- Open follow-ups F1, F2 and U1 to U4 were ruled not blocking by the lead (`dev-team/qa/hbots-16728/READY-TO-FOLD-IN.md`).
- Full gates run on the release commit by the installed tool, with `scripts/personal/node/gates-linux.json` byte-identical to trunk `269acfe846`.

## Rollback

Binary rollback to `ea030dbb756b` (1.67.27) plus its APK. The database is unchanged by this release.

## Gate evidence

<!-- gate-evidence:begin sha=6bc353268a0386bb1459fa7880bec4334941d084 release=6bc353268a03 json-sha256=f226089452d81ec266cf0effa6c0afa4b28cb364b04954e96d4dbe43f6c070ab result=PASS -->

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
