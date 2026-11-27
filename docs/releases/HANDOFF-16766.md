# 1.67.66: provide PersonalExternalMcpService to layerPersonalTurnContext

Based on 1.67.65 (trunk `8ae5798fe8`, live release `8e1621398ae9`). Branch `fix/turn-context-external-mcp`, built in worktree `_wt/hbots-turnctx-ext-mcp`. **No migration** (schema stays 165), so the release runner skips the backup (`--migration-before 165 --migration-after 165`). **Server-only release:** nothing the phone app is built from changed (2 files under `apps/server/src`, plus the version bump of `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json`), so no APK is built, no emulator QA runs, and `latest.json` stays on 1.67.65.

Built and shipped by Neon with Harout's direct approval.

## What changed

- **Server layer wiring (`apps/server/src/server.ts`):** `layerPersonalTurnContext` is provided to `layerOrchestrationV2Runtime` inside `layerOrchestrationApplication`, which sits below `PersonalServerLayerLive`. Without `Layer.provide(PersonalExternalMcpServiceLayer)` directly on `layerPersonalTurnContext`, `Effect.serviceOption(PersonalExternalMcpService)` evaluated to `Option.none()` and `externalMcpServersForThread` returned `[]` for every bot and provider. Providing `PersonalExternalMcpService.layerLive` alongside `PersonalSessionAccessLayer` attaches enabled external MCP servers (such as `ext-executor`) to bot sessions across all providers.
- **Tests (`apps/server/src/personal/turnContext/PersonalTurnContext.test.ts`):** adds coverage for `externalMcpServersForThread` resolving enabled external MCP servers for the thread's bot.
- **Version:** `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json` bumped to `1.67.66`.

## Verification

- **Unit tests and typecheck (`a88237c522`):** `PersonalTurnContext.test.ts` (7/7 PASS) and `pnpm --filter t3 typecheck` (all 5 tsconfigs exit 0), plus `vp fmt`, `vp lint`, and `knip:check`.
- **Stage:** release `a88237c522d2` staged in 20 s (`externals=copied`, `/home/harout/.personal-bots/releases/a88237c522d2`, not activated). Log `dev-team/qa/hbots-16766/stage.log`.
- **Gates:** server-only track (`gates-linux.scoped.json`) on `a88237c522d2`: 4 run (`server-tests` 500 selected files, `e2e` 12 selected journeys, `server-tsc`, `hbots-mobile`), 6 scope-skipped (`web-tests`, `web-tsc`, `personal-client`, `hbots-mobile-kotlin`, `parity`, `release-tools`), all PASS in 700 s wall. Gate evidence PASS (section below). Log `dev-team/qa/hbots-16766/gates.log`.
- **Track:** server-only (no APK built, no emulator QA, `latest.json` stays on 1.67.65).

## Migration

None (165 -> 165). The runner skips the backup.

## Rollback

Binary rollback to 1.67.65 (`8e1621398ae9`). No schema change.

## Gate evidence

<!-- gate-evidence:begin sha=a88237c522d2f6bd8ed765acad09ebafe033e768 release=a88237c522d2 json-sha256=f6b0b991eb46295002f4327b089776fbc7c010e907e8773b649a9122444bf162 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/personal/turnContext/PersonalTurnContext.test.ts, apps/server/src/server.ts; selected 500 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/src/personal/turnContext/PersonalTurnContext.test.ts, apps/server/src/server.ts; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: SKIPPED, skip: no changed path is an input of parity: apps/web, apps/hbots-mobile, packages/personal-client, scripts/personal/parity (not apps/hbots-mobile/package.json, scripts/personal/parity/parity.json)
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 697 s wall, 1156 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 13191 MB, swap growth 114 MB, peak load 13.2
  preflight            guards   start    0 s     21 s   1 job  PASS  |##
  server-tests         selected start   21 s    675 s  12 jobs PASS  |  ##########################################################
  server-tsc           whole    start    0 s     27 s   1 job  PASS  |##
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  selected start   21 s    324 s   1 job  PASS  |  ############################
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start  571 s    109 s   1 job  PASS  |                                                 #########
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               skip     start    0 s      0 s   0 jobs SKIP  |
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
```

<!-- gate-timing:end -->
