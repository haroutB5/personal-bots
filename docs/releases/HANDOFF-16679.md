# hbots 1.66.79

Risk tier: low (Antigravity usage card only; no credentials, no installer changes). No migration (the maximum stays 111), so the release runner skips the backup. `PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16677`, on top of live 1.66.78 notes commit `732405d80b`.

## Changes

- **Antigravity weekly usage reads right when Gemini is spent.**
  - What happened: on 21 Oct, with the Gemini weekly quota spent until 26 Oct, the Antigravity card showed the 5-hour session at 100% and the weekly at 0% (Harout: "It says 0% used for the weekly").
  - Cause 1: when a model's quota is spent, Google's per-model list leaves `remainingFraction` out (a zero is omitted) and keeps only `resetTime`. hbots skipped those models, fell back to the quota summary, and the summary's Gemini figures read untouched (0% used, reset rolling forward).
  - Cause 2: the quota notice's stated reset ("5 days, 2 hours") was capped at 5 hours before it was classified, so a weekly limit was filed as the 5-hour session.
  - Fix: a Gemini model with a reset but no remaining fraction counts as spent. The per-model figure goes on the weekly window when its reset is more than five hours away, otherwise on the session window. The notice keeps its stated reset to pick the window, and a separate expiry keeps the five-hour trust limit Security asked for in 1.66.77.
  - Live probe through the same requests (numbers only): every Gemini model reported only `resetTime: 2026-10-26T20:56:06Z`; the summary had no Gemini group on the daily host.
  - Tests: spent models read as Weekly 100% with the 26 Oct reset; a near reset stays on the session; a 5-day notice is filed as weekly and stops counting after its five trusted hours. Antigravity usage, driver and provider suites: 143 passed, 32 skipped.

## Risks

- A per-model reset more than five hours out while the 5-hour window binds would show as weekly. The live data shows the per-model reset follows the binding limit, so this matches what the runtime enforces.

## Speed: provider logs in the background, SQLite stall labels (Optimizer, 21 Oct)

Harout, 21 Oct: "Also add the two speed jobs in this release" (database work off the main thread, provider logs written in the background).

### Stall attribution (measured first)

- Per-day stall causes from the live server logs (`event loop stall captured`, top profile frame): main-thread SQLite stalls were 110, 58, 123 and 50 a day on 15-18 Oct (219, 144, 259 and 138 s). From 19 Oct, when the 1.66.70 SQLite worker went live (`SQLite connection mode: worker` at every start since), there were **0**. So job 1 (database off the main thread) was already done and live; this release adds no new database work.
- 19-21 Oct, the largest cause the app can fix: **27 stalls, 94.5 s, synchronous `appendFileSync` on provider `events.<thread>.log` files**, including today's 9462 ms (13:29Z: 9121 ms in `writeBuffer` < `appendFileSync` < `writeBatchedMessages` < `drainPending`, 47 ms CPU over 8855 ms wall, 765 MB free RAM).
- Today's 20 stall reports: 7 provider-log appends (22.0 s: 132900Z 9462, 081927Z 3354, 081902Z 3040, 035955Z 2366, 040010Z 1617, 060042Z 1098, 060039Z 1089), 1 process spawn (100449Z 3564 ms, inside `child_process.spawn`), 12 OS pauses where the profiler saw an idle thread (085352Z 3367, 132931Z 3342, 043951Z 2534, 115402Z 1046 and 8 under 1.6 s: the laptop starving or paging the process, not app code).
- Today's reports blamed SQLite (132900Z "synchronous SQLite statement 10030 ms", 132931Z, 081902Z, 040010Z) because a worker query's round-trip time was still noted as a synchronous statement. That is a diagnostics bug and is fixed below.

### Changes

1. `628f33aa28` fix(stalls): a SQLite worker round trip is noted as `sql-worker` and never picked as a stall's cause (it is still listed). Labels only, no behaviour change, so no kill switch. Test: `stallReport.test.ts` "never blames a statement that ran on the SQLite worker" (the 9462 ms case now classifies as `file-write`).
2. `bf4f744f33` perf(provider): provider event logs are appended in the background, using the trace sink's pattern: `RotatingFileSink.writeAsync`, one write in flight per store, so lines land in order and a file is never rotated under an append. `close()` waits for every queued append. A failed append drops that sink and its later queued batches, as a throwing synchronous write did, with the same WARN at the next flush. Over 32 MiB queued, the oldest whole batches drop with WARN `provider event log writes fell behind the disk; oldest lines dropped`. **Kill switch `T3CODE_PROVIDER_LOG_ASYNC=off`** restores the synchronous append; it is read when a store is created, so at server start.

### Numbers (throwaway temp dirs, never the live root)

Benchmark `qa/hbots-provider-log-async/bench.test.ts.txt`, 2,000 provider events of about 2 KB over 4 threads, 5 runs per cell, medians (raw `bench-raw.json`, summary `bench-summary.json`):

| Case                                    | Max event-loop block, sync (`=off`) | Background (default) |
| --------------------------------------- | ----------------------------------- | -------------------- |
| 200 ms injected disk latency per append | 878 ms (worst 1,189)                | 18 ms (worst 20)     |
| Idle disk                               | 22 ms                               | 20 ms                |

Every run wrote all 2,000 lines. The 18-22 ms floor is the benchmark's own 10 ms timer plus Windows timer granularity.

Real check on the staged release `83fcc2dc34be` (throwaway servers, fake Claude CLI, `scripts/personal/e2e/stall-load.mjs` for 40 s with a streaming fake bot turn; evidence `load-on/`, `load-off/`):

- Default: `SQLite connection mode: worker`; the provider log had 23 lines (11 CANON, 12 NTIVE), 0 malformed, timestamps in order, and no provider-log WARN; 0 load errors.
- `T3CODE_PROVIDER_LOG_ASYNC=off` plus `T3CODE_SQLITE_WORKER=off`: `SQLite connection mode: inline`; the provider log was written through the old synchronous path (14 lines, 0 malformed); 0 load errors. Both kill switches work.
- Unit tests (outside the gate's `src/personal src/mcp` scope, run separately): `EventNdjsonLogger.test.ts` 23/23, run 3 times and again with `=off` for the whole file; `stallReport.test.ts` 12/12. New tests cover the kill switch, ordering across 300 lines and many rotations, close draining, and a failed append followed by a fresh sink.

### Risks and what is left

- If the process dies hard, lines queued behind a slow disk are lost (bounded by the disk delay). The synchronous path already lost up to the 1 s batch window; a normal shutdown drains the queue.
- Opening a new thread's sink (mkdir, prune, stat) and a rotation (renames) stay synchronous. They are rare, and none appeared in the stall reports.
- Not changed, not seen in today's stalls: `dshUsageLedger.ts` appendFileSync, and the Antigravity usage reader's `DatabaseSync` on the main thread.
- OS pauses (12 of today's 20 reports) and the 3.56 s spawn are machine-side or need their own investigation; `T3CODE_SPAWN_WARMUP` covers .exe files of 16 MiB or more.
- Migrations unchanged (max 111). `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Gate evidence

<!-- gate-evidence:begin sha=83fcc2dc34bee5cae717196dd05bb5abf66521f0 release=83fcc2dc34be json-sha256=40e7686219b3862d7cb8933d7aa58e16734d1908de42759a85afcdf5872a5f70 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-21T20:52:25Z. Version 1.66.79, release `83fcc2dc34be`, commit `83fcc2dc34bee5cae717196dd05bb5abf66521f0` on `feat/hbots-16677`, working tree clean, result **PASS**.

Machine-readable copy: `releases\83fcc2dc34be\gate-evidence.json` (sha256 `40e7686219b3862d7cb8933d7aa58e16734d1908de42759a85afcdf5872a5f70`) and the full gate logs in `releases\83fcc2dc34be\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2957 tests passed, 0 failed, 4 skipped, in 215 files | 267     |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 18.5    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3007 tests passed, 0 failed, 0 skipped, in 263 files | 31.9    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 5.1     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 79.3    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\83fcc2dc34be" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 247.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `83fcc2dc34bee5cae717196dd05bb5abf66521f0`, at end `83fcc2dc34bee5cae717196dd05bb5abf66521f0`; tracked files modified: none. Staged release: version 1.66.79, sha 83fcc2dc34be, dirty False, externals copied; `dist/bin.mjs` sha256 `8df550d6c41a74dae4c5a058a7bf1c2dc4240c503984c6218c4bf3ec3b12fc93`.
<!-- gate-evidence:end -->
