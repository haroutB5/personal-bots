# steer_task reopens a finished task in its own chat (1.57.2)

2026-09-29, Backend (CTO task 271d5a03). Branch feat/reopen-finished-task, on 1.57.1 (56b168318c). Commits 8f082f8f47 feature, 4dfba98930 version. Release 4dfba989303b, staged with -CopyExternals -NoActivate, build exit 0, not live; live is 1.56.1 (dd3e98877796).

Why: Frontend's animation task ended with a mid-work line after Harout paused it and switched its model. steer_task refused finished tasks, the request was at its 4-delegation limit, so CTO used a one-off routine, which opened a NEW chat. Harout: "This was related to the same task. Why did you create a new chat. Fix it for future sessions."

## What changed

- `PersonalTaskService.steer` (apps/server/src/personal/tasks/PersonalTaskService.ts ~2046, terminal branch ~2058): a terminal task (completed, failed, interrupted, cancelled) is no longer refused; it goes to `reopen` and the outcome is `"reopened"`.
- `reopen` (~1966, helpers `reopenHandoff` ~1933, `reopenNote` ~393): queues the same task again (result, error, completedAt cleared; thread id kept), so the dispatcher's next claim is attempt N+1 on the SAME thread and provider session. Two notes open that turn: the steer ("Update from X: ...", recorded like any steer, get_task lists it) and `reopenNote` ("This task had finished / ended (interrupted) and has been reopened in this same chat. Continue where you stopped."). The turn reads "[Task continuation] / update / reopen note / Continue the task below. / task sections". Its handoff to its parent goes back to `pending`.
- Parent design (the choice asked for): every FINISHED ancestor, up to the first unfinished one, is reopened as `waiting_for_agent` with its own handoff back to pending. From there it is the ordinary 1.57.1 per-child path: the child's result wakes the parent, whose continuation runs in the parent's own chat (after any turn running there, e.g. the turn that did the steer), the parent answers and completes, and that answer climbs the same way. Chosen because it needs no new delivery path and keeps "a result goes to its parent task" true at every depth; posting straight into the parent chat without reopening would leave the parent task completed with a stale result and would not reach a grandparent. An unfinished parent just gets the pending handoff (it parks on it or takes it in its next continuation).
- Refusals: the task's bot deleted ("That task's bot has been deleted..."), or the bot of an ancestor that would have to reopen deleted; both checked on the writing connection inside the transaction. No task is created, so `countTasksInRoot` (the 4-per-request limit) is untouched; the reopened task is just queued, so the slot cap (PERSONAL_TASKS_CONCURRENCY 5) applies.
- MCP reach (apps/server/src/mcp/toolkits/bots/handlers.ts): `steer_task` first tries `reachableTask` (current request tree; lead: unfinished team tasks), then `reopenableTask` (~342, used at ~549): a finished task that ended within 24 h (`REOPEN_WINDOW_MS`) and was delegated from the caller's own chat (its parent task ran in that thread), or, for a team lead, whose bot is on the lead's team. Everything else reads "That task is not in your task tree." New `STEER_REOPENED_NOTE` in the tool result.
- Tool text (tools.ts ~158, ~469): steer_task description says it reopens ended tasks, when (paused, interrupted, ended with a mid-work line, missed part of the brief), that it does not count against the delegation limit, and not to delegate a new task or make a routine for it; title "Steer or reopen a task"; result outcome gains "reopened". Bot instructions (personalBotInstructions.ts line 20) got one matching sentence.
- No web, contracts or migration change.

## Tests

PersonalTaskService.test.ts (49): reopen a completed child in the same thread and the result returns to the completed parent (exact continuation text, attempts 1 and 2 on the same thread, parent reopens to waiting_for_agent, gets a continuation with the new result and completes, turns ran on only the two original threads, still 2 tasks); an interrupted and a cancelled child reopen while the parent still runs; a reopen at the 4-child limit works and creates no task; a reopened task waits for a free slot; a deleted bot is refused. handlers.test.ts: reopen a stopped task in the caller's tree; reopen a task delegated from this chat after that request ended (a new turn = new root; the old root waits in the same chat); a finished task outside reach is refused; a lead reopens a team task within 24 h and not after 25 h; a deleted bot is refused. The old "steer refuses a finished task" tests were replaced.

## Gates

server `vp test run src/personal src/mcp` exit 0 (114 files, 1270 tests), server tsc exit 0. Build exit 0.

## Throwaway

`~/.personal-bots/qa/backend-1573/` (report.txt, run.mjs, fake-claude-log-copy.txt, server-log-copy.txt, shots/, build.log, gate-*.txt). Release 4dfba989303b, fake Claude CLI, PERSONAL_SEED_MODEL=claude-sonnet-5-5, port 38626, server stopped by captured PID, root deleted. Assistant delegated "Avatar animation" to Developer; both completed. A second message in the SAME Assistant chat called steer_task on the finished child: outcome reopened; the child ran attempt 2 on the same thread b2bda237 (same fake CLI process and session as attempt 1) with "[Task continuation] ... Continue where you stopped."; projection_threads stayed 2 and Developer kept 1 chat; the result came back as a second continuation in the Assistant chat, handoff delivered, parent completed again. RESULT: pass.

## Notes

Not tested live: a real provider, a model or provider switch between the attempts (Harout's case switched Frontend's model: the continuation uses the bot's current model; a provider change cannot keep the session, which is the orchestration layer's existing behaviour), the phone. get_task and list_tasks still show a lead only UNFINISHED team tasks; a bot reopens by the id it got from delegate_task or the earlier result. After it goes live: /version.txt 1.57.2; delegate, let it finish, then steer_task the finished id from a new message and check the continuation lands in the same task chat and the result returns.
