# 1.67.25: goals on Tasks show readable titles and their running work, camera in the plus sheet

Based on 1.67.24 (`cff9ad944c11`, trunk `f5a7d43e86`). Branch `rc/1.67.25` merges two verified branches over trunk. Schema stays at 158, no migration. `minimumNativeVersion` is unchanged. A new Android APK ships with this release.

## Why

Harout wanted goals on the Tasks tab to read clearly and show the work running under each goal, and a faster way to attach a photo from the plus button, with a way out when the phone camera gets stuck.

## What changed

- **Goals view** (`feat/goals-view`, `66e866421d`). Tasks show readable titles. Running work is nested under its goal, each goal has a line saying what is happening now, and work that belongs to no goal sits under "Not in a goal".
- **Camera in the plus sheet** (`feat/plus-camera`, `2707daef26`). The plus button has a camera row and your recent photos. One tap adds a photo and it shows at once. Photos are resized with no location data. If the phone camera gets stuck, hbots opens its own camera and shows the error code. A black capture asks for a retry.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.25. The parity snapshot is regenerated in an installed tree after both merges.

## Migration

None. Schema 158 to 158. The runner skips the backup.

## Verification

- Goals view: Verifier 2 PASS on the emulator for items 1 to 5. The TalkBack item was waived by Poteto on accessibility-tree evidence (`dev-team/qa/hbots-goals-view/verify/VERIFY-S1-S2.md`).
- Camera: Verifier 2 round 4 PASS on every required item (`dev-team/qa/hbots-projects-camera/camera/verify-r4/VERIFY-camera-r4.md`). Item 6, a system camera photo lost after the activity is destroyed, was waived by Poteto because trunk loses it the same way. Follow-up D-r4-1 is with Architect.
- Full gates run on the release commit.

## Rollback

Binary rollback to `cff9ad944c11` (1.67.24) plus its APK. No schema change, so 1.67.24 boots on the live database.

## Gate evidence

<!-- gate-evidence:begin sha=2b719a700cb65a234cdf3572816fe08dd911a07b release=2b719a700cb6 json-sha256=e74239b4d391c7b3cc606054e0a8f1802b61594b1b3258969fee3bfb373fa273 result=PASS -->

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
