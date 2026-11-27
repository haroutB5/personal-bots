# 1.67.63: hardening follow-ups for External MCP, tool_call and semantic memory; executor-docker.sh fixes

Based on 1.67.62 (trunk `c8b60507ef`, live release `ff93bbe5f03e`). Branch `fix/hbots-memory-executor-followups`, built in worktree `_wt/hbots-memory-followups`. **No migration** (schema stays 164), so the release runner skips the backup (`--migration-before 164 --migration-after 164`). **Server-only release:** nothing the phone app is built from changed (19 files under `apps/server/src` and `scripts/personal/linux/executor`, plus the version bump of `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json`), so no APK is built, no emulator QA runs, and `latest.json` stays on 1.67.62.

Reviewed by Opusito (`dev-team/qa/hbots-16763/REVIEW.md`, SHIP, no must-fix). Built by Opuser.

## What changed

All in `4ce737a2e1`; these are the non-blocking review follow-ups from 1.67.62 plus executor script fixes.

- **External MCP proxy and connection test** (`proxyRoute.ts`, `PersonalExternalMcpService.ts`): redirects are refused (`redirect: "error"`), a 60 s upstream timeout (headers timeout for SSE), non-SSE response bodies are capped at 4 MiB (HTTP 502 above it), saved secrets and the upstream bearer token are scrubbed from non-SSE and SSE responses, and the connection test shows a scrubbed, actionable error (`HTTP <status>: <snippet>`).
- **`tool_call` and `McpToolExposure`**: `tool_call` enforces the preview/device capability and the read-only/plan mode checks; the loaded-set cap goes from 256 to 1024 sessions and `isListed` refreshes LRU recency.
- **Semantic memory**: the in-memory vector cache is capped at 20,000 entries with one WARN; visible memory ids are pre-filtered with a wider candidate window so other scopes no longer crowd out the semantic top-N.
- **Temporal grounding**: write-time relative-date grounding follows `contextualRetrievalEnabled()` (off with `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy`); the time zone is `T3CODE_PERSONAL_TIMEZONE`, default `Europe/London`, with a local fallback for an invalid zone.
- **Cleanup**: unused `normaliseApps` import removed from `PersonalMemoryTidyService.ts`.
- **Executor script** (`scripts/personal/linux/executor/executor-docker.sh`, README): mounts `/app/data`, adds `--init` and `BETTER_AUTH_URL` (override `EXECUTOR_AUTH_URL`); still loopback only.
- **Version:** `scripts/personal/app-version.txt` and the version line of `apps/hbots-mobile/package.json` bumped to `1.67.63`.

## Verification

Pending: scoped gates and gate evidence on the staged release.

## Follow-ups (from review, not blocking 1.67.63)

- `tool_call` read-only/plan check is stricter than the direct path: plan-narrowed OAuth clients (`T3-Mode-Limit .../plan`) are refused any deferred tool without `readOnlyHint`, while the same tool called directly is not. Bots are not OAuth clients, so no bot impact.
- The embedding cache "LRU" is insertion/update order, not read recency, and an evicted vector is not reloaded until restart. The 20k cap is far above today's count.
- If the proxy fiber is interrupted before fetch settles, the 60 s timer still fires (it aborts an already-aborted controller; harmless).
- `visibleMemoryIds` adds one indexed SELECT per semantic retrieval (cheap at current sizes).

## Migration

None (164 -> 164). The runner skips the backup.

## Rollback

Binary rollback to 1.67.62 (`ff93bbe5f03e`). No schema change.
