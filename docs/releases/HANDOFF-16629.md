# HANDOFF 1.66.29

DeepSeek provider fixes from Astra's review, applied server-side only (no migration): effort changes restart the session, every model alias is pinned to Flash, compaction uses DeepSeek's documented window, and spend prices at the current card by record time.

## What changed

- **Effort changes now reach DeepSeek sessions (Backend).** DeepSeek runs on the same Claude runtime as a Claude bot (`DeepSeekAdapter` wraps `ClaudeAdapter`), and that runtime's effort is fixed when the SDK query is created. The reactor's restart-on-model-selection-change only fired for `claudeAgent`, so switching a DeepSeek bot High -> Max mid-session kept the old effort until the session happened to be recreated. `ProviderCommandReactor.ts` now restarts for every provider on the Claude runtime (`runsClaudeRuntime`: `claudeAgent` + `deepseek`) and keeps the resume cursor, so the conversation continues on the new query.
- **Model aliases pinned to Flash (Backend).** `makeDeepSeekEnvironment` set only the endpoint, key and config dir, and let ambient machine values of `ANTHROPIC_DEFAULT_*_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` through. DeepSeek's endpoint maps an unresolved `claude-opus*` id to `deepseek-v4-pro` (billed at the Pro price, about 4.4x Flash), so any runtime-internal alias-named call (subagents, background jobs) could silently upgrade. The session env now pins DeepSeek's documented Claude Code environment (retrieved 2026-10-11): `ANTHROPIC_MODEL=deepseek-flash[1m]`, `ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`, replacing whatever ambient values were present. The legacy `ANTHROPIC_SMALL_FAST_MODEL` and `ANTHROPIC_DEFAULT_MODEL` are dropped (the pinned names carry those roles). The guide's `CLAUDE_CODE_EFFORT_LEVEL=max` is deliberately not set: the app picks effort per session and turn, and an env pin would fight the picker.
- **Auto-compact window 786432 (Backend).** `DeepSeekAdapter` passed `autoCompactWindow: ""`. It now passes DeepSeek's documented 786432 (768k, three quarters of Flash's 1M context) both through the Claude-shaped `autoCompactWindow` setting and the session env (one shared constant). The text-generation jobs keep their empty window: single-turn title calls never compact.
- **Pricing by record time (Backend).** `usagePricing` had the retired flat card ($0.14 in / $0.0028 cache-hit / $0.28 out per 1M). DeepSeek's current card (retrieved 2026-10-11): off-peak $0.15 / $0.003 / $0.60 per 1M, peak exactly double; peak hours are 01:00-04:00 and 06:00-10:00 UTC Monday to Friday, everything else (weekends included) off-peak. Each record now prices at the window its own UTC timestamp falls in; cache writes still bill as cache misses (DeepSeek publishes no separate write rate). Chinese public holidays are off-peak too and are not modelled: those hours price half too high, never too low. Spend is computed at scan time from stored tokens and timestamps, so the Team token usage card, the usage sheet and the DeepSeek balance spend re-price all existing history on their next scan; nothing is stored at capture time.

## Focused tests

- `apps/server/src/provider/Drivers/DeepSeekEnvironment.test.ts` (7, +2): an ambient model environment is fully replaced by the five pins and the window; the legacy names are dropped; the pins apply with an empty base env.
- `apps/server/src/provider/Layers/DeepSeekAdapter.test.ts` (9, +1): a DeepSeek session passes `settings.autoCompactWindow = 786432` into the runtime query options.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` (116, +1): a DeepSeek session restarts with the resume cursor when the effort changes mid-thread. Written before the fix: it timed out on the old code and passes on the new.
- `apps/server/src/usage/usagePricing.test.ts` (12, +1): off-peak split math, peak exactly 2x, and every boundary instant (00:59 / 01:00 / 03:59 / 04:00 / 05:59 / 06:00 / 09:59 / 10:00 UTC) plus both weekend days.
- `apps/server/src/usage/UsageService.test.ts` and `UsageService.sessionUsage.test.ts`: fixtures updated to the new card, including one peak and one off-peak record in the same scan and a peak-only DeepSeek spend read.
- The six touched suites together: 167 tests, 0 failed. The full fork gate and the e2e ran on this commit (Gate evidence below).

## Built-release acceptance (staged f9e468a70d9b)

- `throwaway-server.ps1 -Name 16629 -Release f9e468a70d9b` (fake Claude CLIs, fresh root): `version.txt` reports version=1.66.29, dirty=False, externals=copied; unauthenticated `POST /api/personal/push/sent` = 401; boot log has no error lines. Stopped by its recorded PID, root deleted.
- The staged bundle carries all four fixes: `new Set(["claudeAgent", "deepseek"])` (reactor), all five pin names plus `786432` twice (env and adapter settings), and the new card `inputCostPerToken: .15 / 1e6`, `outputCostPerToken: .6 / 1e6`, `cacheReadCostPerToken: .003 / 1e6` with the peak card `.3 / 1e6` / `1.2 / 1e6` / `.006 / 1e6` and `isDeepSeekPeakTime`; the old `.14` / `.28` / `.0028` DeepSeek rates are gone from `dist/bin.mjs`.

## What QA should look at

- A DeepSeek bot (dark, phone): switch Reasoning High -> Max mid-chat and send another message; the reply runs on the new effort (the session restarts once and resumes the same chat; at most the usual brief reconnect). Switch back to High: same again.
- A DeepSeek bot still answers normally at default effort, and a Files or subagent run still works (Flash only).
- Usage surfaces: the Team token usage card and the DeepSeek provider card show spend from the new card; a record made between 01:00-04:00 or 06:00-10:00 UTC on a weekday counts double. A spot check against the card is enough; no need to force traffic.

## Limitations

- No real DeepSeek key was used anywhere in this task (a rule of the brief): the pins, window and pricing are proven by the unit suites plus static reads of the runtime (`@anthropic-ai/claude-agent-sdk` 0.3.292 and the installed Claude Code 2.1.296 both read the six environment names; the settings schema documents `autoCompactWindow`) and by the staged bundle contents. A real-key run confirming Flash-only, no-Pro billing belongs to live use.
- The auto-compact window reaches the runtime both as an env value and as a settings value; the exact precedence between the two is not exercised without a real session. Both come from one constant, so they cannot disagree.
- Chinese public holidays are not modelled (over-prices at most a few dozen peak hours a year, never under-prices).
- `ANTHROPIC_DEFAULT_FABLE_MODEL` (a Fable alias the CLI knows) is left as DeepSeek's guide leaves it: an internal fable-alias call would miss at DeepSeek's endpoint rather than silently upgrade. CTO can ask for a pin if wanted.
- A mid-session effort change restarts the DeepSeek session; that is deliberate (the runtime cannot change effort in a live query) and matches how Claude bots already behave.

## Gate evidence

<!-- gate-evidence:begin sha=f9e468a70d9b9757c65b478f65062a24834136d5 release=f9e468a70d9b json-sha256=fedce4465681c197f9a836105f6ec3303971c425b0f6d07a2e2adff243f177fd result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T17:13:34Z. Version 1.66.29, release `f9e468a70d9b`, commit `f9e468a70d9b9757c65b478f65062a24834136d5` on `fix/hbots-deepseek-16629`, working tree clean, result **PASS**.

Machine-readable copy: `releases\f9e468a70d9b\gate-evidence.json` (sha256 `fedce4465681c197f9a836105f6ec3303971c425b0f6d07a2e2adff243f177fd`) and the full gate logs in `releases\f9e468a70d9b\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 191.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 17.2    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2437 tests passed, 0 failed, 0 skipped, in 223 files | 26.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 17.2    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 56.2    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16629\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\f9e468a70d9b" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 242.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `f9e468a70d9b9757c65b478f65062a24834136d5`, at end `f9e468a70d9b9757c65b478f65062a24834136d5`; tracked files modified: none. Staged release: version 1.66.29, sha f9e468a70d9b, dirty False, externals copied; `dist/bin.mjs` sha256 `30a8aec060367f9922963aa4415b099ec93a29792380a57800242f0a37af40c5`.
<!-- gate-evidence:end -->
