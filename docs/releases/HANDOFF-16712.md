# 1.67.12: a Work tab that shows what every bot works on

Based on 1.67.11 (`5a1d157f6007`, trunk `af79b1171d`). Branch `release/16712`, built from `feat/16712-work` at `69c48c1014`. No migration and no schema change, schema stays 148. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110`. A new Android APK ships so the phone gets the new tab and the widget picker pictures. No new native dependency and no new exported Android component.

## Why

There was no single place to see what the bots are doing, for how long, and who started it.

## What changed

- **Work tab.** A new second tab on web and on Android shows a timeline of what every bot works on, how long each piece took, and who started it. Tapping a bar opens its detail.
- **Shared model.** The timeline is built in one shared module, `packages/personal-client/src/work/workTimeline.ts`, so web and Android show the same rows.
- **Web.** `apps/web/src/features/personal/WorkScreen.tsx`, the route `_personal.work.tsx` and the tab bar.
- **Android.** `apps/hbots-mobile/src/work/WorkScreen.tsx`, the bottom bar, the app shell and the navigation routes.
- **Parity.** The Work tab is owned on Android in the parity registry, and `parity.json` is regenerated.
- **Widget picker pictures.** Each of the eight home screen widgets has an example picture in the widget picker. Eight PNG files in `drawable-nodpi`, one `android:previewImage` line in each widget info XML, and a test, `apps/hbots-mobile/src/widgetPreviews.test.ts`. Resources only, no code and no new component.

## Migration

None. The diff against 1.67.11 touches no file under `apps/server`, so no file under `apps/server/src/persistence` changed. The runner takes no production backup and does not compact the database. The server binary logic is the same as 1.67.11.

## Verification

- The work module tests pass, 15 of 15. The web unit tests for the touched files pass. Web typecheck and Android typecheck report 0 errors. Android unit tests passed 1350 of 1350 before the last two small commits, which changed one label function.
- The parity check exits 0 (done 383, unassigned 0). The commit hooks for format, lint and unused-code checks pass.
- The web screen was rendered in Chromium at 360 by 785, dark, in three states. The screenshots are in `/home/harout/Claude/AI/dev-team/qa/hbots-16712/` (`web-4h.png`, `web-1h.png`, `web-detail.png`).
- The release gates run once on the release commit. The table is below.
- A version bump commit and a commit that regenerates `scripts/personal/parity/parity.json` with the gate's `HEAD` refs sit on top of the feature branch. They change no code.

## Rollback

Binary only. The previous release is `5a1d157f6007` (1.67.11), schema 148, so the old binary boots on the same database. Rollback APK 1.67.11 has sha256 `732eac7df0df1fa86c8aaaa250cceaca5051965e49265814757b1a3fec106ab0` and stays in `android-updates/`.

## Known and accepted

- The Android Work screen was not seen on a device. Harout accepted this on 12 Nov. The web screen was seen in a browser and the Android screen is covered by its unit tests and the typecheck.
- Phone push notifications still do not arrive. FCM has no Firebase service account key yet. Voice calls still need a Gemini key.
- The APK is built from the release commit on the laptop with the real key and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The owner's standing rule of 12 Nov applies. No separate verifier run was done ("no need for verification run"). The builder's test evidence stands in for it. No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- A new Work tab shows what every bot works on, how long it took, and who started it.
- It is the second tab, on web and on Android.
- Each widget now shows an example picture in the widget picker.

## Gate evidence

<!-- gate-evidence:begin sha=fbd4e3e31908513da4c69e392e35034178bbae6a release=fbd4e3e31908 json-sha256=0145fe64160e95d51755a73840c2f3bdd5d536e3b7f66f59579adaad5200ea67 result=PASS -->

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
