# 1.67.65: wire extraMcpServers and deferMcpTools through ACP stdio MCP bridge

Based on 1.67.64 (trunk `1de0e2e841`, live release `f091207b9f82`). Branch `acp-stdio-extra-mcp`, built in worktree `_wt/hbots-acp-stdio-mcp`. **No migration** (schema stays 165), so the release runner skips the backup (`--migration-before 165 --migration-after 165`). **Server-only release:** nothing the phone app is built from changed (4 files under `packages/provider-acp/src` and `apps/server/src`, plus the version bump of `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json`), so no APK is built, no emulator QA runs, and `latest.json` stays unchanged.

Built by BabyNeon and shipped by Neon with Harout's direct approval.

## What changed

All code changes are in `24818adaab`:

- **ACP stdio MCP fallback (`packages/provider-acp/src/server/adapter.ts`):** `acpMcpContext` now appends every entry from `session.extraMcpServers` as a stdio `acp-mcp-bridge` server in `servers` (with `ELECTRON_RUN_AS_NODE=1`, `T3_ACP_MCP_ENDPOINT`, `T3_ACP_MCP_AUTHORIZATION`) and passes `T3_ACP_MCP_TOOL_EXPOSURE=deferred` to the `t3-code` stdio bridge when `deferMcpTools` is enabled. Antigravity ACP falls back to stdio bridges rather than HTTP MCP, so this exposes Shared External MCP servers (such as `ext-executor`) and deferred `t3-code` tool loading to Antigravity and other stdio-only ACP agents.
- **Stdio MCP bridge header forwarding (`apps/server/src/mcp/AcpMcpStdioBridge.ts`):** adds optional `toolExposure` to `AcpMcpStdioBridgeOptions`, forwards `t3-tool-exposure` (`MCP_TOOL_EXPOSURE_HEADER`) on POST requests when set, and reads trimmed `T3_ACP_MCP_TOOL_EXPOSURE` in `runAcpMcpCliFastPath` for `acp-mcp-bridge`.
- **Tests (`apps/server/src/personal/externalMcp/adapterWiring.test.ts`, `apps/server/src/mcp/AcpMcpStdioBridge.test.ts`):** covers stdio `servers` wiring for both `extraMcpServers` and `deferMcpTools`, plus header forwarding and env parsing in `AcpMcpStdioBridge`.
- **Version:** `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json` bumped to `1.67.65`.

## Verification

- **Unit tests and checks (`24818adaab`):** BabyNeon ran targeted unit tests (`adapterWiring.test.ts`, `AcpMcpStdioBridge.test.ts`, `AntigravityAdapterV2.test.ts`: 50/50 PASS), `@t3tools/provider-acp` tests (8 files, 108/108 PASS), full `@t3tools/provider-acp` and `t3` server typechecks, `vp lint`, `vp fmt --check`, and `knip:check`.
- **Stage and scoped gates:** run on the release bump commit before sealing and arming.

## Migration

None (165 -> 165). The runner skips the backup.

## Rollback

Binary rollback to 1.67.64 (`f091207b9f82`). No schema change.
