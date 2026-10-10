# HANDOFF 1.66.22

## What changed

1.66.22 puts DeepSeek's prepaid balance on the app's usage surfaces, so the money half of the DeepSeek provider is visible where the Claude and Codex windows already are. DeepSeek publishes exactly one money endpoint (`GET https://api.deepseek.com/user/balance`) and no spend or billing history, so the card shows what is left — total, plus the granted/topped-up split — with its own last-refreshed time, and says plainly that no spend figure is tracked yet. No migrations are included and task concurrency remains 5 (`PersonalTaskService.ts`).

- `apps/server/src/provider/Drivers/DeepSeekBalance.ts` (new): reads DeepSeek's balance server-side with the instance's own key (Bearer header only). A reading is cached for 10 minutes, a failed read backs off for a minute, and a failure keeps the last good numbers. The key is never logged, returned or put in a message; failures come back as reason slugs (`http_error`, `network_error`, `timeout`, `invalid_response`) which the provider turns into its own wording. `T3CODE_PROVIDER_DEEPSEEK_BALANCE_URL` overrides the endpoint (tests only).
- `apps/server/src/provider/Layers/DeepSeekProvider.ts`: the probe reads the balance before the binary check and carries it on every outcome, so a CLI hiccup never blanks the figure. A failed read keeps `status: "failed"` with the last good numbers; a balance read that throws can never take the probe down.
- `apps/server/src/provider/providerSnapshot.ts`: `usageBalance` rides the snapshot beside `usageLimits`.
- `packages/contracts/src/providerUsageLimits.ts`, `packages/contracts/src/server.ts`: `ServerProviderBalance` and `ServerProviderUsageBalance`, and an optional `usageBalance` on `ServerProvider`. Additive: an older snapshot without the field still decodes.
- `apps/web/src/features/personal/usagePresentation.ts`: a `deepseek` usage card (balance view, no session/weekly rows), the same keep-the-last-good behaviour as the window cards, and `selectDeepSeekBalanceLine` for the Team screen.
- `apps/web/src/features/personal/PersonalUsageStrip.tsx`: the usage sheet renders the DeepSeek card — "Balance left $12.34", "Granted $2.00 · Topped up $10.34", "Spend is not tracked for DeepSeek yet.", aged from the provider's own fetch time. The sheet's description names DeepSeek only while its card is there.
- `apps/web/src/features/personal/TokenUsageSection.tsx`: a quiet DeepSeek balance row under the Team token usage totals, the same figure from the same selector, so the two surfaces cannot disagree.
- `apps/web/src/features/personal/usageStrip.ts`: the two-up strip deliberately gets no DeepSeek cell (see below).

## What was left out, and why

- **The "spent" figure.** DeepSeek has no spend endpoint, so spend can only be derived from our own token records — and DeepSeek turns are in none of them: the usage scan reads the transcript homes of `claudeAgent`, `codex` and `grok` instances only (`UsageService.resolveTranscriptDirs`), and `UsageProviderKind` has no `deepseek`. The raw Claude-format transcripts do exist in the instance's config home (`~/.claude-t3-deepseek/projects/*.jsonl`, model `deepseek-flash`, no cost field). Smallest honest way to track spend going forward: add the DeepSeek instance home to that scan with a `deepseek` provider kind, priced at the published Flash rates (input cache-hit $0.0028/M, cache-miss $0.14/M, output $0.28/M; our picker only offers Flash). Then the existing API-price machinery prices it and this card can show spent = our tokens × those rates, with the balance API as the independent check.
- **The two-up strip cell.** The strip is two percent windows with one shared "Session/Weekly percent used" shape, already tuned to fit a 280 px desktop column and 390 px phone; a third cell squeezes the existing two and reads as a window that never fills. The balance lives one tap away in the sheet, and the Team card shows it too.
- **Upstream's /usage-limits panel and the composer chip.** Both render subscription windows; a prepaid balance has no window to draw.

## Verification

Builder proof, dark, 390×844, throwaway root on the staged release (fake key, a local stub endpoint on `T3CODE_PROVIDER_DEEPSEEK_BALANCE_URL`; the real endpoint never appears in the test):

- the usage sheet renders the DeepSeek card with "Balance left", the granted/topped-up split, the spend note and "Updated …" from the provider's fetch time, beside the untouched Claude/Codex cards;
- the strip stays two-up (no DeepSeek cell), and the Team token usage card shows the balance row under its totals;
- a failed stub read leaves the last good numbers in place and adds "Couldn't refresh · DeepSeek could not be reached for the balance."; a missing key shows "No DeepSeek API key. Add one on the DeepSeek instance in Settings." and stops the strip's own probing for it;
- the real endpoint was read once with the instance's stored key (through the app's own settings and secret store, in a temporary data-root copy; nothing printed): the read parsed as a USD reading with finite amounts. No key, no raw balance and no provider error body was printed, logged or committed.

Unit tests added: `apps/server/src/provider/Drivers/DeepSeekBalance.test.ts` (12: USD parse, CNY-only, missing key, HTTP error, timeout/network/invalid body, ten-minute cache, failure window, last-good per key, endpoint override), four new cases in `apps/server/src/provider/Layers/DeepSeekProvider.test.ts`, twelve in `apps/web/src/features/personal/usagePresentation.test.ts`, one in `usageStrip.test.ts`, two in `PersonalUsageStrip.test.tsx`, three in `TokenUsageSection.test.tsx`, one in `packages/contracts/src/server.test.ts`.

Not verified: the physical iPhone (desktop browser proof only), and QA's own pass — this is a builder-tier change per the CTO's brief.
