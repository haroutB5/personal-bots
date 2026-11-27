# 1.67.63: hardening follow-ups for External MCP, tool_call and semantic memory; executor-docker.sh fixes

Based on 1.67.62 (trunk `c8b60507ef`, live release `ff93bbe5f03e`). Branch `fix/hbots-memory-executor-followups`, built in worktree `_wt/hbots-memory-followups`. **No migration** (schema stays 164), so the release runner skips the backup (`--migration-before 164 --migration-after 164`). **Server-only release:** nothing the phone app is built from changed (19 files under `apps/server/src` and `scripts/personal/linux/executor`, plus the version bump of `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json`), so no APK is built, no emulator QA runs, and `latest.json` stays on 1.67.62.

Reviewed by Opusito (`dev-team/qa/hbots-16763/REVIEW.md`, SHIP, no must-fix). Built by Opuser.

## What changed

All in `4ce737a2e1`; these are the non-blocking review follow-ups from 1.67.62 plus executor script fixes.

- **External MCP proxy and connection test** (`proxyRoute.ts`, `PersonalExternalMcpService.ts`): redirects are refused (`redirect: "error"`), a 60 s upstream timeout (headers timeout for SSE), non-SSE response bodies are capped at 4 MiB (HTTP 502 above it), saved secrets and the upstream bearer token are scrubbed from non-SSE and SSE responses, and the connection test shows a scrubbed, actionable error (`HTTP <status>: <snippet>`).
- **`tool_call` and `McpToolExposure`**: `tool_call` enforces the preview/device capability and the read-only/plan mode checks; the loaded-set cap goes from 256 to 1024 sessions and `isListed` refreshes LRU recency.
- **Semantic memory**: the in-memory vector cache is capped at 20,000 entries with one WARN; visible memory ids are pre-filtered with a wider candidate window so other scopes no longer crowd out the semantic top-N.
- **Temporal grounding**: write-time relative-date grounding follows `contextualRetrievalEnabled()` (off with `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy`); the time zone is `T3CODE_PERSONAL_TIMEZONE`, default `Europe/London`, with a local fallback for an invalid zone.
- **Cleanup**: unused `normaliseApps` import removed from `PersonalMemoryTidyService.ts`.
- **Executor script** (`scripts/personal/linux/executor/executor-docker.sh`, README): mounts `/app/data`, adds `--init` and `BETTER_AUTH_URL` (override `EXECUTOR_AUTH_URL`); still loopback only.
- **Version:** `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json` bumped to `1.67.63`.

## Verification

- **Review:** Opusito, SHIP with no must-fix (`dev-team/qa/hbots-16763/REVIEW.md`). The builder ran `vp fmt --check`, `vp lint`, `knip`, `pnpm --filter t3 typecheck` and the scoped `vp test` runs for externalMcp, memory, McpHttpServer and agentContextBudget (387 passed, 2 skipped) at `4ce737a2e1`.
- **Stage:** release `43671862d41e` staged in about 20 s (`externals=copied`, `/home/harout/.personal-bots/releases/43671862d41e`, not activated). Log `dev-team/qa/hbots-16763/stage.log`.
- **Gates:** `gates-linux.scoped.json`, untiered, on release `43671862d41e`: 5 run and 5 skipped by scope, all PASS in 651 s wall (server-tests 228 selected files, server-tsc whole, e2e 12 selected journeys, hbots-mobile whole for the version bump, release-tools 16 selected files); web-tests, web-tsc, personal-client, hbots-mobile-kotlin and parity are skipped, since no input of theirs changed. Gate evidence PASS (section below). Log `dev-team/qa/hbots-16763/gates.log`.
- **Track:** server-only, per the release's `gateScope.mjs`: no APK, no emulator QA, `latest.json` stays on 1.67.62.

## Follow-ups (from review, not blocking 1.67.63)

- `tool_call` read-only/plan check is stricter than the direct path: plan-narrowed OAuth clients (`T3-Mode-Limit .../plan`) are refused any deferred tool without `readOnlyHint`, while the same tool called directly is not. Bots are not OAuth clients, so no bot impact.
- The embedding cache "LRU" is insertion/update order, not read recency, and an evicted vector is not reloaded until restart. The 20k cap is far above today's count.
- If the proxy fiber is interrupted before fetch settles, the 60 s timer still fires (it aborts an already-aborted controller; harmless).
- `visibleMemoryIds` adds one indexed SELECT per semantic retrieval (cheap at current sizes).

## Migration

None (164 -> 164). The runner skips the backup.

## Rollback

Binary rollback to 1.67.62 (`ff93bbe5f03e`). No schema change.

## Gate evidence

<!-- gate-evidence:begin sha=43671862d41ecdec7581ab58089d0ee7b55368a8 release=43671862d41e json-sha256=f5cf21f276aaf774c821acd003319690b52350c6b989cfe6356daa6830aeb9d3 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/mcp/McpHttpServer.test.ts, apps/server/src/mcp/McpHttpServer.ts, apps/server/src/mcp/McpToolExposure.ts, apps/server/src/mcp/toolkits/toolSearch/handlers.ts, ...; selected 228 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/src/mcp/McpHttpServer.test.ts, apps/server/src/mcp/McpHttpServer.ts, apps/server/src/mcp/McpToolExposure.ts, apps/server/src/mcp/toolkits/toolSearch/handlers.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: SKIPPED, skip: no changed path is an input of parity: apps/web, apps/hbots-mobile, packages/personal-client, scripts/personal/parity (not apps/hbots-mobile/package.json, scripts/personal/parity/parity.json)
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/executor/executor-docker.sh; selected 16 test files

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 651 s wall, 1575 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 11965 MB, swap growth 8 MB, peak load 15.3
  preflight            guards   start    0 s     12 s   1 job  PASS  |#
  server-tests         selected start   12 s    582 s  12 jobs PASS  | ######################################################
  server-tsc           whole    start  500 s     50 s   1 job  PASS  |                                              #####
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  selected start   12 s    301 s   1 job  PASS  | ############################
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start  568 s     83 s   1 job  PASS  |                                                    ########
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               skip     start    0 s      0 s   0 jobs SKIP  |
  release-tools        selected start    0 s    548 s   1 job  PASS  |###################################################
```

<!-- gate-timing:end -->
