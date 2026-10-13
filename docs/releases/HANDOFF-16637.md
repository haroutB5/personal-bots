# HANDOFF 1.66.37

The Computer > Performance tab, shipped on its own: it does not touch the Bots home, so it does not wait for 1.67.0.
Branch `release/hbots-16637`, taken from `feat/hbots-1672-perf` (`90462cc0b3`, off live 1.66.36 `f9fe982d10`); after the
QA NO-SHIP round its head is the merge `2c4c91ccf8` of `7e7e1e67ba` (the two fixes below).
Staged release `2c4c91ccf831`, externals copied, 4 env keys loaded.
Migration max **106 -> 106** (no migration in this release; nothing about the data changes).
`PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

## What changed

### The Computer > Performance segment (the whole release)

Design reference: `dev-team/design/hbots/overall-review/SPEC-performance.md` and its
`shots/performance-*.png` (390 px dark first). Built on `feat/hbots-1672-perf`; this release is that branch,
plus the version bump and the two QA NO-SHIP fixes below.

- **Web** (`apps/web/src/features/personal/computer/`): a 4th segment on the Computer screen.
  `PerformancePane.tsx` (summary line, KPI row, CPU chart with the thread strip, temperatures and fans,
  heaviest right now, battery, storage), `performanceModel.ts` (thresholds, summary copy, formatting; pure
  and unit-tested), `PerfChart.tsx` / `PerfSpark.tsx` (one `<path>` per series), `PcAvatar.tsx`,
  `usePerformanceFeed.ts` (the SSE subscription and a sample store outside React), tokens in
  `personal.css`, segment wiring in `ComputerScreen.tsx`. The pane is a lazy chunk, fetched only when the
  segment is opened, so every other journey's request and byte counts are untouched.
- **Server** (`apps/server/src/personal/performance/`): `performanceSampler.ts` (the per-process sampler,
  the 450-sample ring, subscriber fan-out, a 10 s stop grace), `runtime.ts` (spawns one long-lived helper
  process), `perfHelperScript.ts` (the helper: PowerShell with inline C#, PDH P/Invoke counters,
  `CreateToolhelp32Snapshot` for the process tree), `processGroups.ts` (groups processes into the heaviest
  rows; the server's own children get bot names from their session ids), `counterSample.ts`, `sensors.ts`
  (the two loopback readers), `routes.ts` and its registration in `server.ts`.
- **Endpoint**: `GET /api/personal/performance/stream`, SSE, behind personal auth
  (`AuthOrchestrationReadScope`); an anonymous probe learns nothing. One sampler for all viewers, built on
  the first request so the history survives reloads.
- **Contracts** (`packages/contracts/src/personalPerformance.ts`): the sample and stream event types
  (`hello` with the ring, `sample`, `groups`, `slow`, `statics`).
- **Behaviour**: a sample every 2 s (`PERFORMANCE_TICK_MS = 2000`); the server keeps 15 minutes
  (`PERFORMANCE_HISTORY_SAMPLES = 450`), so a reload or a segment switch shows the history instantly and a
  wider gap means time nobody watched. The helper is started on the first viewer and ends about 10 s after
  the last one leaves (`PERFORMANCE_STOP_GRACE_MS = 10000`).

### The two review fixes (CTO, 13 Oct)

- **No extra request on every app open.** The pane's import of `BotAvatar` made rolldown hoist `perfFlags`
  out of the runtime chunk every journey loads into a chunk of its own: +1 request on every app open
  (132/186 against the base's 131/185). `ComputerScreen`, which is in the base bundle anyway, now builds
  the comet (`AvatarOrbitLayer shape="roundedSquare"`) and hands it to the pane as the `orbit` prop;
  `PcAvatar` draws what it is given and imports nothing from the avatar modules. Requests now equal the
  base exactly, and the only new chunk versus the base is the lazy `PerformancePane` itself.
- **The footer fills on the first open.** A viewer that started the sampling built its `hello` before the
  helper had answered, so the statics (model, CPU, GPU, boot time) missed it and the footer's model line
  only filled after a reload. The sampler now broadcasts a `statics` frame the moment the helper's
  greeting is parsed; the feed store applies it and the pane re-renders.

### The two QA NO-SHIP fixes (13 Oct)

QA tested staged `41693544adc8` and held it. Both findings were in the pane's web code; the server,
contracts and data are untouched.

- **No gap where nobody watched.** The charts and sparks plotted the samples one after another instead of
  by time: leaving the tab for 70 s left no break in the line, and about two minutes of samples stretched
  over the whole "15 min ago" to "Now" axis (`t` is the sample's own timestamp in the contract; the pane
  built each series as one entry per sample). Charts and sparks now run on one fixed 15-minute time axis:
  450 slots of 2 s (the server's tick and ring size), every sample placed at its own timestamp, Now on the
  right edge, and every chart and spark shares it (`axisSeries` in `performanceModel.ts`). A stretch
  nobody watched is left empty and the drawing breaks the line there, per the spec's gap rule: consecutive
  samples more than about three intervals (6 s, `PERF_GAP_MS`) apart break the line, while a single missed
  tick inside one gap carries the previous reading so one hiccup does not split it. Samples older than the
  window fall off the left edge. The scrub crosses the slot axis and every slot reads a real sample, so
  readouts keep a real timestamp (`axisSlotMap`); the fan sparks now scale to the fastest speed inside the
  drawn window, which is what their copy promised; and the "Tab closed" label marks interior gaps only
  (a null run at the left edge is where the history begins on a freshly opened tab).
- **Fans hidden while the sensors app was down.** With LHM down the temperatures card forced "Fan reading
  not available right now", though fan rpm comes from the laptop's own reader (a second source,
  `sensors.fans`) and the server was sending live speed (about 2,200 rpm). The fans rows now depend only on
  `fans` / `fanStatus` and the temperatures only on `lhm`; the sensors-down card keeps its notice for
  temperatures and shows the live fan rows below it, and the notice's copy says fan speeds still work.

Tests added (11): `axisSeries` (a sample's own timestamp on the axis, the 72 s empty stretch, the bridged
4 s tick, the 6 s boundary, samples older than the window, the left edge), `axisSlotMap` (the scrub reads
the newest real sample at or before its slot), `chartRuns` and `sparkPoints` (one unbroken run when whole,
two across a 70 s gap), and the pane (fans live while LHM is down; fans calm while the fan reader is down
with temperatures intact; the chart receives the 450-slot series with the gap left empty).

## Proof

All measurements on Harout's laptop (Dell Inspiron 16 Plus 7620), 13 Oct, with the fleet's other bots
running, so the absolute CPU numbers carry that noise; deltas were measured back-to-back on the same
server. Full evidence and scripts: `C:\Users\Ht\.personal-bots\qa\hbots-1670\backend\perf\` (`NOTES.md`,
`_bench-fix-base.txt`, `_bench-fix-branch.txt`, `perf-fix-footer.png`, `perf-390-dark-top.png`,
`perf-390-dark-temps.png`, `perf-390-dark-apps.png`, `perf-390-dark-storage.png`,
`perf-fix-axis-r2-390-dark.png`, `perf-fix-gap-r2-390-dark.png`, `perf-fix-fans-lhm-down-r2-390-dark.png`
(the round-2 live check), `perf-tab-probe.mjs`, `perf-tab-profile.mjs`, `perf-measure.ps1`,
`build-16637-r2.log`, `gate-evidence-16637-r2.log`).

### Zero cost when the tab is closed

| proof                                          | result                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nothing runs with no viewer                    | 0 perf-helper processes, 0 `[performance]` log lines, helperPid null; server CPU 0.31-0.94% of one core over 30 s windows (its idle figure)                                  |
| starts on the first viewer                     | log: "performance counter helper starting", "performance sampler started"; the helper process is present while someone watches                                               |
| stops after the last viewer                    | the helper is gone within about 10 s of the last disconnect (0 matching processes); log: "performance sampler stopped, counter helper ended"; server back to its idle figure |
| reload or segment switch inside the 10 s grace | the same sampler is reused (unit-tested); the `hello` frame carries the ring                                                                                                 |

### Sampler and helper CPU (while one viewer watches)

- Server: 1.56-2.35% of one core total against 0.31-0.94% idle, so the sampling adds about **0.8-1.2% of
  one core** (13 Oct runs under fleet load: +0.31, +0.77, +1.2, +1.8). The helpers' single remaining CIM
  call (the server's own children, about 5 ms) is included.
- Helper: **2.0-2.2% of one core**, its about 0.7 s startup included (5.5-6.8% on the earlier
  WMI-process-tree version; the tree now comes from a toolhelp snapshot inside the helper).
- Client at 390x844, CPU 4x, about 70 s watch: every long task over 50 ms (8-23 of them) sits inside the
  first 2.7-4.5 s page load and **zero during the about 65 s of 2 s updates**; frame p95 19.3 ms; dropped
  42/3860 (1.1%); no page errors; one SSE request. The build's own profile story, each step measured:
  about 16 long tasks per 70 s before memoising the per-sample model work, 6 after it, 6 with coalesced
  store notifications and memoised charts, **0** with off-screen charts and cards skipping their drawing
  (IntersectionObserver).

### Request parity (perf:check)

Base rebuilt from `f9fe982d10`, same throwaway fixture on both builds (a fresh root with the same two
seeded chats, one on the non-pinned Researcher, one on the pinned Assistant, seeded with the fake CLI),
3 runs each. Base re-produced the earlier 131/185 exactly.

| metric                          | base   | this branch               | budget                                                                              |
| ------------------------------- | ------ | ------------------------- | ----------------------------------------------------------------------------------- |
| J1-warm.requests                | 131    | **131** (exact parity)    | 124 (slack 4): the base is over too, fixture drift on a fresh throwaway, kept as-is |
| J1-deep.requests                | 185    | **185** (exact parity)    | 183 (slack 4): the base is over too                                                 |
| J1-warm.jsKB                    | 2191.2 | 2192.6                    | 2195 (passes)                                                                       |
| J1-deep.jsKB                    | 3557.3 | 3560.3                    | 3576 (passes)                                                                       |
| J2.chatShell                    | 100.2  | 126.1                     | 237 (passes)                                                                        |
| longTaskMs / wall, all journeys | -      | equal or better than base | pass                                                                                |

No limit was loosened to pass (Harout's rule); the request budgets stand at their fixed values and the
branch matches the base exactly. Before the avatar fix the branch measured 132/186, so the fix is the
difference.

### Kill switch and env overrides

- **There is nothing running to switch off.** No viewer, no sampling (proven above): the pane is a lazy
  chunk fetched only when the segment opens, the SSE request is aborted when the pane unmounts (switching
  segment, Back, closing the app), and the helper ends about 10 s after the last viewer. There is no
  always-on process, timer or log line, and no server env turns the feature on or off.
- **Env overrides** (test seams, all live): `T3CODE_PERF_LHM_URL` and `T3CODE_PERF_FAN_URL` move the two
  sensor readers to a stub or a closed port, which is how the calm "reader not running" states were
  proven without touching the laptop's real reader apps. Defaults stay on loopback.

### Sensor sources

- **Temperatures, CPU power, battery rate**: LibreHardwareMonitor 0.9.6 (with the PawnIO 2.2.0 driver,
  installed 12 Oct; scheduled task "LibreHardwareMonitor (hbots sensors)" at logon) at
  `http://127.0.0.1:8085/data.json`. CPU and RAM and SSD temperatures and CPU power work; fan speed and
  iGPU temperature are not readable on this Dell, so fans come from the second source.
- **Fan RPM**: the Dell fan telemetry task ("Dell fan telemetry (hbots read-only)", 12 Oct,
  `C:\Program Files\DellFanTelemetry`) at `http://127.0.0.1:8086/fan.json`.
- Both readers: at most one request per 2 s tick each, async, 1 s timeout, never overlapping themselves.
  With either down, the pane shows its calm state and nothing else breaks.

### The two fixes, live (13 Oct, round 2)

A throwaway server on the staged release (`throwaway-server.ps1 -Name 16637fix -Release 2c4c91ccf831`,
`T3CODE_PERF_LHM_URL` pointed at a closed port so the sensors app reads as down while the laptop's real fan
reader keeps answering), 390 px dark:

- 45 s in, the CPU line occupies only the last sliver of the 15-minute axis and the space before it is
  empty (`perf-fix-axis-r2-390-dark.png`): nothing is stretched over the axis any more.
- Leaving the segment for 95 s and coming back shows the earlier stretch, an empty break, then the
  resumed line at Now (`perf-fix-gap-r2-390-dark.png`); the sampler restarted on return and the ring kept
  the pre-gap samples, which is where the old build bridged the two.
- With LHM down, "Sensors app not running" sits above live fan rows (Fastest 2,337 rpm, Fan 2 at
  1,766 rpm) (`perf-fix-fans-lhm-down-r2-390-dark.png`) where the old build said "Fan reading not
  available right now".
- 0 console errors during the check. The throwaway was stopped by its recorded PID and the root deleted.

## QA and DevOps: ship steps

1. Tier: a new user-visible feature (a whole segment) is QA tier. QA's first pass held `41693544adc8` on
   the two bugs fixed above, so the re-test starts with them: the chart gap after leaving the tab for a
   minute (an empty break, then the line resumes at Now, with the space before the history empty) and the
   fans with the sensors app stopped (live rpm under the notice; "not available" only when the fan reader
   itself is down). Then the rest of the spec's acceptance list (section 9) as before: the screens against
   `shots/performance-*.png` at 390 px dark; thresholds including no flicker at 89/91%; history across
   segments, Back to a chat and a reload within 15 minutes; both calm states with a reader stopped; zero
   samplers and zero reader requests with nobody watching; the speed budget. The builder proof is in this
   file and in `qa\hbots-1670\backend\perf\` (the round-2 live check above). The QA proof is added to this
   file once QA has run.
2. Runner: `-MigrationBefore 106 -MigrationAfter 106`, no `-ExtraColumns`. Rollback baseline: live 1.66.36
   = `aeaff698ca1e` (sha `f9fe982d10`).
3. No new required env vars (the two test-only overrides above); `PERSONAL_TASKS_CONCURRENCY = 5`
   untouched; no idle-classifier change; no data root or config file touched.
4. The two sensor tasks are already installed and start at logon; the tab reads the laptop's own sensors,
   nothing paid.
5. `release/hbots-1670` (1.67.0) later merges this branch in; 1.66.37 ships alone and does not wait for it.

## Gate evidence

<!-- gate-evidence:begin sha=2c4c91ccf8317a01581cfb9ac320038907333433 release=2c4c91ccf831 json-sha256=fe1f7d112f6299a947e3d20a1f3106e2be786ef1d183aad7f45f103136c87128 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-13T08:29:39Z. Version 1.66.37, release `2c4c91ccf831`, commit `2c4c91ccf8317a01581cfb9ac320038907333433` on `release/hbots-16637`, working tree clean, result **PASS**.

Machine-readable copy: `releases\2c4c91ccf831\gate-evidence.json` (sha256 `fe1f7d112f6299a947e3d20a1f3106e2be786ef1d183aad7f45f103136c87128`) and the full gate logs in `releases\2c4c91ccf831\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2563 tests passed, 0 failed, 3 skipped, in 186 files | 318     |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 77.9    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2534 tests passed, 0 failed, 0 skipped, in 233 files | 48.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 11.8    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 78.4    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-1672-perf\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\2c4c91ccf831" -Json` (in `.`)                                                                                                                 | 0    | pass: 12/12 journeys passed                                | 290.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `2c4c91ccf8317a01581cfb9ac320038907333433`, at end `2c4c91ccf8317a01581cfb9ac320038907333433`; tracked files modified: none. Staged release: version 1.66.37, sha 2c4c91ccf831, dirty False, externals copied; `dist/bin.mjs` sha256 `d7816c0741ce56087c84c8c194da8dda36b3cfef815e6d45c8d0016ab5883b31`.
<!-- gate-evidence:end -->
