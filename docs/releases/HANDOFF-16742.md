# 1.67.42: Antigravity save_memory exposure, secrets import hardening, and queued mid-turn status

Based on 1.67.41 (`2c1649654e17`, trunk `b629e9a729`). Branch `rc/1.67.42` adds four commits on top of trunk so trunk fast-forwards cleanly to the release. The schema stays at 160. This release ships both server and Android APK 1.67.42.

## Why

Antigravity bots were missing `save_memory` and 14 other personal tools because the server advertised all 107 MCP tools (97.7 KB), exceeding Antigravity ACP's ~58 KB eager MCP budget. Secrets bundle import also needed path-traversal guards noted as a follow-up in 1.67.40. Finally, messages sent mid-turn to Antigravity bots displayed "Steering" in Android even though Antigravity queues follow-up messages until the active turn ends.

## What changed

- **Secrets bundle path hardening** (`024079d9b7`). Tightened `isPortableName` and added `resolvePortableSecretPath` in `apps/server/src/personal/secrets/secretsPortability.ts` so crafted entry names containing `/`, `\`, `..`, NUL, or control characters are rejected with `bundle-malformed` before any write.
- **Personal-bot MCP tool visibility** (`61697e212f`, `a8b5f32c72`). Resolved `personalBot` scope (`isLead`, `isGroup`) once per authenticated MCP request in `apps/server/src/mcp/McpHttpServer.ts` and omitted T3 desktop IDE tools, PR-panel tools, team-lead-only tools for non-leads, and group-vote tools outside group chats from `tools/list` (while keeping `tools/call` unrestricted). Drops advertised schemas under Antigravity's eager cap so `save_memory`, `delegate_task`, `update_project`, routines, and personal tools register eagerly.
- **Non-steering queued status on Android** (`fc744bd4ba`). Added `driverSupportsActiveSteering` and optional `supportsActiveSteering` to `deriveLatestMessageReadStatus` in `packages/personal-client/src/feed/messageReadStatus.ts`, wired through `ChatScreen.tsx` and `Composer.tsx` so mid-turn sends to Antigravity show "Queued" instead of "Steering" and show a subtle "Queued until this turn ends." hint while typing.
- **Staged release cleanup.** Pruned 7 superseded staged release folders via `hbots.mjs prune --keep 1 --protect 0130b5adf7b1 --protect 2c1649654e17 --apply`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.42.

## Release notes for the phone

- Antigravity bots now have access to `save_memory` and all personal tools.
- Messages sent while an Antigravity bot is working now show Queued instead of Steering.
- Secrets import bundles reject crafted path-traversal filenames.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- `apps/server`: `secretsPortability.test.ts` (16/16), `McpHttpServer.test.ts` (37/37), `agentContextBudget.test.ts` (1/1), and all 5 lean TypeScript shards exit 0.
- `packages/personal-client`: `messageReadStatus.test.ts` (8/8) and `tsc --noEmit` exit 0.
- `apps/hbots-mobile`: `vp lint .` (0 errors), `tsc --noEmit` exit 0, `messageList.reconciler.test.ts` (21/21).
- `apps/web`: both lean TypeScript shards exit 0.
- Measured MCP schema payload against Antigravity's `mcp/t3-code/` tool files: dropped from 107 tools (97,657 bytes) to 53 tools (51,890 bytes) for non-lead bots and 57 tools (65,727 bytes total, keeping `save_memory`, `delegate_task`, `update_project`, routines, `secret_request`, and `html_render` inside the ~58 KB eager budget) for team-lead bots.
- Release check runs with the installed scoped `gate-evidence.mjs` tool and `gates-linux.scoped.json`.

## Rollback

Binary rollback to `2c1649654e17` (1.67.41). No data change, so no data restore.

## Gate evidence

<!-- gate-evidence:begin sha=ac42da4c6a51fd7bfdf883681b8b8edea91c45bf release=ac42da4c6a51 json-sha256=b3f0d72a77605821163ea35743f7a2fafdde1a81ba5ddaac3bce1a2d02ae3934 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/mcp/McpHttpServer.test.ts, apps/server/src/mcp/McpHttpServer.ts, apps/server/src/mcp/McpInvocationContext.ts, apps/server/src/personal/secrets/secretsPortability.test.ts, ...; selected 225 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/mcp/McpHttpServer.test.ts, apps/server/src/mcp/McpHttpServer.ts, apps/server/src/mcp/McpInvocationContext.ts, apps/server/src/personal/secrets/secretsPortability.test.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->
