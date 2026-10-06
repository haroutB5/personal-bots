# HANDOFF 1.65.0: chat extras, usage-limit model fallback, quiet notice + reply + choices

One combined release on branch `feat/hbots-1650` (from personal-bots/main bed66c1e84, live 1.64.5). Three parts, built in sequence:

1. Frontend: quiet notice, reply to a message, tap-to-answer choices (Part 1 below, unchanged).
2. Backend: chat extras: snooze, pin, mark unread, search inside messages.
3. Backend: usage-limit model fallback.

Two additive migrations: **100** and **101** (live is at 99). Back up first (the waiter does). Concurrency stays 5 (`PERSONAL_TASKS_CONCURRENCY`).
Staged with `build.ps1 -NoActivate -CopyExternals`, not active. DevOps ships after QA.

## Part 2: chat extras

**Server (migration 100, additive, all columns nullable):** `personal_bot_threads.pinned_at, snoozed_until, marked_unread_at`; `personal_groups.pinned_at, snoozed_until`.

- `personalBots.list` links carry `pinnedAt`, `snoozedUntil` (only while snoozed) and `markedUnread`. Nothing is stored for "woke": a snooze whose time has passed is just awake: the chat is listed again, ordered as if a message arrived at the wake time (`lastActivityAt` bumped), and unread from then (`unread`, `markedUnread`, `lastReplyAt` = wake time). A snoozed chat has no preview and no unread (it is not eligible), so the bot row and the newest-thread choice skip it. Wake now = the snooze ends at that moment.
- `personalBots.updateThreads` (one RPC for one chat or a select-mode batch): `pinned`, `snoozedUntil` (a future time, or null = wake now), `markUnread`. A snooze past a year is refused. Archived chats and group relays are refused (reported per chat in `failed`); archiving drops pin and snooze.
- Mark unread counts from 30 s after it was made (`MARKED_UNREAD_GRACE_MS`): marking from inside the open chat and leaving stamps `last_viewed_at`, which would otherwise read it again at once. The next real open clears it. It shows for every bot (reply-unread still shows only for team leads in the Bots list).
- Groups: `personalGroups.update` takes `pinned` and `snoozedUntil` (null = wake now); the group's `updatedAt` is not touched by either. Groups have no unread state, so no Mark unread there.
- Push: a snoozed chat or group sends no notification until it wakes (`path: snoozed` in the log); counts and chat state still update.
- `personalBots.searchMessages` (`personalMessageSearch.ts`): ASCII-case-insensitive substring over user and assistant message text (never reasoning, system or tool rows), newest first, one hit per chat (+ `moreInChat`), at most 40 chats from 200 rows; a snippet of about 140 characters around the match is cut in SQL, code fences dropped. Skips deleted chats, group relays, deleted bots, **chats of bots with hidden previews and groups with such a member** (their text must not leave the chat). Includes group chats and archived chats (tagged).
- No FTS and no index: a scan of `projection_thread_messages`. A trigger-fed FTS table would add a write to every streamed delta of the hottest table; the scan is measured below.

**Search timing** (read-only snapshot copy of the live DB taken 6 Oct 17:42, 1.7 GB, 35,655 messages, 24 MB of text; the repository's own SQL; 100 queries over 20 terms in 5 rounds, with other builds running on the laptop): p50 160 ms, p95 190 ms, max 230 ms back to back; the first queries of a cold process ran at about 50 ms. `listThreadLinks` on the same copy: p50 75 ms (731 links; it carries three more columns and one more CTE than before). Growth is linear: at ten times the messages expect 0.5 to 1.5 s, and FTS5 (trigram, external content) is the follow-up then. The client debounces 300 ms and ignores stale results. Raw numbers: `~/.personal-bots/qa/hbots-1650-b/bench-*.txt`.

**Web:** `chatState.ts` (pin/snooze logic; presets In 1 hour, This evening 18:00 [only before 17:00], Tomorrow 09:00, Next week Monday 09:00, local time), `SnoozeSheet`, `ChatSectionRows` (Pinned chats and Snoozed sections on the Chats screen), `useSnoozeWakeClock` (one timer to the nearest wake, refetches), `MessageSearchResults` + `useMessageSearch` + `pendingMessageJump`. Where: the chat "..." menu (Pin, Snooze, Mark unread), the group menu (Pin, Snooze), the bot's chat list (pinned first with a pin icon, a collapsed "Snoozed (n)" section with the wake time and Wake now, unread dot for every bot), select mode (Pin/Unpin, Snooze, Mark unread beside Archive and Delete), the Chats screen (Pinned chats section, Snoozed section, "In messages" search results), the chat chips (pinned first, snoozed out). Mark unread leaves the chat by the Back rule and clears the device's seen state (`clearChatSeen`).

## Part 3: usage-limit model fallback

**Setting (bot form, per bot):** "Switch model when the usage limit is hit" (on by default) + provider, model, effort and context pickers. Default for every bot, existing ones included: Claude Sonnet 5.5, effort High, 1M context (`PERSONAL_BOT_DEFAULT_FALLBACK_MODEL`). Saved as `fallback: {enabled, modelSelection}` on `personalBots.create/update`.

**Migration 101 (additive):** `personal_bots.fallback_enabled` (default 1) and `fallback_model_json` (NULL = the default model); new table `personal_bot_fallbacks` (one row = that bot runs on its fallback right now; survives a restart); `personal_chat_resumes.fallback` (default 0).

**How it works** (`PersonalModelFallbackService.ts`, `personalModelFallbackPolicy.ts`):

- Trigger: the provider reports a rate or usage limit (`providerRetry.kind = rate_limited`, any provider): on a **chat turn** that ends in an error session (`PersonalChatResumeService`), and on a **task** (a delegated task or routine run) whose turn failed or was parked on a limit (`PersonalTaskService.finishAttempt`).
- Only when the fallback has room: kill switch on, bot switch on, bot not already on its fallback, fallback model not the same as the home model, the fallback's provider configured, enabled and available, and its latest usage readings (`ServerProvider.usageLimits`, the data behind the Usage strip) show no spent window that applies to the fallback model (a spent Opus-only window does not block Sonnet; a window whose reset has passed is a lagging reading). A fallback on the **same provider** as the home model switches only for a model-specific limit (`seven_day_opus`) into another model family; the shared 5-hour or weekly pool is the same pool, so it waits as today. Otherwise nothing new happens: the bot waits for the reset exactly as before (logged as `personal model fallback not used` with the reason).
- On switch: a row in `personal_bot_fallbacks`; the bot's saved model is untouched. `botModelSelectionForThread` returns the fallback while the row exists, so every server-started turn (chat, task, routine, retry, resume, group relay) runs on it, through the command reactor's existing provider-switch path (fresh provider session, the chat carried over, the work record for tasks). One muted line is written in the chat: "Codex hit its usage limit. IT is on Sonnet 5.5 · H until it resets (about 18:40)." The interrupted chat turn continues at once (a `personal_chat_resumes` row scheduled now with `fallback = 1`, prompt "[Auto-continue on a fallback model] ...", shown as "Continued on the fallback model"; the sweep starts it within 15 s). Tasks waiting out the home limit get `available_at = now` and run again on the fallback. A turn that was already running on the home provider when the bot switched (a second chat) continues on the fallback too, for 5 minutes after the switch.
- Switch back: a 30 s sweep. Due when the stored reset has passed (+15 s); the home provider is re-probed first (`refreshInstance`, at most every 2 min per bot) and a reset it still reports as spent is moved later. With no reset reported: the readings are re-checked every 10 min, and if the provider reports nothing at all the bot goes back after 5 hours. **Only when the bot is idle** (no running session in any of its chats, no running task); never mid-turn. One muted line: "Codex usage limit has reset. IT is back on gpt-6.1-sol · H." Turning the bot's switch off, the kill switch, or saving a new main model also ends it (the first two when idle). A 60 s cooldown after a switch back prevents ping-pong.
- Labels: `bot.fallbackActive` (`modelSelection`, `since`, `resetAt`, `fromProvider`) shows "Sonnet 5.5 · H · fallback" in the Bots list, pinned tiles, chat header, task cards and Team; typed messages send the effective model; the open chat refetches the bots when a fallback line lands.
- **Kill switch: `PERSONAL_MODEL_FALLBACK=off`** (also 0, false, no, disabled) in the server environment: no switch happens, every bot waits as before; an active fallback ends when its bot is idle. Per-bot switch in the bot form.
- Logs (server log): `personal model fallback switched` (bot, source chat/task, from, to, reason, resetAt, tasksReleased), `personal model fallback ended` (bot, reason, heldMs), `personal model fallback not used` (reason), `personal chat continues on the fallback model`.
- Bots on Codex today: IT, Security, Astra, Scheduler (gpt-6-luna). Every bot has the switch on by default, including the OpenCode bots (Musey, Watcher on Muse Spark free); for Claude bots the default fallback is mostly the same pool and does nothing.

## QA fixes after the first staging (qa-1650 NO-SHIP on 6c2203305200)

All in the task path (`PersonalTaskService.ts`) plus one web line.

1. **A task that fails on a usage limit never switched.** Codex reports the limit as `runtime.error` (session `error`, turn still open, no details) and then `turn.completed` with `providerRetry`. The task settled on the first snapshot, so it had no limit details: guessed backoff, no fallback. Now an error that reads like a rate limit, on a turn that has not completed (`activeTurnId` set), waits up to `PERSONAL_TASKS_LIMIT_DETAIL_WAIT_MS` (10 s) for the completion; the 30 s sweep settles it if it never comes. A limited task then switches, or waits for the reported reset when no fallback applies (not the one-minute guess).
2. **The task that triggers the switch ran twice.** Two causes. (a) The thread's session still carried attempt 1's wait: a wait observed before an attempt started is ignored for that attempt (`providerRetryOfAttempt`). (b) The real killer, found by running QA's harness: a moment after the switch the old home provider session reports its own end (a usage-limit `error`, a stop) with `providerInstanceId` = the instance the bot moved off. It landed on attempt 2 (just started on the fallback) and ended it as rate limited, so the task ran again 5 minutes later. A snapshot from `personal_bot_fallbacks.from_instance_id` ends nothing for an attempt that began after the switch (`fromSupersededSession`; restart safe, no new state).
3. Group search hits show the group's name (`MessageSearchResults.tsx`), not the thread's "Group chat".

New tests (`PersonalTaskService.test.ts`): Codex order replay (error first, completion second) switches and runs once; same order with the fallback limited waits for the reported reset; a limit error that never gets its completion settles after the wait; a plain error settles at once; the stale wait does not end the retry; the old session's late error or stop does not end the attempt on the fallback; an error from the fallback's own session still does. The last four of the new tests fail on the previous code. Web: `MessageSearchResults.test.tsx` group name.

Re-test on a throwaway root with QA's harness (`~/.personal-bots/qa/hbots-1650-b/rt/`, fake CLIs): home limited 100 s and 300 s: attempt 1 `rate_limited`, attempt 2 completes on the fallback in about 3 s with one TASKDONE and no attempt 3; fallback also limited: no switch, task parked on the reported reset (gap under 2 s), runs once after it.

## Tests and gates (final)

Server `npx vp test run src/personal` exit 0, 1785 passed, 3 skipped (`src/personal` + `src/persistence` together: 1892 passed); server `tsc --noEmit` exit 0; web `npx vp test run --project unit src/features/personal` exit 0, 2024 passed (203 files); web `tsc --noEmit` exit 0; contracts `tsc --noEmit` exit 0; `vp fmt --check` clean on every changed file; lint 0 errors on changed files.
New server tests: `Migrations/100_*.test.ts`, `Migrations/101_*.test.ts`, `PersonalBotRepository.chatExtras.test.ts` (pin, snooze, wake now, timed wake, mark unread, refusals, search incl. privacy), additions to `PersonalBotService.test.ts` and `PersonalGroupService.test.ts`, `PersonalModelFallbackService.test.ts` (policy matrix, switch, no room, switch off, kill switch, same pool, idle-only switch back, extended reset, chat continues now, loop guard, tasks released) and two task tests in `PersonalTaskService.test.ts` (a Codex limit on a task: the bot is on Sonnet 5.5 and the task runs again at once; fallback provider limited: it waits).

## Proof

`~/.personal-bots/qa/hbots-1650-b/` (RESULT.md, shots/ at 390 px dark, h/ the harness with two fake Claude CLIs, one of them "the home provider that hits its limit"). Dark only (Harout, 6 Oct). Part 1's proof is `~/.personal-bots/qa/chat-1650/`.

## Not tested / left out

- Everything ran against fake CLIs on a throwaway root. Codex's "usage limit reached" through `CodexAdapter` was simulated with a second Claude instance whose fake CLI sends a rejected 5-hour window (the session shape the adapters produce: error session + `providerRetry.rate_limited`); the policy tests use Codex-shaped data. Nothing was run against a real account.
- A **Claude** chat turn that the SDK parks on a rejected window (the session stays running with a retry, no error) is not switched: the SDK resumes it itself at the reset, and a Claude-to-Sonnet fallback shares the pool anyway. Parked Claude **tasks** are covered (the task service pauses them).
- Group rounds: a member that hits a limit keeps the group's own wait (`groupLimitResumes`); it uses the fallback model if its bot was switched by another chat. No group-initiated switch.
- The MCP `create_bot` / `update_bot` tools do not take the fallback fields.
- Group pin and snooze are unit-tested on the server and the web, not clicked through in a browser (the bot-chat paths were). Real iPhone Safari untested.
- Select mode is not offered on the Snoozed rows (they have Wake now).
- Message search has no FTS (see the timing above).

## Part 1: quiet notice, reply to a message, tap-to-answer choices

## Part 1 (Frontend): what it does

**A. Quiet notice.** A bot that is working and has sent nothing for 90 s shows "No response from Claude · 1m 35s" (provider = Claude / Codex / OpenCode ...) as one muted line under the chat header, in place of the progress note. The header status shrinks to "No response" with a muted dot and the avatar goes calm. The line ticks every second by itself; it goes away when anything arrives or the turn ends. Not counted: a pending question, provider approval, secret, login or connection-approval card, browser help, an offline laptop. Never stops the turn. Groups: the speaking member's chat and the round are watched; same line under the group header.
Client only: `thread.updatedAt` moves with every event of the turn (text deltas, tool steps, activities), so no server field was needed (`chatSilence.ts`, `QuietNoticeLine.tsx`). Once the screen has watched a change it counts from when it saw it, so a phone clock that differs from the laptop's does not matter; a chat opened mid-silence counts from the server's stamp.

**B. Reply to a message.** Long press (touch) or right click / the "..." that shows on hover (desktop) opens a small menu: Reply, Copy text. On a touch screen message text is no longer selectable (Copy text takes its place). The composer shows "Replying to <name>" + the first line with an X. The sent message shows the quote in its bubble; tapping it scrolls to the original and flashes it (nothing happens if it is not loaded). Works on user and bot messages, bot chats and groups (`@mentions` unchanged).
Carrier: a `personal-reply` record on the message's `context` (`packages/contracts/src/personalReply.ts`, same trick as the task and group markers). The stored text stays what was typed, so previews, titles and notifications are untouched; the quote survives reload and retry. The model gets `[Replying to Mori's earlier message: "..."]` (own message: "my earlier message"), excerpt capped at 300 chars, prepended in `ProviderCommandReactor` (all providers). Groups: `personalGroups.sendMessage` takes an optional `replyTo`; the posted group message carries the record after the group marker; `readMessageText` adds the quote to what each member reads in its catch-up and verdict brief.

**C. Tap-to-answer choices.** A reply that ends with a ```choices block (2 to 6 lines, each up to 120 chars) draws buttons (`choices.ts`, `ChoiceButtons.tsx`). A tap sends the option as the owner's message through the composer's own send (`quickSendRef`), once (double tap = one message); the set is disabled while the bot is busy or the chat cannot send, and greys out once the owner sends anything after it (the option repeated is marked). Malformed (1 or 7+ options, no closing fence, text after it, line too long) stays a plain code block; a block still streaming in is held back. Reply on such a message quotes the words, not the block. QuestionCard (AskUserQuestion) is untouched.
Bot instruction: one paragraph added to `PERSONAL_BOT_APP_RULES` (`apps/server/src/personal/personalBotInstructions.ts`), which `personalBotSystemInstructions` puts in every bot's system prompt on every provider (`botInstructionCoverage.test.ts` proves each adapter passes it through `withBotInstructions`).

## Part 1 server changes

- `ProviderCommandReactor.ts`: `withPersonalReplyQuote` on the turn text.
- `PersonalGroupService.ts`: `replyTo` on sendMessage, record on the posted message, quote in `readMessageText`.
- `personalBotInstructions.ts`: the choices line.
- Contracts: `personalReply.ts` (new), `PersonalGroupSendMessageInput.replyTo` (optional). No migration, no schema change in the database.

## Part 1 tests

New: `chatSilence.test.tsx`, `QuietNoticeLine.test.tsx`, `choices.test.ts`, `ChoiceButtons.test.tsx`, `messageReply.test.ts`, `ReplyableMessage.test.tsx`, `MessageList.reply.test.tsx`, additions to `PersonalComposer.test.tsx`, `PersonalGroupService.test.ts`, `ProviderCommandReactor.test.ts`, `personalBotInstructions.test.ts`.
Gates: server `vp test run src/personal` 1739 passed (3 skipped) exit 0; server `tsc --noEmit` exit 0; web `vp test run --project unit src/features/personal` 1863 passed exit 0; web `tsc --noEmit` exit 0; `vp fmt --check` clean; `vp lint` 0 errors on the changed files.

## Part 1 proof

`~/.personal-bots/qa/chat-1650/` (RESULT.md, shots/, h/ = harness with a fake Claude CLI; throwaway root deleted). Dark only (Harout, 6 Oct).

## Part 1 known limits / notes

- The 90 s notice also shows for a legitimately long silent tool (a 5 minute build): same as akeru's; the tool's start counts as output, nothing after it does until it ends. The turn is never stopped.
- Copy text is the only addition beyond the brief (it replaces the long-press text selection on touch).
- A reply quote is not shown on a message from the group's bots (only the owner replies).
