# 1.67.66: provide PersonalExternalMcpService to layerPersonalTurnContext

Based on 1.67.65 (trunk `8ae5798fe8`, live release `8e1621398ae9`). Branch `fix/turn-context-external-mcp`, built in worktree `_wt/hbots-turnctx-ext-mcp`. **No migration** (schema stays 165), so the release runner skips the backup (`--migration-before 165 --migration-after 165`). **Server-only release:** nothing the phone app is built from changed (2 files under `apps/server/src`, plus the version bump of `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json`), so no APK is built, no emulator QA runs, and `latest.json` stays on 1.67.65.

Built and shipped by Neon with Harout's direct approval.

## What changed

- **Server layer wiring (`apps/server/src/server.ts`):** `layerPersonalTurnContext` is provided to `layerOrchestrationV2Runtime` inside `layerOrchestrationApplication`, which sits below `PersonalServerLayerLive`. Without `Layer.provide(PersonalExternalMcpServiceLayer)` directly on `layerPersonalTurnContext`, `Effect.serviceOption(PersonalExternalMcpService)` evaluated to `Option.none()` and `externalMcpServersForThread` returned `[]` for every bot and provider. Providing `PersonalExternalMcpService.layerLive` alongside `PersonalSessionAccessLayer` attaches enabled external MCP servers (such as `ext-executor`) to bot sessions across all providers.
- **Tests (`apps/server/src/personal/turnContext/PersonalTurnContext.test.ts`):** adds coverage for `externalMcpServersForThread` resolving enabled external MCP servers for the thread's bot.
- **Version:** `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json` bumped to `1.67.66`.

## Verification

- **Unit tests and typecheck:** `PersonalTurnContext.test.ts` and `pnpm --filter t3 typecheck` pass.
- **Stage and scoped gates:** server-only track (`gates-linux.scoped.json`), run before sealing and arming.

## Migration

None (165 -> 165). The runner skips the backup.

## Rollback

Binary rollback to 1.67.65 (`8e1621398ae9`). No schema change.
