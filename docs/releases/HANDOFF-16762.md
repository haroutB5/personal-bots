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

Pending: scoped gates, gate evidence and QA on the staged release.

## Migration

162, 163, 164 (161 -> 164), additive only. The runner takes the pre-migration backup.

## Rollback

Binary rollback to 1.67.61 (`0f449cf12cf1`). The new tables and index are additive and ignored by 1.67.61.
