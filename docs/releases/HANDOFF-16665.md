# HANDOFF 1.66.65

Two front-end changes for Harout's 17 Oct request from his iPhone: a bot's own routines are now
listed in that bot's settings, and a routine due later on the same London day reads "Today, 14:30"
instead of "Sat 17 Oct, 14:30" everywhere the app shows a next run. No server, contract or migration
change; the maximum migration stays 111. Web-only; `PERSONAL_TASKS_CONCURRENCY` stays 5.

**Version note**: the brief named 1.66.64, but `release/hbots-16664` already exists on origin with the
DeepSeek Harness 0.2.1-rc.2 pin and is staged from the same main commit (`553304db87`). To avoid two
releases on one version, this work is 1.66.65 on `release/hbots-16665`; the CTO can ship it after or
instead of 1.66.64.

Branch `release/hbots-16665`, based on `personal-bots/main` at `553304db87`. Code commits: one for the
Today label and its tests, one for the bot settings Routines section and its tests, one for the
version bump and these notes.

## 1. A bot's routines are in its settings

`BotForm.tsx` gains a **Routines** card between the scheduled-model card and Team, on the edit screen
only (`bot !== null`; a new bot has no routines to list). The new
`BotRoutinesSection.tsx` reads the already-cached `usePersonalRoutines` query (no extra round trip),
filters it to this bot and puts enabled routines first, both groups in the server's Scheduled order
(`botSettingsRoutines` in `conversationRoutinesModel.ts`). Each row shows the title, the schedule in
words (`describePersonalRoutineTrigger`, the same line the Scheduled list uses) and the next-run label
(or "Paused"), and opens `/tasks/routines/$routineId`, the existing detail page with edit, pause and
delete. Empty state: "No routines yet". A "New routine" link is left out because
`/tasks/routines/new` takes no bot parameter today; adding one would be a separate change.

**Where Harout reaches it**: in a bot chat, tap the bot's name or avatar in the header (both link to
`/bots/$botId/edit`) or open Bots → the bot. The chat `...` menu's "Chat settings…" opens the chat's
own settings sheet, not bot settings, so it is not this door; "Switch model…" appears there only when
the provider is unavailable and also lands on the editor.

**Tests** (`BotRoutinesSection.test.tsx`, `conversationRoutinesModel.test.ts`): only this bot's
routines, enabled first and server order within each group, a link per routine to its own id, the
empty state (and not while loading, and not on a load error), and no rows for a bot with none.
`BotForm.schedule.test.tsx` and `BotForm.fallback.test.tsx` mock the routines query so the existing
form tests still render the form in isolation.

## 2. Next run reads "Today" for later today

One shared change in `taskPresentation.ts`: `routineNextRunLabel` now takes an optional `now` (tests
pass it; the app uses the clock) and formats through `formatNextRunDateTime`, which compares the
calendar day in `PERSONAL_TIME_ZONE` (Europe/London), not "within 24 hours". Same London date:
`Today, HH:MM`; any other date: the existing `Sat 17 Oct, HH:MM` (now including the year in the
formatter's parts, which the label does not print). `Paused` and `No more runs` are unchanged.

Because every next-run surface already called this helper, they all changed together:

- Tasks → Scheduled rows (`routineTriggerStatusLabel`);
- the routine detail page's "Next run" (`Today, 14:30`, no "Next:" prefix there);
- the routines strip under a chat (`ConversationRoutinesPanel`, three-routine cap unchanged, date part
  now says Today);
- the Bots list status line ("Next run Today, 14:30" through `botSummaries.ts`);
- the new bot settings Routines rows.

Deliberately left out: `lastFiredAt` ("Last fired …") and `createdAt` on the detail page, event
routines (they have no next run), and "No more runs"/"Paused". There is no "Tomorrow" label: the
request was only for today.

**Tests** (`taskPresentation.test.ts`, 5 new cases): 14:30 later today reads "Next: Today, 14:30";
00:20 just after London midnight reads Today while the UTC date is still yesterday; 23:30 on another
London day keeps "Sun 18 Oct, 23:30" even inside 24 hours; a run 30 minutes away that crosses London
midnight is not Today ("Sun 18 Oct, 00:20"); a paused routine due today still reads "Paused". The two
existing format tests now pin `now` so they cannot flip on 14 Sep.

## Builder verification

- `apps/web`: `vp test run --project unit src/features/personal` — 257 files, 2877 tests passed, 0
  failed (10 new tests: 5 in `taskPresentation.test.ts`, 2 in `conversationRoutinesModel.test.ts`, 3
  in `BotRoutinesSection.test.tsx`).
- `apps/web`: `tsc --noEmit` exit 0.
- `vp fmt` on the nine changed files.
- Real check at 390x844, dark mode only, on a throwaway started from this staged release with its
  own temp data root (never the live 38472 server or Harout's data): a Developer bot carrying the two
  requested titles ("Tennis: is Court 2 still free after 15:00 today?" and "Revisit upstream
  orchestrator v2") plus a paused one showed all three in its settings, enabled first, the tennis row
  reading "Next: Today, 14:30"; every row opened `/tasks/routines/<id>` and the detail page read
  "Next run / Today, 14:30". Scheduled showed "Next: Today, 14:30" beside "Next: Sun 18 Oct, 09:00".
  Screenshots: `%USERPROFILE%\.personal-bots\qa\hbots-16665\bot-settings-routines-390x844-dark.png`
  and `scheduled-today-390x844-dark.png`.
- Fork gate: `gate-evidence.ps1` on this staged release; result and counts in the section below.

## What QA should focus on

1. A bot with routines: its settings show only its own, enabled first; tap each row and confirm it
   opens the right routine. A bot with none shows "No routines yet".
2. Any next run later today in London shows "Today, HH:MM" on the Scheduled list, the routine page,
   the chat's routines strip and the Bots list; a run tomorrow still shows the weekday and date.
   Paused routines still say "Paused".
3. The routines strip under a chat still caps at three and its "See all" still opens Scheduled.

## Gate evidence

<!-- gate-evidence:begin sha=7cdc928a7788062dce532950ffaa70eadc246092 release=7cdc928a7788 json-sha256=2fc51349292918e63d2d7e58a941f3769363dba950a7bbf11942cd23bc298b4b result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-17T10:19:26Z. Version 1.66.65, release `7cdc928a7788`, commit `7cdc928a7788062dce532950ffaa70eadc246092` on `release/hbots-16665`, working tree clean, result **PASS**.

Machine-readable copy: `releases\7cdc928a7788\gate-evidence.json` (sha256 `2fc51349292918e63d2d7e58a941f3769363dba950a7bbf11942cd23bc298b4b`) and the full gate logs in `releases\7cdc928a7788\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2920 tests passed, 0 failed, 4 skipped, in 210 files | 252.4 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 781.6 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2877 tests passed, 0 failed, 0 skipped, in 257 files | 53.3 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 2.3 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 262 checks ok, 0 failed | 75.8 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16665\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\7cdc928a7788" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 276.7 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `a62c94ec4ba862bcb820d7af279ab90969894028`, at end `a62c94ec4ba862bcb820d7af279ab90969894028`; tracked files modified: none. Staged release: version 1.66.65, sha 7cdc928a7788, dirty False, externals copied; `dist/bin.mjs` sha256 `672a8beb4734f6e46267596a3f33d7c0ea883efd021ca33befb36262a4130b4a`.
<!-- gate-evidence:end -->
