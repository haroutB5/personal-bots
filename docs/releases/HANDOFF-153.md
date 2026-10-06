# Group auto-continue, OpenCode command kill (already done), transfer budget, latest progress line (1.53.0)

2026-09-29, Backend (CTO task 3bbf591a). Branch feat/musey-kill-group-resume, worktree C:/Claude/AI/_wt/hbots-153. Built on 1.51.0 (ac32a281bf) and merged with Frontend's 1.52.0 (branch feat/pinned-short-label, head 175cb9a06a, release 2841d1093066); Frontend's branch was not touched.

## 1. OpenCode chats: delete and archive already end their commands (no code change)

The brief said every OpenCode chat shares one server. A bot's OpenCode chat does not: `startSession` refuses an external server for a bot, so each chat spawns its own `opencode serve` (`opencodeRuntime.startOpenCodeServerProcess`, lifetime bound to the chat's session scope). And on Windows the Effect child-process spawner ends that process with `taskkill /pid <pid> /T /F` (NodeChildProcessSpawner.ts), a tree kill, when the scope closes; `stopOpenCodeContext` also sends `session.abort` first. So a chat's command already dies with its chat, on delete and on archive (the deletion reactor and `PersonalBotService.archiveThread` both stop the session). The 1.50 note "OpenCode commands are not covered (shared server)" was wrong: 1.50 only had to add the walk for Claude (SDK spawns the CLI) and Codex (app-server child).

A PID walk for OpenCode was built (terminateDescendants(serverPid) before the scope closes, unit-tested) and then reverted (9812488923 + revert bfd97a4d7d): the evidence below shows the live release already does it, and a second process snapshot per stop would only duplicate the tree kill.

Evidence (`~/.personal-bots/qa/backend-153/opencode-kill.mjs`, report `opencode-kill-before-1.51.json`): throwaway root `%TEMP%/hbots-153-e2e`, port 38573, release 4ca62451a269 (the live 1.51.0, i.e. the "before" code), a bot on the free OpenCode model `opencode/muse-spark-1.3-contributor-free`. Three chats each ran `node -e "setTimeout(()=>{},900000)" MARK...` through the model's shell tool; the PIDs were found by that marker (evidence only, nothing was killed by name):

| chat | command PID | ancestry (child <- parent)                                                  | before | after A deleted | after B archived |
| ---- | ----------- | --------------------------------------------------------------------------- | ------ | --------------- | ---------------- |
| A    | 49788       | node <- bash <- bash <- opencode.exe 30240 <- cmd.exe 47492 <- server 61012 | alive  | gone            | gone             |
| B    | 43604       | node <- bash <- bash <- opencode.exe 73744 <- cmd.exe 30780 <- server 61012 | alive  | alive           | gone             |
| C    | 45404       | node <- bash <- bash <- opencode.exe 46116 <- cmd.exe 37180 <- server 61012 | alive  | alive           | alive            |

Each chat has its own opencode.exe, and A's and B's opencode.exe and cmd.exe were gone too (checked by PID afterwards; C's stayed). The script stopped the throwaway server by walking from its recorded PID.

Limits: a command that detaches itself so that no live parent links back to the server (a daemonised process) escapes `taskkill /T` exactly as it escapes the Claude/Codex walk. A restart of the hbots server does not stop the opencode servers of chats that were running at the time (unchanged, not per-chat).

## 2. A group round cut off by a usage limit continues at the reset

Before: a group member that hit a limit was skipped ("the group moved on"), dropped after a second hit, or (alone) parked until the reset. The parked round kept its original wall clock (10 to 45 minutes from the round's start), so a five-hour reset woke the round after its deadline and it ended "The group ran out of time"; a skipped or dropped member was never asked again.

Now (`PersonalGroupService.handleThrottle`, `groups/groupLimitResumes.ts`, migration 086 `personal_group_limit_resumes`):

- A skipped or dropped member, or a final verdict that could not finish, whose provider reported a reset is booked: one scheduled row per round and kind, members cut off by the same round share it (their names join the row, the later reset wins). Reset time plus 5 s grace, same `decideLimitHit` as the chat auto-continue.
- The group sweep (every 30 s and at startup, under the group lock) reopens the round at that time: the same round goes back to `running` with only the cut-off member queued (a verdict hit re-runs the verdict), a fresh window, budget at least the queue plus one. The member's cursor is rewound to the question, so its brief replays the question and what the group said since (its cursor had moved when its throttled turn started). Runs through the normal pump, so the group slot (1) applies; it does not take a task slot.
- Skipped, with the reason on the row: group deleted (`deleted`), archived (`archived`), the owner wrote in the group after the hit (`new_message`), another round took over (`superseded`), the round is still live for 30 min past due (`busy`), no member left (`no_members`). Once per hit: the row is claimed (`scheduled` to `resumed`) before anything is reopened. Survives a restart (rows in SQLite; the sweep runs at startup). At most 2 automatic continues in a group without the owner writing; the third hit only says so.
- The lone-addressee park now gets a new window from the reset, so it wakes into a live round instead of "ran out of time" (a bug with any reset beyond the round window, which is every five-hour limit).
- A short wait (under the 2-minute long-wait threshold) reported on the running session was dropped before the error that ends the turn, which arrives without a reset time (seen on the throwaway run: seq 72 running + retryAt, seq 77 error with none, seq 82 error with it, 5 ms later). The last reported wait per member thread is kept and used by the error branch (`reportedWaits`).
- Notice lines in the transcript (new system events `member-paused`, `round-resumed`): "Paused: Claude usage limit. Assistant continues at 00:19." (London time), and after the reset "Auto-continue after usage reset: Assistant continues." (`groupModel.ts` labels for both).

Tests (`PersonalGroupService.test.ts`, 8 new, plus `086_PersonalGroupLimitResumes.test.ts`): continues once at the reset (not before, brief replays the question, later sweeps add nothing); skipped when the owner wrote since; skipped when archived and when deleted; a restart between the hit and the reset (second service on the same DB) resumes once; verdict cut off and retried; lone addressee wakes at the reset; the cap notice after two continues; the short-wait case.

Throwaway run (`qa/backend-153/group-*.mjs`, fake Claude CLI via `providers.claudeAgent.binaryPath`, `PERSONAL_SEED_MODEL=claude-sonnet-5-5`, no real Claude or Codex use): group "Launch crew" of Assistant and Developer, "@Assistant and @Developer LIMIT ..." with the fake rejecting the five-hour window for Assistant only, reset in 90 s.

- 23:17:26Z Assistant hit the limit (reset 23:18:56Z); Developer answered; round completed. Row: kind members, resume_at 23:19:01Z, scheduled. Transcript: "Paused: Claude usage limit. Assistant continues at 00:19." (`t2-before-restart.png`).
- 23:17:47Z the server was stopped and started again (same data root).
- 23:19:19Z "personal group resumed after a provider limit": row `resumed`, "Auto-continue after usage reset: Assistant continues." and Assistant's reply "Continued. ... You are Assistant in this group." (`t3-after-reset.png`). The fake CLI log shows exactly one Assistant prompt after the reset ("limit window reopened; answering normally"); no second one in the next 9 minutes.
- Before the stash fix the same run had booked nothing (90 s wait, error without reset): `t1-after-hit.png`.

Not covered: a member's turn that fails on a limit without any reset time (unreported) keeps the round's own handling (skip / 60 s backoff); the paused-budget and paused-vote states.

## 3. server.test.ts "reports thread HTTP and WebSocket transfer budgets"

Failed on the 1.49.0 base and after: thread snapshot 7,547 B (codex) and 7,545 B (claudeAgent) against the 7,500 B budget; the other budgets passed. Cause: 1.48.0 (d923276830, Queued / Read) stores a `user-message.delivered` activity per owner message, id `<messageId>:delivered:<ms>`. The scenario's 10 user messages put 10 such rows (218 B raw each, unique ids and timestamps so they compress badly) into every thread snapshot: 118,950 B decoded, ~209 B of gzip over. Headers are the same 222 B as ever (content-type, length, encoding, vary, cors, date).

It was waste, not payload the client needs: the web reads only the delivery for the latest owner message (`deriveLatestMessageReadStatus`), and every delivered row rode in every snapshot for the life of a chat (a 200-message chat: ~44 KB raw, ~8 KB gzip on every open, and each row also takes one of the 500 activity slots). Fix: the activity id is now `user-message-delivered:<threadId>` (`ProviderRuntimeIngestion.runtimeEventToActivities`), the projection upserts by id, so each delivery replaces the last: one row per thread. The client reducer already replaces an activity with a seen id. Result: thread snapshot 7,338 B (codex), 7,333 B (claudeAgent), budget unchanged at 7,500 B. Old rows of already-stored chats keep their old ids and stay (harmless: the client scans for the latest message's id). Test: `ProviderRuntimeIngestion.activity.test.ts` (same id per thread, a different one for another thread).

## 4. "Latest progress" line for a working bot (CTO's added item, Harout asleep)

Sonnet 5.5 chats look blank while they work: the progress is in thinking summaries (`reasoning` messages, which `conversationModel.ts` hides) and tool steps (hidden unless "Show tool steps"). Now one muted line shows the newest note while a turn runs, gone when it ends:

- **Note** (`packages/contracts/src/personalProgressNote.ts`, shared by client and server): the newest of (a) the latest thinking message of the running turn and (b) the title of its latest tool step; a thinking message wins a tie. A thinking message accumulates for the whole turn, blocks run together ("...anything.**Planning the fix**

..."), so the note is the LAST bold summary title, else the last non-empty line of raw thinking. One plain line (markdown stripped), at most 120 characters with an ellipsis. Only reasoning text and the tool step's title are read, never tool output, arguments or detail; secret-looking runs (Bearer, sk-, ghp_, xox, AKIA, JWT, password/token/api key=..., PB_SECRET_..., 40+ key characters) are blanked to "[hidden]" before the cut, and a line that is only a secret shows nothing. Tests: `personalProgressNote.test.ts` (15).

- **Chat** (`latestProgress.ts`, `ProgressNoteLine.tsx`, ConversationScreen): derived from the messages and activities the open chat already holds, for the turn since `latestTurn.requestedAt`; a slim line directly under the header, `text-[13px]` tertiary, one line truncated, not a live region, nothing rendered without a note. Tests: `latestProgress.test.ts` (7), `ProgressNoteLine.test.tsx`.
- **Bots list** (`personalBots.workingProgress` RPC, read scope; `personal/workingProgress.ts`; `useWorkingProgress.ts`; `BotRow.previewOf`): the list holds only thread shells, so the server answers for the working chats: per running or starting session, the newest thinking message and tool step title since the owner's latest message, through the same shared function. The list asks only about working bots' freshest live chat (`BotSummary.liveThread`), repeats the read when that shell's `updatedAt` moves, at most every 2.5 s, never while the page is hidden; the row shows the note instead of the last message while `live`, and the last message again when the turn ends. Never written to the cold-start snapshot (`snapshotPreviewLabel` test). Pinned bots have no preview line (their tile is unchanged). Tests: `workingProgress.test.ts` (server, real projection tables), `BotRow.preview.test.ts` (3 new), `ChatsScreen.test.tsx` (2 new), `useWorkingProgress.test.ts`.
- **Limit worth knowing:** Claude's adapter titles every command step "Command run" (`titleForTool`), so a Claude bot that is only running commands reads "Command run"; thinking summaries (what Sonnet writes) come first on a tie and carry the real text. OpenCode and Codex step titles are more descriptive.

Throwaway evidence (`~/.personal-bots/qa/backend-153/progress-shots.mjs`, `progress-poll.mjs`, `progress-snap.mjs`; fake Claude CLI that streams a thinking block "**Reading the failing test**", a Bash step, then "**Planning the fix**"): 390x844 screenshots `progress-chat-{thinking,tool-step,thinking-2,after-turn}-{dark,light}.png` and `progress-list-{working,after-turn}-{dark,light}.png`. While working: chat header line "Reading the failing test" (both schemes), Planner row "Working / Reading the failing test" with the live dot; after the turn: no line, row back to "Ready / Done with the progress demo.". Found on the way (not changed): a reasoning block only reaches the projection when the block ends (the next block, a tool step, text, or the turn end), so the note advances at block boundaries, which is how real Claude thinking blocks arrive; and an already-open Bots page in the headless throwaway did not pick up "Working" on its own within 30 s on 1.51 either (a fresh navigation does), so the list evidence is from navigations during the turn.

## Gates (head 1cd64bf10e, release 1cd64bf10eb5)

- server: `vp test run src/auth src/personal src/persistence/Migrations src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts` exit 0 (147 files, 1191 tests); `src/server.test.ts -t "transfer budgets"` exit 0 (thread snapshot 7,338 B of 7,500 B); `tsc --noEmit` exit 0 (the effect language service reports its rules as errors: no `new Date()` or `JSON.parse/stringify` in Effect code; the first gate run caught 9 and they were fixed).
- web: `vp test run --project unit src/features/personal` exit 0 (118 files, 1145 tests); `tsc --noEmit` exit 0.
- contracts: `vp test run` exit 0 (30 files, 493 tests).
- Build: `scripts/personal/build.ps1 -CopyExternals -NoActivate` exit 0, release 1cd64bf10eb5, VERSION 1.53.0.
- Not run: the whole-repo checks (CI owns them).

## Release

Staged, not activated. Waiter `~/.personal-bots/run/restart-1.53.0.ps1` (PID 76348, in restart-1.53.0.pid): idle 3x20 s, up to 48 h, or the go-ahead file `restart-1.53.0.now` / `restart-1.52.0.now` once 90 s old; then `restart.ps1 -Release 1cd64bf10eb5` and `smoke.ps1 -ExpectRelease 1cd64bf10eb5`, log `~/.personal-bots/logs/restart-1.53.0.log`. Frontend's 1.52.0 waiter (PID 35432, release 2841d1093066) was stopped by that PID on the CTO's word: 1.53.0 contains it. Rollback: 1.51.0 = 4ca62451a269 (live now). Throwaway root `%TEMP%/hbots-153-e2e` deleted; evidence stays in `~/.personal-bots/qa/backend-153/`.
