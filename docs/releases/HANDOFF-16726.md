# 1.67.26: goals show what changed and why, camera photo survives Android closing hbots

Based on 1.67.25 (`2b719a700cb6`, trunk `658005f486`). Branch `rc/1.67.26` merges two verified branches over trunk. Schema moves from 158 to 159 (additive). `minimumNativeVersion` is unchanged. A new Android APK ships with this release, including the new native module `hbots-camera`.

## Why

Harout wanted the Tasks tab to show what changed since he last looked, and each goal to say why it matters and what happened. He also lost photos when Android closed hbots while the phone camera was open.

## What changed

- **Goals S3 and S5** (`feat/goals-why`, `21f940ffd0`, which contains `feat/goals-since`). Tasks, Work shows a "Since you looked" box. A goal's sheet shows Why, On it now and What happened (newest first, Show all), and the sheet body scrolls inside its height cap. The `update_project` tool takes a `why` argument (tool list grows 160 bytes, budget 74658). Overdue goals sort before idle ones. Time left rounds to the half hour. The phone now sends `personalWork.since` as an ISO string; the wire frame is unchanged, so old and new builds interoperate.
- **Camera keeps the photo** (`fix/camera-own-intent`, `b53e1a4a00`). hbots launches the system camera itself through the native `hbots-camera` module, writes to a file it owns, and records the launching chat first. If Android destroys the activity or kills the process, a fresh start reopens that chat and claims the photo once. Camera files are deleted once the draft owns a copy, and orphans older than 24 hours are pruned. All 1.67.25 camera behaviour stays.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.26. The parity snapshot is checked in an installed tree after both merges.

## Migration

159 `PersonalProjectsWhyHistory`, additive. Schema 158 to 159. The runner takes the pre-migration backup (`--migration-before 158 --migration-after 159`). Migration 159 was proven on a seeded 158 copy by Verifier 2.

## Verification

- Goals S3: Verifier 2 PASS on the emulator (`dev-team/qa/hbots-goals-view/verify-s3-fix/VERIFY-S3-fix.md`).
- Goals S5: Verifier 2 PASS and recheck PASS (`dev-team/qa/hbots-goals-view/verify-s5/VERIFY-S5.md`, `verify-s5-r2/VERIFY-S5-r2.md`). Sheet drag-to-close could not be proven because adb cannot drag any sheet, and Poteto waived it.
- Camera: Verifier 2 round 6 PASS, device-kept-activities off 4 of 4, process kill 4 of 4, ownership, cleanup and round 4 passes (`dev-team/qa/hbots-projects-camera/camera/verify-r6/VERIFY-camera-r6.md`). D-r6-1 (prune deletes a pending record's file older than 24 hours, canonical versus raw path) was waived by Poteto as low and rare. The fix follows in the next release.
- Full gates run on the release commit.

## Rollback

Binary rollback to `2b719a700cb6` (1.67.25) plus its APK. The database stays at 159. The 159 change is additive, so 1.67.25 boots on it. The pre-migration backup is the data fallback.
