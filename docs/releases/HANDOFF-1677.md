# 1.67.7: push follows the session, Android rounds r3 to r11, voice calls, one chat per Share, locked links

Based on 1.67.6 (`0ed8cfa02c3d`, main `caed537d92`). Branch `integ/1.67.7`. Two migrations: 145 `PersonalPushSubscriptionSession` and 146 `PersonalSensitiveSites`, schema 144 to 146. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Follow-ups from 1.67.6 (revoked sessions kept push and live sockets, the phone Computer screen could not take control back), the Android rounds r3 to r11 (app lock, encrypted offline cache, share target and Quick Settings tile, notification actions, launcher shortcuts, a home widget, a working notification, a faster new chat), voice calls in the app, Share that made more than one chat, an app lock that let a link act before it closed, and shared bot pages in the browser.

## What changed

- **Push and sessions.** Browser push follows the successor session, so a re-paired phone keeps its pushes. A revoked session loses its push subscriptions and its live sockets at once. The mobile live ticket now carries a DPoP proof.
- **Take control back.** The phone can take control of the Computer screen back after losing it, and keeps password mode after an email field.
- **Android rounds r3 to r5.** An optional app lock, the offline chat cache and queued attachments encrypted at rest, sign-out that wipes the cache, outbox and shortcuts, a share target and a Quick Settings tile for a new chat, notification content with reply and answer actions, per-bot notification channels, picture in picture for the live view, and a hardware Enter that sends.
- **Voice calls (r9).** The app can place a voice call to a bot, and it releases the microphone when it goes to the background. Voice calls need a Gemini key that is not saved yet, so no call works until Harout saves one.
- **Shortcuts, widget and notification (r10, r11).** Launcher shortcuts open a bot or start a new chat. A home widget lists the bots. A working notification shows while a bot runs and goes away after. New chat start waits for a slow connection and says so instead of failing.
- **Share.** One share makes one chat. A share that times out ends in "Couldn't send. Try again." after about 15 seconds, and the retry fills the chat made at the lost forward.
- **App lock.** A link that brings the app back from the background is held until the lock closes, and then acts once. A notification tap and a launcher shortcut are held the same way.
- **Browser host.** The personal browser host serves select, refuses unsupported operations honestly, closes its tab, and explains shortened waits. Shared bot tabs stay usable behind the user's tab and a frame pump keeps them drawing. Imported sensitive sites count as sensitive without a saved login (migration 146).
- **Shared Brave backend.** It is in the code and ships switched off. Nothing in this release turns it on and it is not a feature of 1.67.7.

## Migrations

Both are additive. Neither deletes or rewrites a row.

- **145 `PersonalPushSubscriptionSession`.** Adds a nullable `auth_session_id` column to `personal_push_subscriptions` when it is missing, and the index `idx_personal_push_subscriptions_session`. A subscription saved before this has no session and receives nothing until its browser sends it again.
- **146 `PersonalSensitiveSites`.** Creates `personal_sensitive_sites` (origin, label, primary key on both) with `IF NOT EXISTS`.

The release is a migration change, so the runner takes the full production backup first.

## Verification

- Verifier PASS, device smoke at `1cf1901f25`, with finding M-A: `/home/harout/Claude/AI/dev-team/qa/hbots-1677-integ/VERIFY-SMOKE.md`.
- Verifier PASS at `b977df1e46`, M-A fixed and Share makes one chat: `/home/harout/Claude/AI/dev-team/qa/hbots-1677-integ/VERIFY-LOCK-SHARE.md`.
- Earlier per-branch verifications are named in the merge commit messages of the branches above.
- The diff touches `apps/server`, `apps/web`, `packages/` and `apps/hbots-mobile`, so the gate scope is a full run at the evidence commit. The table is below.

## Rollback

Binary only. The previous release is `0ed8cfa02c3d` (1.67.6). Migration 145 adds a nullable column and an index, and 146 adds a table, so the 1.67.6 binary runs on the 146 schema without change.

## Known and accepted

- Phone push notifications do not arrive. FCM has no Firebase service account key yet, so the server keeps it off.
- Voice calls do not work until Harout saves a Gemini key.
- The shared browser backend is off. `T3CODE_PERSONAL_BROWSER_BACKEND` stays unset.
- Two Low findings from the lock and share check go to 1.67.8. L-1: resuming onto an open chat marks it viewed while the PIN prompt is up (pre-existing). L-2: system Back on the Share confirm step closes the whole picker (pre-existing).
- The APK is built from the release commit and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).
