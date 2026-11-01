# 1.66.110: Claude team leads stop stalling on their own words and keep delegated results

Based on 1.66.109 (`6d65905b02`). Branch `release/hbots-166110`. No migration; schema remains 114. Server only; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Harout: "Check why p-stack team isn't working well with Claude. Keeps stopping and not tracking tasks well." Poteto (the PStack lead) moved from DeepSeek to Claude Opus 5.5 mid-job. Its task `4a39b9fa` then looked stopped for half an hour, and a delegated result landed on a second task nobody was reading. Findings and measured timings: `/home/harout/Claude/AI/dev-team/state/pstack-team/evidence/2026-11-01-claude-stalls.md`.

## Root causes

1. **A lead's normal status line held its own task open.** For `claudeAgent` sessions only, `backgroundOutcome` passed `statedWait` from `saysItIsWaiting` into `stepBackgroundWait`, and the first pattern matches "I'll pick it up when either one reports back." The attempt then stayed active for up to the 8 h hard cap. Finished delegated children cannot start the `[Task continuation]` attempt while the thread still has an active attempt, so their results waited for an unrelated user message. Server log evidence: `personal task waiting for its work to finish { taskId: 4a39b9fa, backgroundTasks: [], statedWait: true }` at 11:06:38, 11:17:53 and 11:37:15. The wait exists for work the app cannot see; delegated children are work the app delivers itself.
2. **An approval answer became a separate root task.** `answerLead` starts a plain user turn with the `team-bot-answer` chat notice. When that turn runs, the lead's task is queued for its continuation and no attempt owns the thread, so `resolveCallerTask` adopted the turn as a new root (`af335eaa`, source `user`). The lead's delegation in that turn (`0ed3ce15`) was parented to the new root instead of `4a39b9fa`, and its result went to a task that stayed queued behind the busy thread.

## What changed

- `apps/server/src/personal/tasks/taskBackgroundPolicy.ts`: `stepBackgroundWait` takes `openChildren`. When the attempt's task has a delegated child still running, or one finished and waiting to be handed over, a stated wait is dropped (including one already in force) so the bot's words cannot hold the attempt open. Background commands (`pending`) keep their wait exactly as before, and tasks with no open children keep the stated-wait behaviour.
- `apps/server/src/personal/tasks/taskSettling.ts`: `backgroundOutcome` reads the task's handoffs and passes `openChildren` when any is `pending` or `returned` (Claude only, like `statedWait`). Ending the attempt lets `resolveAfterTurn` park the task on its children; the child's result then wakes it and starts the continuation attempt.
- `apps/server/src/personal/tasks/PersonalTaskRepository.ts`: new `latestUnfinishedTaskForThread`, the newest task in a thread whose status is outside `PERSONAL_TASK_TERMINAL_STATUSES`.
- `apps/server/src/personal/tasks/taskCallers.ts`: when the newest user message in the thread is the server's `team-bot-answer` turn message, `resolveCallerTask` returns that thread's unfinished task (same bot) instead of adopting the turn as a new root, so delegations made in the answer join the running task's tree. A thread with no unfinished task keeps today's behaviour.

## Verification

- Red first, then green, on the pre-fix sources: `taskPolicies.test.ts` (3 new cases) and `PersonalTaskService.test.ts` (2 new cases) failed 5 tests with 173 existing passing; with the fix both files pass 178/178.
  - `does not let the words hold an attempt whose delegated children the app delivers`
  - `ends a held stated wait once a delegated child has a result to deliver`
  - `keeps a background command's wait even while children are open`
  - `a Claude lead's stated wait ends when its delegated children can report, and their result continues it`
  - `an approval answer joins the thread's unfinished task instead of starting a root`
  - `an approval answer with no unfinished task still adopts its turn as a root` (keeps the old path)
- Lead-bot service tests stay green: `src/mcp/toolkits/bots/leadBots.test.ts` and `handlers.test.ts`, 97/97.
- Server typecheck (`node scripts/personal/node/typecheck-lean.mjs`) exits 0.

## Gate evidence

<!-- gate-evidence:begin sha=5a67a39f2a1e6d731766bdb28031fdd4dca1bf98 release=5a67a39f2a1e json-sha256=9d41190d59186017c71a3bbab080c28ded6550c1efbcbe1777397bfdb4ae10ba result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
