# Task steering continuity

Incident: delegated task `4a2d9603-9ae2-4c6d-9203-d4f769d5c573`,
thread `0b7eff88-5f6f-4441-8954-ba8557eda3aa`, 25 October 2026.

## Cause and change

The copied provider cursor says `engine: acp`, instance `opencode-v2`.
`opencode-v2` is wired through `opencode2.ts` to `NativeAcpAdapter`.
It does not use the SDK adapter in `OpenCodeAdapter.ts`. ACP accepts one
prompt at a time, so the native adapter cancelled the active prompt before
submitting a steer. It called the public `interruptTurn` operation, emitting
`turn.aborted` with reason `interrupted`. The task settler treated that event
as a terminal interruption even though the replacement prompt was starting.

The isolated incident-row copy records:

| UTC time     | Evidence                                                                           |
| ------------ | ---------------------------------------------------------------------------------- |
| 19:32:23.258 | Delivered steer note and `thread.turn-start-requested`, sequence 1249788.          |
| 19:32:23.439 | `thread.session-set` interrupted, no active turn, sequence 1249791.                |
| 19:32:23.442 | Replacement turn `088f5409-06b6-493b-b4ce-15419c34edcb` running, sequence 1249795. |
| 19:32:23.474 | Attempt 1 ended with `error_category=interrupted`, `resumable=1`.                  |

Thus steering itself generated a terminal transition. The replacement turn
continued producing events after the task attempt had ended. The source was
opened read-only for one consistent, indexed copy (94,208 bytes, integrity
check `ok`); analysis used only that copy. No live DB write was made.

The adapter now cancels only the ACP prompt and retains the logical turn ID
and running session across replacement prompts. It publishes one start and
one final completion. Steer admission and settlement use the same thread lock;
concurrent steers and errors from superseded prompts cannot settle the task.
A failed final replacement still reports failure. Explicit Stop still aborts
the logical turn, including during the handoff or busy-prompt retry.

Rollback: `PERSONAL_TASK_STEER_CONTINUITY=off` restores the previous cancel,
abort, new-turn behavior. The switch is checked for every send. No migration,
task concurrency change, model call, live-task reproduction or deployment is
part of this branch.

## Regression proof

The task-service integration uses an isolated SQLite database and the real
ACP transport against a mock agent. It waits until the first prompt is inside
a tool, steers the task, checks that cancellation leaves the task running,
then checks one successful terminal event, one task attempt and the exact
assistant result `Steered work finished.`. With the rollback switch set to
`off`, the same test fails with expected `running`, actual `interrupted`.

Task-service steering coverage also runs for `claudeAgent` and `codex`.
Their adapter checks verify Claude's active-turn injection and Codex's
`turn/steer` request (including refused-steer fallback). The separate
`DeepSeekDshAdapter` already queues mid-turn steers without cancellation.
The SDK OpenCode adapter also retains the active turn ID. Neither calls the
native adapter's faulty abort/resubmit path.

Native ACP checks cover concurrent steers, a failed middle setup followed by
later work, a failed final setup, cancelled-prompt rejection, busy-prompt
retry and explicit Stop.

The full fork gate passed on this branch:

| Check                                        | Result                  |
| -------------------------------------------- | ----------------------- |
| Server personal and MCP suites               | 2,984 passed, 4 skipped |
| Web personal and auth suites                 | 3,080 passed            |
| Native ACP, Stop/retry and Codex steering    | 18 passed               |
| Claude active-turn injection                 | 1 passed                |
| Standalone DSH held-steer behavior           | 1 passed                |
| Server and web typechecks                    | PASS                    |
| Changed-file lint, formatting and whitespace | PASS                    |

The complete task-service suite also passed independently (113 tests), as did
the four final concurrent-steer failure cases. The first server typecheck
failed because the worktree lacked its `scripts/node_modules` junction.
Adding that dependency link, without changing source or installing packages,
made the rerun pass. The initial failure and successful rerun are retained.

Sanitized incident evidence, failing and passing regression logs, gate logs
and `final-gate-summary.json` are in
`C:/Users/Ht/.personal-bots/qa/hbots-steer-fix-20261025/`.

## Combining branches

Based on `a81db54eef` (`release/hbots-16693`). Only production file changed:
`apps/server/src/provider/Layers/NativeAcpAdapter.ts`. Task settling and
background policy are untouched.

`fix/hbots-task-stated-wait` changes task settling and adds tests later in
`PersonalTaskService.test.ts`; this branch adds steering tests around the
existing running-steer test. Preserve both sets of tests when merging.
`feat/hbots-linux-server` had no overlapping edits in these files at review.
Run the combined release gates and focused task QA before DevOps ships.
