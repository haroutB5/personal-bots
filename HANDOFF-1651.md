# HANDOFF 1.65.1: fallback in update_bot, cooldown log, throwaway-server script, no Pinned section, Select text

Small-fix release on top of live 1.65.0 (3c8940d78e26), branch `fix/hbots-1651`. No migration, no schema change. Staged with `build.ps1 -NoActivate -CopyExternals`, not active; DevOps ships. Small-fix tier: builder proof (below), no QA. Dark mode only (Harout, 6 Oct).

## 1. MCP `create_bot` / `update_bot` take the usage-limit fallback

New optional fields on both tools:

- `fallbackEnabled` (bool): the "Switch model when the usage limit is hit" switch.
- `fallbackModel` `{ provider?, model?, effort?, context? }`: the model it switches to. What is left out stays as the bot has it; a new bot starts from the default fallback (Sonnet 5.5, high, 1M).

How it is checked (`PersonalLeadBotService.ts`, `leadBotModel.ts`, `leadBotPolicy.ts`):

- Resolved from the providers' own lists, like the main model: unknown provider, model, effort or context window is refused with the list of what is offered (`Fallback model: ...`). The context window follows the model's own `contextWindow` option; only models that offer a choice accept one.
- Same rule as the main model for the most expensive tiers: a Fable or Mythos fallback is refused for a lead (`forbidden_model`), unless it is the fallback the bot already has (Harout's own choice stays when only the switch is changed).
- Ownership and confirm-card rules are unchanged. A fallback change is one new sensitive field, `fallback`, next to name, instructions, description and model: on a bot the lead created itself it applies at once; on any other bot (made by Harout, another lead, or moved since) it raises the Yes/No card from a chat turn Harout started and is refused from a routine, task or group turn, exactly like a model or effort change. The card shows `usage-limit fallback: on → off` and `fallback model: A → B`; a card goes stale if the bot's fallback changed before the tap. The audit row keeps the old and new value (`fallbackEnabled`, `fallbackModel`).
- The write goes through the same `personalBots.update` / `create` path as the bot form, so the bot form shows it.
- Side fix in `resolveLeadModelSelection`: changing only the effort of a bot keeps its context window (it was dropped before, for the main model too).

Tests (`leadBots.test.ts`, 6 new): off and on and model change with audit and announcement; effort and context follow the model's lists, refusals change nothing; Fable/Mythos refused on create and update; create takes the fields; a user-made bot gets a card for a fallback change and a routine turn is refused; a card goes stale.

## 2. Log line when a guard holds a fallback switch back

`PersonalModelFallbackService.onLimitHit`: the 60 s cooldown after a switch back (and a bot id that no longer exists) now log one INFO line, `personal model fallback not used`, the same line every other guard already wrote, with `botId`, `source`, `reason: "cooldown"` and `secondsLeft` (plus home and fallback model). Test: 20 s after a switch back the line says 40 s left; a missing bot logs `reason: no_bot`.

## 3. `scripts/personal/throwaway-server.ps1`: one script for a fresh-root throwaway server

```powershell
# start (release = a release folder, a built worktree, or a sha12 under ~\.personal-bots\releases)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\throwaway-server.ps1 -Name fb1651 -Release 3c8940d78e26
# prints Name, Root, URL, Pairing (single-use link), PID, Version, Stop command
powershell ... -File scripts\personal\throwaway-server.ps1 -Pair fb1651     # a fresh pairing link
powershell ... -File scripts\personal\throwaway-server.ps1 -List            # roots under %TEMP% and whether they run
powershell ... -File scripts\personal\throwaway-server.ps1 -Stop fb1651     # kill the recorded PID, delete the root
```

- Root `%TEMP%\hbots-tw-<name>` (name: lower-case letters, digits, dashes). Always fresh: it refuses an existing root, so a test never inherits an old database.
- `userdata\settings.json` points `providers.claudeAgent.binaryPath` at a fake CLI (forward slashes, no BOM) and adds a second instance `claudeLimited` ("Home (limited)") on a second fake; codex, opencode, cursor and grok are disabled. `PERSONAL_SEED_MODEL=claude-sonnet-5-5`, headless browser, no T3 Connect. Free port on 127.0.0.1.
- The fakes live in `scripts/personal/testing/fake-claude/` (QA's 1.65.0 fakes plus an `MCPTOOL <name> <json>` trigger that calls any MCP tool and answers with the result). The script copies them to `<root>\fake\fakeok` and `fakelimit`; the folder name picks the persona. Trigger words and the `limit-until` / `usage-full` state files are listed at the top of `cli.js`. State and log: `<root>\fake-pids`.
- Server output: `<root>\server.log`, `server.err.log`. The record (name, port, PID, bin, start time) is `<root>\throwaway.json`.
- `-Stop` re-checks that the PID's command line still names this release and this root before it kills it (taskkill of that one PID and its child tree), so a reused PID is never touched; nothing is killed by name. It then deletes the root: every reparse point (junction, symlink) under the root is unlinked first and never followed. If the PID will not die the root is kept and the exit code is 1.
- If the server does not come up it is stopped, the root is removed and the last log lines are shown.

## 4. No Pinned chats section on the Bots page

Harout: "i dont want pinned chat to appear in the bots main menu. Just pin it as it is in the bot's chat itself."

- Removed `PinnedChatList` (and its "..." menu, the snooze sheet it opened and the section's search/unread plumbing) from `ChatsScreen`. `buildChatSections` now returns only the Snoozed section.
- Pinning still works where it belongs and is untouched: first in that bot's own chat list with the pin mark (`BotThreadsScreen`), first in its chat chips, the chat "..." menu and select mode. The Snoozed section (with Wake now) and bot pinning (`PinnedStrip`) are unchanged.
- Decision (CTO to confirm): a pinned **group** has no bot chat list to be pinned in, so it is not hidden: it stays among the group rows, first, with its pin mark (`plainGroups` no longer drops pinned groups). Unpin for a group is in the group's own menu.
- Tests: `chatSections.test.ts`, `ChatSectionRows.test.tsx`, `ChatsScreen.test.tsx` updated (no Pinned section, pinned chat listed nowhere, pinned group first and once, wake refusal).

## 5. Select text from a message

Harout: select sentences of a bot's reply to copy. 1.65.0 made message text non-selectable on touch so the long press opens the Reply menu; that stays.

- The long-press menu is now Reply, **Select text**, Copy text. "Select text" turns that one message selectable (`select-text`, `-webkit-touch-callout: default`) and selects all of it by script once the menu has closed, so iOS shows its handles and Copy bubble; the owner drags them to the sentence.
- **Double tap** on message text turns that message selectable and selects the tapped word (caret from point, widened to the word: contractions, hyphens and decimals stay whole). Two quick taps (320 ms, 24 px) on the same spot; the first must be short and still. Not for a mouse. A double tap on a link, button, choice or quote is that control's own and starts nothing. The row is `touch-action: manipulation` on touch so a double tap never zooms the page.
- Selecting ends when the selection is cleared (after it had one), on a tap elsewhere, or when the message scrolls out of view (IntersectionObserver); the selection inside the message is cleared with it. While selecting, a hold on that message is the browser's own (no Reply menu); a long press on any other message still opens the menu. A streaming message and a chat that cannot send are not wrapped (they were never locked).
- Bot, user and group messages all go through `ReplyableMessage`, so group chats are covered. Desktop: a mouse press never starts the press timer and the lock is only under `pointer: coarse`, so text selects with the mouse as before.
- Code: `messageTextSelection.ts` (rules and DOM helpers), `ReplyableMessage.tsx`. Tests: `messageTextSelection.test.ts` (12) and 14 new `ReplyableMessage.test.tsx` cases.

## Gates and proof

(filled in below after the run)
