# hbots 1.66.78

Risk tier: low (provider snapshot and usage presentation; no credentials, no installer changes). No migration (the maximum stays 111), so the release runner skips the backup. `PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16677`, on top of live 1.66.77 notes commit `20d63febf4`.

## Changes

- **Antigravity models after a restart.**
  - What happened: on live 1.66.77 the bot form showed no model or effort picker for Antigravity until some bot started a Gemini chat (Harout, 21 Oct, 11:22).
  - Cause: the 1.66.77 health check marks Antigravity ready from the quota read without starting a session. `ProviderRegistry.shouldRetainMissingProviderModels` keeps the old models only for a "warning, unknown auth" snapshot, so the empty model list from the health check replaced the cached one and was written to `caches/antigravity.json`.
  - Fix: the driver seeds the provider with the last cached models at boot, and the health check keeps them. If a signed-in provider still has no models (a first install with no cache), one background model discovery runs (at most once until sign-out), never on a request path.
  - Effect: Gemini 4 Argon and Gemini 3.8 Flash, with Low, Medium and High effort, are there right after boot.
- **Antigravity usage reads the real Gemini figure.** Live on 21 Oct the quota summary said Gemini was untouched (100% left, its reset rolling forward on every read) after hours of bot use, while the per-model list on the daily host said 81% left with a fixed reset. The 5-hour session now comes from the tightest Gemini model in that list (live check through the code path: 20% used, resets 16:27). The summary only adds the weekly window once it shows any use, so a figure that never moves is not shown.
- **Antigravity usage.** Only Gemini windows are shown. The Claude & GPT windows are gone (Harout: "Then dont show claude and gpt from antigravity in usage stats"). A quota notice always marks the Gemini window.
- **Token usage stats include Antigravity** (Harout: "Also add antigravity or any other active provider in the stats here").
  - Source: the runtime's own conversation stores, `userdata/providers/antigravity/<hash>/antigravity-acp/conversations/<sessionId>.db`, opened read-only. Re-read only when the file, or its `-wal`, changes size or time.
  - One record per Gemini call: uncached input, cached input, cache creation, output and reasoning tokens, deduplicated by call id. Records are attributed to bots through the Antigravity resume cursor (`sessionId`), like the other providers.
  - Prices: CTO checked them against https://ai.google.dev/gemini-api/docs/pricing on 21 Oct. Gemini 4 Argon is $2 in, $10 out and $0.10 cached per 1M (introductory, until 30 Nov 2026; then $4, $20 and $0.20). Gemini 3.8 Flash is $0.75 in, $3.75 out and $0.075 cached per 1M (until 31 Dec 2026; then double). Follow-up: update the rates on those dates.
  - Plausibility: on 21 Oct the reader counted about 2.38B tokens, 2.31B of them cached input, because every agent call re-sends the context. That is the same pattern as Claude.
  - Grok sessions are counted too. Registry agents and Cursor are not: registry agents write no transcripts or per-turn counts, and Cursor only offers account-level usage.
- **Catalogue.** Antigravity counts as a subscription ("Your Google AI plan: free with a Google account, Google AI Pro or Ultra raises the limits"), so the Subscription chip in Add provider includes it.
- Other session-learned drivers were checked: Cursor lists its models in the health check and is already retained, OpenCode lists them over its local HTTP API, and the registry driver probes with session/new.

## Builder proof

- AntigravityProvider, ProviderRegistry, antigravityUsageLimits and AntigravityDriver tests: 92 passed, 11 skipped. New: cached models with effort are published after boot without a session; a fresh provider triggers the background probe.
- Web usage presentation tests: 44 passed.
- Server tsc exit 0.

## Risks

- The background discovery starts the Antigravity runtime once when a signed-in provider has no models. It is a heavy launch, so it runs only in that case.

## Gate evidence

<!-- gate-evidence:begin sha=1230b1e87c5025d75feb7bee6f923104595cd467 release=1230b1e87c50 json-sha256=b7d5606bf488ce073d25e3cd7e357b0b55e5457cb4c741d238421731d669708c result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-21T11:40:28Z. Version 1.66.78, release `1230b1e87c50`, commit `1230b1e87c5025d75feb7bee6f923104595cd467` on `feat/hbots-16677`, working tree clean, result **PASS**.

Machine-readable copy: `releases\1230b1e87c50\gate-evidence.json` (sha256 `b7d5606bf488ce073d25e3cd7e357b0b55e5457cb4c741d238421731d669708c`) and the full gate logs in `releases\1230b1e87c50\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2949 tests passed, 0 failed, 4 skipped, in 214 files | 286.5   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 37.6    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3000 tests passed, 0 failed, 0 skipped, in 262 files | 36.5    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 8.1     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 80.5    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\1230b1e87c50" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 273.7   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `1230b1e87c5025d75feb7bee6f923104595cd467`, at end `1230b1e87c5025d75feb7bee6f923104595cd467`; tracked files modified: none. Staged release: version 1.66.78, sha 1230b1e87c50, dirty False, externals copied; `dist/bin.mjs` sha256 `b99d4ec33d249f21610cee8f5ddf94cb2cd432e251a3ef3945d3333b22e1c996`.
<!-- gate-evidence:end -->
