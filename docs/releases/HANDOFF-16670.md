# HANDOFF 1.66.70

SQLite no longer runs on the server's main thread. One worker thread owns one
`node:sqlite` connection and runs every prepare/execute/transaction/close in
strict arrival order; the main thread only sends statements and copies results.
`T3CODE_SQLITE_WORKER=off` restores the previous in-thread bridge exactly, read
once at server start. No schema change and no migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5. Staged only; nothing is activated.

Branch `release/hbots-16670`, cut from `personal-bots/main` `a99d8a68e9` (the
docs commit after live 1.66.69 `9bb580cc2975`). Code commits `81165e135d` (the
worker), `2e81b53101` (test timing) and `b141113faa` (lint only); staged release
`b141113faa0d` (version 1.66.70, externals copied). The measurement below ran on
`81165e135d80`, the same server code without those test and lint changes.

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
thread used to lose. The measured bundle and `b141113faa0d`'s `dist/bin.mjs`
are byte-identical (sha256
`77e50425a12ad20fe04f65220adb62807f480a60509104bfae9606623e204e27`), so the
numbers apply to the staged release exactly. Evidence:
`qa/hbots-sqlite-worker-20261018/SUMMARY.md` (raw `before.json` / `after.json`).

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

## Gate evidence

<!-- gate-evidence:begin sha=b141113faa0d3a63ab1d7b6d46f1852c9c0235e6 release=b141113faa0d json-sha256=9e8fc652b867677c3690a1cd8b97fefb8d632f733c78f4db83bdf7bfd07f9ff1 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-18T01:58:52Z. Version 1.66.70, release `b141113faa0d`, commit `b141113faa0d3a63ab1d7b6d46f1852c9c0235e6` on `release/hbots-16670`, working tree clean, result **PASS**.

Machine-readable copy: `releases\b141113faa0d\gate-evidence.json` (sha256 `9e8fc652b867677c3690a1cd8b97fefb8d632f733c78f4db83bdf7bfd07f9ff1`) and the full gate logs in `releases\b141113faa0d\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2933 tests passed, 0 failed, 4 skipped, in 211 files | 402.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 42.6    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2879 tests passed, 0 failed, 0 skipped, in 257 files | 37.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 6.5     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 275 checks ok, 0 failed                              | 68.9    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16670\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\b141113faa0d" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 279.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `839bef10985c88a8394cc33b84a15ac5eec6501f`, at end `839bef10985c88a8394cc33b84a15ac5eec6501f`; tracked files modified: none. Staged release: version 1.66.70, sha b141113faa0d, dirty False, externals copied; `dist/bin.mjs` sha256 `77e50425a12ad20fe04f65220adb62807f480a60509104bfae9606623e204e27`.
<!-- gate-evidence:end -->
