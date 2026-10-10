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

## Gate evidence

<!-- gate-evidence:begin sha=84c4498e92802c8839ddc9dbba97520700a16604 release=84c4498e9280 json-sha256=069f8e681a7291c3f7d278ca7bb662e9e255c16c3385c817a11fda2c7b7cb73b result=FAIL -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-10T20:11:02Z. Version 1.66.22, release `84c4498e9280`, commit `84c4498e92802c8839ddc9dbba97520700a16604` on `feat/hbots-deepseek-usage`, working tree NOT clean, result **FAIL**.

Machine-readable copy: `releases\84c4498e9280\gate-evidence.json` (sha256 `069f8e681a7291c3f7d278ca7bb662e9e255c16c3385c817a11fda2c7b7cb73b`) and the full gate logs in `releases\84c4498e9280\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 247.5   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 48.4    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2417 tests passed, 0 failed, 0 skipped, in 222 files | 39      |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 1    | FAIL: exit code only                                       | 11.4    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 59.1    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-deepseek-flash\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\84c4498e9280" -Json` (in `.`)                                                                                                            | 0    | pass: 12/12 journeys passed                                | 286.7   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `84c4498e92802c8839ddc9dbba97520700a16604`, at end `84c4498e92802c8839ddc9dbba97520700a16604`; tracked files modified: M apps/web/src/features/personal/TokenUsageSection.test.tsx. Staged release: version 1.66.22, sha 84c4498e9280, dirty False, externals copied; `dist/bin.mjs` sha256 `55a822e5c1722ed9b2f9bfb386c6e46e2cd28f0fa67194b13cfe836bfdaf3758`.
<!-- gate-evidence:end -->
