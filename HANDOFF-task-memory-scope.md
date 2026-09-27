# Task turns no longer carry task summaries in "Known facts" (1.48.4)

2026-09-27, Backend (CTO task 2118745e).

**Symptom.** A delegated task's prompt started with "Known facts (from memory)..." listing the bot's summaries of earlier, unrelated tasks (model bench r4: each Bench bot's batch-2 task carried its batch-1 summary). The same block reaches every CTO turn.

**Cause.** `ProviderCommandReactor.personalMemoryForTurn` (apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) asks `PersonalMemoryService.contextForThread` for the top 8 FTS matches in the bot's scope on every turn, with no filter on kind, and `formatMemoryBlock` prefixes them to the user message.

**Fix.** A turn whose message id is a task message (`isPersonalTaskMessageId`, prefix `personal-task-`, set by `PersonalTaskService.startTurn` for delegate_task tasks, routine runs, retries and steers into a task) passes `excludeTaskSummaries`; `PersonalMemoryService.search` then adds `m.kind <> 'task_summary'` BEFORE ranking and the limit, so the 8 slots fill with preferences, notes and other kinds. Nothing left means no block. Chat turns are unchanged. Relay routines start no turn and are unaffected.

**Scope note.** The check covers every task-service turn, so user-created board tasks and steers into a task also leave out task summaries. Narrowing to delegate_task/routine only would need the task source threaded through to the reactor.

**Tests (failed first, 4 of 6):** PersonalMemoryService.test.ts "a task turn gets no task summaries; a chat turn still does", "a task turn with only task summaries to match gets no memory block"; ProviderCommandReactor.test.ts "personal memory for a turn" (delegated task, routine run, chat turn).
