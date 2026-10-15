# hbots 1.66.53: an unloadable bot plugin skill is logged, and the provider probe-timeout test is fixed

QA: not started. Recommended tier: **small fix** (one new diagnostic WARN plus a test-only fix; nothing changes for a skill that loads). Builder proof is complete and in this file, including a running-server check. What QA should look at if it runs: send one message to a bot whose plugin folder holds a BOM `SKILL.md` and confirm exactly one `bot plugin skill failed to load` WARN naming that bot, with the file and the reason.

Staged release: `a31b7eb866c2`, branch `release/hbots-16653`, based on live notes `761ad6625e` (1.66.52). No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5`. Staged with `build.ps1 -CopyExternals` (the build loaded all 4 public `.env` keys; version 1.66.53).

## Follow-up 1: a broken bot plugin skill is no longer silent

A `SKILL.md` that a provider cannot parse is dropped without a word. Codex 0.162.1 answers `skills/list` with an `errors` array for exactly that (`missing YAML frontmatter delimited by ---` for a UTF-8 BOM), but a bot session never asks for that list: hbots names the bot's extra roots once and the file simply vanishes from the bot's catalogue. Claude Code and the DeepSeek harness skip the folder the same way. QA found the cause on 15 Oct: all four installed `agent-browser/SKILL.md` files carried a UTF-8 BOM.

- `apps/server/src/provider/botPluginSkillDiagnostics.ts` (new) resolves a bot's plugin skill folders (the shared `bot-plugins/_shared/`, then the bot's own) and reads every `SKILL.md` in them. One WARN per unloadable file:
  `bot plugin skill failed to load` with `botId`, `path` and `reason` (`the file starts with a UTF-8 BOM, ...`, `missing YAML frontmatter delimited by ---`, `malformed YAML frontmatter`).
- The file is read as bytes and decoded with the BOM kept: Node's UTF-8 decoder drops a leading BOM, which would hide the very failure being reported.
- Called where hbots hands those folders to a provider, so all three paths are covered and there is one implementation:
  - `ClaudeAdapter` (session start, next to the `plugins` it passes; also the DeepSeek `claude-code` engine),
  - `CodexAdapter` (the same folders it is about to name to the app-server with `skills/extraRoots/set`; nothing is logged when `PERSONAL_BOT_CODEX_SKILLS=off`, since then a bot has no skills at all),
  - `DeepSeekDshAdapter` (the folders it writes into the launch patch as `customSkillDirs`).
- `CodexProvider` now also logs Codex's own `skills/list` errors (one WARN per refused file, `Codex skill failed to load`, with `cwd`, `path`, `reason`) at the two places hbots already reads that answer. That covers the owner's and the workspace's skills, which were equally invisible.
- Only files are checked, never a folder without a `SKILL.md`, dot-folders are skipped, and a skill that loads logs nothing. A malformed file never fails the session.
- `ClaudeSkills.parseSkillFrontmatter` is now exported so all three paths report the same reason words Codex uses.

## Follow-up 2: the red provider test

`apps/server/src/provider/Layers/ProviderRegistry.test.ts` -> `closes the app-server probe scope when provider status times out` failed on 1.66.52 and on `525daec605` (kill callback ran 0 times, expected 1).

**The test was wrong, not the code.** The test runs on `TestClock`, so `TestClock.adjust("11 seconds")` fires the probe's 10 s timeout instantly. The probe reaches its first spawn only after `resolveSpawnCommand` resolves `codex` on PATH, which is real asynchronous work (Node's libuv probes, `packages/shared/src/shell.ts`). On this laptop that walk had not finished when the virtual clock moved, so the probe was interrupted **before it ever spawned**: no handle existed, no finalizer was registered, and the kill the test expected could never happen. Instrumented run of the same scenario: `spawnCalls 0, killCalls 0` without the fix, `spawnCalls 1, killCalls 1` once the spawn is awaited. The scope itself was never leaking: `Effect.timeoutOption` interrupts the probe fiber and `raceFirst` awaits that interruption, which closes the probe's scope and runs the spawn finalizer.

The fix is in the test: `hangingScopedSpawnerLayer` now completes a `Deferred` when the handle exists, and the test awaits it before moving the clock, so the scope under test really holds an app-server handle when the timeout fires. Nothing in `src` changed for it. Tier stays small: no leak, not a risky change.

## Builder proof

- `vp test run src/provider` fully green: `1755 passed | 58 skipped (1813)` across 107 files plus 2 skipped files, run with `--maxWorkers=4` (the default-parallel run is flaky on this laptop under load: two earlier full runs each lost one different timing-sensitive test, `DeepSeekDshAdapter` "settles a cancelled turn with the aborted tool" once and a 120 s timeout in `ProviderRegistry` "re-probes when settings change the codex binaryPath" once; both pass on their own and neither touches this change). For comparison, the same full run at the base commit `761ad6625e` fails the probe-timeout test below, which this release fixes.
- New `apps/server/src/provider/botPluginSkillDiagnostics.test.ts`: 5 tests. A BOM file, a missing-frontmatter file and a malformed-YAML file each produce one problem; a good skill (LF and CRLF), a folder with no `SKILL.md` and a dot-folder produce none; a root-level `SKILL.md` is read; the WARN carries the bot id, the exact path and the reason; a bot with healthy skills logs nothing; the shared and the bot's own plugin folders are both checked.
- One new test per provider path, each against the real adapter with its provider runtime mocked:
  - `CodexAdapter.test.ts` `warns once for the skill a bot's plugin folder cannot load`,
  - `ClaudeAdapter.test.ts` `warns once for the skill a bot's plugin folder cannot load`,
  - `DeepSeekDshAdapter.test.ts` `warns once for the skill a bot's plugin folder cannot load` (real ACP runtime against the recorded dsh mock),
  - `CodexProvider.test.ts` `warns once for each skill Codex refused in `skills/list``.
- Proved on a running server: throwaway root, staged release `a31b7eb866c2`, a BOM `SKILL.md` (`EF BB BF` verified) in the seeded Developer bot's plugin folder plus one healthy skill in the same folder. The whole run logged **exactly one** `bot plugin skill failed to load` line, naming `personal-seed-developer`, that file and the BOM reason, at that bot's session start; the healthy skill and the Researcher bot (no broken skill, session started and answered) logged none, and a second turn on the open chat added none. Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-16653-backend/README.md` (`warn-excerpt.txt`, `send-run.log`, `researcher-run.log`, `chat-390-dark.png`; agent-browser 0.39.1 through `ab.cmd`, 0 page errors, one unrelated Clerk console warning). The root was stopped and deleted afterwards; the live server and live release were untouched.
- The probe-timeout test now passes, repeated: `vp test run src/provider/Layers/ProviderRegistry.test.ts -t "closes the app-server probe scope"` green (it failed 0/1 before).

## QA checks (only if QA runs)

- [ ] On a throwaway root, put a BOM `SKILL.md` in one bot's plugin folder, start that bot's session and confirm exactly one WARN naming the bot, the file and the reason, and that the other skills of that bot still load.
- [ ] Confirm a bot with only healthy skills logs no such WARN.
- [ ] Quick regression at 390 x 844 dark: Bots list, open a chat, send a message (a session start is where the check runs).

## Gate evidence

<!-- gate-evidence:begin sha=a31b7eb866c2efc4e596ccac38ed02957755567d release=a31b7eb866c2 json-sha256=08f8858ca9a5eaaa773e33c6271d5e2a898a11a82c451b003e41bc6e3243bf42 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T22:27:32Z. Version 1.66.53, release `a31b7eb866c2`, commit `a31b7eb866c2efc4e596ccac38ed02957755567d` on `release/hbots-16653`, working tree clean, result **PASS**.

Machine-readable copy: `releases\a31b7eb866c2\gate-evidence.json` (sha256 `08f8858ca9a5eaaa773e33c6271d5e2a898a11a82c451b003e41bc6e3243bf42`) and the full gate logs in `releases\a31b7eb866c2\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2699 tests passed, 0 failed, 3 skipped, in 194 files | 300.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 46.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2626 tests passed, 0 failed, 0 skipped, in 238 files | 45.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 40.1    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 76.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16653\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\a31b7eb866c2" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 294.8   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `a31b7eb866c2efc4e596ccac38ed02957755567d`, at end `a31b7eb866c2efc4e596ccac38ed02957755567d`; tracked files modified: none. Staged release: version 1.66.53, sha a31b7eb866c2, dirty False, externals copied; `dist/bin.mjs` sha256 `06d03152ed7c55f922e7b9aecbe9f4fe570734cc36255bb99840c9479709182b`.
<!-- gate-evidence:end -->
