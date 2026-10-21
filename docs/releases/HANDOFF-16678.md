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
- **Antigravity effort works.**
  - What happened: on 21 Oct DevOps (Gemini 3.8 Flash, High) failed to start with `Invalid value "gemini-3.8-flash-high" for session config option "model"`. Every Antigravity bot with an effort level set failed the same way since 1.66.76; Default effort worked.
  - Cause: hbots sends the effort as a suffixed model ID, which runtime 1.4 accepts (it sets `model` and `thinking_level` from it), but `AcpSessionRuntime` rejected the value client-side because only the plain family IDs are in the `model` select.
  - Fix: Antigravity passes its own config-option checks into `AcpSessionRuntime` (other providers keep the strict check). After setting the model, hbots confirms the runtime's `model` and `thinking_level` match the request. Stale suffixed saved models and the manifest default map to the family plus effort; the manifest lists family slugs.
  - Proof: Backend set `gemini-3.8-flash-high` and `gemini-4-argon-medium` on the signed-in runtime and read back the matching `model` and `thinking_level`. AntigravityAcpSupport 44, ModelManifest 16 and AntigravityProvider 26 tests pass.
- **PC at a glance on the Bots page** (Harout, 21 Oct: "add the ram perc usage, cpu and storage info under the Bots logo in main screen. Keep it small but visible").
  - A small line under the Bots header: "CPU 12% · RAM 63% · C: 120 GB free". A figure turns amber at 90% (CPU, RAM) or under 10% free disk. A tap opens Computer > Performance.
  - Source: new signed-in route `GET /api/personal/performance/summary`. CPU and RAM come from the existing HostResources reading (cached 5 s for every caller), the disk from one `statfs` of the data drive (cached a minute). It never starts the Performance sampler.
  - The page asks every 10 s only while visible (30 s after a failed request), and keeps the row's height from the first paint so the list doesn't jump.
  - Tests: route (answer, 401 without a session and no reading), summary rounding and the line's words, amber, missing figures and fetch.
- Other session-learned drivers were checked: Cursor lists its models in the health check and is already retained, OpenCode lists them over its local HTTP API, and the registry driver probes with session/new.

## Builder proof

- AntigravityProvider, ProviderRegistry, antigravityUsageLimits and AntigravityDriver tests: 92 passed, 11 skipped. New: cached models with effort are published after boot without a session; a fresh provider triggers the background probe.
- Web usage presentation tests: 44 passed.
- Server tsc exit 0.

## Risks

- The background discovery starts the Antigravity runtime once when a signed-in provider has no models. It is a heavy launch, so it runs only in that case.

## Gate evidence

<!-- gate-evidence:begin sha=29663e513202227e01d5ec4cbdb6a3f96e49e9ff release=29663e513202 json-sha256=901090031cccd91bc062ea716c0b4b5d629ed4717184eebda31190d0b9e7badb result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-21T18:31:58Z. Version 1.66.78, release `29663e513202`, commit `29663e513202227e01d5ec4cbdb6a3f96e49e9ff` on `feat/hbots-16677`, working tree clean, result **PASS**.

Machine-readable copy: `releases\29663e513202\gate-evidence.json` (sha256 `901090031cccd91bc062ea716c0b4b5d629ed4717184eebda31190d0b9e7badb`) and the full gate logs in `releases\29663e513202\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2957 tests passed, 0 failed, 4 skipped, in 215 files | 286.5   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 25.8    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3007 tests passed, 0 failed, 0 skipped, in 263 files | 33.9    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 1.6     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 85.3    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\29663e513202" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 304.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `29663e513202227e01d5ec4cbdb6a3f96e49e9ff`, at end `29663e513202227e01d5ec4cbdb6a3f96e49e9ff`; tracked files modified: none. Staged release: version 1.66.78, sha 29663e513202, dirty False, externals copied; `dist/bin.mjs` sha256 `223860255f85b0aa3b8aa9e63e1574290dcb9040e1d9010b394fa4c446a4e43e`.
<!-- gate-evidence:end -->
