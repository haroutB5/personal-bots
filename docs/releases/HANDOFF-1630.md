# hbots 1.63.0: independent upstream T3 Code fixes, cherry-picked (no orchestrator v2)

Branch `chore/upstream-picks-1005`, on top of `88dc0d873b` (1.62.0 live), no force. `git cherry-pick -x`, one commit each, in upstream order; every pick carries its upstream sha in the message. No migration, no dependency version change (one patch hash, see below). `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -NoActivate -CopyExternals`, repo `.env` copied in (log: "Loaded 4 key(s)"); `current.txt` untouched. Not live until DevOps ships it.

Release `cafb31f19eba` (built from commit `cafb31f19e`; HANDOFF commit follows it). Evidence: `C:/Users/Ht/.personal-bots/qa/backend-upstream-picks/`.

## Picked (18 upstream commits)

| upstream   | our commit              | what                                                                                                                                                                                                                   |
| ---------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9151ea407a | 0d446cf188              | saving the thread list cache no longer freezes the UI                                                                                                                                                                  |
| 8872666957 | 1b8f423831              | fewer idle wakeups (Connect relay, session reaper)                                                                                                                                                                     |
| 95030dc674 | 1459a5104d              | background git status fetches no longer fill the disk with failed repacks                                                                                                                                              |
| 94f92a7a38 | 9d00a3030f              | Claude: abort turns before closing sessions (conflict: kept both context fields)                                                                                                                                       |
| ed57bed8e7 | ddf7b433a9              | typing latency: skip unchanged shortcut modifier updates                                                                                                                                                               |
| adfc9240ea | 7856b8d0ab              | usage kept in oversized transcript records                                                                                                                                                                             |
| e518866d28 | 164c4a4314              | OpenCode stop no longer hangs                                                                                                                                                                                          |
| 9da066dbe9 | 7370938d21 + 44260ee7be | Claude /compact no longer leaves the thread busy (conflict: our "result before the prompt started" guard kept, upstream's other-turn guard added after it; upstream test added as its own commit, our turn tests kept) |
| e0db2a5e58 | 3a5bf28543              | a second server no longer resends Claude turns                                                                                                                                                                         |
| 9333509c91 | 6265c112d5              | reconnect backoff with jitter, keep healthy sockets                                                                                                                                                                    |
| 798e945aa7 | a99ce11a2d              | agent preview clicks no longer steal composer focus                                                                                                                                                                    |
| 56914128c1 | 25fba62943 + 397140b936 | Codex Fast and Ultrafast priced at what they bill (see usage cache below)                                                                                                                                              |
| 39efcd8558 | adfc45231a              | DOM changes no longer restyle the whole page                                                                                                                                                                           |
| 0cfa113be5 | 32c89f633e              | lint rule flagging unscoped :has() (the no-test-in-loop line from a commit we do not have was left out)                                                                                                                |
| a92c43b80b | 8fc853bf8c              | relay disconnects no longer show as thread errors                                                                                                                                                                      |
| 0fe4fa40fe | 64e79d6585              | SQLite transactions wait for the write lock instead of failing                                                                                                                                                         |
| 3e6b45028c | 41b16bfd43              | worktrees honour submodule settings (GitWorkflowService.createWorktree now goes through GitManager; server.test.ts mock updated)                                                                                       |
| eac52f0087 | 5d4d140d05              | closing a busy stream no longer drops the connection (effect patch; our patch was identical to upstream's previous one; lockfile: only the patch hash and its derived peer hashes changed, kept our lock)              |

## Skipped

| upstream                                  | why                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8bc40b4e07 idle shells reloading projects | only touches orchestration v2 shell code (`subscribeOrchestrationV2Shell`, project enrichment); our `ws.ts` has none of it                                                                                                |
| 71dbaf1f94 warm usage scans               | rewrites the usage aggregator, scan loop and cache writer that our own scan-cache work (line format, sliced yields) also changed: 9 conflict hunks in the usage bar's core. Better as its own task with real-data timing. |
| a78760e5e7 RPC scopes in group middleware | refactor, and it assumes one `WsRpcGroup`; ours is five merged groups with one `toLayer` each (TypeScript instantiation limit). Not needed for safety here: audit below.                                                  |
| 836098543c Claude commands per workspace  | builds on upstream provider-refresh code we lack (`fresh` workspace refresh, `slashCommandsPending`) and adds a Claude CLI probe per workspace; conflicts in the usage probe where our reset-credit code lives            |
| b528a70110, b21f3b7191 Windows PTY        | both need node-pty 1.1.0 to 1.2.0-beta.15 (upstream 4923ff417f), a native module upgrade; not allowed in this batch                                                                                                       |

## Usage cache (56914128c1)

Our scan cache is the line format (v5). Codex tiers need a new version, so the cache is now line format **v6** and is written to **`usage-scan-cache-v5.json`** (upstream's file name; 1.62.0 keeps reading and writing `usage-scan-cache.json`, so a rollback does not fight over one file). v5 lines and single-document caches still load once: their saved usage is kept (also for deleted rollouts) and live Codex rollouts are re-parsed whole, once, so Fast/Ultrafast get priced. First start after the release does that one Codex re-read. `usageScanCache.test.ts` and `UsageService.test.ts` cover it (v5 lines, v4 single document, deleted rollout kept, legacy file left intact).

## RPC scope audit (a78760e5e7 skipped)

Every one of the 259 handlers in `WsRpcGroup.of({...})` in `ws.ts` goes through `observeRpcEffect/Stream/StreamEffect` with its own method name, which checks `requiredScopeForRpcMethod(method)` against the session; `RpcAuthorization.test.ts` pins `RPC_REQUIRED_SCOPES` to exactly the group's methods. Runtime check on the staged release (throwaway root): all 115 `personal*` RPCs called with the paired session, none refused for scope (32 succeed, 81 answer a validation error to the empty payload, 2 are streams that open without a first chunk); the same 115 with no session are all refused at the WebSocket upgrade; `GET /ws` 401; `POST /api/personal/push/sent` 401.

## Tests

- Server `vp test run src/personal src/mcp`: 153 files, 1976 passed, 3 skipped, exit 0; `npx tsc --noEmit` exit 0.
- Web `vp test run --project unit src/features/personal`: 174 files, 1760 passed, exit 0; `npx tsc --noEmit` exit 0. client-runtime and shared tsc exit 0.
- Upstream tests the picks brought, outside `src/personal`: server (`server.test.ts` 208 passed, `src/usage`, ClaudeAdapter, OpenCodeAdapter, relay, ProviderSessionDirectory, cloud http, AgentSessionJson...) pass; client-runtime 15 files / 185 tests, shared sqlite client 8 tests, lint-rule test 24 tests pass; the three web DOM tests (`previewClickFocus`, `shortcutModifierState`, `storage`) pass with `jsdom` copied in temporarily (jsdom is not in this tree's dependencies; removed again).
- One failure that is not ours: `GitVcsDriverCore.test.ts > keeps untracked filenames with pathspec magic` fails on Windows on 1.62.0 too (a file named `:(exclude)after.ts` cannot be created).

## Real check (staged `cafb31f19eba`, throwaway root, fake Claude CLI, port 38841)

`verify1630.mjs`, 18 of 18: chat gets a reply; a bot's `preview_navigate/click/snapshot` turn clicks a real page ("clicked 1") and the composer keeps focus; a task created over `personalTasks.create` completes and `personalTasks.get` returns it; `personalRoutines.list`; `personalBots.tokenUsage` ready and `server.getUsageSummary` ok on the real home transcripts (read-only), cache file `usage-scan-cache-v5.json` written; all 115 personal RPCs with and without a session (above); server log 0 ERROR.

## Rollback

No migration: run the previous release (binary only). 1.62.0 ignores the new cache file.
