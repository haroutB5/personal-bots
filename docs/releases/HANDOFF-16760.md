# 1.67.60: bot-creatable webhook/event routines with 0600 local hook env files

Based on 1.67.59 (trunk `a43da7f89b`, live release `7356b96267e4`). Branch `release/hbots-16760`, built in release slot 1. **No migration** (schema stays 161). **Server-only release:** nothing the phone app is built from changed (only `apps/server/`, `scripts/personal/app-version.txt`, and `apps/hbots-mobile/package.json` version sync), so no APK is built, no emulator QA runs, and `latest.json` stays on 1.67.59. Blocking scoped gates (`GATE_TIER=blocking`) run before release, with deferred `server-tests` (11 files) and `e2e` (12 journeys) running in the async tier.

## Why

Harout asked for bots to be able to create webhook/event routines themselves (for example, so local scripts like a 30-minute battery alert can post directly into hbots with zero LLM turns via `delivery: "relay"`), without Harout having to create a webhook routine manually in the app and copy the token.

## What changed

- **Local 0600 hook env files (`apps/server/src/personal/routines/routineHookEnv.ts`, `PersonalRoutineService.ts`):** (`afd0558483`)
  - Added `routineHookEnv.ts` with `ROUTINE_HOOKS_DIR = "routine-hooks"`, `routineHookEnvPath(baseDir, routineId)` (validating safe single-segment basename), `writeRoutineHookEnv(baseDir, port, routineId, hookToken)` (creating dir `0o700`, writing temp file `0o600`, and atomically renaming to `<baseDir>/personal/routine-hooks/<routineId>.env` containing `HBOTS_HOOK_URL=http://127.0.0.1:<port>/api/personal/hooks/<hookToken>\n`), and `removeRoutineHookEnv(baseDir, routineId)` (ignoring `ENOENT`).
  - Wired `PersonalRoutineService` via `Effect.serviceOption(ServerConfig.ServerConfig)` to write/sync the hook env file on event routine `create` (both new and idempotent retry) and `regenerateHook`, and remove it on `remove` (`deleteRoutine`).
- **Bot-creatable webhook/event routines & delivery mode (`apps/server/src/mcp/toolkits/personal/tools.ts`, `handlers.ts`):** (`afd0558483`)
  - Extended `create_routine` input with `frequency: "event"`, optional `eventLabel`, and optional `delivery: "model" | "relay"` (default `"model"`).
  - For `frequency: "event"`, `create_routine` requires `eventLabel`, refuses schedule fields (`time`, `days`, `everyHours`, `date`), omits `threadId` when `delivery === "relay"`, and returns `hookEnvPath` without ever exposing raw `hookToken`.
  - For scheduled routines, `create_routine` refuses `eventLabel` if supplied and passes `delivery` through (omitting `threadId` when `delivery === "relay"`).
  - Tightened routine tool descriptions in `tools.ts` and ratcheted `apps/server/src/personal/agentContextBudget.json` downward (`mcpToolListJsonBytes`: `65887 → 65641`, `-246` bytes).
- **Tests:** (`afd0558483`)
  - Added unit tests in `apps/server/src/personal/routines/PersonalRoutineService.test.ts` (create, `0o700`/`0o600` modes, idempotent retry restoration, `regenerateHook` rotation, `remove` cleanup + ENOENT tolerance, unsafe `routineId` rejection) and `apps/server/src/mcp/toolkits/personal/routineHandlers.test.ts` (event relay/model creation, `hookEnvPath` returned, `hookToken` never leaked, refusals for missing `eventLabel` / schedule fields on event / `eventLabel` on scheduled, scheduled relay delivery).
- **Version:** `scripts/personal/app-version.txt` (`afd0558483`) and `apps/hbots-mobile/package.json` (`b47f682e9f`) bumped to `1.67.60`.

## Verification

- **Targeted unit tests:** `PersonalRoutineService.test.ts` (48/48), `routineHandlers.test.ts` (16/16), `handlers.test.ts` (15/15), `agentContextBudget.test.ts` (1/1, `mcpToolListJsonBytes = 65641`), `AgentContextBudget.test.ts` (2/2) — 82/82 PASS.
- **Server typecheck:** `apps/server` `pnpm run typecheck` (`typecheck-lean.mjs`) — 5/5 tsconfig targets exit 0.
- **Stage:** staged release `b47f682e9f03` (`/home/harout/.personal-bots/releases/b47f682e9f03`, `externals=copied`, `rc=0`).
- **Gates:** `GATE_TIER=blocking` scoped gates PASS in 123 s wall on release `b47f682e9f03` (`preflight` 7 s, `server-tsc` 27 s, `hbots-mobile` 93 s, `server-tests` 44 selected files 115 s; `e2e` and 11 remaining server test files deferred to async tier; server-only track).

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.59 (`7356b96267e4`). No schema change, so the rollback is clean.

## Gate evidence

<!-- gate-evidence:begin sha=b47f682e9f037034fc52bc25815d5f1175e9b747 release=b47f682e9f03 json-sha256=864e4437de3d65d1333a6304daf891615e323ea31719162349bd32b4df982a42 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/mcp/toolkits/personal/handlers.ts, apps/server/src/mcp/toolkits/personal/routineHandlers.test.ts, apps/server/src/mcp/toolkits/personal/tools.ts, apps/server/src/personal/agentContextBudget.json, ...; selected 55 test files; 44 within 1 import hop of the change block, 11 run after the release
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: DEFERRED, runs after the release (async tier): e2e inputs changed: apps/server/src/mcp/toolkits/personal/handlers.ts, apps/server/src/mcp/toolkits/personal/routineHandlers.test.ts, apps/server/src/mcp/toolkits/personal/tools.ts, apps/server/src/personal/agentContextBudget.json, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: SKIPPED, skip: no changed path is an input of parity: apps/web, apps/hbots-mobile, packages/personal-client, scripts/personal/parity (not apps/hbots-mobile/package.json, scripts/personal/parity/parity.json)
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 123 s wall, 242 s if serial; budget 7 of 12 cores, server lanes 4; min MemAvailable 17661 MB, swap growth 0 MB, peak load 13.9
  preflight            guards   start    0 s      7 s   1 job  PASS  |####
  server-tests         selected start    7 s    115 s   5 jobs PASS  |    ########################################################
  server-tsc           whole    start    0 s     27 s   1 job  PASS  |#############
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  deferred start    0 s      0 s   0 jobs DEFR  |
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start    7 s     93 s   1 job  PASS  |    #############################################
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               skip     start    0 s      0 s   0 jobs SKIP  |
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
```

<!-- gate-timing:end -->
