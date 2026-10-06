# Finished task chats archive themselves; lists order by real activity (1.51.0)

2026-09-28, Backend (CTO task 835f032e). Built on 1.50.0 (8c9e51095f). Release 4ca62451a269 (commits 9fdeaeacec auto-archive + list order, 4ca62451a2 seed model + pinned labels; branch feat/auto-archive-task-chats, worktree C:/Claude/AI/_wt/hbots-151), staged -CopyExternals -NoActivate, build exit 0. An earlier staging of 9fdeaeacec alone (release 9fdeaeacec6a) is superseded. Restart waiter ~/.personal-bots/run/restart-1.51.0.ps1 (PID in restart-1.51.0.pid; go-ahead file restart-1.51.0.now). Rollback: 1.50.0 = 58e552044577 (live), or 1.48.4 = 908e4fe26dbc.

## 1. Finished delegated-task chats archive after 30 idle minutes

Harout: "currently the bots have 30+ chats open from previous tasks done... when an orchestrator delegates tasks and the bots complete it, just archive it automatically after its been idle and not used for 30m."

**Rule** (`apps/server/src/personal/taskChatAutoArchivePolicy.ts`, pure; the dry run imports the same SQL and decision):

- Only a chat made for a delegated task: a `personal_tasks` row with `source = 'delegation'` on the thread, created no later than the chat itself.
- Every task on the chat is terminal (completed, failed, cancelled), and no child task it delegated is still open.
- Never: a chat holding any non-delegation task (Harout's own messages to a lead become `user` tasks, routine runs `routine` tasks), a routine's home chat (`personal_routines.thread_id`), a group member thread, a pinned chat (`projection_threads.pinned_at`, or settled_override `active`), an archived or deleted chat, a deleted bot's chat, a chat this sweep already archived once.
- Not while the session has a live turn (running/starting or an active turn), background work (`backgroundLiveness`) or a pending approval/question.
- Idle clock: 30 minutes (`TASK_CHAT_AUTO_ARCHIVE_IDLE_MS`) from the latest of the task's end, the chat's last message (bot or Harout) and Harout last having it open. Opening or writing restarts it.

**Opened.** The page already reports "this chat is open and visible" every 10 s for notifications (`useReportViewingThread`, in memory only). `PersonalPushService.reportViewing` now also writes `personal_bot_threads.last_viewed_at` for bot chats, at most once a minute per chat (`TASK_CHAT_VIEWED_WRITE_INTERVAL_MS`), so the clock survives a restart. 1.48's Queued/Read status is the bot reading Harout's message, not Harout opening a chat, so it could not be used.

**Archive path.** `PersonalBotService.archiveThread({ archived: true })`, the same call as the chat menu's Archive and bulk Archive: the link gets `archived_at`, the session stops with `terminateProcesses` (1.50). Nothing is deleted; the task page and task cards open the chat as before; Unarchive works. After the archive the sweep sets `personal_bot_threads.auto_archived_at`, which is never cleared, so a chat Harout unarchives stays open.

**Sweep.** `PersonalTaskChatArchiveService.ts`, started with the personal reactors in `server.ts`: once at startup (after activation) and every 5 minutes (`TASK_CHAT_AUTO_ARCHIVE_SWEEP_MS`); a semaphore stops overlapping runs. All state is in SQLite, so a restart just runs the next sweep. One log entry per sweep: `personal task chat auto-archive sweep { archived, finishedTaskChats }` (or `...: off in Settings`). A chat that fails logs `personal task chat auto-archive failed for a chat` and is retried next sweep.

**Setting.** Settings > Chat > "Auto-archive finished task chats", on by default. Stored server side (`personal_meta.taskChatAutoArchive` = on/off, absent = on) through the profile RPC (`PersonalProfile.autoArchiveTaskChats`, `PersonalProfileSetInput.autoArchiveTaskChats`), so it is the same on every device.

**Migration 085** (`085_PersonalTaskChatAutoArchive.ts`): `personal_bot_threads.last_viewed_at`, `auto_archived_at`, both nullable, additive.

**Existing chats.** The first sweep after the restart archives every existing chat that meets the rule. Latest dry run (fresh copy, 21:53Z): 239 open bot chats, **141 would archive**: Frontend 46, Backend 42, QA 34, DevOps 7, Planner 3, Designer 3, IT 2, Security 2, Astra 2. First dry run against a copy of the live DB (VACUUM INTO from a read-only handle at 20:23Z, then the 085 columns added to the copy; `~/.personal-bots/qa/backend-151/dry-run.mjs`, rows in `dry-run-rows.json`), at 20:29Z: 243 open bot chats, 142 finished-task chats, **141 would archive**: Frontend 46, Backend 42, QA 33, DevOps 7, Planner 3, Designer 3, IT 2, Security 2, Astra 2, Bench Sonnet55 H 1. Kept: 1 (Bench Sonnet55 X, ended 20:00Z, not yet 30 min). That is far more than the "30 to 35" in the brief: Frontend alone had 47 open chats. 2 of the 141 have a message from Harout (days old). 31 of them still show a session (29 ready, 2 error) and get a session stop; 111 are already stopped. After the restart the number will be a little different (new tasks since, 30-minute rule).

## 2. Chats no longer jump to the top on a metadata write

**Root cause.** Upstream's `ThreadSettlementReactor` settles a thread `sidebarAutoSettleAfterDays` (3 here) after its last activity. A fresh settle emits `thread.settled` with `updatedAt = now`, and the settle's session stop adds `thread.session-set` events, which also stamp `projection_threads.updated_at`. The Bots list, a bot's chat list and the server's preview ranking all ordered by that `updated_at`. "Backend exercise set r2 (opus-backend)": last turn 25 Sep 20:09:17Z, `thread.settled` (actor server, command `server:auto-settle:...`) at 28 Sep 20:10:05Z, exactly 3 days later. "QA exercise set r2 (opus-qa)": last turn 20:16:28Z, settled 28 Sep 20:17:05Z, then a session start at 20:18:41Z (the chat being opened: opening a chat prewarms its session) bumped it again. No message, title or read-status write was involved. Every chat idle for 3 days would have done this once.

**Fix.** Lists order by conversation, never `updated_at`:

- Server: `PersonalBotRepository.listThreadLinkRows` ranks previews by `activity_at` = the chat's newest non-system, non-reasoning message, else its creation, and returns it as `PersonalBotThread.lastActivityAt` (new optional contract field, list only).
- Web: `chatActivity.ts` `chatActivityMs(shell, link)` = latest of the shell's `createdAt`, `latestUserMessageAt`, latest turn requested/started/completed, and the link's `lastActivityAt` (relay routines post without a turn). Used by `buildBotSummaries` (row order, newest chat, "7m") and `collectAttentionThreads`, and by `botThreadRows` (a bot's chat list).

Group rows keep `personal_groups.updated_at` (written by rounds, not by the orchestration projection).

## 3. Seeded bots never default to Fable (CTO add-on)

Every fresh data root (each throwaway test server) seeded its four default bots on the catalog's `isDefault` model, `claude-fable-5-1`, the most expensive one (56 Fable requests since Sunday from e2e roots). `seedModel.ts` `seedModelFor`: `PERSONAL_SEED_MODEL` (env, used when the provider lists it), else `claude-opus-5-5` at medium effort (when the model offers effort), else the provider default or first current model that is not Fable or Mythos; nothing left means that bot is not seeded. Throwaway servers should run with `PERSONAL_SEED_MODEL=claude-sonnet-5-5` (qa/backend-151/start-server.mjs does).

## 4. Pinned bots show their model (CTO add-on)

The pinned faces at the top of the Bots list get a second line under the name from the same `botModelLabel` as the rows: 11 px tertiary, one line, `truncate`, inside the fixed 72 px tile; every tile (group, cold-start snapshot) reserves the line so the strip height never changes. The tile's accessible name includes the model. Follows a model change live like the rows. Measured with the rendered font: "Opus 5.5 high" 68 px and "Opus 5.5 max" 66 px fit; "Opus 5.5 medium" 86, "Sonnet 5.5 high" 76, "GPT-6-Astra medium" 102, "Muse Spark 1.3 Free xhigh" 127 px truncate (e.g. "Opus 5.5 me..."). That is the spec (tile width fixed, one line); if Harout wants them whole it needs two lines or a wider tile.

## Tests

Server: `PersonalTaskChatArchiveService.test.ts` (5, real bot service and repository on SQLite): archives at 30 min, not at 29, with the manual archive's session stop and nothing deleted; Harout's message and his open restart the clock; unfinished (running, waiting), routine task, routine home chat, group member, pinned, Harout's chat (user + delegation tasks), no task, live turn, background work, open child task all kept, failed and cancelled archived; setting off archives nothing, on again archives; restart (a second service on the same DB) archives once, then an unarchived chat stays open a day later. `taskChatAutoArchivePolicy.test.ts` (3), `085_PersonalTaskChatAutoArchive.test.ts`, `PersonalBotService.test.ts` (setting default on, saved off, kept across a name change), `PersonalPushService.test.ts` (viewed time written once a minute, not on leave), `PersonalBotRepository.test.ts` (the 28 Sep case: settled old chat with new `updated_at` gets no preview and keeps its 25 Sep `lastActivityAt`). Web: `chatActivity.test.ts` (2), `botSummaries.test.ts` (settled 3-day-old chat stays below; server time for relay posts), `botThreadRows.test.ts` (order ignores `updated_at`), `PersonalSettingsScreen.test.tsx` (toggle shows On, saves Off).

Also `seedModel.test.ts` (4: never Fable/Mythos, Opus medium first, override honoured only when listed, fallback), `PersonalBotService.test.ts` seed test now has the catalog's Fable default plus Opus and asserts Opus medium, `PinnedStrip.test.tsx` (label under the name, truncates, blank reserved line on a snapshot tile), `ChatsScreen.test.tsx` (pinned names now include the model).

Gates on 4ca62451a2: server src/personal + migration registry + 085 exit 0 (96 files, 1032 tests), server tsc exit 0, web personal exit 0 (115 files, 1123 tests), web tsc exit 0. Earlier on 9fdeaeacec: server `vp test run src/personal` + migration registry + 085 exit 0 (95 files, 1028 tests), server tsc exit 0, web `vp test run --project unit src/features/personal` exit 0 (115 files, 1122 tests), web tsc exit 0. PERSONAL_TASKS_CONCURRENCY still 5.

## Throwaway-server evidence (`~/.personal-bots/qa/backend-151/`)

Data root `%TEMP%/hbots-151-e2e3`, port 38563, releases 9fdeaeacec6a then 4ca62451a269 (same root, restart in between). Claude was the fake CLI (`fakebin/claude.cmd`, source `fake-claude.mjs`) set as `providers.claudeAgent.binaryPath` in the root's settings.json; a prompt with `DELEGATE:<bot>` makes it call the server's `delegate_task` MCP tool itself. No real model usage on this root.

- Delegation: Assistant chat 0596fdd4 "DELEGATE:Planner" -> 4 delegated Planner task chats (b1e98761 P1, 7afd302c P2, bf3062da P3, 7c1eaf40 P4), all completed 21:01:29-32Z (the fake re-delegated on each relayed result, up to the cap of 4). Harout's 3 Assistant chats hold `user` tasks.
- 21:02:19Z P3: typed "Thanks, looks good" (no new task made; `last_viewed_at` written by the heartbeat). 21:15:10Z P2: opened 15 s, `last_viewed_at` 21:15:10Z.
- Periodic sweeps every 5 min logged `{ archived: 0, finishedTaskChats: 4 }` until **21:34:06Z `{ archived: 3, finishedTaskChats: 4 }`**: P1, P3, P4 archived (`archived_at` and `auto_archived_at` set, sessions stopped); P2 kept (opened 19 min earlier); Assistant chats untouched (`db-after-sweep.json`).
- `verify-archived.mjs`: task page of P1's task -> "Open chat" opens the archived chat (`archived-chat-from-task-page-dark.png`); the delegator's card in the Assistant chat (1 card link for that chat) opens it; Planner's list reads "... 33m Archived chats (3)" (`planner-chats-after-auto-archive-dark.png`).
- Restart: server stopped 21:34:44Z, started on release 4ca62451a269 at 21:45:30Z (P2 due 21:45:10Z): startup sweep **`{ archived: 1, finishedTaskChats: 1 }`**, P2 archived at 21:45:44Z; the 3 archived earlier were not touched again.
- Unarchive through the archived section's button (`planner-archived-section-dark.png`): P3 back in the list, `archived_at` null, `auto_archived_at` kept; the next startup sweep (another restart, 21:48:49Z) saw `finishedTaskChats: 0` and left it open.
- Pinned labels (`pinned.mjs`): `pinned-390-dark.png`, `pinned-390-light.png`, `pinned-430-dark.png`, `pinned-430-light.png`; 4 pinned bots, every tile 72 px wide and 101 px tall, strip 105 px, no page overflow at either width. On this root the fake Claude and the OpenCode probe do not list Sonnet 5.5 / Muse Spark, so those two show their raw ids ("claude-sonnet-5-5 high", "opencode/muse-spark-1.3-contributor-free xhigh"), exactly as the rows do; "Opus 5.5 medium" and "GPT-6-Astra medium" show names. Live change in the edit form (Planner -> Opus 5.5 low) showed "Opus 5.5 low" on the pinned tile without a reload (`pinned-live-change-390-dark.png`).
- Seed (`seed-check.mjs`, fresh roots `hbots-151-e2e-seed2-*`, fake Claude only): no override -> all four seeded bots `claude-opus-5-5` effort medium; `PERSONAL_SEED_MODEL=claude-sonnet-5-5` -> `claude-sonnet-5-5` medium.
- Real usage slip: my first two throwaway roots (`hbots-151-e2e`, `-e2e2`, 20:56Z and 20:58Z) put the fake only on PATH, which the SDK ignores (it spawns its bundled claude.exe), so two short Assistant turns (on Fable, the seed default at the time) and a title ran on Harout's Claude account before I stopped them (session usage 42% -> 44%). Those roots and `-e2e3`, `-e2e-seed*`, `-e2e-seed2-*` are throwaway and can be deleted.

## Known

- The worktree has no `.env`, like every worktree build since 1.47: its keys are T3CODE_* read at runtime by start.ps1 from the main checkout, so the release is unaffected.
- A chat Harout writes in after the task ended stays a task chat when his message makes no task (seen in a Planner task chat) and archives 30 minutes after his last message or open. If his message becomes a `user` task (as in the Assistant chats here), the chat counts as his and is never auto-archived.
- The web list shows an auto-archived chat until its next list refresh (the list has no push); after the restart every client refetches.
