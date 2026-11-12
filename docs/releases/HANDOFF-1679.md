# 1.67.9: reset credit Redeem fix, faster sending, phone cache and composer fixes, smaller database, shared browser

Based on 1.67.8 (`244b94816e71`, main `3da75bce78`). Branch `release/1679`. One migration: 148 `OrchestrationV2CommandReadIndexes`, schema 147 to 148. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Redeeming a Claude reset credit could fail or leave the weekly usage bar wrong. Sending a message was slow on a very large chat. The Android app could hang while it read a big chat copy at start, and the message box did not grow with the text. The state database also held about 7 GB of free pages left by the 1.67.0 history cleanup.

## What changed

- **Reset credit Redeem.** Redeem works again, and the weekly usage bar shows the new window after a reset. A spent credit no longer comes back when two refreshes race. If the server refuses without spending a credit, the app says it could not tell the outcome instead of claiming success.
- **Faster sending.** Migration 148 adds three indexes that the message send path reads. The first start after this release builds them once, which takes about 11 to 39 seconds (measured by the builder and the verifier on a copy of the real database). The server is not ready until that finishes.
- **Phone: chat copy and start.** A chat copy over 1 MB is no longer kept on the phone, so that chat needs a connection to open. A chat copy that is slow or broken to read no longer blocks opening the chat from the server. A start step that throws is retried with a growing wait instead of stopping the app.
- **Phone: message box.** The message box grows with wrapping text and shrinks back after send, at font scale 1.0 and 1.3.
- **Smaller database.** The release runner compacts `statev2.sqlite` while the server is stopped, after the full backup and its integrity check. Harout approved it on 12 Nov 2026: "Yes, compact the database with 1.67.9". No table is dropped. `state.sqlite` and the old v1 tables are not touched.
- **Shared browser.** `~/.config/hbots/env` holds `T3CODE_PERSONAL_BROWSER_BACKEND=shared` and the shared Brave profile folder. They take effect at this restart. Harout waived the sensitive-site block for mail and bank on 12 Nov 2026. No sensitive sites are seeded, and bots still never read cookies, passwords or tokens. To roll this back, delete the two lines and restart through the runner.

## Migration

148 `OrchestrationV2CommandReadIndexes` is additive. It creates three indexes on the v2 command tables and nothing else. It deletes no row and changes no column.

The release changes the schema number and compacts the database, so the runner takes the full production backup first and restores it if the compaction fails.

## Verification

- Slice D (indexes, migration 148), Verifier PASS: `/home/harout/Claude/AI/dev-team/qa/hbots-dispatch/verify/VERIFY-D.md`.
- Slices R and U (Redeem, usage bar), Verifier round 1 and 2: `/home/harout/Claude/AI/dev-team/qa/hbots-redeem/verify/VERIFY-RU.md` and `VERIFY-RU-2.md`. Finding N1 was fixed by the lead in `79c4537376` with a regression test, red then green, in `/home/harout/Claude/AI/dev-team/qa/hbots-redeem/build-n1/`. It was not re-reviewed by the Verifier.
- Phone fixes, Verifier verdict FAIL on one criterion, F1, accepted by the lead: `/home/harout/Claude/AI/dev-team/qa/hbots-1679/verify/VERIFY-PHONE.md`.
- Decisions and accepted items: `/home/harout/Claude/AI/dev-team/qa/hbots-1679/DECISIONS.md`.
- The diff touches `apps/server`, `apps/web`, `packages/` and `apps/hbots-mobile`, so the gate is a full run at the release commit. The table is below.

## Rollback

Binary only for the server. The previous release is `244b94816e71` (1.67.8). The 1.67.8 binary boots on a schema 148 database with exactly one WARN, "Database migration history diverges from this build", measured by the Verifier. Rollback APK 1.67.8 has sha256 `b9deaf70092bff465fa70b905dac48dd1a8eecc73e9203e1728b84bc98f2cca3`. The compaction rolls back by the runner's own restore of the verified backup, and only on a compaction failure.

## Known and accepted

- F1. A phone start step that keeps throwing retries silently and the screen stays on "Starting" with no message and no retry button. Nothing is wiped. The 1.67.8 build stayed on "Starting" with no retry at all. A "still starting, retrying" line and a retry control are the next release.
- Lows from the phone review. F2, a late failing cache read can delete a fresh copy (cache only). F3, a store that ignores cancellation. F4, offline with an oversized copy shows "Loading chat" until online. F5, a doc comment names a missing constant.
- Lows from the index review. A node pointing at another thread's active run is skipped (0 of 43,082 in real data). `INDEXED BY` needs schema 148, and doctor and restore were not tested on an older copy.
- Lows from the Redeem review. N2, the pair-again line may flash while the session loads. N3, `UsageLimitsPooled.tsx` and `apps/mobile` sit outside the shared rule. N4, refusals that spend nothing read as outcome unknown. N5, a top-level `resetsAt` is not guarded against milliseconds. N6, with two credits the kept record is dropped at the first expiry.
- Thirty web unit tests in `ConnectOnboardingDialog`, `reactCompilerCoverage` and `UsageProviderChart` fail on trunk too and are outside the release gate. Repo-root lint (1265 errors) and fmt (79 files) fail on trunk too and are not release gates.
- Not tested: keyboard image insert after the composer change, hardware Enter on a device by the Verifier (the builder tested it), a startup step that hangs rather than throws, and a real phone.
- Phone push notifications still do not arrive. FCM has no Firebase service account key yet. Voice calls still need a Gemini key.
- The APK is built from the release commit on the laptop with the real key and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).
