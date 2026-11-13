# 1.67.15: the "Updated to" note disappears after 10 seconds, releases land a little sooner

Based on 1.67.14 (`3354279c591c`, trunk `3036e0807a`). Branch `release/16715`, built from `feat/16715` at `46cdd2c2b8`. No migration and no schema change, schema stays 148. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110`. A new Android APK ships so the phone gets the shorter note. No new native dependency and no new exported Android component.

## Why

The phone showed "Updated to x" for a minute of server time after a server update. Ten seconds is enough. The release runner's idle gate also took four looks 30 s apart, which added two minutes after the bots went quiet.

## What changed

- **Updated note.** The note stands for 10 seconds from when this app first shows it, once per version, then hides. The banner sits on several screens, so the ten seconds are counted once for all of them. Files: `packages/personal-client/src/update/serverUpdate.ts`, `packages/personal-client/src/update/serverUpdate.test.ts`, `apps/hbots-mobile/src/shell/ServerUpdateBanner.tsx`.
- **Idle gate.** The runner looks every 15 s instead of 30 s, with the CPU budget scaled from 0.6 to 0.3 to match. Four quiet looks are still required and the 90 s without chat events still has to hold through every look. The rest of `config.mjs` changes only import names and line wrapping. File: `scripts/personal/linux/hbots-release/lib/config.mjs`. Release tools are copied per release, so this takes effect for this release.

## Migration

None. The diff against 1.67.14 adds no migration file and writes no row. The runner takes no production backup and does not compact the database.

## Verification

- Builder evidence is in `/home/harout/Claude/AI/dev-team/qa/hbots-16715/summary.txt`. Release tools, personal-client, Android tests, both typechecks and parity exit 0.
- The release gates run once on the release commit. The table is below.
- A version bump commit sits on top of the feature branch. It changes no code.

## Rollback

Binary only. The previous release is `3354279c591c` (1.67.14), schema 148, so the old binary boots on the same database. Rollback APK 1.67.14 has sha256 `f53b9017f1634d661c09609075b8fa4a29094fde5777ea8ce06238b7c37214c1` and stays in `android-updates/`.

## Known and accepted

- The note change was not seen on a real device. It is covered by unit tests and the typechecks.
- Phone push notifications still do not arrive. FCM has no Firebase service account key yet. Voice calls still need a Gemini key.
- The APK is built from the release commit on the laptop with the real key and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The owner's standing rule applies. The lead built this and no separate verifier run was done. The builder's test evidence stands in for it. No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- The "Updated to" note now disappears after 10 seconds.
- Releases land a little sooner: the server checks for a quiet moment twice as often.

## Gate evidence

<!-- gate-evidence:begin sha=6fe945fc8694114b3ae8bfe928e74d3655a4d0cb release=6fe945fc8694 json-sha256=8faf8d3e561b1aba500e74480803f924ac2ddd51eae67476d6503e5b4aae15e7 result=PASS -->

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
