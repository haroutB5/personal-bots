# 1.67.65: wire extraMcpServers and deferMcpTools through ACP stdio MCP bridge

Based on 1.67.64 (trunk `1de0e2e841`, live release `f091207b9f82`). Branch `acp-stdio-extra-mcp`, built in worktree `_wt/hbots-acp-stdio-mcp`. **No migration** (schema stays 165), so the release runner skips the backup (`--migration-before 165 --migration-after 165`). Because `packages/provider-acp` is a transitive workspace dependency of `@hbots/mobile`, `gateScope.mjs` classifies this on the full release track and the signed arm64 APK is built in parallel with the gates.

Built by BabyNeon and shipped by Neon with Harout's direct approval.

## What changed

All code changes are in `24818adaab` (with `AcpRegistryAdapterV2.test.ts` updated in `8e1621398a`):

- **ACP stdio MCP fallback (`packages/provider-acp/src/server/adapter.ts`):** `acpMcpContext` now appends every entry from `session.extraMcpServers` as a stdio `acp-mcp-bridge` server in `servers` (with `ELECTRON_RUN_AS_NODE=1`, `T3_ACP_MCP_ENDPOINT`, `T3_ACP_MCP_AUTHORIZATION`) and passes `T3_ACP_MCP_TOOL_EXPOSURE=deferred` to the `t3-code` stdio bridge when `deferMcpTools` is enabled. Antigravity ACP falls back to stdio bridges rather than HTTP MCP, so this exposes Shared External MCP servers (such as `ext-executor`) and deferred `t3-code` tool loading to Antigravity and other stdio-only ACP agents.
- **Stdio MCP bridge header forwarding (`apps/server/src/mcp/AcpMcpStdioBridge.ts`):** adds optional `toolExposure` to `AcpMcpStdioBridgeOptions`, forwards `t3-tool-exposure` (`MCP_TOOL_EXPOSURE_HEADER`) on POST requests when set, and reads trimmed `T3_ACP_MCP_TOOL_EXPOSURE` in `runAcpMcpCliFastPath` for `acp-mcp-bridge`.
- **Tests (`apps/server/src/personal/externalMcp/adapterWiring.test.ts`, `apps/server/src/mcp/AcpMcpStdioBridge.test.ts`, `apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`):** covers stdio `servers` wiring for both `extraMcpServers` and `deferMcpTools`, plus header forwarding and env parsing in `AcpMcpStdioBridge`.
- **Version:** `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json` bumped to `1.67.65`.

## Release notes for the phone

Antigravity bots can now reach shared External MCP servers (such as Executor) and use deferred MCP tool loading through the stdio bridge.

## Verification

- **Unit tests and checks (`24818adaab`, `8e1621398a`):** targeted unit tests (`adapterWiring.test.ts`, `AcpMcpStdioBridge.test.ts`, `AntigravityAdapterV2.test.ts`, `AcpRegistryAdapterV2.test.ts`, `AcpAdapterV2.test.ts`), `@t3tools/provider-acp` tests (8 files, 108/108 PASS), full `@t3tools/provider-acp` and `t3` server typechecks, `vp lint`, `vp fmt --check`, and `knip:check`.
- **Stage:** release `8e1621398ae9` staged in 20 s (`externals=copied`, `/home/harout/.personal-bots/releases/8e1621398ae9`, not activated). Log `dev-team/qa/hbots-16765/stage2.log`.
- **Gates:** full (untiered) `gates-linux.scoped.json` on `8e1621398ae9`: 6 run (server-tests 236 selected files, e2e 12 selected journeys, server-tsc, web-tests, web-tsc, hbots-mobile), 4 scope-skipped (personal-client, hbots-mobile-kotlin, parity, release-tools), all PASS in 879 s wall. Gate evidence PASS (section below). Log `dev-team/qa/hbots-16765/gates2.log`.
- **Release APK (arm64):** built inside the gates in 243 s: `hbots-1.67.65-arm64-release.apk`, versionCode 1067065, 50,067,963 bytes, sha256 `41310b8158e62bab883e647e2c337141b869e72a91ca941293a8078153433d16`.

## Migration

None (165 -> 165). The runner skips the backup.

## Rollback

Binary rollback to 1.67.64 (`f091207b9f82`). No schema change.

## Gate evidence

<!-- gate-evidence:begin sha=8e1621398ae950dfd5ef839ebf929998726a5aad release=8e1621398ae9 json-sha256=21a19e1b766f6db385948bae0ff9c026267747b0403a6bf5563807cb188dc56e result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/mcp/AcpMcpStdioBridge.test.ts, apps/server/src/mcp/AcpMcpStdioBridge.ts, apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts, apps/server/src/personal/externalMcp/adapterWiring.test.ts, ...; selected 236 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/mcp/AcpMcpStdioBridge.test.ts, apps/server/src/mcp/AcpMcpStdioBridge.ts, apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts, apps/server/src/personal/externalMcp/adapterWiring.test.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: SKIPPED, skip: no changed path is an input of parity: apps/web, apps/hbots-mobile, packages/personal-client, scripts/personal/parity (not apps/hbots-mobile/package.json, scripts/personal/parity/parity.json)
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 879 s wall, 1084 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 15090 MB, swap growth 0 MB, peak load 21.3
  preflight            guards   start    0 s      9 s   1 job  PASS  |#
  server-tests         selected start    9 s    533 s  12 jobs PASS  | ####################################
  server-tsc           whole    start    0 s     37 s   1 job  PASS  |###
  web-tests            whole    start  459 s    108 s   1 job  PASS  |                               #######
  web-tsc              whole    start  314 s     23 s   1 job  PASS  |                     ##
  e2e                  selected start    9 s    305 s   1 job  PASS  | #####################
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start  567 s     69 s   1 job  PASS  |                                       #####
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               skip     start    0 s      0 s   0 jobs SKIP  |
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start  636 s    243 s   1 job  PASS  |                                           #################
```

<!-- gate-timing:end -->
