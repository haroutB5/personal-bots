# hbots 1.66.90: token usage names every provider and model per bot

The Team screen's "By bot" table showed one model beside each bot: the model the bot runs on now. A bot's tokens are not all from that model, though. Frontend's 7-day total of 2.8B was drawn as **DeepSeek V4.1 Flash · Max** even though that week it ran on DeepSeek (1.0B), Claude Sonnet 5.5 (1.0B), OpenCode DeepSeek (0.4B) and two Codex models (0.3B). This release lists every provider and model a bot used, each with its own tokens and its own API price estimate.

## Changes

- **Each bot row lists its provider and model lines.** Under the bot's name, one compact line per route the bot's chats actually ran on, heaviest first: `DeepSeek · V4.1 Flash 1.0B · $12.02`, `Claude · Sonnet 5.5 1.0B · $210.50`, `OpenCode · DeepSeek V4.1 Flash 436.7M · $2.94`, and so on. The bot's total, share, bar and overall estimate stay as they were; the lines add up to them. Tapping the row still opens the bot.
- **The old single model label is gone.** It came from the bot's _current_ model selection (`botActiveModelShortLabel`), which was never a history of what used it. Removing it is what stops a mixed total from reading as one model.
- **Provider is part of the model's identity.** The same model id run through Claude and through OpenCode is two lines with their own prices, because the route and the rate differ.
- **No five-model cap.** The server used to keep at most five model names per bot and had no provider or price on them (`MAX_MODELS_PER_ROW`). It now keeps every `(provider, model)` cell a bot used in the window, with its own four token buckets, `costUsd` and `unpricedTokens`; the previous five-model limit hid routes on a busy week.
- **Model names resolve through the provider pickers.** A raw id such as `deepseek-flash`, `gpt-6.1-sol` or OpenCode's `opencode/deepseek-v4.1-flash` is drawn as the name the picker shows it by ("DeepSeek V4.1 Flash", "GPT-6.1-Sol", "DeepSeek V4.1 Flash"), and the redundant provider word is folded into the line label (`DeepSeek · V4.1 Flash`, not `DeepSeek · DeepSeek V4.1 Flash`). A model no provider lists keeps a readable form of its id, so a retired model never disappears.
- **Accessibility.** The row's accessible name now reads each model line, its tokens and its estimate, before the rank and split.
- Contract: `PersonalBotTokenUsageModel` gains `provider`, `totals`, `costUsd` and `unpricedTokens`; `PersonalBotTokenUsageRow.models` keeps every route. Server and web ship together, so there is no compatibility window. No migration, no settings change, task concurrency stays 5.

## Validation

- Server: `apps/server/src/personal/botTokenUsage.test.ts` and `PersonalBotTokenUsageService.test.ts` pass, 33 of 33 tests. New cases pin that every model is listed (not five), that the same model id under two providers stays two entries with its own estimate, and that the contract payload still encodes.
- Web: `tokenUsagePresentation.test.ts`, `TokenUsageSection.test.tsx` and `TokenUsageSection.refresh.test.tsx` pass, 64 of 64 tests. New cases cover the per-model lines and their tokens/prices, the same model id on two providers, the accessible model sentence, and that the removed current-model label no longer appears.
- Typecheck: server `tsc --noEmit` exit 0; web `tsc --noEmit` exit 0 (server prints pre-existing Effect suggestions only).
- Lint of the ten changed files: no errors; only pre-existing warnings in `TeamScreen.tsx` and `personalBots.ts`.
- Real-data cross-check (read-only, live dev root, 18-24 Oct): Frontend splits 1.01B DeepSeek, 0.99B Claude Sonnet 5.5, 0.36B OpenCode DeepSeek, 0.21B Codex GPT-6 Luna and 0.08B Codex GPT-6.1 Sol; Backend splits DeepSeek, Claude, OpenCode and Codex too. The rows now show those routes instead of one current model.

## Runtime and activation

No migration (112 to 112), so no production backup per Harout's 20 Oct and 23 Oct rules. Roll back to 1.66.89 `98a4951f0e73` (binary only) if the smoke fails. Node stays at 24.22.1 (unchanged). The change is the contracts usage schema, the per-bot aggregation and the Team screen card.
