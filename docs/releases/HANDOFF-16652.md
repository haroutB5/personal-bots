# hbots 1.66.52: SQLite checkpoints off the main thread, and Codex bot skills

**QA: SHIP** (15 Oct 2026). Two passes, both by QA on throwaway roots with fake Claude CLIs; the live server, database and config were never touched in either.

- **SQLite checkpoint worker** (this release's original change, staged `de81b5740839`; the fold-in below only touched provider skill files, and QA did not re-run these 8 checks): **8/8 pass**. Boot with no `checkpoint worker unavailable` WARN and 0 ERROR over 10 boots (3 crash restarts); the server's own main connection reads `PRAGMA wal_autocheckpoint=0` mid-load and never restores 1000; WAL bounded at 10.4 MB over three 180 s runs (23-26 restarts each, database mtime moving 32-35 times, at most 2,374 unbackfilled frames); 3/3 captured-PID crash-kills recovered every acknowledged chat write (9/7/9) and writer row (1,141/1,040/984) with `integrity_check` ok and migration 108; the release backup path on a copy of the real 3.3 GB backup finished with **restarts 0**, `ic ok` and 2,259 memory rows under a 10 commits/s writer (3,403 commits, snapshot 254 s); `T3CODE_SQLITE_CHECKPOINT_WORKER=off` restores `wal_autocheckpoint=1000` with 0 worker checkpoints and the same 23/23 turns acknowledged; main-thread COMMIT is better than 1.66.51 on the same interleaved load (p50 9.8 vs 12.0 ms, p95 71 vs 152, p99 254 vs 417, max 976 vs 1,687 ms; 3 vs 7 over 500 ms); 390x844 dark quick regression clean (0 page errors); `current.txt` still `260dcb7dedf1`. Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-16652/README.md` (raw data in `w1-3/`, `k1-3/`, `bk/`, `ks/`, `commit-compare.json`).
- **Codex per-bot skills, the delta folded in from `d4bf5da25c`** (this is the staged artifact `b974ded4722d`): **7/7 pass, plus 314 focused provider tests** (127 Codex adapter/runtime/launch-args, 187 Claude/DSH) independently re-run by QA. Against the **real Codex 0.162.1 app-server**, driven exactly as the runtime drives it, a bot with its own plugin folder registered exactly 2 roots (own + shared) and listed `qa-owned-only` and `qa-shared` enabled in the same real thread-start process; a second bot with no own folder registered the shared root alone and did not list the other bot's skill; a synthetic owner skill was `enabled=false` in all 3 real sessions while the owner's `skills.config` still disables its exact path; the kill switch gave 0 extra roots, 0 enabled fixtures and 0 registration logs on a real session that still started and replied; the BOM fixture is refused and reported in `skills/list.errors` (`missing YAML frontmatter delimited by ---`) while the other skills still load; 390x844 dark quick regression clean; live untouched. On naming: the installed skill's own frontmatter `name` is `agent-browser`, while `skills/list` namespaces it as `qa-bot:agent-browser` under the bot's plugin; the two names are the same bot-owned path. Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-16652/delta/README.md` (`results.json`, `catalogues-on.ndjson`, `focused-tests.log`, `live-before/after.json`).
- Gate evidence (builder, unchanged): PASS at `b974ded4722d` - 2699 server tests, 2626 web tests, 247 PowerShell checks, tsc 0/0, e2e 12/12 on the staged artifact; `dist/bin.mjs` sha256 `190d4fa61fafa9c0697276eae13771fe5ff87939939d4da358de5881c2e9cc2c`. The live check (a real Codex bot session on the live server logging one `Codex extra skill roots registered` line) is the last QA check below, after this release is live.

**Follow-ups (neither is a blocker for this release, both outside its changed code):**

- **BOM-prefixed skill files.** Codex's frontmatter parser refuses a `SKILL.md` that starts with a UTF-8 BOM (`missing YAML frontmatter delimited by ---`), and that refusal is reported only inside `skills/list`'s `errors` array, which hbots does not inspect: the session logs its successful registration and the bot silently loses that one skill. All four installed `agent-browser/SKILL.md` files carried a BOM and were stripped by hand on 15 Oct (unchanged body). A re-install brings it back. A later change could normalise a BOM at install or surface `skills/list` errors as one WARN. Location to know: `CodexSessionRuntime.ts:795` logs the registration success only.
- **Red provider test, pre-existing.** `apps/server/src/provider/Layers/ProviderRegistry.test.ts` - `closes the app-server probe scope when provider status times out` fails on this release and on the live notes commit `525daec605` (assert at line 575: the kill callback ran 0 times, expected 1). It is outside the release gate's paths (`vp test run src/personal src/mcp` in `apps/server`), which is why the gates are green. Not caused by this release; a follow-up for whoever owns the provider tests.

Staged release: `b974ded4722d` (`dist/bin.mjs` sha256 in the Gate evidence section), branch `perf/hbots-commit-pauses`, based on live notes `525daec605` (1.66.51). No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5`. Code commits `03c2e748bd` (SQLite checkpoints) and `d4bf5da25c` (Codex bot skills, folded in after the first stage `de81b5740839`, which was then re-staged as this release); this release adds only the version bump and these notes.

## The problem

Live logs 10-15 Oct: 397 SQLite COMMIT stalls of 1 s or more on the main thread. 155 of them had no other slow statement within 60 s (median 1.7 s, max 25.5 s).

hbots runs WAL with synchronous NORMAL, so a normal COMMIT only appends to the `-wal` file and never waits for the disk. The disk waits come from checkpoints: with SQLite's default `wal_autocheckpoint=1000`, the COMMIT that takes the WAL past 1000 frames runs the checkpoint itself. That is a WAL sync, up to 64 MB of page writes into the 3.3 GB database and a database sync, all on the main thread. On a busy disk that is the multi-second COMMIT.

Bench on a copy of backup 20261015-173457 (real `orchestration_events` and `orchestration_command_receipts` writes): commits that ran a checkpoint had a median of 22 ms against 6 ms for plain commits, and every one of the worst commits (125-377 ms) was a checkpoint.

## The change

- After migrations, a worker thread opens its own connection to the same database (same `synchronous` setting) and runs `PRAGMA wal_checkpoint(PASSIVE)`. Only once it reports ready does the main connection set `wal_autocheckpoint=0`.
- Trigger: the same as SQLite's own, 1000 WAL frames not yet copied into the database, read once a second from the wal-index header in `-shm`. Up to 4 quick follow-up passes drain frames written during a sync, so a steady writer still lets the WAL restart.
- PASSIVE only: the worker never takes the write lock and never blocks the writer or a backup reader.
- Fallback: if the worker fails to start (5 s), exits or errors, the main connection gets `wal_autocheckpoint=1000` back with one WARN: `SQLite checkpoint worker unavailable; restored main-thread auto-checkpoints`. A Node build whose SQLite has the concurrent WAL-reset bug (before 3.44.6 / 3.50.7 / 3.51.3; live Node has 3.53.1) never starts the worker.
- A background checkpoint of 1 s or more logs one WARN `SQLite background checkpoint` (off the main thread, so it is not a stall).
- Durability unchanged: `synchronous` stays NORMAL (FULL with `T3CODE_SQLITE_SYNCHRONOUS=full`, which the worker follows), nothing set to OFF.

Files: `apps/server/src/persistence/sqliteCheckpointWorker.ts` (new), `apps/server/src/persistence/Layers/Sqlite.ts`, and their tests.

## Numbers (main-thread COMMIT, ms)

Same load per pair, runs interleaved, bench at CPU BelowNormal / I/O Very Low while the live server ran.

| Run                                 | Mode      | p50       | p95         | p99          | max          | WAL restarts on main thread |
| ----------------------------------- | --------- | --------- | ----------- | ------------ | ------------ | --------------------------- |
| quiet 1 (3500 commits)              | old / new | 6.2 / 6.3 | 10.2 / 10.3 | 22.6 / 21.4  | 136.5 / 58.4 | 39 / 16                     |
| quiet 2                             | old / new | 4.8 / 5.8 | 19.1 / 20.2 | 35.4 / 37.2  | 377.4 / 85.2 | 39 / 16                     |
| contended c1 (2000, 32 MB/s writer) | old / new | 6.7 / 6.7 | 18.7 / 12.6 | 295.6 / 24.3 | 931.6 / 54.9 | 16 / 7                      |
| contended c2                        | old / new | 6.6 / 6.7 | 12.7 / 11.4 | 23.6 / 24.2  | 134.2 / 60.9 | 16 / 8                      |
| contended c3                        | old / new | 6.7 / 6.7 | 14.9 / 11.7 | 24.2 / 24.7  | 140.7 / 47.4 | 16 / 7                      |
| slow (120 at 2/s)                   | old / new | 8.3 / 9.0 |             |              | 21.4 / 21.3  | 1 / 1                       |

p50 and p95 do not move (only about 1% of commits checkpoint). The worst commit drops 2-6x and no checkpoint work runs on the main thread any more. WAL stays bounded: 4 MB in steady state, grows only while a reader pins it (64-89 MB in the bench, 13.4 MB during a real backup), then is cut back to the 32 MB `journal_size_limit`. The live multi-second regime was not reproduced (the laptop's safe disk-stress ceiling with the live server running was 32 MB/s); the claim is that the part removed is exactly the part that waits for the disk. What stays on the main thread: the WAL-header sync when a commit restarts the WAL, and plain reads and appends when the disk is saturated.

Found and fixed before commit: a first version triggered on WAL file size, which never shrinks, and at 2 commits/s caused 12 main-thread WAL restarts against 1. The shipped trigger reads the wal-index header; a test covers it.

## Safety proof (builder)

- Crash-kill (`crash.json`): SIGKILL at a random point after 933-2937 acknowledged commits, 7 runs (5 worker NORMAL, worker FULL, legacy). Every acknowledged commit recovered, ids contiguous, `quick_check` ok each time.
- Backup under load (`backup-load.json`, `backup-integrity.json`): `scripts/personal/sqlite-snapshot.cjs` on the 3.3 GB copy while writing 10 commits/s with the worker on. Snapshot 96.5 s, full `integrity_check` ok, 0 restarts, migration 108.
- No live database was opened. The production copy in `%TEMP%` was deleted after the runs (no junctions).
- Staged artifact `de81b5740839` (the first stage; the fold-in is re-gated below and the release e2e runs on the final artifact) on a throwaway root (`throwaway-server.ps1`, stopped and deleted after): boot with no `checkpoint worker unavailable` WARN and 0 ERROR. A probe wrote 3,133 WAL frames from its own connection with auto-checkpoint off, so only the server's worker could copy them in: the WAL restarted at frame 4 (the file stayed 26.6 MB, reused in place) and the worker backfilled all 3,137 frames within 5.5 s in one 4.3 s pass, logged as `SQLite background checkpoint`; no main-thread stall in that window (`staged-worker-probe-2.json`, `staged-throwaway-server.log`). An earlier pass on the same root took 77 s for a 27 MB WAL while the disk was busy just after the gates (the TEMP root, unlike the live DB, has no Defender exclusion; not verified as the cause); it ran off the main thread, and the server logged no slow SQL statement in that time. Boot itself logged one 2.0 s COMMIT on the fresh root during start-up, before or around the worker's start; not attributed. QA: on a TEMP throwaway root, expect slow background checkpoints and allow up to about 90 s for the WAL check.

Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-commit-pauses/` (`REPORT.md`, raw per-commit JSON, bench and crash scripts, live log classification `live-commits.json`, `wal-timeline.txt`).

## Codex bots see their own plugin skills (folded in after the first stage)

Astra's review (`qa/agent-browser-astra-review/`, P1) found the agent-browser rollout
incomplete: a personal Codex bot got no skills at all. The adapter turns the owner's
`~/.codex/skills` and `~/.agents/skills` off for a bot (`skills.config=[{path=...,enabled=false}]`)
and Codex has no config key for another root, so QA and Optimizer (both on Codex) never
saw `agent-browser`, while the Claude and DeepSeek bots did.

- `apps/server/src/provider/botPluginSkillRoots.ts` (new): the skill folders a bot's own
  plugins declare, the shared folder (`bot-plugins/_shared/`) then the bot's own
  (`bot-plugins/<botId>/`), read from the same manifest field DeepSeek uses. Only folders
  that exist are named, and an unknown or unsafe bot id gets the shared folder alone, so no
  bot can reach another bot's skills.
- `CodexAdapter` resolves them for a personal bot and passes them as `extraSkillRoots` on
  the session. `CodexSessionRuntime` names them with the app-server's own
  `skills/extraRoots/set` (in-memory, per process, absolute paths) right after `initialize`
  and before `thread/start`, so the session's catalogue has them. A refusal logs one WARN
  (`Codex refused this bot's own skill roots; its plugin skills will be missing.`) and the
  session still runs, with the skills missing: today's behaviour, never a broken session.
  Success logs one INFO line naming the roots.
- The owner's own skill roots stay turned off, unchanged, and a normal (non-bot) Codex
  session is untouched: no extra roots, no `skills.config` entry.
- `DshAcpSupport` now imports the shared manifest reader and the exported bot id pattern
  instead of keeping its own copies. No DeepSeek behaviour changed (its test still passes).

Blocker found in the real install: all four installed `agent-browser/SKILL.md` files began
with a UTF-8 BOM. Claude Code tolerates it; Codex's frontmatter parser refuses the file
(`missing YAML frontmatter delimited by ---`), so wiring the root alone would still have
left QA and Optimizer without the skill. The BOM was stripped from the four files (QA
`02ac9a2b`, Backend `247ca831`, Optimizer `bot-6238bcf0`, Frontend `df17a657`); the body is
byte-identical (sha256 before and after). That fix is outside the repo: whoever installs a
skill with a BOM brings it back, and Codex will refuse that one skill again.

Real proof (`C:/Users/Ht/.personal-bots/qa/hbots-codex-bot-skills/`): the shipped resolver
run for the real Optimizer and QA bot ids over the real plugin root, then the real `codex`
0.162.1 app-server driven exactly as the runtime drives it (`initialize` /
`skills/extraRoots/set` / `skills/list`) with a scratch `CODEX_HOME`, so nothing the owner
has installed can be what shows up and nothing is written to the real one. Before the call
neither bot's skill is listed (and the agent-browser file still carried its BOM in the first
run: `missing YAML frontmatter delimited by ---`); after it, `optimizer-bot:agent-browser`
and `qa-bot:agent-browser` are listed with no errors (`optimizer-skills-list.txt`,
`qa-skills-list.txt`). A throwaway hbots root was not used for a live Codex session: it
gives Codex its own account-less home on purpose, and without an account Codex lists no
models, so a Codex bot cannot exist there at all (the adapter and runtime plumbing is
covered by the unit tests below, and the release's own e2e runs on the staged artifact).

## Kill switch

`T3CODE_SQLITE_CHECKPOINT_WORKER=off` (also `0`/`false`/`no`/`disabled`): no worker; the main connection keeps `wal_autocheckpoint=1000`, the old behaviour. Read at server start, so the usual idle restart applies it. In the app sheet's env table from 1.66.52.

`PERSONAL_BOT_CODEX_SKILLS=off` (also `0`/`false`/`no`/`disabled`): a Codex bot's session names no extra skill roots, so it has no skills at all, as before this change. Read when a bot session starts, so no restart is needed to flip it. In the app sheet's env table from 1.66.52.

## QA checks

- [ ] Boot: the staged release starts on a throwaway root; server log has no `SQLite checkpoint worker unavailable` WARN and no ERROR.
- [ ] Checkpoints happen: during a few thousand writes (chats, delegated tasks), sample the throwaway root's `state.sqlite-wal` size every few seconds; it stays bounded (32 MB or less once no reader pins it, not growing without limit), and the database file's modified time keeps moving (pages are being copied in).
- [ ] Crash-kill: kill the throwaway server's PID mid-write; on restart every message or task that was acknowledged before the kill is still there, `PRAGMA quick_check` ok.
- [ ] Backup under load: `backup.ps1` (or `sqlite-snapshot.cjs`) on the throwaway root while a bot is writing succeeds, and the backup passes `integrity_check`.
- [ ] Kill switch: with `T3CODE_SQLITE_CHECKPOINT_WORKER=off` the server boots with no ERROR and the same write load keeps the WAL bounded the same way (the main connection checkpoints again). The pragma itself is covered by the unit test `keeps legacy auto-checkpoints when the worker kill switch is set`.
- [ ] Codex bot skills (the delta): the new tests pass (`CodexSessionRuntime.test.ts` -t "extra skill roots", `CodexAdapter.test.ts` -t "bot plugin skills", `codexLaunchArgs.test.ts` -t "personalBotCodexSkillsSwitchOn"), and the real-binary probe in `qa/hbots-codex-bot-skills/` re-run for `02ac9a2b-b042-496b-ba67-41a37907b2e2` still lists `qa-bot:agent-browser|user` with no errors.
- [ ] Codex bot skills, live (the real end-to-end, only possible with an account): once this release is live, the QA bot's own next chat is a Codex session; the live server log must hold one `Codex extra skill roots registered` line naming `bot-plugins/02ac9a2b-b042-496b-ba67-41a37907b2e2/.claude/skills` and `bot-plugins/_shared/.claude/skills`, and no `Codex refused this bot's own skill roots` WARN.
- [ ] Codex bot skills, kill switch: `PERSONAL_BOT_CODEX_SKILLS=off` on a throwaway root starts the server with no ERROR, and a Codex session logs neither the registration line nor the refusal WARN.
- [ ] No regression: a normal (non-bot) Codex session's app-server args carry no `skills.config` and no extra roots; Claude and DeepSeek bots still load the same skills as before (Claude/DSH tests pass).
- [ ] Quick regression at 390 x 844 dark: Bots list, open a chat, send a message, delegate a task.

## Gate evidence

<!-- gate-evidence:begin sha=b974ded4722df321297cac471f52c1fac126db0a release=b974ded4722d json-sha256=a16323528f983071cb2423c108eba8895c6e6dffaa9d42d75f8d9cdba5cd6563 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T19:36:18Z. Version 1.66.52, release `b974ded4722d`, commit `b974ded4722df321297cac471f52c1fac126db0a` on `perf/hbots-commit-pauses`, working tree clean, result **PASS**.

Machine-readable copy: `releases\b974ded4722d\gate-evidence.json` (sha256 `a16323528f983071cb2423c108eba8895c6e6dffaa9d42d75f8d9cdba5cd6563`) and the full gate logs in `releases\b974ded4722d\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2699 tests passed, 0 failed, 3 skipped, in 194 files | 281.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 48      |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2626 tests passed, 0 failed, 0 skipped, in 238 files | 38.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 1.3     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 90.9    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-freeze-1\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\b974ded4722d" -Json` (in `.`)                                                                                                                  | 0    | pass: 12/12 journeys passed                                | 311.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `b974ded4722df321297cac471f52c1fac126db0a`, at end `b974ded4722df321297cac471f52c1fac126db0a`; tracked files modified: none. Staged release: version 1.66.52, sha b974ded4722d, dirty False, externals copied; `dist/bin.mjs` sha256 `190d4fa61fafa9c0697276eae13771fe5ff87939939d4da358de5881c2e9cc2c`.
<!-- gate-evidence:end -->
