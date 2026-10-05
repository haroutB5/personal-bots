# hbots 1.61.1: a rate limit from a provider the bot left no longer pins its row

Branch `fix/stale-limit-provider-switch`, on top of `a6995ca98f` (1.61.0). Web only: no server change, no migration. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Symptom

QA was switched from Codex to Claude Opus 5.5 and the Bots list still said "Rate limited". Its chat 4e0bfa17 had a session in `error` with a Codex limit (retryAt 2026-10-09T21:10:43Z). `isRateLimitStale` only cleared a limit when the chat's task had ended or a later completed turn came from the same provider, so QA's later Claude turns never cleared it.

## Fix

`isRateLimitStale` (`apps/web/src/features/personal/botSummaries.ts`) takes a fourth argument, `botProviderNames`: the bot's current instance id plus that instance's driver (`botProviderNames(bot, providers)`). A limited chat whose session names a provider (instance id, driver or the retry's own) and shares none of those names with the bot's current ones is stale. `buildBotSummaries` passes it for every bot.

Kept as before: only a chat whose session is `error` can be stale (a turn still waiting on the provider's clock keeps its limit), a chat that names no provider says nothing against the limit, a custom instance matches on its driver, and the ended-task and same-provider-reply rules are unchanged. The chat itself (header, chip, chat list row) still says what happened in it; only bot-level status clears.

## Where the bot-level limit shows (all fed by `summary.rateLimitedThread`)

Bots list row (`BotRow`), pinned strip tile and badge (`PinnedStrip`), avatar motion "blocked" (`avatarMotion`), `botStatus`. One fix covers them. Chat-level places (`conversationModel`, `chatChipRows`, `BotThreadsScreen`) are per chat and unchanged on purpose. Group rows use the round's `waiting_provider` status from the server, not a bot-level limit; not changed.

## Tests

`botSummaries.test.ts`, "after the bot switched provider": QA's exact case on Claude with a later Claude turn, the same with no later turn, a bot still on Codex keeps the limit (also with a Claude reply in another chat), a custom instance matches on its driver, an unnamed chat is not stale, and a running turn keeps its limit.
