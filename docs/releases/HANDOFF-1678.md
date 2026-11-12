# 1.67.8: provider updates resume, a calmer chat screen, machine stats, drag to reorder pins, two-swipe delete

Based on 1.67.7 (`0ac33352a228`, main `f41273b97b`). Branch `integ/1.67.8`. One migration: 147 `PersonalBotPinOrder`, schema 146 to 147. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Eleven owner requests on the Android app and the Bots home, plus one server fix. Provider auto-update had stopped working because the maintenance runner was not provided in the server layer. The chat screen, the bot list and the settings page needed the changes the owner asked for after living with 1.67.7.

## What changed

- **Provider updates resume.** The server layer now provides the one maintenance runner, so provider auto-update runs again. CLI tools on the host may update themselves after this release.
- **Chat header.** Tapping the chat header opens that bot's settings.
- **Chat tabs.** The selected chat tab scrolls fully into view.
- **Chat menu.** The three dots menu is shorter. Token usage sits before Delete chat.
- **Sending.** Send clears the text box at once. A send that fails shows "Not sent" with "Try again" and keeps its text, quote and files. A send that gets no answer fails after a wait instead of hanging.
- **Camera and jump to latest.** Camera moved under the plus button. A jump to latest button appears when the chat is scrolled up.
- **Computer tab.** Shows the host machine's stats. `GET /api/personal/performance/summary` gains the fields `cpuTempC`, `diskTempC` and `fans`. They are read off the request path and are empty when the host reports no sensor.
- **Delete a bot.** Two swipes. The first arms the row, the second opens a confirm dialog that says the delete is permanent. A touch elsewhere disarms the row.
- **Pinned bots.** Drag a pinned bot to reorder the strip. The order is saved on the server (migration 147, RPC `personalBots.reorderPinned`).
- **Settings.** Regrouped into sections with a search box. An empty search says no settings match.
- **Share.** System Back on the Share picker returns to the bot list.
- **Smaller fixes.** The name sheet stays above the keyboard. Small chat controls are at least 44 dp. The Computer strip has a 44 dp touch target.

## Migration

147 `PersonalBotPinOrder` is additive. It adds a nullable `pin_order` integer column to `personal_bots` and numbers the bots that are already pinned from zero in their current list order. It deletes no row and rewrites no other column.

The release changes the schema number, so the runner takes the full production backup first.

## Verification

- Verifier PASS, device pass F1 to F9 at `f7354fb5c8` on the emulator: `/home/harout/Claude/AI/dev-team/qa/hbots-1678/VERIFY-DEVICE-3.md`.
- Verifier device pass R1, R2, R4, R6, R8 PASS: `/home/harout/Claude/AI/dev-team/qa/hbots-1678/VERIFY-DEVICE-2.md`.
- Verifier code review, checks 1, 2, 4, 5, 6 PASS, findings M1 and M2 fixed and proven on device in DEVICE-3: `/home/harout/Claude/AI/dev-team/qa/hbots-1678/VERIFY-CODE-2.md`.
- Lead checks at `f7354fb5c8`: lint 0, mobile and personal-client typecheck 0, 1233 mobile tests, 840 personal-client tests (`/home/harout/Claude/AI/dev-team/qa/hbots-1678/integ/c3-*.log`).
- The diff touches `apps/server`, `apps/web`, `packages/` and `apps/hbots-mobile`, so the gate is a full run at the release commit. The table is below.

## Rollback

Binary only. The previous release is `0ac33352a228` (1.67.7). Migration 147 adds a nullable column, so the 1.67.7 binary runs on the 147 schema without change. Rollback APK 1.67.7 has sha256 `c9fd4aeee23a826c2bac8be6782caf7e7df9b53dc6ce3464669772eb7b16e4ff`.

## Known and accepted

- Phone push notifications still do not arrive. FCM has no Firebase service account key yet.
- The shared Brave browser backend is off and is not a feature of this release.
- Voice calls still need a Gemini key.
- Lows found in review and not fixed here. Save on the name sheet leaves the keyboard up. The Gboard expanded GIF panel can cover Send. A held send blocks that chat's queue until the app reconnects. An unencrypted copy of a send's attachments stays in the private cache while the send is failed. The refusal notice shows the raw server error text. `message.dispatch` is slow on very large chats, which is server-side and not fixed.
- The APK is built from the release commit and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).

## Gate evidence

<!-- gate-evidence:begin sha=244b94816e7126e8cbe3215b4c35655292b0d86d release=244b94816e71 json-sha256=a1da5a2561ee6b04af579e2288a2a5584cc0c11a6c6e2f0b24835d3d15b59e32 result=PASS -->

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
