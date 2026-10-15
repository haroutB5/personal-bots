# hbots 1.66.52: SQLite checkpoints off the main thread

PROOF_PLACEHOLDER: QA result on this exact staged artifact goes here.

Staged release: `de81b5740839` (`dist/bin.mjs` sha256 in the Gate evidence section), branch `perf/hbots-commit-pauses`, based on live notes `525daec605` (1.66.51). No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5`. Code commit `03c2e748bd`; this release adds only the version bump and these notes.

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
- Staged artifact `de81b5740839` on a throwaway root (`throwaway-server.ps1`, stopped and deleted after): boot with no `checkpoint worker unavailable` WARN and 0 ERROR. A probe wrote 3,133 WAL frames from its own connection with auto-checkpoint off, so only the server's worker could copy them in: the WAL restarted at frame 4 (the file stayed 26.6 MB, reused in place) and the worker backfilled all 3,137 frames within 5.5 s in one 4.3 s pass, logged as `SQLite background checkpoint`; no main-thread stall in that window (`staged-worker-probe-2.json`, `staged-throwaway-server.log`). An earlier pass on the same root took 77 s for a 27 MB WAL while the disk was busy just after the gates (the TEMP root, unlike the live DB, has no Defender exclusion; not verified as the cause); it ran off the main thread, and the server logged no slow SQL statement in that time. Boot itself logged one 2.0 s COMMIT on the fresh root during start-up, before or around the worker's start; not attributed. QA: on a TEMP throwaway root, expect slow background checkpoints and allow up to about 90 s for the WAL check.

Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-commit-pauses/` (`REPORT.md`, raw per-commit JSON, bench and crash scripts, live log classification `live-commits.json`, `wal-timeline.txt`).

## Kill switch

`T3CODE_SQLITE_CHECKPOINT_WORKER=off` (also `0`/`false`/`no`/`disabled`): no worker; the main connection keeps `wal_autocheckpoint=1000`, the old behaviour. Read at server start, so the usual idle restart applies it. In the app sheet's env table from 1.66.52.

## QA checks

- [ ] Boot: the staged release starts on a throwaway root; server log has no `SQLite checkpoint worker unavailable` WARN and no ERROR.
- [ ] Checkpoints happen: during a few thousand writes (chats, delegated tasks), sample the throwaway root's `state.sqlite-wal` size every few seconds; it stays bounded (32 MB or less once no reader pins it, not growing without limit), and the database file's modified time keeps moving (pages are being copied in).
- [ ] Crash-kill: kill the throwaway server's PID mid-write; on restart every message or task that was acknowledged before the kill is still there, `PRAGMA quick_check` ok.
- [ ] Backup under load: `backup.ps1` (or `sqlite-snapshot.cjs`) on the throwaway root while a bot is writing succeeds, and the backup passes `integrity_check`.
- [ ] Kill switch: with `T3CODE_SQLITE_CHECKPOINT_WORKER=off` the server boots with no ERROR and the same write load keeps the WAL bounded the same way (the main connection checkpoints again). The pragma itself is covered by the unit test `keeps legacy auto-checkpoints when the worker kill switch is set`.
- [ ] Quick regression at 390 x 844 dark: Bots list, open a chat, send a message, delegate a task.

## Gate evidence

<!-- gate-evidence:begin sha=de81b5740839c9b35405aaf346410502d4077a4a release=de81b5740839 json-sha256=44d01eba6b52cbf2d5a889c3b43abedd016ee8378e7d100a0ccf54bd45d609e6 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T17:59:14Z. Version 1.66.52, release `de81b5740839`, commit `de81b5740839c9b35405aaf346410502d4077a4a` on `perf/hbots-commit-pauses`, working tree clean, result **PASS**.

Machine-readable copy: `releases\de81b5740839\gate-evidence.json` (sha256 `44d01eba6b52cbf2d5a889c3b43abedd016ee8378e7d100a0ccf54bd45d609e6`) and the full gate logs in `releases\de81b5740839\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2699 tests passed, 0 failed, 3 skipped, in 194 files | 272.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 42.5    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2626 tests passed, 0 failed, 0 skipped, in 238 files | 34.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 5.7     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 66.2    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-freeze-1\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\de81b5740839" -Json` (in `.`)                                                                                                                  | 0    | pass: 12/12 journeys passed                                | 291.9   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `de81b5740839c9b35405aaf346410502d4077a4a`, at end `de81b5740839c9b35405aaf346410502d4077a4a`; tracked files modified: none. Staged release: version 1.66.52, sha de81b5740839, dirty False, externals copied; `dist/bin.mjs` sha256 `ccbe5009683ceac6d2b1f4ed4bd8beba89487199f849f0b46e8e821f4f324c19`.
<!-- gate-evidence:end -->
