# hbots 1.66.93: token usage card redesign A, a per-bot model sheet, and the DeepSeek Harness rc.3 pin

The Team token usage card follows the Designer's Direction A: a hero total, a provider mix bar with a 2x2 legend, and one row per bot. Tapping a bot opens a bottom sheet with every model it used (tokens, cost, share, in/cached/out). Antigravity's Claude and GPT routes are left out of every total, share and cost. The release also carries two earlier dsh commits that were never shipped; one of them moves the DeepSeek Harness runtime to **0.2.1-rc.3**, which DevOps must check on activation (see "Runtime and activation").

## Changes

- **Card A.** Hero token total with the API estimate (`+` when part of it is unpriced), a provider mix bar, a 2x2 legend (share, cost, tokens), then one row per bot with its own mix bar, model count, share and cost. Bots with no use fold into one line (`No use: Planner`); Outside Bots keeps its row. One Today / 7 days / 30 days switch.
- **Per-bot sheet.** Opens from `/bots/team?usage=<botId>`. Header with the bot, three tiles (tokens, API estimate with the not-priced tokens, share and rank), the session count (the data has it: `row.sessions`, so "64 sessions" is shown, not dropped), providers, token mix, and every model with provider, tokens, cost, share bar and in/cached/out. A single-model bot gets a one-line provider and no share bar. States: loading, empty range, unpriced, partial cost, single model. "Open {bot} chat" is a 44px button.
- **Navigation.** The sheet pushes `?usage=` with a history mark. Back, swipe and the x close it and keep you on Team (a deep-linked sheet is closed by a replace, never leaving Team). Open chat goes to the bot chat and Back from there returns to Team without the sheet. The sheet and the card share one range switch.
- **No lag.** No new fetch (the sheet reads the payload the card already has), and `TeamScreen` no longer subscribes to the location, so opening the sheet does not re-render the Team screen.
- **Antigravity Claude/GPT left out.** `botTokenUsage.ts` skips cells whose provider is `antigravity` and whose model is a Claude or GPT route, so provider rows, bot model rows, Outside Bots and the grand total all agree. Gemini and `Antigravity · Unknown model` stay counted. No contract change.
- **Chats usage sheet.** A provider dot before each title (`PersonalUsageStrip`). The limit bars keep their colours.
- **Provider colours** as `--personal-provider-*` tokens (Claude #c98500, OpenCode #d55181, Antigravity #3987e5, Codex #008300, others #8c8c88) in the base and dark blocks.
- **Carried from earlier, unpushed commits** (both on this branch before the work above):
  - `7957366c5d` fix(dsh): count usage from checksummed session frames (P15). The frame walk now includes the 4-byte zstd checksum, so `usage/<session>.jsonl` is written (rc.2 and rc.3 wrote none).
  - `80594c43d2` feat(dsh): pin DeepSeek Harness 0.2.1-rc.3 (P14). Engine constant, runtime package and lockfile, installer default and live-smoke path all say rc.3, with a drift test.
- Commits for the work: `485be47dd7` (server rule; its body says tokens were "counted twice", which overstates it: the rule is what was asked for) and `13f3b33dae` (web card, sheet, dots, version).
- `PERSONAL_TASKS_CONCURRENCY` stays 5. Not added: the optional chat-settings "Token usage" row.

## Validation

- Server `botTokenUsage.test.ts` 26 of 26 (5 new for the Antigravity rule). Web: `tokenUsagePresentation.test.ts` 41 (including a reconciliation fixture: bot mix and models add to the bot total, providers add to the grand total, Outside Bots plus bots add to the total), `TokenUsageSection.test.tsx` 39, `usageSheetRoute.test.tsx` 7, `PersonalUsageStrip.test.tsx` 25. Full-suite counts are in the gate section below.
- Browser run: Playwright on Brave against a throwaway server from staged `13f3b33dae8a`, 390x844 dark, the real `personalBots.tokenUsage` response rewritten with a fixture (seven-model bot with a long Gemini name and an unpriced Antigravity model, a single-model bot, a partial-cost bot, an idle bot, Outside Bots, an empty Today). 32 of 32 checks pass: no horizontal overflow on Team or in the sheet, bot rows 68px and legend cells 44px, close button and Open chat 44px, no model name clipped, opening the sheet made 0 requests, Back closes the sheet and stays on Team, x closes, a deep link opens and closes onto Team, Open chat then Back lands on Team without the sheet, the card follows the sheet's range, `$2.50+` for partial cost, provider dot on the Chats usage sheet, no page errors, no console errors. Results in `C:\Users\Ht\.personal-bots\qa\hbots-16693\VERIFY.json`.
- Not browser-checked: the swipe-down close (it is the shared `Sheet` component's own drag; Back and x are verified). Light theme not checked (dark only was asked).
- Screenshots (390x844 dark) in `C:\Users\Ht\.personal-bots\qa\hbots-16693\`: `01-overview-390-dark.png`, `02-sheet-developer-390-dark.png` (+ `02b`, `02c`, the models and the end of the sheet), `03-sheet-single-model-390-dark.png`, `04-sheet-empty-range-390-dark.png`, `05-empty-range-card-390-dark.png`, `06-card-30days-390-dark.png`, `07-sheet-researcher-partial-390-dark.png`, `08-chats-usage-sheet-dots-390-dark.png`.
- Lint: the new files add `no-arbitrary-values` findings of the same kind the baseline already has (60); lint is not part of the gate and they were left.
- Live 1.66.92 was not touched: `releases\current.txt` unchanged, no deploy or restart ran.

## Runtime and activation

No migration. **Check the dsh runtime install on activation:** the pin moves `scripts/personal/dsh-runtime` to `0.2.1-rc.3` (lockfile regenerated), so the installed dsh runtime must end up at rc.3 (`install-dsh.ps1` default) before the smoke. Roll back to 1.66.92 (binary only) if the smoke fails. DevOps deploys; nothing was activated.
