# HANDOFF 1.60.26: a rate limit that has passed stops showing on the bot row

Frontend task 230d7d0f, branch fix/stale-rate-limit, worktree C:/Claude/AI/_wt/hbots-ratelimit, on main ef589a2a33 (= live 1.60.25). Web only, no migration, no contract change.

## Symptom (2 Oct, 19:49)

QA's row read "Rate limited · reset not reported" while its latest chat said "Live QA PASS" 40 minutes earlier. Chat 0b372305 (task 5d0327d5, failed after 4 attempts on a Codex usage limit, 17:21) kept `session.status = error` with `providerRetry {kind: rate_limited}` and no retryAt. That task is terminal, so the chat never gets another turn, and `botSummaries` took any non-archived chat in `providerWaitState === "rate_limited"` as the bot's state.

## Change

- `botSummaries.ts`: new `isRateLimitStale(shell, botShells, endedTaskThreadIds)`. A rate-limited chat only drives the row (`rateLimitedThread`, `rateLimited`, the status text, the pinned tile badge and the avatar's blocked pose all read it) when it is not stale. Stale means the chat's session is in `error` (its turn already failed; a chat still running keeps its limit) and either every task of the chat has ended, or another chat of the same bot on the same provider completed a turn after the limit's `observedAt` (else the session's `updatedAt`). Replies count from archived chats too. Provider match: any of providerInstanceId / providerName / retry.provider shared, or either side naming none.
- `delegationModel.ts`: `threadIdsWithEndedTasks(tasks)`: chats whose tasks are all completed/failed/interrupted/cancelled (an open task, `rate_limited` included, keeps the chat out).
- `ChatsScreen.tsx`: passes that set to `buildBotSummaries` (`endedTaskThreadIds`, optional).
- A stale chat falls through: `isThreadErrored` already returns false for a chat in a provider wait, so the row shows the normal state (Ready, next routine, waiting label), never "Couldn't reply" for the old limit. Other errors keep their existing behaviour.

## Not changed on purpose

- The chat's own header, chat list row ("Rate limited" in BotThreadsScreen) and the conversation state still say what happened in that chat.
- Group rows (`groupStatusLine`) read the server's round status (`waiting_provider`), which the group sweep owns.
- Team screen and task cards do not aggregate a bot's chats into a state (Team uses `isThreadLive` only; task cards show the model label), so there was nothing to apply.

## Tests (apps/web, `vp test run --project unit`)

botSummaries.test.ts: the QA case, a genuine limit (retry time and "reset not reported"), another provider / an older reply does not clear it, ended task, still-running chat keeps its limit, fresh limit beside a stale one, fallbacks. delegationModel.test.ts: `threadIdsWithEndedTasks`.
