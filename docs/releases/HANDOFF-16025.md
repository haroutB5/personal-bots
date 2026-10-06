# HANDOFF 1.60.25: a background follow-up never replaces a task's real report

Backend task 3dc215d0, branch fix/task-background-followup, worktree C:/Claude/AI/_wt/hbots-bgfollow.

## Incident

2 Oct, task 84a37cf7 (rainhb 0.13.1): the bot ended a turn with its full report and questions while a Monitor was
live. The task stayed `running` (PERSONAL_TASK_BACKGROUND_WAIT_MS). When the Monitor expired, Claude Code ran a
follow-up turn ("nothing pending") and `finishAttempt` took that reply as the whole result. get_task showed
`running` with no result for 16 minutes.

## Change (apps/server/src/personal/tasks/PersonalTaskService.ts)

- `BackgroundWait.replies`: the reply of every turn that ended with background work left is held at that moment.
- Result = `composeTaskReplies(held replies + the final reply if new)`: first reply whole, each later reply after
  "(Follow-up after background work finished:)". Cap, session-ended and no-follow-up closes use the same composition
  plus their note. Over `PERSONAL_TASK_RESULT_MAX_CHARS` (100k) the oldest follow-ups go first; the first reply is never cut.
- While waiting, the task row (still `running`) gets `result = { summary: replies so far, waitingOnBackgroundSince }`
  (no migration: `result_json` is JSON, the field is optional). Cleared on claim, interrupt, failure, rate limit, completion.
- get_task / list_tasks: `resultSummary` is prefixed "[Still running, not final: ... since <iso>. Its reply so far:]" and the
  new optional `waitingOnBackgroundSince` is set, only while the task is `running`.
- Task screen: the Result card reads "Reply so far (still finishing background work)" while waiting.
- Not done: pinging the parent chat. The only path into a parent is the handoff (`returned` queues a "tasks have
  finished" continuation and `delivered` blocks the real return), so an early ping would need a new handoff state.

## Left alone (checked)

Group rounds (`PersonalGroupService.finalReplyText`) end the member's turn at the first reply and never wait on
background work, so a later follow-up cannot replace it. Routine runs and handoffs read `task.result` and inherit the fix.
Release notices post a turn into a chat; they read no reply.

Version 1.60.25 (main already carried 1.60.24, the 48-hour auto-archive).
