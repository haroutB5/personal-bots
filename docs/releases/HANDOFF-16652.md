# hbots 1.66.52: SQLite checkpoints off the main thread

PROOF_PLACEHOLDER: QA result on this exact staged artifact goes here.

Staged release: see the Gate evidence section below, branch `perf/hbots-commit-pauses`, based on live notes `525daec605` (1.66.51). No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5`. Code commit `03c2e748bd`; this release adds only the version bump and these notes.

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
