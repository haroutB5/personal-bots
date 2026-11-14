# 1.67.20: reply preview in phone notifications, gate tooling

Based on 1.67.19 (`d8a0c8f57126`, trunk `50a0d0e865`). Branch `release/16720`, built from `rc/1.67.20` at `2458a81da3`. No schema change (stays 157). `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` is unchanged. A new Android APK ships with this release (version bump only in the mobile package), built with Firebase on.

## Why

A phone notification for a bot reply said only "New message", so Harout had to open the app to see what the bot said. Release gate runs also lost time to a hand-set gate environment and to running gates whose inputs had not changed.

## What changed

- **Reply preview in notifications.** The stored phone notification text for a chat reply is now a plain-text preview of the reply, up to 500 characters (`apps/server/src/personal/push/PersonalPushService.ts`, `57d808d2e7`). The phone fetches that text from the hbots server. The FCM payload is unchanged and still carries ids only, so the reply text never goes through Google. Proof `dev-team/qa/hbots-push-preview/RESULT.md` (emulator, tests 71 of 71).
- **Gate tooling.** The gate collector sets its own `TMPDIR` under `/tmp/hbots-gate-*` and removes it, sets `PLAYWRIGHT_BROWSERS_PATH` to the pinned folder unless the caller set one, decides skips from a gate-inputs table (an unknown path runs every gate) and has a `--dry-run` flag (`c11d90c15e`, `024ea2e1d7`, `ac62d252d1`). Write-up `dev-team/qa/hbots-release-speed/build/`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.20. No code changes in the bump commit.

## Migration

None. Schema stays 157. The runner skips the backup (no migration).

## Verification

- Reply preview (Verifier, measured): notification shows the preview on the emulator, the FCM body carries ids only, the fallback still shows "New message" when the server cannot be reached. `dev-team/qa/hbots-push-preview/RESULT.md`.
- Gate tooling: reviewed and merged by the lead. This release is its first real gate run.
- Full gates run on the release commit below.

## Rollback

Binary only. The previous release is `d8a0c8f57126` (1.67.19). No schema change, so 1.67.19 boots on the same database. The previous APK (1.67.19) stays in `android-updates/`.

## Known and accepted

- No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- Notifications show a preview of the bot's reply.
- The reply text is fetched from your own server and never sent through Google.
