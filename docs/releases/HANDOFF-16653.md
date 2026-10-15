# hbots 1.66.53: unloadable bot plugin skills are logged, the provider probe-timeout test is fixed, and Settings set the auto-archive wait

QA: not started. Recommended tier: **small fix** (a new diagnostic WARN, a test-only fix, and one Settings field that reuses the existing sweep; nothing changes for a skill that loads or a chat that uses the default). Builder proof for the first two parts is in this file, including a running-server check; the third was built, gated and browser-checked by Frontend and reviewed by the CTO. **QA's quick regression should open Settings > Chat once: the "Archive after" row shows 48h on a fresh root, and it is hidden when the auto-archive toggle is Off.** For the first part, send one message to a bot whose plugin folder holds a BOM `SKILL.md` and confirm exactly one `bot plugin skill failed to load` WARN naming that bot, with the file and the reason.

Staged release: `5d20b9a86366` (supersedes the earlier stage `a31b7eb866c2` of the same version), branch `release/hbots-16653`, based on live notes `761ad6625e` (1.66.52), with `feat/hbots-archive-after` (`70fc42294a`) merged as `a996ca918d`. No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5`. Staged with `build.ps1 -CopyExternals` (the build loaded all 4 public `.env` keys; version 1.66.53).

## Settings set the auto-archive wait (folded in from `feat/hbots-archive-after`)

Harout asked for the sweep's fixed 48-hour wait to become a setting. Merged whole (branch head `70fc42294a`, merge commit `a996ca918d`); built, gated and browser-checked by Frontend, diff and screenshots reviewed by the CTO.

- The Settings > Chat "Archive after" row, under the auto-archive toggle while it is On: a whole number with `m` or `h` (`30m`, `90 M`, `48h`, `2H`), 5m to 720h, saved on blur or Enter; Escape or a bad value restores the saved one and shows an inline error. The row is hidden while the toggle is Off.
- One saved value (`autoArchiveTaskChatsAfterMinutes`, `personal_meta.taskChatAutoArchiveAfterMinutes`, default 2880 = 48 hours) drives both the finished-task idle clock and the unread routine report, read once per sweep, so a change applies within 5 minutes. Absent or unreadable reads as 48 hours: no migration, and an older data root is unchanged. The server refuses an out-of-range value instead of clamping it.
- `packages/contracts/src/personalChatArchive.ts` (new) is the one parser, formatter and range both the web form and the server use. `decideTaskChatArchive` takes the wait as a fourth argument and defaults to 48 hours, so every existing caller and the QA dry run keep their behaviour.
- Files: the new contracts module plus tests, `index.ts`, `personalBots.ts`, `apps/server/src/personal/{taskChatAutoArchivePolicy,PersonalTaskChatArchiveService,PersonalBotService}.ts` and their tests, `apps/web/src/features/personal/PersonalSettingsScreen.tsx` and its test. No provider file is touched, so the provider work below carries over byte for byte.
- Two stale texts fixed in the same release (CTO asked): the `autoArchiveTaskChats` comment in `packages/contracts/src/personalBots.ts` said a finished task chat archives after 30 idle minutes (it now names the setting, 48 hours by default), and the `auto-archive` line in `dev-team/apps/personal-bots.md` said "after 48 h" (it now says the Settings 'Archive after' value, default 48h, 5m to 720h).
- Frontend's proof: `vp test run src/personal` 2350 passed, web personal 2630 passed, contracts tsc 0, and a throwaway-root browser check at 390x844 dark (48h on a fresh root, an out-of-range value saves nothing and errors, Escape restores, `120m` saves and shows `2h`, it survives a reload, and the API rejects out-of-range and malformed values). Evidence: `C:/Claude/AI/dev-team/qa/hbots-archive-after/`.

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
- Proved on a running server: throwaway root, run on this version's earlier stage `a31b7eb866c2` (the merge that folded in the archive-after change touches no provider file, so the same code is in the final stage `5d20b9a86366`), a BOM `SKILL.md` (`EF BB BF` verified) in the seeded Developer bot's plugin folder plus one healthy skill in the same folder. The whole run logged **exactly one** `bot plugin skill failed to load` line, naming `personal-seed-developer`, that file and the BOM reason, at that bot's session start; the healthy skill and the Researcher bot (no broken skill, session started and answered) logged none, and a second turn on the open chat added none. Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-16653-backend/README.md` (`warn-excerpt.txt`, `send-run.log`, `researcher-run.log`, `chat-390-dark.png`; agent-browser 0.39.1 through `ab.cmd`, 0 page errors, one unrelated Clerk console warning). The root was stopped and deleted afterwards; the live server and live release were untouched.
- The probe-timeout test now passes, repeated: `vp test run src/provider/Layers/ProviderRegistry.test.ts -t "closes the app-server probe scope"` green (it failed 0/1 before).

## QA checks (only if QA runs)

- [ ] On a throwaway root, put a BOM `SKILL.md` in one bot's plugin folder, start that bot's session and confirm exactly one WARN naming the bot, the file and the reason, and that the other skills of that bot still load.
- [ ] Confirm a bot with only healthy skills logs no such WARN.
- [ ] Quick regression at 390 x 844 dark: Bots list, open a chat, send a message (a session start is where the check runs).
- [ ] Settings > Chat: open it once. The "Archive after" row shows 48h on a fresh root while the auto-archive toggle is On, and is hidden when it is Off. No deeper archive test is needed: the sweep itself is unchanged and Frontend's browser check covered the field.

## Gate evidence

<!-- gate-evidence:begin sha=5d20b9a86366a73d64954546511f7cc886f55e7d release=5d20b9a86366 json-sha256=123cb1a016ffade3f98ca65df8a1644eff46259b83236f258a53717c36721ae5 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T22:46:01Z. Version 1.66.53, release `5d20b9a86366`, commit `5d20b9a86366a73d64954546511f7cc886f55e7d` on `release/hbots-16653`, working tree clean, result **PASS**.

Machine-readable copy: `releases\5d20b9a86366\gate-evidence.json` (sha256 `123cb1a016ffade3f98ca65df8a1644eff46259b83236f258a53717c36721ae5`) and the full gate logs in `releases\5d20b9a86366\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2702 tests passed, 0 failed, 3 skipped, in 194 files | 273.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 41.4    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2630 tests passed, 0 failed, 0 skipped, in 238 files | 38.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 55.3    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 72.2    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16653\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\5d20b9a86366" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 295.8   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `5d20b9a86366a73d64954546511f7cc886f55e7d`, at end `5d20b9a86366a73d64954546511f7cc886f55e7d`; tracked files modified: none. Staged release: version 1.66.53, sha 5d20b9a86366, dirty False, externals copied; `dist/bin.mjs` sha256 `f6ee0a704d8d95852d7aa583ec6d4f02be6bee4288f3768c998df56771e8b0bf`.
<!-- gate-evidence:end -->
