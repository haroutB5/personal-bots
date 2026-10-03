# hbots 1.60.27: small fixes from the 1.60.26 code read

Branch `fix/small-fixes-16027` (from `personal-bots/main` c06a18f4f5 = live 1.60.26). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5.

## A. The memory block no longer vanishes silently

- `ProviderService.sendTurn`: when `turnContext` (chat handoff + memory block) plus the input would pass `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`, it tries `turnContextFallbacks` in order and sends the first that fits; only when none fits is the context left out. Each degraded case logs one WARN with `threadId`, `inputChars`, `contextChars`, `limit`, `sentChars` (reduced) and a plain-words `dropped` label. Never the memory text.
- `ProviderCommandReactor`: offers two fallbacks: the same block without notes and task summaries (header + preferences, or the one-line reminder), then the memory without the chat handoff. A lookup that fails outside `contextForThread` also logs a WARN with its `errorTag`.
- `PersonalMemoryService.contextForThread` returns `preferencesBlock` (only when it differs from `block`), logs `errorTag` on a retrieval error, and clears the unconfirmed "sent" record at the start of every build, so a failed build can never be confirmed by a later send.
- `ProviderTurnStartResult.turnContextDelivery` ("full" | "reduced" | "none", only when a turn context was given). The reactor calls `confirmPreferencesSent` unless it is "none", so preferences that were dropped are not marked as sent and the full list is due again next turn. The renew-session retry path now returns its own send result, so the confirm reads the result of the send that actually ran.
- Retry and "continue where you left off" turns still go without a block (unchanged).

## B. Interrupted task and routine chats auto-archive

`taskChatAutoArchivePolicy.ts`: `TASK_TERMINAL_STATUSES` now includes `interrupted`, and the SQL lists are built from it (a test pins it to `PERSONAL_TASK_TERMINAL_STATUSES`). All guards stay (live turn, background work, pending request, pinned, user tasks, group members, owner-unarchived). A new turn still unarchives.

## C. Team names match case-insensitively

`mcp/toolkits/bots/handlers.ts`: list_bots, delegate_task (teammates list and cross-team check), `teamOpenTasks` and `reachableTask` use `isBotOnTeam`. `PersonalBotRepository.clearTeamLeadRow` compares `lower(team)` so "one lead per team" also holds across case variants. Memory scopes were already case-insensitive; lead-bot ownership already lowercases.

## D. Wording

- save_memory `kind` description: full preference list at session start and when the set changes, after a compaction or every 12 turns; reminder line in between.
- ProviderCommandReactor comment: 6 notes + 6 task summaries.
- memoryTidy.ts / PersonalMemoryTidyService header: shared and team entries only.
- Tidy `merged` column: kept (contract + web label read it) but now written as 0 with a comment, because merges never apply on their own; a new `mergesProposed` count is in the "personal memory tidy-up finished" log line.
- `MEMORY_AUTO_SAVE_RULE` doc: what the auto-save permission really drops.
- PersonalGroupService comment: 5 task slots, so the worst case is six provider turns.
- ConversationScreen comment: the context badge shows at any size (the conversationModel comment was right).
