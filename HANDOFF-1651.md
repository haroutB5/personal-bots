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
# prints Name, Root, URL, Pairing (single-use link), PID, Server, Version, Stop command (-Json: one object)
powershell ... -File scripts\personal\throwaway-server.ps1 -Pair fb1651     # a fresh pairing link
powershell ... -File scripts\personal\throwaway-server.ps1 -List            # roots under %TEMP% and whether they run
powershell ... -File scripts\personal\throwaway-server.ps1 -Stop fb1651     # kill the recorded PID, delete the root
```

- Root `%TEMP%\hbots-tw-<name>` (name: lower-case letters, digits, dashes). Always fresh: it refuses an existing root, so a test never inherits an old database.
- `userdata\settings.json` points `providers.claudeAgent.binaryPath` at a fake CLI (forward slashes, no BOM) and adds a second instance `claudeLimited` ("Home (limited)") on a second fake; codex, opencode, cursor and grok are disabled. `PERSONAL_SEED_MODEL=claude-sonnet-5-5`, headless browser, no T3 Connect. Free port on 127.0.0.1.
- The fakes live in `scripts/personal/testing/fake-claude/` (QA's 1.65.0 fakes plus an `MCPTOOL <name> <json>` trigger that calls any MCP tool and answers with the result). The script copies them to `<root>\fake\fakeok` and `fakelimit`; the folder name picks the persona. Trigger words and the `limit-until` / `usage-full` state files are listed at the top of `cli.js`. State and log: `<root>\fake-pids`.
- Server output (stdout and stderr together): `<root>\server.log`. The record (name, port, PID, server PID, bin, start time) is `<root>\throwaway.json`. The server is started the way the release scripts do it (a detached `cmd.exe` wrapper with the output redirected inside cmd), so a caller that captures the script's output (`$info = ...ps1 -Json | ConvertFrom-Json`) does not hang on a pipe the server keeps open (found and fixed in this release's own test). PID is that wrapper, Server is the node process that listens.
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

- Server `npx vp test run src/personal src/mcp`: exit 0, 156 files, 2100 passed, 3 skipped. `tsc --noEmit` exit 0 for server, web and contracts. Web `npx vp test run --project unit src/features/personal`: exit 0, 204 files, 2047 passed. `vp fmt --check` clean on every changed file; `vp lint` exit 0 on them (5 warnings, all in lines this release did not touch).
- Build: `build.ps1 -NoActivate -CopyExternals`, 4 .env keys loaded, externals copied, no migration. Release id = the commit it was built from (see the report); not activated.
- Browser and server checks on a throwaway root from the staged release (fake CLIs, Sonnet 5.5 seed, headless Chrome 390 px dark, touch emulation, isolated profile). Harness and evidence: `~/.personal-bots/qa/hbots-1651/` (`h/` scripts, `shots/`, `c1-result.json`, `c2-result.json`, `gates/`).
  - `c1` (14 checks, real MCP path: a fake lead chat calls `create_bot` / `update_bot`): create with fallback off + own model; update turns it on, changes the effort (context window kept), turns it off; Fable fallback and a missing effort refused with nothing changed; a bot the user made gets a card (nothing changes), the card lists `usage-limit fallback: on → off`, his Yes applies it; the bot form (`/bots/<id>/edit`) shows the switch off, then on with Sonnet 5.5 / High / 1M; 0 page errors, 0 ERROR lines in the server log.
  - `c2` (touch emulation): Bots page has no Pinned chats section and lists the pinned chat nowhere, a pinned group is among the group rows once, first, with its pin; the bot's own chat list and the chat chips have the pinned chat first with its pin. Message text is `user-select: none` on touch; long press opens Reply / Select text / Copy text; Select text selects the whole message and the mode stays on while the selection is narrowed to a sentence; a tap on another message ends it and clears the selection; a single tap does nothing; a double tap selects exactly the tapped word ("strongest"), the page scale stays 1 and no menu opens; two slow taps do nothing; a long press on another message still opens the menu; the same in a group chat's verdict message; desktop (mouse, 1100 px): text selectable with no mode, double click selects "warehouse" natively.
  - Throwaway script: start and stop run twice (one with a junction inside the root pointing at a folder outside it, which survived), each time no root, PID, port or process naming the root left; also run with its output captured by a calling script.
- The cooldown log line is proven by the unit test only (real service, real repository, a real logger), not by a live two-limit run.

## Not tested / left out

- Real iPhone Safari: whether iOS shows its handles and Copy bubble for a selection set by script, and how its own double tap and callout behave, cannot be proven headless. Chrome with touch emulation shows the selection, the mode and the events; the iPhone check is Harout's.
- Nothing ran against a real account (fake CLIs). The new tool fields were only exercised on the Claude provider; the resolution code is provider-generic (it reads the provider's own model, effort and context lists).
- Watcher and Musey (Harout-made, on Muse Spark) still need their fallback switch turned off: a lead calling `update_bot` for them raises a confirm card from a chat turn Harout started.
- Group pin: pinning is only through the group's own menu now (the Bots page no longer lists pinned items).
