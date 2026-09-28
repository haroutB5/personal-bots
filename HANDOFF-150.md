# Model label, chats continue after a usage limit, delete ends a chat's commands (1.50.0)

2026-09-28, Backend (CTO task 83954690). Built on 1.49.0 (5d7bb83e09). Release 58e552044577 (commits 857d231ec4 + 58e5520445, personal-bots/main = origin), staged -CopyExternals -NoActivate, build exit 0. Restart waiter ~/.personal-bots/run/restart-1.50.0.ps1 (PID in restart-1.50.0.pid) replaced the 1.49.0 one. Rollback: 1.48.4 = 908e4fe26dbc (the live release; 1.49.0 5d7bb83e09f6 never went live).

## 1. Model label beside the bot's name

Harout: "add the model name in small next to bot name. So example: opus 5.5 medium".

- `apps/web/src/features/personal/botModelLabel.ts`: `botModelLabel(modelSelection, providers)`. The model's name as the picker shows it (`ServerProviderModel.name`) without the leading "Claude ", plus the effort option's label lowercased when one is set (`effort`, Codex `reasoningEffort`, OpenCode `variant`). No effort set = no effort word (Sonnet with only contextWindow 1m reads "Sonnet 5"). The raw id only when the provider does not list the model. `EFFORT_OPTION_IDS` moved here (botFormModel re-exports it).
- `BotSummary.modelLabel` (buildBotSummaries), so it follows the bot list and provider snapshot live: a model change shows without a reload.
- Bots list row (`BotRow.tsx`): after the name, before the mute bell and live dot, 13 px tertiary, `shrink-[100]` so it truncates before the name. Pinned strip: no label (unchanged).
- Bot's chats-list header (`BotThreadsScreen.tsx`): same label beside the name; here the name keeps its width (`shrink-0 max-w-full`) and the label gets what is left, since the header has less room (58e5520445). The title line underneath is unchanged.
- Other open devices see a model change on their next list refresh, like every other bot field (name, pin, mute): the list has no server push. The device that saved it updates at once.

## 2. A chat stopped by a usage limit continues on its own

Before: tasks waited for the reset (PersonalTaskService); a plain chat just stopped and Harout had to say "continue".

**Why the reset time was lost (Claude).** The CLI's "You've hit your session limit" line is assistant output, and output clears the session's "rate limited" wait (ProviderRuntimeIngestion), so the failed turn ended as `error` with no reset. Now `ClaudeAdapter` keeps each rejected window's wait in the turn state and puts the latest one on the failed `turn.completed` (`usageLimitRetryForFailedTurn`); a limit seen only in the reply text carries `{kind: rate_limited}` without a time. Codex already put its reset on the failed turn. Side effect (wanted): a task whose Claude turn fails on the limit now waits for the reported reset instead of the 1-minute backoff, as Codex tasks did.

**Service** `apps/server/src/personal/PersonalChatResumeService.ts` (+ `personalChatResumePolicy.ts`), started with the other personal reactors in `server.ts`:

- A bot chat's session goes `error` with `providerRetry.kind = rate_limited`: one row in `personal_chat_resumes` (migration 084, unique per thread + failed turn, so a hit is handled once, also across restarts) and a "Paused" row in the chat.
- Skipped: chats that are not bot chats, turns of a task or group round (the newest user message is `personal-task-*` / `personal-group-*`, or the task service owns the turn). Groups keep their own throttle handling (skip/retry/drop the member); resuming a cut-off group member is not handled here.
- No reset reported, a reset more than 8 days out, or already 2 automatic continues since Harout last wrote: notice only ("... send a message to continue").
- A sweep every 15 s (and once on start, so resumes due during a restart run) starts due resumes, oldest hit first. At fire time it re-checks: chat deleted or archived (thread or bot link), any user-role message since the hit, a task owning the turn: skipped. Session busy without a new message: waits, up to 30 min.
- Each resume takes a slot from the task cap through `PersonalTaskService.reserveExternalSlot` (tasks + resumes <= PERSONAL_TASKS_CONCURRENCY = 5; the pump counts both); given back when the resumed turn ends (or after 3 h, or on delete). Same provider: at least 15 s between starts.
- The continue is a `thread.turn.start` with message id `personal-resume-<id>`, the bot's own model selection, prompt "[Auto-continue after usage reset] ... Continue where you left off ...". Grace 5 s after the reported reset, plus up to 15 s sweep delay.
- Also skipped by events: `thread.turn-start-requested` from anyone else, `thread.deleted`, `thread.archived`.

**What Harout sees.** Both lines carry a `personal-chat-notice` context marker (contracts `personalChatNotices.ts`), so the web renders them as system rows, never a bubble:

- "Paused: Claude usage limit. Continues at 23:00." (assistant-role row written by the server; the time is re-rendered from the marker in the device's zone; "Tue 09:00" when not today).
- "Auto-continue after usage reset" (the continue turn; tap shows the prompt the bot got, like task rows). The provider needs a prompt, so it is a user-role message underneath, but it is excluded from "Harout replied" checks, from Queued/Read, and previews as the label on the Bots list.
- No push for the pause (push fires on running -> ready only); the resumed turn's reply notifies as usual.

## 3. Deleting or archiving a working chat ends its commands

- `ProviderStopSessionInput.terminateProcesses` and `ProviderAdapter.stopSession(threadId, {terminateProcesses})`. The deletion reactor always sets it; archive (`PersonalBotService.archiveThread`, archived=true, single or bulk) dispatches `thread.session.stop` with the new `terminateProcesses` flag when the chat's session is not stopped. A settle stop does not set it, so idle-settle keeps behaving as before.
- Claude: `claudeProcessSpawner.ts` spawns the CLI through the SDK's `spawnClaudeCodeProcess` (same spawn options as the SDK's own) and remembers the child. Stop with terminate: `processTree.terminateDescendants(cliPid)` before `query.close()`, then the SDK closes the CLI as before. Kill switch: env `PERSONAL_CLAUDE_SDK_SPAWN=1` (SDK spawns; delete no longer ends commands). Trade-off: the SDK can no longer fold the CLI's stderr into its exit error; the tail is logged as `claude.process.exited-abnormally` instead.
- Codex: the app-server child's PID (`CodexSessionRuntime.processId`), same call.
- OpenCode runs one shared server, so its commands are not ended per chat (not covered).
- `processTree.ts`: one Win32_Process snapshot (PowerShell CIM), walk from the session's own PID, skip any process created before its "parent" (PID reuse) and this server and its parent, then `taskkill /PID <n> /F` per PID, parents first. Never by name or filter. Logs `claude.session.processes-terminated` / `codex.session.processes-terminated` with found and killed PIDs.
- Session row: `ProjectionPipeline` marks `projection_thread_sessions` stopped (active turn cleared) when it projects `thread.deleted`; before, the later "stopped" was rejected for a deleted thread and the row read `running` forever.
- `~/.personal-bots/run/idle-check.mjs`: kept with the deleted-thread guard (belt and braces): rows left `running` by chats deleted before 1.50.0 are not repaired by the fix. Backup of the original stays at `idle-check.mjs.bak-1.49.0`.

## Tests

Server: `PersonalChatResumeService.test.ts` (8: pause + continue at the reset with the bot's model and a held slot; owner replied, by event and by stored message; deleted and archived; restart with a second service on the same DB, duplicate hit, three sweeps = one continue; no reset = notice only; task and group turns ignored; slots full then one after another; loop guard), `personalChatResumePolicy.test.ts` (5), `084_PersonalChatResumes.test.ts`, `processTree.test.ts` (5, one with real processes: a sleeping grandchild ended by its parent's PID, parent left alone), ClaudeAdapter usage-limit tests assert `retry` on the failed turn, PersonalTaskService "chat resume takes a slot from the same cap", ProjectionPipeline "deleted mid-turn leaves its session stopped", bulkPersonalChats archive dispatches the stop with terminateProcesses. Web: `botModelLabel.test.ts` (4), `chatNotices.test.ts` (3).

## Throwaway-server evidence (`~/.personal-bots/qa/backend-150/`)

Data root `%TEMP%/hbots-150-e2e`, port 38562, releases 857d231ec425 then 58e552044577. Claude was a fake CLI (`fakebin/claude.cmd` -> `node_modules/@anthropic-ai/claude-code/cli.js`, same file as `fake-claude.mjs`): LIMIT rejects the five-hour window (reset in 120 s) the way the real CLI does, SLEEP starts a long-running child and keeps the turn open, anything else replies. No real Claude usage.

- Labels (`labels.mjs`, `labels2.mjs`, `header.mjs`, `longrow.mjs`): `bots-labels-dark.png` / `-light.png` at 390x844: Updates "Opus 5.5 medium", Developer "GPT-6-Astra medium", Researcher "Muse Spark 1.3 Free xhigh", Planner "Sonnet 5"; no clipping, no page overflow. Pinned strip (Assistant) has no label. Live: Planner edited in the same tab, saved, landed on /bots with "Opus 5.5 low", then back to "Sonnet 5" (`bots-labels-live-change-dark.png`). Long names: label shrinks to 0 first, then the name truncates (`bots-longname-dark.png`, `chats-header-longname-*.png`).
- Auto-continue (`limit.mjs`, `limit-one.mjs`, `after-reset.mjs`, `db.mjs`): four chats paused at 00:32Z ("Paused: Claude usage limit. Continues at 01:34."): A resumed at 00:34:18.9 (due 00:34:13), one continue message, bot replied (`resumed-A-dark.png` / `-light.png`); B skipped new_message (owner replied), C skipped deleted, D skipped archived at its due time. E paused 00:43:27, server stopped before the reset and started 00:46:05: resumed 00:46:06.8, one continue message. Sessions of all of them ended ready/stopped.
- Commands (`sleep-kill.mjs`, `sleep-kill-report.json`, `pids/sleep-pids.txt`): single delete, archive and a bulk delete of two chats, each while the fake CLI's child ran: every sleep PID (70176, 39828, 9532, 77856) was gone within 6-8 s; the fake CLIs (45200, 18744, 77704, 68508) exited after the SDK's close (the fake ignores stdin EOF; the real CLI does not). Server log `claude.session.processes-terminated` lists found/killed PIDs per stop. Afterwards 0 sessions running/starting in the throwaway DB; the deleted chats' rows read stopped.

## Known

- `src/server.test.ts` "reports thread HTTP and WebSocket transfer budgets" fails (thread snapshot ~7.5 KB vs 7.3 KB budget) on the 1.49.0 base too; not part of the personal gate, not caused by this change.
- OpenCode commands are not ended per chat (one shared server).
- Group chats: a member cut off by a limit is left to the group round's own throttle handling (skip, retry, drop); no resume at the reset.
