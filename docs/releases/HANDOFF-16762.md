# 1.67.62: memory upgrades (temporal grounding, hybrid semantic memory), deferred MCP tools, External MCP servers

Based on 1.67.61 (trunk `903059a0aa`, live release `0f449cf12cf1`). Branch `feat/hbots-memory-upgrades`, built in worktree `_wt/hbots-memory-upgrades`. **Migrations 162, 163, 164** (schema 161 -> 164, all additive `CREATE ... IF NOT EXISTS`), so the release runner takes the pre-migration backup (`--migration-before 161 --migration-after 164`). **Phone release:** the Android app gains the Settings -> External MCP servers screen, so a new arm64 APK is built and `latest.json` moves to 1.67.62. The lockfile changes (ONNX runtime, transformers, sharp), so every scoped check runs whole.

Reviewed by Opusito (`dev-team/qa/hbots-16762/REVIEW.md`, approve after round-1 fixes). Built by Opuser.

## What changed

- **Temporal grounding and replacement history** (`1629333a68`): memory answers carry dates relative to now, superseded entries keep a cycle-safe history chain (`includeHistory`, `supersededAt`/`supersededBy`), query routing for time questions. Migration 162 adds a partial index on `superseded_by`.
- **Deferred MCP tools** (`c4b0fac1d5`): personal bots get `tool_search` + `tool_call` instead of every tool schema up front; same visibility filter and `McpServer.callTool` guards. Kill switch `T3CODE_PERSONAL_MCP_DEFER`.
- **Hybrid semantic memory** (`229fcd51ae`): FTS5 plus local CPU ONNX embeddings (`Xenova/bge-small-en-v1.5`, q8) in a worker thread (`dist/memory-embedding-worker.mjs`), fused with RRF; idle background backfill. Migration 163 adds `personal_memory_embeddings`. Kill switches `T3CODE_PERSONAL_MEMORY_SEMANTIC=off` and `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy`.
- **External MCP server registry** (`54fd6c71d9`, `5aa0bec7fd`): register outside MCP servers, guarded secret-sealed reverse proxy, provider wiring passes only the proxy URL and a session token; Android Settings screen. Migration 164 adds `personal_external_mcp_servers`. Kill switch `T3CODE_PERSONAL_EXTERNAL_MCP`.
- **Licenses** (`a44f9614f7`): third-party license overrides for ONNX Runtime and sharp-libvips.
- **Round-1 review fixes** (`6611f10b13`): the per-turn query embed waits at most 2.5 s, then falls back to FTS5 only without degrading the embedder (M1); a failed embed degrades semantic search for 10 minutes instead of until restart (S1); ONNX intra-op threads capped at 2 (S2).
- **Gate fix** (`759039c557`, round 1 of the release gates): the `ProviderSessionManager.test.ts` mock of `PersonalTurnContext` now implements `externalMcpServersForThread`. `Layer.mock` turned the missing optional method into a throwing stub, so the personal-bot capability test failed in the whole server-tests run. Test-only.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.62`.

## Release notes for the phone

Settings now has External MCP servers, and bots remember better: they find notes by meaning as well as by words, and they know when something was said.

## Verification

- **Review:** Opusito approved after round 1 (`dev-team/qa/hbots-16762/REVIEW.md`). Round-1 fixes in `6611f10b13`: M1 the per-turn query embed is bounded to 2500 ms and falls back to FTS5 only without degrading the embedder (the in-flight embed still finishes and warms the model); S1 a failed embed degrades semantic search for a 10 minute cooldown instead of until restart, one WARN; S2 ONNX intra-op threads capped at 2, inter-op 1. Memory tests at the fix: exit 0 (`dev-team/qa/hbots-16762/memtests.out`).
- **Stage:** round 1 staged `98e4a0ae9d28`; its gates failed one server test (the `ProviderSessionManager.test.ts` mock, fixed test-only in `759039c557`). Re-cut staged release `ff93bbe5f03e` in 21 s (`externals=copied`, `/home/harout/.personal-bots/releases/ff93bbe5f03e`, not activated). Log `dev-team/qa/hbots-16762/stage.log`.
- **Gates:** round 2, every check whole (toolchain changed), `gates-linux.scoped.json` on release `ff93bbe5f03e`: 10/10 PASS in 1133 s wall (server-tests 1042 s on 4 lanes, server-tsc, web-tests, web-tsc, e2e 302 s, personal-client, hbots-mobile, hbots-mobile-kotlin, parity, release-tools 623 s); gate evidence PASS (section below). Log `dev-team/qa/hbots-16762/gates.log`.
- **Hand-run tests no gate covers:** `apps/server/src/ws.test.ts` 33/33 exit 0; `scripts/lib/cli-external-packages.test.ts` 14/14 exit 0, both at `ff93bbe5f03e` (`dev-team/qa/hbots-16762/hand-ws.out`, `hand-cliext.out`).
- **Release APK (arm64):** built inside the gates in 193 s by `build-android.sh`: `hbots-1.67.62-arm64-release.apk`, versionCode 1067062, 50,069,959 bytes, sha256 `383aa07fc23b059a1eba678b78d2fbbadf8ead43eaf1fa931cb28b717d525f45`, signer CN=hbots, O=haroutB5, same certificate as live 1.67.61.
- **Emulator QA (External MCP screen):** x86_64 QA APK of `ff93bbe5f03e` (sha256 `607ae5f09a35049eb55456a32e8acdcf2d95fbd5f85bbdccf7b64413cb128b0f`, shows `v1.67.62`) on AVD `FindX9Pro-QA`, dark mode, against a throwaway server on staged release `ff93bbe5f03e`: **7/7 steps PASS**. Settings row and empty state; one-tap local Executor preset (`http://127.0.0.1:4400/mcp`) with the Bot scope set to Developer; the Bearer token is masked and the window is `FLAG_SECURE` while it is typed (the screenshot comes out black), cleared after save; the saved card shows only `Token saved`; edit of the display name sticks across leaving and reopening the screen, and the edit form never shows the token; the connection test returns a clean `fetch failed` with no token; enable switch off and on; delete with confirmation back to the empty state; back gesture returns to Settings. Throwaway server log 0 ERROR and 0 WARN lines; the token appears nowhere in the server log, logcat or server data dir; logcat 0 FATAL. Emulator, adb server, tunnel and throwaway server stopped, `emulator free` afterwards. Evidence `dev-team/qa/hbots-16762/emulator/VERIFY.md` and `emulator/run-20261127T010054Z/`. The daily-use chat flows were not rerun (R11: no chat, compose or photo code touched); Harout checks the rest on the phone.

## Follow-ups (from review, not blocking 1.67.62)

The features are opt-in and each has a kill switch.

- External MCP proxy (`proxyRoute.ts`, test-connection in `PersonalExternalMcpService.ts`): do not follow redirects (`redirect: "manual"` or `"error"`), add an upstream timeout, cap non-SSE response buffering, and redact upstream responses as the header promises.
- `tool_call` sidesteps provider-side per-tool deny lists keyed on tool name (no regression today: the Claude non-sandbox wildcard pre-approves every tool).
- Semantic top-N is taken across all scopes before the scope filter (a recall loss, not a leak).
- Temporal grounding uses the server time zone, not the user's, and is not behind the legacy retrieval flag.
- The embedding vector cache is unbounded (about 1.7 KB per memory): add a size log or cap.
- `McpToolExposure` loaded-set eviction after 256 sessions.
- External MCP screen: the connection-test error for an unreachable server is the raw `fetch failed`; a plain "Could not reach the server" would read better (seen in emulator QA).

## Migration

162, 163, 164 (161 -> 164), additive only. The runner takes the pre-migration backup.

## Rollback

Binary rollback to 1.67.61 (`0f449cf12cf1`). The new tables and index are additive and ignored by 1.67.61.

## Gate evidence

<!-- gate-evidence:begin sha=ff93bbe5f03e1b460f5155cc90d745e77d475b4c release=ff93bbe5f03e json-sha256=6aa86d4da9f52c1a73ce76cbdddaa79ff34397ff651b75091471b409461ce430 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0
- release-tools: PASS, exit 0
- not run by any gate: apps/server/src/ws.test.ts
- not run by any gate: scripts/lib/cli-external-packages.test.ts

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 1133 s wall, 2505 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 15684 MB, swap growth 73 MB, peak load 18.3
  preflight            guards   start    0 s      9 s   1 job  PASS  |#
  server-tests         whole    start    9 s   1042 s   4 jobs PASS  |#######################################################
  server-tsc           whole    start  386 s     45 s   1 job  PASS  |                    ##
  web-tests            whole    start  688 s    145 s   1 job  PASS  |                                    ########
  web-tsc              whole    start  310 s     25 s   1 job  PASS  |                #
  e2e                  whole    start    9 s    302 s   1 job  PASS  |################
  personal-client      whole    start  335 s     51 s   1 job  PASS  |                  ###
  hbots-mobile         whole    start  833 s    106 s   1 job  PASS  |                                            ######
  hbots-mobile-kotlin  whole    start  543 s    146 s   1 job  PASS  |                             ########
  parity               whole    start  432 s     12 s   1 job  PASS  |                       #
  release-tools        whole    start    0 s    623 s   1 job  PASS  |#################################
  arm64 build (bg)     android  start  940 s    193 s   1 job  PASS  |                                                  ##########
```

<!-- gate-timing:end -->
