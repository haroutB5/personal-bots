# 1.67.18: phone notifications through Firebase, archived chat fix

Based on 1.67.17 (`f27c799467b2`, trunk `2aa9c6c7de`). Branch `release/16718`, built from `rc/1.67.18` at `15a5374af2`. No schema change, the schema stays at 155. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` is unchanged. A new Android APK ships with this release, built with Firebase on.

## Why

Chat replies never reached the phone as a notification. The server could not read a Firebase server key, the release APK was built without Firebase, and the engine handed the end of a run to only one of its readers, so the push reader never saw a reply finish. Separately, archiving a chat that was just started left a "New chat" chip behind on phone and web.

## What changed

- **Firebase server key.** The server reads the Firebase server key from `<baseDir>/personal/fcm-service-account.json` when no saved secret holds it (`c13d867cd6`).
- **Firebase in the Android build.** `build-android.sh` sources `scripts/firebase-env.sh` and prints one Firebase on or off line (`caec1ca773`, `65bf3ce230`).
- **Engine events.** Every subscriber of `engine.events` gets its own turn state. Before, only the first reader of a finished run got `TurnEnded`, so chat replies were never pushed (`25f47c614b`, with a regression test).
- **Archived chat.** An archived chat no longer stays as a "New chat" chip, on phone and web (`2beadb99bc`, parity snapshot `8eafb1ff93`).
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.18. No code changes in the bump commit.

## Migration

None. No file under `apps/server/src/persistence` changed (shipper, measured with `git diff --name-only 2aa9c6c7de 15a5374af2`).

## Verification

- Real FCM push on an emulator (builder, measured). The server logged `path: 'phone', sent: 1`, the notification showed with the app in the background, and a tap opened the chat. Evidence `dev-team/qa/hbots-fcm/RESULT.md`.
- Archived chat fix (builder, measured). Web proof at phone size, tests 170/170 phone and 112/112 web. Evidence `dev-team/qa/hbots-archive-new/`.
- The engine fix touches every reader of `engine.events`, so the full server suite runs in the release gates below.

## Rollback

Binary only. The previous release is `f27c799467b2` (1.67.17), schema 155. The previous APK (1.67.17) stays in `android-updates/`.

## Known and accepted

- The owner waived the separate verifier run for this release. The lead read the engine diff and accepts it. No QA recheck after live (Harout, 27 Oct).
- Test branch `test/fcm-live-a` is throwaway and never merges.
- A chat-reply notification reads "Open the chat to read it." and does not show the reply text.

## Release notes for users

- Notifications now arrive on the phone.
- Archived chats leave the chat row.
