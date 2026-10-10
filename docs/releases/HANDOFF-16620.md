# HANDOFF 1.66.20

## What changed

1.66.20 is the first release that carries both lines of pending bot work. It merges the gated 1.66.18 transcript-window audit branch onto the DeepSeek 1.66.19 release line. Merge commit `1ed641390d`; no migrations were added and task concurrency remains 5 (`PersonalTaskService.ts:50`).

From 1.66.19 (DeepSeek V4.1 Flash):

- The optional `deepseek` provider runs on the Claude Agent SDK against the fixed `https://api.deepseek.com/anthropic` endpoint (`DeepSeekEnvironment.ts:25`), with an isolated config home (`:66`), `PB_SECRET_*` and unrelated provider-token stripping (`:44`), and ambient endpoint/model overrides dropped before the fixed endpoint is set (`:86`).
- The Bots picker exposes only DeepSeek V4.1 Flash (`deepseek-flash`); documented Flash aliases canonicalize to it and Pro or Claude ids are rejected (`DeepSeekModelCatalog.ts:59`).
- `providerDriverMeta.ts` lists DeepSeek so the Add provider instance dialog offers it, and `ProviderInstanceCard` guides the key as a sensitive `ANTHROPIC_AUTH_TOKEN` with the endpoint fixed.
- The API key never enters driver settings: it travels as a sensitive provider environment entry and is stored in the server's encrypted secret store (`packages/contracts/src/settings.ts:762`).

From 1.66.18 (transcript window and jump/reply scroll):

- Personal transcripts mount at most 80 conversation items; older and later controls move by 40 with overlap and restore a visible row's pixel position. History is never truncated or deleted, and the full fixture stays reachable.
- Search and reply jumps materialize the target page first, center it, and keep the follow guard. Incoming messages and resize do not drag a reader back to the tail; Jump to latest resumes following. This is the `MessageList.tsx` / `transcriptWindow.ts` / `messageReply.ts` work.
- Preview evaluate normalizes its result before the real MCP `CallToolResult` constructor validates it (`apps/server/src/mcp/jsonResult.ts`): object undefined fields are omitted, array undefined/holes become null, and cycles, non-finite numbers, bigint/functions/symbols and unsupported object classes fail with value-free errors.

The earlier 1.66.19 shipping blocker (the Add provider instance dialog not offering DeepSeek) was real for the `e24e094532b5` binary, which predated `1209267aa4`. That fix is included here.

## Live configuration and proof on 1.66.19

The DeepSeek provider was enabled and its live key stored while 1.66.19 was the active release, so the configuration carries forward to 1.66.20 unchanged. Proof on the live server (release `1209267aa46f`, local origin `http://127.0.0.1:38472`):

- `/settings/providers` lists DeepSeek, its instance editor shows the key guidance, `ANTHROPIC_AUTH_TOKEN` is stored as a sensitive variable, and `settings.json` carries no plaintext key. The encrypted entry is the 35-byte `userdata/secrets/provider-env-ZGVlcHNlZWs-QU5USFJPUElDX0FVVEhfVE9LRU4.bin`; the instance settings hold `{ sensitive: true, valueRedacted: true }` with an empty value.
- The bot form offers provider "DeepSeek" with exactly one model option, "DeepSeek V4.1 Flash"; the created bot stored `{"instanceId":"deepseek","model":"deepseek-flash"}`.
- A real turn completed in the app: the bot was asked to reply with `PONG`, answered `PONG` (header `Idle · DeepSeek V4.1 Flash`), and the temporary bot was deleted afterwards (`deleted_at` recorded), so no test bot remains.
- The key itself was validated twice before wiring: a raw Anthropic-protocol call returned HTTP 200 with model `deepseek-flash`, and the Claude Code binary authenticated through the same endpoint.

Evidence: `C:/Users/Ht/.personal-bots/qa/backend-16619/` (`live-deepseek-after.png`, `live-e2e-deepseek-reply.png`, `deepseek-turn-live.json`, `enable-deepseek-live.json`).

Not verified: the effort control's non-default values on a live DeepSeek turn, and DeepSeek Pro ids (intentionally rejected). No paid Pro turn was made.

## Review status carried from 1.66.18

The 1.66.18 branch notes stated that independent QA was still pending for that work. It is included here on the strength of its own recorded gate pass plus the full 1.66.20 gate below, which re-ran every gate against the merged binary. If that independent review lands with findings, treat them against 1.66.20 rather than reopening 1.66.18.

## Gate evidence

<!-- gate-evidence:begin sha=1ed641390dab8534faddd3f5904401cf2cb6c2fb release=1ed641390dab json-sha256=33d8013313f338c85f0a7606fbf2d3ee9b35305138720ca1152042f626e91082 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-10T17:47:37Z. Version 1.66.20, release `1ed641390dab`, commit `1ed641390dab8534faddd3f5904401cf2cb6c2fb` on `release/hbots-16619`, working tree clean, result **PASS**.

Machine-readable copy: `releases\1ed641390dab\gate-evidence.json` (sha256 `33d8013313f338c85f0a7606fbf2d3ee9b35305138720ca1152042f626e91082`) and the full gate logs in `releases\1ed641390dab\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 273.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 60.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2400 tests passed, 0 failed, 0 skipped, in 222 files | 37.4    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 1.6     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 67.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-deepseek-flash\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\1ed641390dab" -Json` (in `.`)                                                                                                            | 0    | pass: 12/12 journeys passed                                | 295.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `ccc6057b1612f407c54b9b5907300329bbd14428`, at end `ccc6057b1612f407c54b9b5907300329bbd14428`; tracked files modified: none. Staged release: version 1.66.20, sha 1ed641390dab, dirty False, externals copied; `dist/bin.mjs` sha256 `8ba695ca155c057e0dbc112dd217fe8c6dc7ea7dc41e91092c9ae6f4d6efc085`.
<!-- gate-evidence:end -->
