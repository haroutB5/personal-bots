# hbots 1.66.53: an unloadable bot plugin skill is logged, and the provider probe-timeout test is fixed

QA: not started. Recommended tier: **small fix** (one new diagnostic WARN plus a test-only fix; nothing changes for a skill that loads). Builder proof is in this file. What QA should look at if it runs: send one message to a bot whose plugin folder holds a BOM `SKILL.md` and confirm exactly one `bot plugin skill failed to load` WARN naming that bot, with the file and the reason.

Staged release: `STAGED_SHA`, branch `release/hbots-16653`, based on live notes `761ad6625e` (1.66.52). No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5`. Staged with `build.ps1 -CopyExternals`.

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

- `vp test run src/provider` fully green: `2346 passed | 4 skipped (2350)` across 46 files (numbers from the run below); the four new provider-path tests are listed there.
- New `apps/server/src/provider/botPluginSkillDiagnostics.test.ts`: 5 tests. A BOM file, a missing-frontmatter file and a malformed-YAML file each produce one problem; a good skill (LF and CRLF), a folder with no `SKILL.md` and a dot-folder produce none; a root-level `SKILL.md` is read; the WARN carries the bot id, the exact path and the reason; a bot with healthy skills logs nothing; the shared and the bot's own plugin folders are both checked.
- One new test per provider path, each against the real adapter with its provider runtime mocked:
  - `CodexAdapter.test.ts` `warns once for the skill a bot's plugin folder cannot load`,
  - `ClaudeAdapter.test.ts` `warns once for the skill a bot's plugin folder cannot load`,
  - `DeepSeekDshAdapter.test.ts` `warns once for the skill a bot's plugin folder cannot load` (real ACP runtime against the recorded dsh mock),
  - `CodexProvider.test.ts` `warns once for each skill Codex refused in `skills/list``.
- Proved on a running server (throwaway root on the staged release, not the live one): a BOM `SKILL.md` in a seeded bot's plugin folder produced exactly one WARN ... (`THROWAWAY_PROOF`).
- The probe-timeout test now passes, repeated: `vp test run src/provider/Layers/ProviderRegistry.test.ts -t "closes the app-server probe scope"` green (it failed 0/1 before).

## QA checks (only if QA runs)

- [ ] On a throwaway root, put a BOM `SKILL.md` in one bot's plugin folder, start that bot's session and confirm exactly one WARN naming the bot, the file and the reason, and that the other skills of that bot still load.
- [ ] Confirm a bot with only healthy skills logs no such WARN.
- [ ] Quick regression at 390 x 844 dark: Bots list, open a chat, send a message (a session start is where the check runs).

## Gate evidence

See the section below (written by `gate-evidence.ps1`).
