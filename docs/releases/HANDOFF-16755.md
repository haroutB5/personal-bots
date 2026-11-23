# 1.67.55: "Working in background" on the Bots list

Based on 1.67.54 (trunk `a5ff83c5d4`). Branch `release/hbots-1.67.55`, built in release slot 1. Merges `feat/hbots-bg-status` (`8755397111`), `feat/hbots-email-6c` (`a76c287717`) and `feat/hbots-verify-f13-f14` (`efa6b67f36`). **No migration** (schema stays 161), so the gates are tiered: the blocking tier runs before the release and the finisher runs the async tier after it. This release ships Android APK 1.67.55 and server 1.67.55.

## Why

Harout, 23 Nov 2026, with screenshots: while Opuser's 1.67.54 task ran its gates in the background, the task card in Opusito's chat said "Working", Opuser's row on the Bots list said "Ready" and the chat header said "Idle". The task was `running` with `waitingOnBackgroundSince` set; only the Tasks screen and the task card knew.

## What changed

- **Working in background (phone and shared client).**
  - `buildBotSummaries` takes `backgroundThreadIds`: the chats of running tasks with `waitingOnBackgroundSince` (`threadIdsWaitingOnBackground`). The Bots screen builds it from the live task feed.
  - The summary gets `workingInBackground` (not live, and a linked chat's task waits on background work). `botStatus` says "Working in background" just below the live states; the needs-you states still win.
  - The Bots list sorts it with the working bots and gives it the working dot (and the pinned tile its working badge).
  - The task's own chat header says "Working in background" instead of "Idle", with the working dot colour. The task card in the delegating chat says "Working in background" instead of "Working", with no step left current.
  - A live turn (the background job woke the bot) is plain "Working" again everywhere, and the label goes when the task ends.
- **Email screen, finding 6c (Low, from 1.67.54).** The unsupported state showed the add-on's reason as it came, which could be the Commonpost notice or a raw add-on error. hbots's own sentences still show as they are. The add-on's notice and the bridge's start, timeout and cancel failures map to plain lines, and any other text becomes "Thunderbird's mail add-on reported an error."
- **Emulator QA.** Flow 13 (Settings, Integrations, Email, the no-bridge repair state) is committed to `drive.py`; in 1.67.54 it ran as a temporary patch. New flow 14: Assistant delegates a background task to Planner, and the task card, Planner's row and the task chat header must all say "Working in background"; Interrupt clears the card and the row.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.55`.

## Release notes for the phone

1. The Bots list and chat header say "Working in background" while a bot's task waits on background work

## Verification

To be filled in from the gate run and the emulator run.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.54 (`fdbd73c95a40`). No schema change, so the rollback is clean.
