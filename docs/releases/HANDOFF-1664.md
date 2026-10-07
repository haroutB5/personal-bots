# HANDOFF 1.66.4

## What changed

Branch `feat/hbots-1664` (off main 79ce7d53df = 1.66.3). Frontend. Web change only: no server change, no migration. Concurrency stays 5.
Staged with `build.ps1 -CopyExternals` (4 `.env` keys loaded), not active. Built from Designer's spec `dev-team/design/hbots/chat-settings/SPEC.md`.

**1. Chip order is by recency, and holds still while he stays.** Chips are pinned first, then newest real activity first: the All chats list's order
(`botThreadRows` `active`), minus task and routine chats. `byCreation` is gone. A new pure function, `applyFrozenChipOrder` (`chatChipOrder.ts`), lays
the fresh order over the order he last saw: known chips (same id, same pin state) keep their place; a newcomer (new chat, woken snooze, chip whose pin
changed) goes first in its group (pinned or not) when nothing known is newer, else just before the first known chip after it, else last. Chats that leave
close the gap. Sending, another chat finishing a turn, a chip switch and "+" never move a chip. The freeze is kept per bot in a module map and cleared when
the bot's chat screen is left for anything but another chat of the same bot (Back, All N, Edit bot, another bot, Settings), and when the page shows again
after 60 s or more hidden (then the open chip is re-centred instantly). CTO decision: re-sort on entry and on a 60 s return.

**2. Chat settings sheet** (`ChatSettingsSheet.tsx`, `chatSettingsModel.ts`). Holding a chip (500 ms, `useLongPress`) opens that chat's settings in the
snooze sheet's floating card: title, state words, last message (hidden when the bot hides previews), then Pin or Unpin, Snooze... (swaps in place, with
Back) or Wake now on a snoozed chat, Mark unread (left out when already unread), Rename, Wrapup, Archive or Unarchive, Delete, Cancel. Actions on another
chat never navigate, except Wrapup, which opens that chat and sends the wrapup once its thread has loaded (a 10 s hand-off mark, `chatChipHandoff.ts`;
if it cannot start, the usual "Couldn't start the wrapup" shows there). Wrapup is greyed with its reason ("After this reply", "Unavailable", "Loading").
Delete on another chat names it in the confirm and adds a line when it is working. Failures name the chat; successes on another chat are announced to a
screen reader. A chat that goes away while its sheet is open closes the sheet. No Stop for another chat in this version (CTO).

**3. Other ways in.** Holding the name block in the header opens the open chat's sheet (one-chat header: the whole Edit bot link; chips header: line 1
and the avatar). Right-click on a chip or the name, and ContextMenu or Shift+F10 on a focused chip, open it too. Chips and header blocks carry one hidden
hint ("Touch and hold for chat settings.") through `aria-describedby`; chips are not draggable and have no iOS callout. A hold cue (`useHoldCue`,
`personal.css`): after 150 ms the pressed chip dips and darkens, and pops when it fires; reduced motion gets colour only. Focus returns to the chip,
header block or menu button on close. `useLongPress` gained an optional `onPressChange` (existing callers unchanged). The All chats list long-press
select mode is untouched.

**4. Three-dots menu** is now: Stop (while a turn runs), Switch model... (provider wait), then **Chat settings...** with the hint "or hold a chip" (chips
showing) or "or hold the name", then New chat, All chats N and the mute group. Wrapup, Pin, Snooze, Mark unread, Rename, Archive and Delete left it; each
lives only in the sheet. The trigger is still named "Chat options". `scripts/personal/perf/stream.mjs` cleaned up its test chat through the old Delete row,
so it now goes Chat options, Chat settings..., Delete chat in the sheet (same confirm).

**5. Follow-ups after CTO review (same release).** (a) The chip row follows a pin: when pinning moves a chip to the front, or unpinning drops it
elsewhere, the row scrolls so that chip is fully visible (clear of the edge fade), smoothly, or at once under reduced motion. Nothing moves when the
chip is already in view; the open chat's own pin keeps the usual centring; a new chip is not a pin (`ChatChips.tsx`, `scrollLeftToReveal` in
`chatChipNavigation.ts`). (b) Delete always names the chat on failure: `Couldn't delete "X"` plus the server's reason when it gives one, else
"Try again.", for another chat and for the open chat (and the archived bar's Delete), like Archive's (`useDeleteChat.ts`, new `name` option; the
confirm's words are unchanged).

## Proof

- Web unit tests: 2208 (was 2064), 208 files (was 204). New or reworked: `chatChipOrder.test.tsx` (order and freeze, pin and unpin, new chat, woken snooze,
  chats leaving, the leave and re-enter rule, the 60 s return, the hook), `chatSettingsModel.test.ts` (open chat, another chat, archived, task chip, snoozed,
  unread, running turn, needs you, waiting, rate limited, previews hidden, announcements), `ChatSettingsSheet.test.tsx` (rows, disabled rows, snooze in
  place), `ChatChips.hold.test.tsx` (hold, tap, scroll and drift, composer guard, right-click, keys, hint, centring after a re-sort), `useLongPress.test.tsx`
  (`onPressChange`), `ConversationScreen.archived.test.tsx` (the menu's exact contents and hints, every action on the open chat and on another chat, the
  header hold, the pending wrapup, the order while he stays), `useDeleteChat.test.ts`, `chatChipHandoff.test.ts`, `chatChipRows*.test.ts` (recency order).
- Real Chrome, 390x844 phone context with touch, dark, on a throwaway server (fake CLI only) running the staged release (`qa/chatsettings-1664/check.mjs`
  and `part2.mjs`, screenshots in `qa/chatsettings-1664/shots1`). Every check passed except two that were my script's own expectations (the one-chat
  header hint after a delete, and an archived row that the list had folded away), not the app. Checked: chips newest first; frozen after sending in the
  3rd chip, after a switch and after "+"; re-sorted on the next entry; a hold on a chip opens that chip's sheet without switching; a tap switches with
  no sheet; a 25 px drift opens nothing; Pin moves the chip first and Unpin is then offered; Mark unread lights the chip and drops the row; Snooze swaps
  in place, Back returns, a pick removes the chip; Rename starts from that chat's title; Wrapup opens that chat and the wrapup turn starts; Archive and
  Delete leave us on the open chat, Delete names the chat; the menu holds only the door and the hint; one chat: hold on the name opens the sheet and a tap
  still opens Edit bot; a two-line clamp for a long title; desktop 1280: right-click, a 430 px card, Shift+F10 and ContextMenu, and focus returns to the
  chip after Escape. No uncaught page errors.
- Restage browser check (`qa/chatsettings-1664/part3.mjs`, shots in `shots2`; 390x844, dark, throwaway server on release `a60c35469edb`, 24 chats): with the row
  scrolled 300+ px along, Pin on a visible chip put it first and the row scrolled back to the start with the chip fully in view; Unpin dropped it at the far
  end and the row scrolled to it, fully in view; a pin of a chip already first and in view left it in view. 9 of 9 checks passed, no page errors. The failed-Delete
  wording is covered by unit tests only (a refused delete cannot be forced on a throwaway server).
- Test-harness note: a tap that lands within 350 ms of the finger lifting from a hold is eaten on purpose (`useLongPress`), so a script must wait about
  half a second after the sheet shows before tapping a row. A person does.
- Release gates: see "Gate evidence" below (server 2304 tests, web 2208, both tsc, 233 PowerShell checks, e2e 5/5).

## Not tested / limits

- A physical iPhone. iOS Safari has no web haptics, so the hold is visual only there. VoiceOver reading of the hint was not run.
- The perf script `stream.mjs` was edited for the new delete path but not run (it costs a model turn); the click path it uses (Chat options, Chat
  settings..., Delete chat in the dialog) was exercised by the browser check above.
- Light mode was built from the same tokens and not checked (Harout's rule: dark only).
- A chip moved by a pin or unpin made on another device while this screen is open scrolls into view the same way (the row follows any pin change it sees).
- An archived chat's sheet (Rename, Unarchive, Delete) is covered by unit tests at screen level, not in the browser run.

## For QA

Focus on the new parts, then a quick regression. Order: pin and unpin; send in the third chip and switch around, order must not move; Back to Bots and
reopen the bot (re-sorted); background the PWA for 60 s or more and return (re-sorted, open chip centred); a task chat opened from Team (temporary chip
first). Hold on chips: tap vs hold vs scroll the row, hold the open chip, hold the header name (one chat and several), right-click and keys on desktop.
Sheet on another chat: every row, with the chat staying open; Wrapup on another chat and on a working chat; Delete on a working chat. Sheet on the open
chat: Snooze and Mark unread leave, Archive and Delete go to All chats. An archived chat (Rename, Unarchive, Delete), a snoozed chat from Snoozed (Wake
now). Regression: the All chats list long-press select mode and swipe, the archived bar's Unarchive and Delete, Back from a chat goes to /bots (or
/bots/team from Team). Never press Redeem.

## Gate evidence

<!-- gate-evidence:begin sha=a60c35469edbaa1fb7aab2e0b2e4d6fb64e53ca4 release=a60c35469edb json-sha256=a56a86ab447cd9df0cc3ec852f74f92a898bf47910893fbc0ff120eabaf77d6c result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-07T16:56:06Z. Version 1.66.4, release `a60c35469edb`, commit `a60c35469edbaa1fb7aab2e0b2e4d6fb64e53ca4` on `feat/hbots-1664`, working tree clean, result **PASS**.

Machine-readable copy: `releases\a60c35469edb\gate-evidence.json` (sha256 `a56a86ab447cd9df0cc3ec852f74f92a898bf47910893fbc0ff120eabaf77d6c`) and the full gate logs in `releases\a60c35469edb\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2304 tests passed, 0 failed, 3 skipped, in 171 files | 215.3   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 41.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2208 tests passed, 0 failed, 0 skipped, in 208 files | 30.3    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 9.5     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 63.2    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-chatsettings\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\a60c35469edb" -Json` (in `.`)                                                                                                              | 0    | pass: 5/5 journeys passed                                  | 35.7    |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok.

Tree: HEAD at start `a60c35469edbaa1fb7aab2e0b2e4d6fb64e53ca4`, at end `a60c35469edbaa1fb7aab2e0b2e4d6fb64e53ca4`; tracked files modified: none. Staged release: version 1.66.4, sha a60c35469edb, dirty False, externals copied; `dist/bin.mjs` sha256 `0fe8f7a9e03daa3d90d7589cc8f9f844dbfcbe36074fe4bcfae28f88fc5e53e4`.
<!-- gate-evidence:end -->
