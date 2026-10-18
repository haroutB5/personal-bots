# HANDOFF 1.66.70

SQLite no longer runs on the server's main thread. One worker thread owns one
`node:sqlite` connection and runs every prepare/execute/transaction/close in
strict arrival order; the main thread only sends statements and copies results.
`T3CODE_SQLITE_WORKER=off` restores the previous in-thread bridge exactly, read
once at server start. No schema change and no migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5. Staged only; nothing is activated.

Branch `release/hbots-16670`, cut from `personal-bots/main` `a99d8a68e9` (the
docs commit after live 1.66.69 `9bb580cc2975`). Code commits `81165e135d` (the
worker) and `2e81b53101` (a test-timing fix only); staged release `2e81b53101ce`
(version 1.66.70, externals copied). The measurement below ran on
`81165e135d80`, the same server code without that test-file change.

## 1. One serialized worker

**Why.** The 17 Oct session-freeze investigation classified 1,091 captures over
1 s in seven days as synchronous SQLite, including one eight-row memory SELECT
that held the loop for 4.55 s while the disk was busy
(`qa/hbots-session-freeze-20261017/RESULT.md`). Awaiting the Effect did not move
the synchronous `StatementSync.all/run` off the server thread.

**What moved** (`packages/shared/src/nodeSqliteWorker.ts`,
`packages/shared/src/nodeSqliteClient.ts`):

- The connection is opened, used and closed in the worker. The main thread has
  no `DatabaseSync` at all in worker mode.
- The worker answers its message queue in arrival order and executes each
  statement synchronously, so no other statement can run between a
  transaction's BEGIN and its COMMIT/ROLLBACK. The existing single-permit
  semaphore and transaction reservation are unchanged.
- One RPC runs one statement with its prepare, `setReadBigInts` /
  `setReturnArrays` handling and result mode, so prepared-statement caching
  stays inside the worker (same 200 capacity and 10 minute TTL, failures not
  cached).
- `executeRaw` keeps returning the driver's `run()` result when the statement
  returns no rows; `executeValues` still returns positional arrays; blobs,
  BigInts and row transforms go through structured clone unchanged.
- Errors are rebuilt on the caller side with `message`, `code`, `errcode`,
  `errstr` and `stack`, then classified exactly as before: a unique violation
  is still `UniqueViolation` with `constraint` set, a busy writer still
  `LockTimeoutError`.
- Startup migrations, the checkpoint worker (`T3CODE_SQLITE_CHECKPOINT_WORKER`)
  and the separate `backup.ps1` / `sqlite-snapshot.cjs` / `release-db-check.cjs`
  processes are unaffected: the checkpoint worker already had its own
  connection and the tools are separate processes.
- `Sqlite.ts` logs one startup line, `SQLite connection mode: worker` or
  `inline`, so the live mode is visible in the release log.

**Cancellation.** Interrupting an effect stops waiting only. The statement
already sent still finishes in the worker (as a synchronous call could not be
interrupted before it returned), and a later request keeps its order behind it.
An abandoned request's late success or failure is dropped without being
mistaken for a dead worker. BEGIN/COMMIT/ROLLBACK run inside the existing
uninterruptible transaction wrapper: a cancelled body rolls back before the
connection is reused, and a commit is never cut short by interruption. Worker
death rejects every pending request and every later one; nothing is retried,
because a request that died around a commit has an unknown outcome.

## 2. Measurement

Throwaway servers, fake CLI, schedulers off, a copy of the 3.55 GB backup
`20261018-011051` (2,588 memory entries), 5 concurrent fake sessions plus 5
parallel `personalMemory.search` clients, and 4 random readers over the backup
to recreate the busy-disk condition. Event-loop delay came from
`monitorEventLoopDelay` on the server's main thread only; `/version.txt` was
pinged every 25 ms. Three rounds each; worst of three:

| 1.66.69 main-thread SQLite     | 1.66.70 worker                |
| ------------------------------ | ----------------------------- |
| ELD p99 401.9 ms, max 539.5 ms | ELD p99 48.8 ms, max 174.5 ms |
| external ping max 1,547 ms     | external ping max 153 ms      |
| memory-search RPC max 1,939 ms | memory-search RPC max 256 ms  |

The worker run keeps a ~40-50 ms p99 from IPC and result copying; the
hundreds-of-ms to seconds disk stalls are gone. The ~80 histogram samples in
an 8 s before window versus ~450 after show how much of the loop the main
thread used to lose. Evidence: `qa/hbots-sqlite-worker-20261018/SUMMARY.md`
(raw `before.json` / `after.json`).

## 3. Tests

`packages/shared/src/nodeSqliteWorker.test.ts` (new): strict send order, an
abandoned success and an abandoned failure both leave the worker usable,
worker loss fails visibly, a transaction stays whole against a concurrent
write, an interrupted transaction rolls back before reuse, constraint and
BigInt behaviour, the kill switch and its documented off words. The existing
`nodeSqliteClient.test.ts` (open failure, prepare retry, lock timeout, raw
values) now runs through the worker. Two server tests that used only
`Effect.yieldNow` to wait for database work now wait for a real event-loop
turn, because the outbox and refresh rows genuinely arrive from the worker;
their assertions are unchanged.

## 4. Risks and what QA should focus on

- Transaction ordering and cancellation are the main risk: sends, tasks,
  memory and secrets, a turn cancelled mid-transaction, and a worker that is
  stopped at shutdown.
- Large result sets still cross structured clone on the main thread. Check a
  large memory page and a busy chat list for a responsive UI.
- The release smoke and release-db-check use the same database file through
  separate processes; confirm the live DB opens, migrates nothing and stays
  `integrity_check ok`.
- Kill switch: `T3CODE_SQLITE_WORKER=off` must boot and behave as 1.66.69 did.
