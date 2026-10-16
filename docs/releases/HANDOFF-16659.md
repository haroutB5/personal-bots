# HANDOFF 1.66.59

Four fixes on `release/hbots-16659`, all from Harout's live testing on 16 Oct 2026.
Frontend's call summary ships in this same release and adds its own section below.

1. **Empty Tasks page** (Backend, web) - a root with no tasks at all sat on
   "Loading..." forever instead of showing "Nothing is running right now".
2. **Plain step titles on the ACP path** (Backend, server) - DeepSeek dsh bots
   (and any other ACP provider) showed the raw `mcp__<server>__<tool>` name, or
   "Tool" on the steps that finished with output.
3. **Task-chat auto-archive** (Backend, server) - a delegated-task chat that
   later had routine runs posted into it stayed protected from auto-archive.
4. **dsh drain busy loop** (Backend, server; merged from
   `fix/hbots-dsh-drain-spin`, commits `6b67e5742e` and `6084b10c41`) - a
   message held behind a running dsh turn was retried about 7,000 times a
   second until the turn ended, which held the live server at 112% of a core.

## 1. Empty Tasks page

Cause: `apps/web/src/features/personal/usePersonalAutomation.ts:34` folded the
task replay with `Stream.groupedWithin` -> `Stream.scan`, and `scan` emits
nothing when its upstream emits nothing. The server concatenates the replay rows
with the live subscription (`taskQueries.ts:152`), so on a root with zero tasks
the replay is empty and no event arrives at all; the feed never produced a first
value, while `TasksScreen.tsx:305` reads `null` as "still loading".

Fix: `apps/web/src/features/personal/feedStartsWith.ts` (new) puts the fold's
empty state in front of the stream (`Stream.prepend`, so E and R are kept).
Applied to the tasks feed (`usePersonalAutomation.ts:45`), the groups feed
(`usePersonalGroups.ts:92`) and the in-app notification feed
(`usePersonalAutomation.ts:409`). The empty state is replaced by the real value
as soon as the replay lands; the tasks and groups feeds group it into 50 ms
chunks, so the worst case on a slow connection is one frame of the empty state.

Other feeds checked and left unchanged: the routines, files and memory lists are
query atoms and always resolve a first value; the browser-activity feed's server
stream always emits two head items (`browserLifecycle.ts:242`) and desktop
status is `Stream.concat(status, changes)` (`ws.ts:3792`).

## 2. Plain step titles on the ACP path

Cause: `makeToolCallState` used the raw ACP title as the presentation title, and
a result-only `tool_call_update` (no title, no kind, only content) derived the
generic fallback "Tool", which `mergeToolCallState` then used to replace the
title the call was announced with. Every ACP step that finished with output read
"Tool".

Fix in `apps/server/src/provider/acp/AcpRuntimeModel.ts`: `mcpStepLabelForAcpTitle`
(line 483) reads the model-facing `mcp__<server>__<tool>` name through the
1.66.58 helper `mcpToolStepLabel`, and `presentationTitle` (line 567) is set
only by a call that names itself (a title or a kind), so a result-only update can
no longer overwrite the announced title. A provider's own title for its built-in
tools is kept word for word, and only a bare hostname is ever read out of a
tool's arguments - never a path, query or value.

The naming is proved in dsh's own source: `dsh-acp` titles a tool call with
`event.data.name` and `dsh-mcp-client` builds `mcp__<server>__<rawName>`. A
provider that names MCP calls some other way keeps its own title, so nothing is
guessed.

## 3. Task-chat auto-archive

Cause: the delegation branch of `TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL`
(`apps/server/src/personal/taskChatAutoArchivePolicy.ts`) refused a
delegated-task chat while another task of a non-delegation source was still
open in it, so a routine run posted into the chat afterwards made it a
permanent non-candidate.

Fix: line 137 is now `other.thread_id = bt.thread_id AND other.source NOT IN
('delegation', 'routine')`, so only the owner's own work protects a chat. The
later `NOT EXISTS` (another source with an open task) is untouched, so a chat
that holds the owner's own task is still excluded.

Tests: `taskChatAutoArchiveCandidates.test.ts` runs the real candidate SQL
against an in-memory SQLite database (node:sqlite) for four cases - the CTO's
five-chat shape stays a candidate, it is refused while one of those routine runs
is still open, a chat holding the owner's own task is still excluded, and a chat
whose delegated task has not finished is still refused.
`PersonalTaskChatArchiveService.test.ts` held a case asserting the old
behaviour; it now asserts that such a chat archives 48 h after creation.

Live impact: those chats report `chatKind: "routine"` (they hold routine tasks),
so an unopened one uses its creation clock - the CTO's five DevOps chats of
11 Oct are long past it and clear on the next sweep.

## 4. dsh drain busy loop (merged)

`origin/fix/hbots-dsh-drain-spin` (`6b67e5742e`, one commit on top of live
`a67c7658cb`) is merged into this branch before the gates. In
`apps/server/src/provider/Layers/DeepSeekDshAdapter.ts`: `turnInFlight`,
`finishTurn` now schedules the drain, `attemptTurn` takes a
`requeue: "back" | "front"` argument, the drain loop puts a held message back at
the front and stops when a turn it did not start is in flight, and
`scheduleDrain`'s `Effect.ensuring` re-checks (inside an interruptible fork) so a
turn that ends while the loop is closing cannot strand a message.

New test `waits for the running turn without retrying a held message in a loop`:
at most 5 `attemptTurn` calls in 300 ms (the old code made 10,840), and the held
messages run in order once the running turn ends.

Astra's review of that commit (verdict SHIP) found two pre-existing gaps, fixed
in the follow-up commit `6084b10c41`, which is merged here too:

- A held message whose start failed (for example the bot-edit restart failed)
  was only logged: it never completed, and a failure after the turn was marked
  active left stale state that held every later message. The drain now settles
  it the way `sendTurn` does (`finishTurn`, failed, translated text) and carries
  on; an interrupt just stops the loop. Test: `fails a held message that cannot
start, and still runs the ones behind it`.
- A fresh send arriving between a turn ending and the drain it scheduled could
  start ahead of the held messages (Astra reproduced C, A, B). A fresh send now
  queues while anything is held or the drain is running. Test: `starts a send
that arrives as a turn ends behind the messages already held` (order A, B, C).

Backend's ACP step-title change does not touch this file, so both edits stand.

## Proof

Unit, on the code head `8209fbbb0b` (worktree `_wt/hbots-16659`, clean tree,
16 Oct 2026; `8209fbbb0b` is the merge of the review follow-up `6084b10c41`, and
only this notes file changed afterwards). Logs:
`C:/Claude/AI/dev-team/qa/hbots-16659-backend/gate3-*.log`.

| Gate         | Command                                                                                    | Exit | Result                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------- |
| server-tests | `vp test run src/personal src/mcp src/provider/Layers src/provider/acp` (in `apps/server`) | 0    | 4107 tests passed, 17 skipped, in 258 files; one 120 s timeout, re-ran alone green (see below); 507 s |
| server-tsc   | `tsc --noEmit` (in `apps/server`)                                                          | 0    | clean (Effect suggestions only)                                                                       |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps/web`)                         | 0    | 2827 tests passed, 0 failed, in 252 files; 40 s                                                       |
| web-tsc      | `tsc --noEmit` (in `apps/web`)                                                             | 0    | clean                                                                                                 |
| lint         | `vp lint --report-unused-disable-directives` on the 11 changed files                       | 0    | 0 errors, 4 warnings                                                                                  |

The one timeout was `src/provider/Layers/ProviderRegistry.test.ts` >
`re-probes when settings change the codex binaryPath` (120 s), a file neither
merged commit touches and which passed in the same gate 20 minutes earlier. It
re-ran alone in 6 s: 54 tests passed, exit 0
(`gate3-registry-rerun.log`). Frontend's own suite was running at the time, so
this was load, not code.

Note on the gate environment: the Bots app injects its own live environment into
every bot shell (`T3CODE_ENVIRONMENT_LABEL=Bots`, `T3CODE_PERSONAL_STALL_DIR`,
`DSH_HOME`, ...). With `T3CODE_ENVIRONMENT_LABEL=Bots` present,
`src/environment/ServerEnvironmentLabel.test.ts` fails 8 of 9 for a reason that
has nothing to do with the code; with those injected names cleared it passes 9
of 9 (checked 16 Oct). The gate above ran with the injected `T3CODE_*`,
`PERSONAL_*` and `DSH_*` names cleared, like a clean shell.

## For QA / CTO

- **Empty Tasks page**: a throwaway root with no tasks. `/tasks` shows "Nothing
  is running right now" within about 2 s instead of "Loading...".
- **ACP step titles**: a DeepSeek bot on the dsh engine that calls an MCP tool.
  The working step reads plainly (the 1.66.58 wording), not
  `mcp__t3-code__...`, and it does not become "Tool" once output arrives.
- **Auto-archive**: the five 11 Oct DevOps chats from the CTO's live query are
  candidates again; a chat that holds the owner's own task still is not.
- **Drain**: a message sent while a dsh turn runs must not push a core to 100%,
  and the held message runs in order once the turn ends.

## Cleanup

- Nothing is staged from this branch yet: `current.txt` is still `230ed5bce7ae`
  (1.66.58), so the rollback baseline is unchanged. Staging and
  `gate-evidence.ps1` run on the final 1.66.59 head, after Frontend's call
  summary commits land, because the evidence is tied to the commit and the
  staged artifact is sealed.
- No live server was touched: no build, restart or activation, and no live data
  was written. Worktree `_wt/hbots-16659`, branch `release/hbots-16659`; no
  background job of mine is left running.
