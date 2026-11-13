# 1.67.17: one-tap restart after an Android update, Work inside Tasks, usage fix

Based on 1.67.16 (`5f3c636f3bfa`, trunk `c396d9c281`). Branch `release/16717`, built from `feat/android-restart-update` at `a2058ca5fd`. No schema change, the schema stays at 155. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110`. A new Android APK ships with this release.

## Why

The phone installed updates silently in the background, so the owner never knew when a new version arrived. This release asks first: one tap installs and the app reopens itself.

## What changed

- **Restart after an update.** When an update is downloaded the phone posts "hbots X is ready" with a Restart action. One tap installs it and the app opens again by itself. A new receiver reopens the app after the package is replaced. A new permission, display over other apps, lets the app reopen itself, and This phone has a "Let hbots reopen itself" setting. Without the permission the phone posts "hbots updated" and a tap opens the app. The silent install when the app goes to the background is no longer scheduled at download.
- **Update check fix.** The check made at the moment of install now sends the proof for sign-ins bound to a key, and an expired token means ask later instead of dropping the update.
- **Chat load.** A chat that fails to load on the phone retries by itself three times, after 2, 6 and 12 seconds, before the error shows.
- **Tasks.** The filters are Work, Scheduled and Done. The top-level Work tab is gone on web and phone, and `/work` redirects to `/tasks`.
- **Update status lines.** They leave after 10 seconds on phone and web. Problems and "Restarting" stay.
- **Usage.** In `packages/provider-core` a full usage read is merged per window instead of being thrown away after a live tick. This fixes the per-model weekly figure staying stale after a reset.
- **Lint scope.** `vite.config.ts` exempts the Bots web screens from the React Compiler lint rules that came with the 13 Nov upstream sync.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.17. No code changes in the bump commit.

## Migration

None. No file under `apps/server/src/persistence` changed (lead, inferred from the diff, confirmed by the release shipper from `git diff --name-only`).

## Verification

- Emulator test on the gaming PC rig (lead, measured). The Restart tap at 15:18:43 started the install and the 1.67.93 test build was in front at 15:18:46. With the overlay permission denied the "hbots updated" notification posted.
- Kotlin `:hbots-updater` unit tests pass, `hbots-mobile` typecheck 0, `provider-core` typecheck 0 with 44 usage tests passing, parity done 384 planned 0 (lead, measured). Evidence `dev-team/qa/hbots-restart-update/RESULT.md`.
- Not device-tested. Restart tapped after the token expired (about an hour in the background). The code path skips the check, defers the install and asks to open the app.
- The release gates ran on the release commit. The table is below. All nine gates ran once at 16:00 GMT. `server-tests` failed that run (exit 1) on two tests in `src/preview/ServerBrowserPage.test.ts`, which could not launch Chromium.
- `server-tests` was rerun alone with `--gates server-tests --merge` and passed (shipper, measured). The cause of the first failure was the environment, not the code. The server pins `playwright-core` 1.60.0, which needs `chromium_headless_shell` revision 1223. The shared cache `~/.cache/ms-playwright` held only revision 1234, installed by a newer Playwright. Revision 1223 was installed with the pinned 1.60.0 into the isolated path `dev-team/qa/hbots-16717/pw-browsers`, and the rerun used `PLAYWRIGHT_BROWSERS_PATH` pointing there. The shared cache and revision 1234 were not touched. No code changed between the two runs. The first run's evidence is kept at `dev-team/qa/hbots-16717/ship/gate-evidence-run1-failed.json`.

## Rollback

Binary only. The previous release is `5f3c636f3bfa` (1.67.16), schema 155. The previous APK (1.67.15) stays in `android-updates/`.

## Known and accepted

- The owner waived the separate verifier run on 12 Nov. The lead's test evidence stands in for it. No QA recheck after live (Harout, 27 Oct).
- Test branches `test/restart-a` to `test/restart-d` are throwaway and never merge.

## Release notes for users

- When an update is ready the phone tells you. Tap Restart and hbots installs it and opens again.
- Work now lives inside Tasks.
- A chat that fails to load tries again by itself.
- The weekly usage figure per model updates after a reset.

## Gate evidence

<!-- gate-evidence:begin sha=f27c799467b297616d864aafd6e8e5f40feefa9e release=f27c799467b2 json-sha256=eaebeb2c06f6047c15af6c893d30c3bf2674e9f80adfec811e20c1b0b384dfd6 result=PASS -->

- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0
- server-tests: PASS, exit 0

<!-- gate-evidence:end -->
