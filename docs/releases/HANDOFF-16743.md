# 1.67.43: Antigravity effort fix, full team-lead MCP budget, Queue-after-turn fix, and audit polish

Based on 1.67.42 (`a0baa48a18df`, trunk `8b58aeebdc`). Branch `rc/1.67.43` stays strictly fast-forward on top of trunk with schema version unchanged at 160. This release ships both server and Android APK 1.67.43.

## Why

A full end-to-end audit of Antigravity in `hbots` uncovered several live bugs: (1) Antigravity bots silently dropped their configured `effort` (`low`/`medium`/`high`) because `AntigravityProvider` renamed ACP's `thinking_level` to `effort` without translating it back when configuring sessions or text generation; (2) team-lead Antigravity bots still exceeded `agy`'s ~58 KB eager MCP budget, dropping `create_bot` and `update_bot`; (3) Android's `"Queue after this turn"` sent `followUp: "queue"` without `dispatchMode: "queue"`, steering Antigravity 1.5+ immediately while labeling the bubble `"Queued"`; plus fallback family scoping, tool/subagent labels, usage sheet filtering, Provider settings UX, and remaining upstream `v0.1.11`+ Antigravity/ACP fixes.

## What changed

- **Antigravity `effort` -> `thinking_level` runtime translation.** `applyAntigravityAcpModelSelection` in `apps/server/src/provider/acp/AntigravityAcpSupport.ts` now applies `{ id: "effort" }` (or `thinking.id`) to `agy`'s `thinking_level` config option after model selection; `AntigravityAdapterV2.ts` declares `ownedModelOptionIds: ["effort"]` to eliminate the live warning; `AntigravityTextGeneration.ts` honors saved `effort`; `PersonalBotRepository.ts` reads `effort`/`reasoningEffort`/`variant`/`thinking_level` for `engineLine` in bot instructions.
- **Full team-lead MCP tool budget under ~58 KB.** `McpHttpServer.ts` hides desktop `device_*` tools when a personal bot lacks the `device` capability, and concise descriptions in `bots/tools.ts` and `personal/tools.ts` trim ~9.5 KB (updating `agentContextBudget.json`) so all personal and team-lead tools (including `create_bot`, `update_bot`, `delegate_task`, and `save_memory`) register eagerly in Antigravity with zero dropped tools in both direct and group chats.
- **Remaining upstream `v0.1.11`+ Antigravity & ACP fixes.** Backported `#36496` (0-byte `mcp_config.json` in text gen), `#36978` (identified plans across turns), `#35837` (permission option id unchanged), `#37505` (whitespace in history replay), `#38106` (web search classification), `#39147` (location-only tool updates), `#39151` (cleared compaction summary), `#37468` (ACP image previews), `#39443` (drop stale sign-in failure), `#39485` (per-instance Google sign-in keyring bypass), `#28355` (name runtime crash), and `#39378` (Auto uses `agy`'s Auto review).
- **Antigravity fallback, usage, and tool labels.** `personalModelFallbackPolicy.ts` scopes Antigravity `gemini-*`/`claude-*`/`gpt-*`/`3p-*` windows by family; `runtimeModel.ts` normalizes Antigravity's `"Run mcp_t3-code_<tool>"` titles via `mcpToolStepLabel`; `liveWork.ts` and `chatThread.ts` humanize `"<server>.<tool>"` tool names and show subagent titles; `usagePresentation.ts` selects the highest-used Gemini session window.
- **Android `"Queue after this turn"` & Provider settings polish.** `Composer.tsx` and `outboxNative.ts` pass `dispatchMode: "queue"` when `followUp === "queue"`; `ChatScreen.tsx` prefers live session `capabilities.turns.supportsActiveSteering`; `ProviderScreen.tsx` shows Sign out for authenticated OAuth-only providers (Antigravity), removes `"then tap Test"` when `!canTest`, uses `entry.isDefault` for `"Default model"`, and fixes the install-progress notice copy.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.43`.

## Release notes for the phone

- Antigravity bots now apply their configured effort level (`low`/`medium`/`high`) instead of falling back to default, and team-lead bots keep `create_bot` and `update_bot` registered.
- Long-pressing Send -> "Queue after this turn" now genuinely queues behind an active turn instead of steering immediately.
- Cleaner Antigravity MCP tool and subagent activity labels, family-scoped usage/fallback limits, and Sign out + model default fixes on Provider settings.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- `packages/provider-acp` & `packages/provider-acp-registry`: `typecheck` and `runtimeModel.test.ts` pass.
- `apps/server`: all 5 lean TypeScript shards, Antigravity & ACP suites, `McpHttpServer.test.ts`, `agentContextBudget.test.ts`, and `personalModelFallbackPolicy.test.ts` pass.
- `packages/personal-client`: `typecheck`, `liveWork.test.ts`, `messageReadStatus.test.ts` pass.
- `apps/hbots-mobile`: `tsc --noEmit` and `vp lint` pass.
- Release check runs with the installed scoped `gate-evidence.mjs` tool and `gates-linux.scoped.json`.

## Rollback

Binary rollback to `a0baa48a18df` (1.67.42). No data change, so no data restore.

## Gate evidence

## Gate evidence

<!-- gate-evidence:begin sha=d0a643b0a93a3c31b17b34e7af1e310de86f85a0 release=d0a643b0a93a json-sha256=8dc5660f2d9d8dd598557dc060d8b7a2a112fd253401c5b8275985f4007d6be9 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/scripts/acp-mock-agent.ts, apps/server/src/mcp/McpHttpServer.test.ts, apps/server/src/mcp/McpHttpServer.ts, apps/server/src/mcp/toolkits/bots/tools.ts, ...; selected 263 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/scripts/acp-mock-agent.ts, apps/server/src/mcp/McpHttpServer.test.ts, apps/server/src/mcp/McpHttpServer.ts, apps/server/src/mcp/toolkits/bots/tools.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner
- not run by any gate: apps/server/src/textGeneration/AntigravityTextGeneration.test.ts
- not run by any gate: packages/provider-acp/src/server/runtimeModel.test.ts

<!-- gate-evidence:end -->
