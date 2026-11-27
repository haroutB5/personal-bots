# 1.67.67: Gemini/Antigravity Eco mode, stdio MCP t3-eco bridge, and mobile bot form Eco support

Based on 1.67.66 (trunk `369d1a8991`, live release `a88237c522d2`). Branch `feat/hbots-eco-gemini`, built in worktree `_wt/hbots-eco-gemini`. **No migration** (schema stays 165), so the release runner skips the backup (`--migration-before 165 --migration-after 165`). Because `packages/contracts`, `packages/personal-client`, and `packages/provider-acp` changed, `gateScope.mjs` classifies this on the full release track and the signed arm64 APK is built in parallel with the gates.

Built by BabyNeon and prepared for Neon to ship with Harout's approval.

## What changed

Code changes span `87912b456d`, `e60b0d180e`, `dd1ffe9620`, `f950561d3d`, `8c6e865d70`, and `36556455fe` (with `personal-bots/main` `369d1a8991` merged in `96695e7d69`):

- **Gemini/Antigravity Eco mode (`packages/provider-acp/src/server/adapter.ts`, `packages/provider-core/src/server/ecoGuard.ts`, `apps/server/src/personal/eco/ecoMode.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/mcp/toolkits/personal/`):** two-prompt same-session ACP Eco handoff (planner on Gemini 4 Neon -> builder on Gemini 4 Hydrogen) with planner edit guard, `eco_handoff` MCP tool gated on `t3-eco: 1`, builder prompt watchdog, late-switch restore, and shell key extraction.
- **Stdio MCP `t3-eco` bridge (`packages/provider-acp/src/server/adapter.ts`, `apps/server/src/mcp/AcpMcpStdioBridge.ts`, `apps/server/src/mcp/advertisedTools.ts`):** wires `T3_ACP_MCP_ECO=1` into the `t3-code` stdio bridge `env` and `processEnvironment` when `ecoCapable` is true, forwards `MCP_ECO_HEADER` (`t3-eco: 1`) from `runAcpMcpStdioBridge`, `mcpToolSession`/`callAcpMcpTool`, and `runAcpMcpCliFastPath` (`acp-mcp-bridge` and `acp-mcp-call`), and excludes Eco-only `eco_handoff` from `advertisedToolList()` so non-Eco context budgets stay unchanged.
- **Mobile & contracts Eco support (`packages/contracts/src/personalBots.ts`, `packages/personal-client/src/bots/botDraft.ts`, `packages/personal-client/src/bots/botFormModel.ts`):** adds Gemini/Antigravity Eco mode support in the bot form (default builder Gemini 4 Hydrogen high, Gemini cost tiers) and fixes saving Eco settings while providers are still loading. Zero `apps/web` edits.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.67`.

## Release notes for the phone

Gemini/Antigravity bots can now use Eco mode (plan on Gemini 4 Neon, build on Gemini 4 Hydrogen) from the bot settings screen.

## Verification

- **Unit tests and checks (`f950561d3d`, `36556455fe`):** targeted unit tests (`AcpMcpStdioBridge.test.ts`, `AntigravityAdapterV2.test.ts`, `AcpRegistryAdapterV2.test.ts`, `adapterWiring.test.ts`: 4 files, 105/105 PASS), 5 preflight server guard tests (24/24 PASS), full `t3` server typecheck (5/5 tsconfigs PASS), `vp fmt`, `vp lint` (0 warnings, 0 errors), and `vp run knip:check`.
- **Stage:** release `36556455fe5c` staged in 20 s (`externals=copied`, `/home/harout/.personal-bots/releases/36556455fe5c`, not activated). Log `dev-team/qa/hbots-16767/stage2.log`.
- **Gates:** full (untiered) `gates-linux.scoped.json` on `36556455fe5c`: 8 run (`server-tests`, `server-tsc`, `web-tests`, `web-tsc`, `e2e`, `personal-client`, `hbots-mobile`, `parity`, all whole), 2 scope-skipped (`hbots-mobile-kotlin`, `release-tools`), all PASS in 891 s wall. Gate evidence PASS (section below). Log `dev-team/qa/hbots-16767/gates3.log`.
- **Release APK (arm64):** built inside the gates in 270 s: `hbots-1.67.67-arm64-release.apk`, versionCode 1067067, 50,068,639 bytes, sha256 `e260b5ed5aab17bb1aa2ec74203364a35f6ee166cecdd2a48708414a104f8eaf`.

## Migration

None (165 -> 165). The runner skips the backup.

## Rollback

Binary rollback to 1.67.66 (`a88237c522d2`). No schema change.

## Gate evidence

<!-- gate-evidence:begin sha=36556455fe5c7a36d93c93144a1f190a096823e0 release=36556455fe5c json-sha256=fa9731e96d1932e2f4440783dee36806c6773dbdc238dffc713b4c90b6ac83e1 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner
- not run by any gate: packages/contracts/src/personalBots.test.ts

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 891 s wall, 1582 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 15023 MB, swap growth 0 MB, peak load 24.7
  preflight            guards   start    0 s      8 s   1 job  PASS  |#
  server-tests         whole    start    8 s    882 s   4 jobs PASS  | ###########################################################
  server-tsc           whole    start    0 s     31 s   1 job  PASS  |##
  web-tests            whole    start  586 s    138 s   1 job  PASS  |                                       #########
  web-tsc              whole    start  312 s     35 s   1 job  PASS  |                     ##
  e2e                  whole    start    8 s    304 s   1 job  PASS  | ####################
  personal-client      whole    start  312 s     61 s   1 job  PASS  |                     ####
  hbots-mobile         whole    start  488 s     98 s   1 job  PASS  |                                 #######
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start  347 s     26 s   1 job  PASS  |                       ##
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start  586 s    270 s   1 job  PASS  |                                       ##################
```

<!-- gate-timing:end -->
