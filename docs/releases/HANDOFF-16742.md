# 1.67.42: Antigravity v0.1.11 upgrade, MCP tool exposure, and secrets import hardening

Based on 1.67.41 (`2c1649654e17`, trunk `b629e9a729`). Branch `rc/1.67.42` stays strictly fast-forward on top of trunk with schema version unchanged at 160. This release ships both server and Android APK 1.67.42.

## Why

Antigravity bots were missing `save_memory`, `delegate_task`, and 13 other personal tools because the server advertised all 107 MCP tools (97.7 KB), exceeding Antigravity ACP's ~58 KB eager MCP budget. Secrets bundle import also needed path-traversal guards noted as a follow-up in 1.67.40. In addition, upstream T3 Code `v0.1.11` (and immediate follow-ups on `main`) shipped major Antigravity 1.5.x improvements including native active prompt steering, keeping runs open through background commands and wakes, mid-turn 404 retry, subagent tracking, and accurate usage/limits.

## What changed

- **Secrets bundle path hardening** (`024079d9b7`). Tightened `isPortableName` and added `resolvePortableSecretPath` in `apps/server/src/personal/secrets/secretsPortability.ts` so crafted entry names containing `/`, `\`, `..`, NUL, or control characters are rejected with `bundle-malformed` before any write.
- **Personal-bot MCP tool visibility** (`61697e212f`, `a8b5f32c72`). Resolved `personalBot` scope (`isLead`, `isGroup`) once per authenticated MCP request in `apps/server/src/mcp/McpHttpServer.ts` and omitted 51 T3 desktop IDE and PR-panel tools, team-lead-only tools for non-leads, and group-vote tools outside group chats from `tools/list` (while keeping `tools/call` unrestricted). Drops advertised schemas under Antigravity's eager cap so `save_memory`, `delegate_task`, `update_project`, routines, `secret_request`, and `html_render` register eagerly.
- **Upstream T3 Code `v0.1.11` (+ latest `main`) Antigravity & ACP improvements.** Backported 40+ commits covering:
  - Native active prompt steering on Antigravity 1.5.x (`#39165`, `#39767`) so mid-turn messages steer without canceling active tools or subagents.
  - Background command and scheduled wake continuation (`#38864`, `#38916`, `#39421`, `#39806`) so Antigravity runs stay open through background commands and deliver follow-up replies instead of dropping output or failing permissions.
  - Mid-turn 404 auto-retry (`#39869`), host sleep timeout resilience (`#39395`), local harness crash recovery (`#23654`), and proper failed/refused stop-reason handling (`#28797`, `#37377`, `#37537`).
  - Subagent visibility, detached 1.5 transcript reading, killed-subagent cleanup, and transcript tail boundaries (`#38966`, `#39004`, `#39519`, `#39855`).
  - Antigravity 1.5.x usage/limits accuracy and thinking-token double-count fix (`#38957`, `#39435`, `#39686`), `call_mcp_tool` and `html_render` tool labels (`#39474`, `#38864`), MCP/thread env on spawn (`#36495`), workspace cwd fix (`#37997`), compaction support (`#37020`, `#39891`), UTF-16 BOM attachments (`#39456`), global `AGENTS.md`/`GEMINI.md` (`#39531`), `skills.json` discovery (`#39765`), valid Unicode truncation (`#38837`, `#39697`), saved thinking level in text generation (`#39720`), and ACP history/subagent perf (`#23724`, `#29422`).
- **Mid-turn steering/queued indicator on Android** (`fc744bd4ba` + Antigravity 1.5+ update). Added `driverSupportsActiveSteering` in `packages/personal-client/src/feed/messageReadStatus.ts` wired through `ChatScreen.tsx` and `Composer.tsx`, reporting active steering for Claude, Codex, and Antigravity 1.5+, and "Queued" for non-steering providers (`pi`, `opencode`, `cursor`, `acp-registry`).
- **Staged release cleanup.** Pruned 7 superseded staged release folders via `hbots.mjs prune --keep 1 --protect 0130b5adf7b1 --protect 2c1649654e17 --apply`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.42.

## Release notes for the phone

- Antigravity bots now have access to `delegate_task`, `save_memory`, and all personal tools.
- Major Antigravity 1.5.x upgrade from T3 Code 0.1.11: native mid-turn steering without canceling work, background commands and wakes no longer stall or drop replies, mid-turn 404 auto-retry, subagent tracking, and accurate token/limit reporting.
- Non-steering providers show Queued instead of Steering when a message is sent mid-turn.
- Secrets import bundles reject crafted path-traversal filenames.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- `packages/provider-acp` & `packages/provider-acp-registry`: `typecheck` and `runtimeModel.test.ts` pass.
- `apps/server`: all 5 lean TypeScript shards, Antigravity & ACP adapter/provider/text-generation suites, `secretsPortability.test.ts`, `McpHttpServer.test.ts`, and `agentContextBudget.test.ts` pass.
- `packages/personal-client`: `messageReadStatus.test.ts` and `tsc --noEmit` pass.
- `apps/hbots-mobile`: `vp lint .`, `tsc --noEmit`, and `messageList.reconciler.test.ts` pass.
- Measured MCP schema payload against Antigravity's `mcp/t3-code/` tool files: dropped from 107 tools (97,657 bytes) to 53 tools (51,890 bytes) for non-lead bots and 57 tools (65,727 bytes total, keeping `save_memory`, `delegate_task`, `update_project`, routines, `secret_request`, and `html_render` inside the ~58 KB eager budget) for team-lead bots.
- Release check runs with the installed scoped `gate-evidence.mjs` tool and `gates-linux.scoped.json`.

## Rollback

Binary rollback to `2c1649654e17` (1.67.41). No data change, so no data restore.

## Gate evidence
