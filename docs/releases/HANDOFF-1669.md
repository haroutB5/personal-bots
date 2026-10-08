# HANDOFF 1.66.9

## What changed

The Team screen's Token usage card now shows tokens and an API price estimate (USD) per provider and per bot. No migration, no new setting, no new dependency. `PERSONAL_TASKS_CONCURRENCY` is still 5.

**Server**

- `usage/botUsage.ts`: `UsageBotAggregator` prices every record as it folds it in (`priceUsage`, the usage page's own pricing: LiteLLM rates with cached input at the cached rate, custom prices from settings, a provider's own reported cost). Each cell gets `costUsd` (priced records) and `unpricedTokens` (all four buckets of records with no rate). Priced per record, so a fast-speed record inside one cell is priced at its own rate.
- `usage/UsageService.ts`: `readSessionUsage` loads the rate table (cached `usage-model-rates.json`, one LiteLLM fetch when stale) and passes rates and price overrides to the aggregator. A failed fetch with no cache leaves every model "not priced", never $0.
- `personal/botTokenUsage.ts`: each window gets `providers` (one row per provider, most tokens first, tokens add up to `total`, Outside Bots included), and every bot row, `other` and `total` carry `costUsd` and `unpricedTokens`.
- `packages/contracts/src/personalBots.ts`: `PersonalBotTokenUsageCost`, `PersonalBotTokenUsageProviderRow`, `providers` on the window. Numbers only, still no session ids.

**Web**

- `TokenUsageSection.tsx`, `tokenUsagePresentation.ts`: a "By provider" block right under the range switch (Claude, GPT / Codex, OpenCode: name, tokens, bar, estimate, share; an "All providers" total) with the one-line note "API price estimate: what these tokens would cost at list API prices, not money charged (subscriptions are flat). + means some tokens have no price." Then "By bot" and the existing rows, each with its estimate under the share (right column still 64 px). Outside Bots and Total show an estimate under their tokens.
- Wording: priced `$12.40`; part priced `$12.40 + unpriced` (provider rows and the provider total) or `$12.40+` (bot rows, 64 px column); no rate at all `not priced`; no tokens, no estimate shown. Dollars: `<$0.01`, `$12.40`, `$1,235` from 1000, `$12.3k` from 10000.
- A server that sends no `providers` or no cost (an older one) shows no provider block and no estimate, never zero.

**Tests added** (all in the gate)

- `usage/botUsage.test.ts` "UsageBotAggregator cost": LiteLLM rates on all four buckets (0.0013875 USD for the fixture), cached input at the cached rate and as plain input when LiteLLM has none, unpriced model (GPT-6-Astra style, free Muse Spark) = no cost and its tokens in `unpricedTokens`, priced and unpriced side by side, no rate table = nothing priced, provider-reported cost, custom price, fast speed inside one cell, dropped duplicate not counted twice.
- `usage/UsageService.sessionUsage.test.ts`: priced Claude cell and unpriced Codex cell through the real service and a fake LiteLLM response; the old "no HTTP at all" check is now "only the LiteLLM URL, at most once, no Cursor request".
- `personal/botTokenUsage.test.ts` "provider and cost totals": provider rows sorted, provider tokens add up to the window total and to rows + Outside Bots, cost and unpriced tokens carried to providers, bots, other and total, per-window days, empty window.
- `personal/PersonalBotTokenUsageService.test.ts`: the served payload carries providers and costs and still encodes against the contract.
- `web tokenUsagePresentation.test.ts` ("the API price estimate", "providers in the table") and `TokenUsageSection.test.tsx` ("by provider and the API price estimate"): formatting, priced / part priced / not priced / none, provider order and sums, removed bot folded into Outside Bots, old server payload, placement above the bot rows, note text, 64 px column kept.

**Proof from real data** (read-only, 8 Oct 14:33 BST, Europe/London; script not committed). The live transcripts and the live database were read, nothing was written. Month = 9 Sep to 8 Oct:

| Provider    | Tokens         | API price estimate                                       |
| ----------- | -------------- | -------------------------------------------------------- |
| Claude      | 14,005,875,547 | $5,625.61                                                |
| GPT / Codex | 992,370,447    | $424.87 + 979,379 tokens unpriced (`codex-auto-review`)  |
| OpenCode    | 221,794,348    | not priced (Muse Spark free, union-alpha, nemotron free) |
| All         | 15,220,040,342 | $6,050.48 + 222,773,727 unpriced tokens                  |

Provider tokens sum to exactly the window total. Per bot, month: Frontend $733.60, Backend $654.35, CTO $798.69, QA $291.67, Astra $81.13 (GPT-6-Astra is in LiteLLM now, so it is priced); Musey and Watcher are not priced; Outside Bots 6.71B tokens, $3,253.90 + unpriced. The same numbers came out of the real app: a throwaway server built from release `3d298f7e6206` with the real transcripts and live sessions mapped onto its seeded bots showed Claude 14.0B $5,626, GPT / Codex 992.4M $424.87 + unpriced, OpenCode 221.8M not priced, All 15.2B $6,051 + unpriced.

**Screenshots** (390x844, dark, real Chrome, 0 page errors, no horizontal overflow): `C:\Users\Ht\.personal-bots\qa\hbots-1669\` (`card-default.png` 7 days, `card-30days.png`, `card-Today.png`, `bottom-30days.png`, `live-readonly-report.json`).

**What QA should check** (new parts only plus a quick regression)

- Team screen at 390 px, dark: By provider block under the switch and above By bot; switching Today / 7 days / 30 days changes both blocks; provider tokens add up to the Total at the bottom.
- Estimates: Claude and Codex priced, OpenCode `not priced`, `+` on a bot with some unpriced tokens, the note under the provider block, nothing overflowing or truncating the cost, the right column width unchanged, row tap still opens the bot.
- Per-provider cost against the usage page (Settings, Usage) for the same days: same rates and same pricing code, so Claude and Codex should be close for the same days (not checked against the page by the builder; the page also folds in other providers and cuts days in the zone it is given).
- Regression: first read after a restart still says "Counting tokens", then fills in; a restart is not needed for any of this (no migration).

**Left out, on purpose**: the usage page already has cost and a provider chart, so it was not touched. Per-chat and sub-agent token counts (messages timeline, agents panel) have no per-chat pricing, so no estimate was added there. Models with no LiteLLM rate stay unpriced; nothing is guessed.

**Housekeeping**: an earlier staged release `5f825b38c1a1` (version commit, before the last UI tweak) is still in `releases\`; do not ship it, ship `3d298f7e6206`. A temporary live read-only script was committed by mistake in `cfc809d8af` and removed in `3d298f7e62` (it holds no secrets: it reads the live settings file only to find transcript homes). Not an amend, history is untouched.

## Gate evidence

<!-- gate-evidence:begin sha=3d298f7e62063fcf0ea875ba04ba3ad15c30c14d release=3d298f7e6206 json-sha256=9218e6b0638985e8f4e5ec9b9a33332a1bbaf3be570e04f0930551aa72b2722d result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-08T13:47:42Z. Version 1.66.9, release `3d298f7e6206`, commit `3d298f7e62063fcf0ea875ba04ba3ad15c30c14d` on `feat/hbots-1669`, working tree clean, result **PASS**.

Machine-readable copy: `releases\3d298f7e6206\gate-evidence.json` (sha256 `9218e6b0638985e8f4e5ec9b9a33332a1bbaf3be570e04f0930551aa72b2722d`) and the full gate logs in `releases\3d298f7e6206\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2454 tests passed, 0 failed, 3 skipped, in 177 files | 243     |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 40.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2268 tests passed, 0 failed, 0 skipped, in 210 files | 31.7    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 55.2    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 62.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-1669\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\3d298f7e6206" -Json` (in `.`)                                                                                                                      | 0    | pass: 5/5 journeys passed                                  | 36.5    |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok.

Tree: HEAD at start `3d298f7e62063fcf0ea875ba04ba3ad15c30c14d`, at end `3d298f7e62063fcf0ea875ba04ba3ad15c30c14d`; tracked files modified: none. Staged release: version 1.66.9, sha 3d298f7e6206, dirty False, externals copied; `dist/bin.mjs` sha256 `9d94a43226cd513b0fa6c2483c4b8bd64cc4ded73f2e9e7b58f0c5f4ee7f0fa5`.
<!-- gate-evidence:end -->
