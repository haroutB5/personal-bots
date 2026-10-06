# hbots 1.60.37: event loop stall recorder, and SQLite no longer fsyncs every commit

Branch `perf/event-loop-stalls` (from `personal-bots/main` 5bee110329 = 1.60.36). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5.

## What blocks the loop (shown, not guessed)

The server runs SQLite (`node:sqlite`) and its log appends **synchronously on the main thread**, so any wait on the disk is a wait of the whole event loop.

Live evidence, 4 Oct 12:09 (a real stall, 2943 ms in the 30 s monitor, `utilization` 0.32, CPU 3.4 s in the 30 s window, so most of the "active" time was waiting): in `server.trace.ndjson` a single `sql.transaction` span ran 3873 ms (12:08:51.452 to 12:08:55.326, inside `orchestration.command.thread.message.reasoning.delta`) with **no child span ending in between**, i.e. the time was spent inside the final `COMMIT`. At the same time a `vp i` (7 min, thousands of small files, Defender scanning them) was running on the laptop. In the same 6-minute window 69 `sql.*` spans were over 120 ms (up to 3.9 s, five over 1.7 s); in the 20 minutes after the install ended there were none.

Reproduction on a throwaway root: schema from a throwaway server, seeded with the live database's shape (1.7 GB: 317k events + receipts, 184k activities, 28k messages, 733 threads, 672 bindings, 797 tasks; synthetic rows, no real content), a writer that does one streamed delta per transaction (event + receipt + activity + thread update, 20 per second) and 8 parallel small-file writers as the disk load.

| Seeded root, 30 s runs under disk load           | before (FULL)                                     | after (NORMAL)                             |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------ |
| time the loop was blocked in COMMIT, runs 1 to 4 | 3.4, 3.8, 7.0, 7.9 s                              | 0.3, 0.4, 3.9, 2.5 s (median 5.4 to 1.4 s) |
| commits over 100 ms                              | 9, 10, 9, 28                                      | 1, 2, 3, 10                                |
| same test on a 10 MB scratch database, 5 pairs   | median 5.9 s blocked, a commit over 1 s in 5 of 5 | median 1.7 s, a commit over 1 s in 1 of 5  |

Honest limit: the whole transaction (including the INSERT statements, which read cold index pages of a 1.7 GB database) improves much less under heavy load (blocked 13.9, 18.5, 9.2 s before; 12.3, 12.8, 7.3 s after, 11 to 31 %). The remaining stalls are cold-page reads and WAL appends, not the commit sync. A larger SQLite page cache and moving WAL checkpoints to a worker thread were measured and are **not** in this release: the checkpoint worker removed the 200 to 300 ms commits that the inline checkpoint costs on the big database (10 per 30 s to 0 when idle), but the full-transaction numbers did not clearly improve, so it is a candidate for once the recorder has real data.

## The four stalls of 3 Oct

The stall log line is written by a sampler that ticks every 30 s, so the stall happened in the 30 s before the line. The trace files of 3 Oct had already rotated away (10 files of 10 MB cover about 30 min to 2 h), so the monitor's CPU/utilisation attributes for these four are gone.

- **14:46:40, 2569 ms.** Not determined. The log is silent from 14:45:16 (a prewarm) to 14:46:40; no sweep ran in the window (archive sweeps at 14:42:41 and 14:47:41). The 19.8 s `j3-first` at 14:45:05 ended 95 s earlier and is not in the window. Most likely the same disk-wait class as 12:09, unproven.
- **16:29:25, 4742 ms.** Not determined. Window 16:28:55 to 16:29:25 is silent; the reaper ran at 16:25:27 (it reaped 1 of 634 bindings, with one projection read per idle binding) and the archive sweep at 16:25:25 and 16:30:25, none overlapping.
- **20:45:29.449, 2261 ms.** The archive sweep is **not** the cause. The monitor sampler and the sweep both started within about 0.1 s at startup and tick together (sampler every 30 s, sweep every 5 min, both phase-locked: 20:45:29.449 vs 20:45:29.514, and 20:50:29.638 vs 20:51:29.631), so the sweep always logs right after a tick. The sweep's candidate query takes 4.7 to 7 ms on the live database (78 candidates, covered by indexes), the busy-chat check 0.3 ms.
- **20:51:29.631, 11,440 ms.** Window reconstructed from the log: cloudflared logged the origin connection reset at 20:51:13/14 and the bot's preview `navigate` (started 20:51:09.8) timed out after its 15 s at 20:51:24.841, so the loop was blocked from about 20:51:13.4 to 20:51:24.8. The `PreviewAutomationNoAvailableHostError` burst, "re-registering with the preview broker" and `stopped-script` are consequences: the host's connection to the broker dropped during the stall, and the timed-out operation then ran the unstick probe, which stopped a script on a page that was fine. The cause of the stall itself is not provable from what is left. (Side finding: a server stall can make `unstick` stop a healthy page's script; not changed here.)

## What changed

- **Stall recorder (always on).** A worker thread watches a heartbeat the main thread writes. When the main thread has not run for 1 s it reads the main thread's CPU profile through the inspector (V8's sampler keeps sampling while the main thread is blocked, inside a native SQLite call too, and attributes the samples to the JavaScript frame that called it) and joins it with notes the main thread keeps: named jobs (the 18 periodic sweeps and every unary RPC, `withStallJob`), SQLite statements and log writes that blocked for 100 ms or more (SQL with its literals masked, file base names), garbage collections of 50 ms or more, CPU time against wall time. One WARN line per stall, `event loop stall captured`, with the likely cause, the jobs, the slow calls and the top frame, plus one JSON file (about 2 to 5 KB, capped at 64 KB, 20 kept) in `<root>\..\logs\stalls` (the launcher sets `T3CODE_PERSONAL_STALL_DIR` to `%USERPROFILE%\.personal-bots\logs\stalls`). Labels and numbers only: no page content, chat text, ids or secrets.
- Cause kinds: `sqlite-statement`, `file-write`, `garbage-collection`, `javascript`, `process-paused` (CPU far below wall time: starved or paused by the OS, or waiting on disk) and `unknown`.
- **Cost, measured:** about +0.3 % of one core at the default 50 ms sampling (+1 % at 20 ms), no change in a mixed JSON/regex workload.
- **SQLite `synchronous=NORMAL`** (WAL): no fsync per commit, only at checkpoints. A server crash loses nothing either way; a power cut or OS crash can lose the last commits, the database stays consistent.
- Real server check: in a throwaway server the recorder reported an injected 3 s JavaScript block as `injectedJsBlock`, an injected 9 s native SQLite call as `get`, and, unprompted, a 1.9 s cold read at startup as the exact statement, a `COMMIT` that took 895 ms and an INSERT that took 664 ms.

## Kill switches (apply with the usual idle restart)

| Setting                                | Effect                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `T3CODE_STALL_RECORDER=off`            | no watchdog, no notes, no GC observer                                                             |
| `T3CODE_STALL_PROFILER=detect` / `off` | profile only when a stall starts (does not name functions that were already running) / no profile |
| `T3CODE_STALL_SAMPLE_US=20000`         | sampling interval (5,000 to 200,000, default 50,000)                                              |
| `T3CODE_PERSONAL_STALL_DIR=<dir>`      | where the JSON reports go                                                                         |
| `T3CODE_SQLITE_SYNCHRONOUS=full`       | back to fsync on every commit                                                                     |

## Reading a stall

`Select-String 'event loop stall captured' -Context 0,14 C:\Users\Ht\.personal-bots\logs\server-<date>.log`, then the file named in the `file` field. `cause.kind` says what to look at; `ops` has the slow statements (SQL with literals masked) and log writes with their offset into the stall; `profile.topSelf` and `topStacks` the hot frames; `cpu` against `wallMs` says CPU-bound or waiting.

## Not changed on purpose

- Cold-page reads and WAL appends on a busy disk (see the limit above): next candidates are a bigger page cache, WAL checkpoints on a worker thread, and async trace/log appends (under the same disk load `appendFileSync` of 20 KB took p95 150 ms, p99 250 ms, max 760 ms). Decide from the recorder's first real reports.
- Startup runs `listActivitiesByKind` (worktree setup reconcile): 1.6 s cold on the live database, 0.15 s warm; it blocks the loop at every restart.
- The trace files (10 x 10 MB) rotate every 30 min to 2 h; the monitor's stall spans are lost long before anyone looks. The new JSON reports are kept separately.
