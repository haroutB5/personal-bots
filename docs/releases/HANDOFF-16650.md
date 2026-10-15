# hbots 1.66.50: spawn stalls, DeepSeek usage, model labels, no delegation cap

PROOF_PLACEHOLDER: focused risky-tier QA is pending. This is a builder handoff, not clearance to activate.

Staged release: `e57adb66c109`, branch `perf/hbots-spawn-stalls`, based on live notes `543c3b45f2` (1.66.49). No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5`. Build loaded all four public `.env` keys (each value verified present in the staged dist) and copied all runtime externals. The live release pointer remains `9203dde389b7`. This artifact supersedes `5d117de7a5c4` (what QA started on) because Harout asked for one release, not two: the delegation cap removal is merged into 1.66.50 here (branch `feat/hbots-no-delegation-cap`, merge `e57adb66c1`). Against `5d117de7a5c4` the dist has the same 4,944 files, none added or removed: `bin.mjs` and its map change for the cap removal, `client/version.txt` for the release stamp, and three client source maps; every client runtime file is byte-identical (`client=index-CpJczh3Q.js`). Earlier artifacts `ddfcdd1d3fbc`, `aea9d451a354` and `fc938161f8f3` stay superseded. Use only `e57adb66c109`.

## Spawn stalls

Windows checks a newly written/unseen large program image inside synchronous CreateProcessW. A cold CLI launch blocked the event loop for 3.6-5.4 seconds, recurring 16-18 times a day on 10-14 October. The async resolver avoids synchronous PATH/Claude executable stats. Before spawning a Windows .exe >=16 MiB, a worker starts and immediately terminates it so the real launch sees an already-checked image. It rechecks on file change or after five minutes, shares concurrent checks, and fails open. The warming spawner is provided above NodeHttpServer's captured NodeServices; this covers provider probes and Claude SDK session launches.

Accepted spawn head `5f7fa17ccc` remains included. Throwaway server, 22 fresh executable launches each: block median 3808 -> 33 ms, worst 5652 -> 350 ms, stall reports 22 -> 0. Real spawner microbenchmark: median 3717 -> 5.3 ms inside spawn, worst 3785 -> 11.1 ms; stdout and exit codes identical in all 44 launches. Full measurements and call-site table: `C:/Users/Ht/.personal-bots/qa/hbots-spawn-stalls/README.md`.

Switches (server env, normal idle restart): `T3CODE_SPAWN_WARMUP=off`, `T3CODE_SPAWN_ASYNC_RESOLVE=off`.

QA checks:

- [ ] With warm-up enabled, use a fresh large executable copy and confirm launch work moves off the main thread, output/exit unchanged, and no spawn stall.
- [ ] Refresh provider probes across the configured provider types; confirm ready/version/capability results remain correct.
- [ ] Start a Claude session through the real adapter boundary on an isolated root, confirm output, exit and cancellation, and verify the wrapped spawner is used.

## DeepSeek spend pricing

The 15 October 06:09:35 UTC trace attributed 3554 ms to Effect DateTime's UTC conversion inside per-record spend pricing. Peak lookup now uses UTC day/hour arithmetic without constructing calendar objects, and the spend loop yields in eight-millisecond slices. The weekday/windows and pricing arithmetic are unchanged. The shared window helper also supplies the scheduled peak label's deadline.

Isolated, read-only copies of the real Claude-engine transcripts and dsh ledger: 99 files, 193,606,453 bytes, 28,680 raw records, 13,734 after dedupe. Pricing microbenchmark over those records (seven runs): median 35.43 -> 23.39 ms, worst 87.59 -> 47.30 ms. Actual UsageService warm read (seven after the cold read): median 19.28 -> 17.26 ms. All returned the exact same cost `23.21885038199992`, record count and since timestamp; all token totals match. These warm tests did not reproduce the historical multi-second stall, so those traces are not used as an artificial before/after benchmark.

Switch: `T3CODE_DEEPSEEK_PRICING_FAST=off` restores DateTime pricing and the unsliced spend loop. Restart applies the pricing switch.

QA checks:

- [ ] Compare DeepSeek spend and usage totals with the original implementation on the same isolated ledger copy, including peak/off-peak boundaries, duplicates and custom prices.
- [ ] Confirm pricing-switch results are equal; no dropped or double-counted turns.

## DeepSeek transcript parsing

The 15 October 08:02:50 UTC trace attributed 2263 ms to synchronous parseDeepSeekLine. The existing reader already cached offsets; another cache would not protect a cold/replaced file. DeepSeek parses now run on one reusable worker, using that exact byte reader, tail and guard logic. Only usage records cross back. Reads are serialized on the worker, idle memory is released after ten seconds, and worker failure falls back to the original reader. Other provider readers are unchanged. The single-executable upstream packaging retains its inline path; this release is the Node script runtime.

The final built release `5d117de7a5c4` was tested directly, not just source modules: every one of ten scans returned the same 28,680 records and SHA-256 fingerprint. Main-thread JSON.parse calls per full ledger scan: 28,680 -> 0. The historical 2.3-second parse pause did not reproduce on the copied warm ledger. Offloading adds background elapsed time: the actual spend service's first scan was 438 -> 576 ms; repeated forced full scans without the service cache cost more IPC time (final median 420 -> 1331 ms, details in `deepseek-built-worker.json`). Maximum event-loop gaps remained below 20 ms in the measured copied-ledger checks. This is isolation from synchronous parsing, not a claim that file scanning became faster.

Switch: `T3CODE_DEEPSEEK_SCAN_WORKER=off` restores inline parsing, read at each parse. Worker and inline records, unfinished-tail completion, append/resume, rewrite guards, missing files, concurrent reads and large streaming projections have focused tests. No cache format or data migration.

QA checks:

- [ ] On an isolated root, compare worker/inline totals and resume after appended records and a replaced file.
- [ ] Confirm the staged worker entry loads and no main-thread fallback occurs during a normal DeepSeek usage refresh.

## Model labels

Bots rows reserve a non-shrinking sched/peak/fallback marker beside a group containing the bot name and model. The model ellipsises first; names that fit beside the marker stay whole. Extremely long names can still truncate within the available row. Scheduled DeepSeek peak notes now show the earlier of the schedule end and current UTC peak end, formatted in the device's zone.

390 x 844 dark screenshot of the real staged app: `C:/Users/Ht/.personal-bots/qa/hbots-spawn-stalls/labels-390-dark.png`. All three long names are whole, all markers visible, model bases truncate, no horizontal overflow. The screenshot used `aea9d451a354`; after the native timer correction, web runtime assets were byte-identical (4,916 asset files compared; only two source maps differed). The last commit only changed the calendar comparison test; all 2,486 final runtime files match `fc938161f8f3`, excluding source maps and version.txt (`runtime-identical.json`). The shared label function covers every existing long-label consumer; the row layout correction is scoped to Bots rows. Peak/schedule policy kill switches remain available for their underlying features; no extra UI toggle.

QA checks:

- [ ] At 390 px dark, long-name Bots rows retain sched/peak/fallback; model names give way first, names remain whole when space permits.
- [ ] A scheduled DeepSeek model whose schedule outlasts peak says peak until 04:00/10:00 UTC (local formatting); a shorter schedule ends the note first. Check BST and GMT cases.

## No per-request delegation cap

Harout (15 Oct): "Remove the cap i dont see it useful and its just constraining your work." A request may now delegate as many tasks as the work needs.

- `PERSONAL_TASKS_DEFAULT_MAX_CHILDREN = 4` is gone. A root row stores `0` (no cap) unless a caller passes its own `maxChildren`; the two-level depth limit (`PERSONAL_TASKS_DEFAULT_MAX_DEPTH = 2`) is unchanged.
- New kill switch `PERSONAL_TASKS_MAX_CHILDREN`: unset (the live default) = no cap; a positive whole number caps every request at that many delegated tasks and restores the old refusal with the real number (`Delegation limit reached (at most N delegated tasks per request).`). It is read on every delegation, so it needs no restart, and the tighter of the switch and a root's own stored limit applies.
- Still bounding work, unchanged: `PERSONAL_TASKS_CONCURRENCY = 5` (extra tasks queue), the depth limit, the same-bot-and-objective-in-one-turn dedup, and `steer_task` (a reopen creates no task, so no cap can refuse it).
- Text: `delegate_task` no longer says "two levels of delegation and four delegated tasks per request", and `steer_task` no longer says a reopen "does not count against the delegation limit". Both describe the depth limit only and say there is no cap, so bots are not told about a cap that does not exist. The web task UI never showed "x of 4" (only test fixtures carry `maxChildren`), so nothing changed there; `max_children INTEGER NOT NULL` stays, hence no migration.
- Test tool: the fake Claude CLI ran only the first `MCPTOOL`/`MCPONCE` call in an owner message; it now runs every call in that message, in order, one answer line each, so a test can delegate six tasks in the one turn.

Unit tests: six delegations in one request all accepted (six rows; five run, one queues, and the queued one starts when a slot frees); same bot and objective in one turn still deduped; a third depth level still refused; `PERSONAL_TASKS_MAX_CHILDREN=4` refuses the fifth with "at most 4 delegated tasks per request" while a reopen still works at a full request; six `delegate_task` calls at tool level give six distinct children; fake CLI multi-call tests. Gate counts below: server-tests 2,692 (was 2,689, +3 new).

Throwaway (fake CLI, this artifact, root `%TEMP%\hbots-tw-16651b`, dark 390 x 844): one owner message with six `MCPONCE delegate_task` calls, each child slowed with `SLOW15` (written as a JSON unicode escape so the delegating message itself never matches the fake's SLOW trigger), the root's SQLite sampled read-only every second. Six delegations accepted in the one turn (six ok lines, zero refusals), six children, all completed in about 31 s; peak running tasks 5, peak active attempts 5, peak delegated running 5, peak queued 2. A second root (`%TEMP%\hbots-tw-16651c`) started with `PERSONAL_TASKS_MAX_CHILDREN=4`: five calls, four landed, the fifth refused in the chat with the cap wording, four child rows. Evidence `C:/Users/Ht/.personal-bots/qa/hbots-16651/` (`six-delegations.json` and its samples, `five-with-cap.json`, both 390 px dark screenshots, the sampler and the runner scripts, and the dist comparison against `5d117de7a5c4`).

Observed with the fake CLI, not an app defect: with `MCPTOOL` (which the fake repeats on every `[Task continuation]` turn, unlike `MCPONCE`) the same six briefs were re-delegated each time a child finished, reaching 271 children in about 2.5 minutes. All were accepted and queued; running tasks and active attempts never exceeded 5 and the phone stayed responsive throughout. The dedup does not bound that queue across turns, because the tool's idempotency key includes the caller's turn, so the same objective in a later turn is new work by design. `PERSONAL_TASKS_MAX_CHILDREN` is the guard.

QA checks:

- [ ] A single request delegates six tasks (six `delegate_task` calls in one turn): all six created, five run at once, the rest queue, all finish.
- [ ] `PERSONAL_TASKS_MAX_CHILDREN=4` on a throwaway root: the fifth delegation is refused with "at most 4 delegated tasks per request" and no task is created; unset returns to no cap.
- [ ] The depth limit still refuses a third level, and `steer_task` still reopens a stopped part at a full request.
- [ ] `delegate_task` and `steer_task` no longer promise a four-task cap in a bot's tool text.

## Builder validation and evidence

Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-spawn-stalls/` (spawn README and benchmarks, DeepSeek source/built/service A/B JSON, focused test logs, build log, screenshot). No live database was opened or changed. Throwaway servers and browser are stopped. The app sheet lists all four spawn/DeepSeek switches, and the cap-removal switch `PERSONAL_TASKS_MAX_CHILDREN`.

Cap-removal evidence: `C:/Users/Ht/.personal-bots/qa/hbots-16651/` (both throwaway scripts and their JSON/screenshots, the read-only SQLite sampler, and the dist comparison against `5d117de7a5c4`). Both throwaway roots were stopped and deleted with `throwaway-server.ps1 -Stop`; the only SQL run was read-only `SELECT` against those roots, and no live database was opened. The `HANDBOOK.md` lines that still describe the old "4-delegations-per-request limit" are left for the CTO to edit.

Cleanup exception: automatic approval review rejected deletion of the isolated read-only real-ledger copy with "blocked by policy", including a narrower attempt. It remains at `C:/Users/Ht/AppData/Local/Temp/hbots-16650-ledger` (123 copied files including ancillary files; 99 JSONL ledgers). Its absolute root was verified and reparse-point count is zero. CTO should arrange cleanup through the permitted path; the copy must not be shipped or committed.

Gate evidence follows. Focused QA must replace PROOF_PLACEHOLDER with its result in a docs-only commit before DevOps can arm the idle waiter. DevOps alone ships; the builder has not restarted or activated hbots.

## Supplemental checks outside the default fork gate

Final live-log observation: the still-running 1.66.49 recorded a 2.1 s SQLite COMMIT at 15:05:55 BST and a 3.4 s synchronous executable stat/spawn at 15:29:14 BST. The candidate covers that old stat/spawn path; the SQLite/disk stall remains outside this change. All heavy work ran at background priority, but these reports alone cannot establish whether it contributed to the COMMIT delay. Sources: live `logs/stalls/stall-20261015T140555Z-2061ms.json` and `stall-20261015T142914Z-3439ms.json`.

| Check                                                                                | Result          | Exit |
| ------------------------------------------------------------------------------------ | --------------- | ---: |
| Touched usage pricing, byte reader/worker, streaming, UsageService and session usage | 74 tests passed |    0 |
| Shared UTC peak windows and spawn shell resolver                                     | 45 tests passed |    0 |
| Shared TypeScript                                                                    | passed          |    0 |

Logs: `usage-final-tests.log`, `shared-final-tests.log`, `shared-final-tsc.log` in the evidence folder. The final calendar reference uses the previous Effect DateTime implementation; all supplemental checks passed before the final build/gate. The original accepted spawn tests and 22-launch measurements are retained in the spawn README.

## Gate evidence

<!-- gate-evidence:begin sha=e57adb66c109a88a160b487c2f65f1c8483e1210 release=e57adb66c109 json-sha256=fbfce919ad503a3297ead45538dcfe0ce151edc9ec3deffabc9235dedfaf725d result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T15:45:01Z. Version 1.66.50, release `e57adb66c109`, commit `e57adb66c109a88a160b487c2f65f1c8483e1210` on `perf/hbots-spawn-stalls`, working tree clean, result **PASS**.

Machine-readable copy: `releases\e57adb66c109\gate-evidence.json` (sha256 `fbfce919ad503a3297ead45538dcfe0ce151edc9ec3deffabc9235dedfaf725d`) and the full gate logs in `releases\e57adb66c109\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2692 tests passed, 0 failed, 3 skipped, in 194 files | 301.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 42.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2626 tests passed, 0 failed, 0 skipped, in 238 files | 35.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 6.1     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 67      |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-freeze-1\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\e57adb66c109" -Json` (in `.`)                                                                                                                  | 0    | pass: 12/12 journeys passed                                | 308.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `e57adb66c109a88a160b487c2f65f1c8483e1210`, at end `e57adb66c109a88a160b487c2f65f1c8483e1210`; tracked files modified: none. Staged release: version 1.66.50, sha e57adb66c109, dirty False, externals copied; `dist/bin.mjs` sha256 `fba9eda417d29ffb08454cd0d4cd033e415425f76edf88500b1c9af7937451d3`.
<!-- gate-evidence:end -->
