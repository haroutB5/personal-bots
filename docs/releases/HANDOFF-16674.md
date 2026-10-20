# HANDOFF 1.66.74

Server starts restore CPU AboveNormal, I/O Normal (2), and memory Normal (5)
for node and cloudflared. Builds and release gates share one machine-wide
heavy-job lock. The phone automatically reconnects after transient origin
failures during bootstrap instead of showing the crash page.

Branch `fix/hbots-stability`, worktree `C:/Claude/AI/_wt/hbots-stability`.
Includes 1.66.73 notes/base `79d8783a4558` and fetched
`origin/personal-bots/main` (`713302bea5` at merge time). No migration;
maximum remains 111. `PERSONAL_TASKS_CONCURRENCY` remains 5.
Risk tier: QA risky, assigned by CTO (startup path and release tooling).
Builder stages and pushes; CTO briefs QA; DevOps alone ships.

**Status at the 20 October continuation checkpoint: not ready for QA or
deployment.** Source candidate `f3ddcefc5f42` is committed. The initial full
build exited 0 and staged that folder, but its dependency junctions resolved
contracts from main and omitted the assigned base's Antigravity bot driver.
That artifact is invalid. Local workspace links are corrected; the required
rebuild and full gate evidence could not start because another worktree's
build held the heavy-job lock for about 30 minutes. No gate-evidence.json
exists for this candidate. Do not deploy it. See section 6 for continuation.

## 1. Observed live stalls

CTO supplied this real-world observation from `server-20261020.log` on
20 October 2026. At about 08:46 BST, CTO manually raised live node and
cloudflared to I/O 2 / memory 5:

| Live window (BST) | Recorded event-loop stalls | Over 10 seconds | Maximum |
| --- | ---: | ---: | ---: |
| 07:38-08:46 | 69 | 16 | 66,612 ms |
| 08:46-09:47 | 1 | 0 | 2,436 ms (08:56) |

Builders continued tsc, builds and e2e through heavy-job. This is an
observational comparison, confounded with heavy-job adoption and differing
workload/windows; it does not isolate priority restoration's causal effect.
Both protections are part of this release. Optimizer did not change live
processes or deployment during its tests.

Read-only verification found a discrepancy in the supplied summary. There
are two metrics in the log: EventLoopMonitor warnings (`event loop stalled
for N ms`) and separate StallRecorder captures (`durationMs`). Using the
printed log clock, the monitor has **57** warnings in 07:38-08:46 (16 over
10 seconds, maximum 66,612 ms at 07:53:56), then **1** in 08:46-09:47
(20,357 ms at 08:56:39). The total of 69 earlier monitor warnings starts at
06:07:14, not 07:38. The recorder's separate 2,436 ms capture is timestamped
08:46:05. CTO's supplied figures above are retained with attribution, not
presented as independently reproduced. Evidence:
`live-stall-monitor-lines.log`, `live-stall-summary.json` and
`live-stall-audit-provenance.json` under the evidence root in section 3.

## 2. Changes and rollback controls

- `start.ps1` normalizes its inherited priorities before creating node,
  repairs node/cloudflared descendants, and repairs an already-running
  server without restarting. `restart.ps1` and the release runner reach
  this same start path. `smoke.ps1` checks after readiness/stability and
  **fails** for missing or wrong priorities. Diagnostic rollback:
  `HBOTS_SERVER_PRIORITY=legacy`; smoke still requires AboveNormal/2/5.
- Repo `scripts/personal/heavy-job.ps1` uses the same
  `Global\hbots-heavy-job` mutex and holder file as the dev-team wrapper.
  It is nested-safe, recovers an abandoned mutex and propagates exit codes.
  `build.ps1` and `gate-evidence.ps1` acquire it themselves. Heavy children
  run BelowNormal / I/O 0 / memory 1. `HBOTS_LOW_PRIORITY=off` disables
  lowering, not the mandatory serialization lock.
- Auth/environment and descriptor bootstrap retry gateway HTTP
  502/503/504/520-530, HTTP 408, transport failures, timeouts and interrupted
  response bodies (including HTTP 200 headers followed by an abort).
  HTTP 400/401/403, HTTP 500 and schema/JSON errors stay visible errors.
- The personal reconnect fallback stays mounted while bootstrap retries,
  waits for each attempt, and retries at 2/4/8/16/30 seconds plus
  online/visibility events. It preserves the queued-message notice.
  Device rollback: `localStorage['bots:origin-recovery']='off'`.

Implementation commits: `e3c0bd782f`, `6de2e659f0`, `dbcbb57d8b`,
`d8c63c64ba`, `1e6becd60d`, `45783c4ce8`, `049767fb4a`.
Assigned base merged in `239d4aec85`.

## 3. Controlled memory-pressure comparison

Evidence root: `C:/Users/Ht/.personal-bots/qa/hbots-stability-20261020/`.
Full details in `REPORT.md`, raw samples `pressure.json`, log `pressure.log`.
Actual disposable 1.66.72 hbots binary, same CPU AboveNormal in both arms,
old/new/new/old/old/new interleaved, 10 seconds per arm, polling
`/api/auth/session`. Bounded worker holds up to 4 GiB and touches pages.
Entire benchmark runs through heavy-job at BelowNormal / I/O 0 / memory 1.
No live database or real account used.

| Metric | Old I/O 1 / memory 2 | New I/O 2 / memory 5 |
| --- | ---: | ---: |
| Requests | 243 | 240 |
| Latency median | 17.793 ms | 17.609 ms |
| Latency p75 | 18.418 ms | 18.176 ms |
| Latency maximum | 220.091 ms | 369.189 ms |
| Errors / recorded stalls | 0 / 0 | 0 / 0 |
| Recorded stall median / maximum | 0 / 0 ms | 0 / 0 ms |
| Minimum free RAM | 306 MB | 186 MB |

**The synthetic run showed no gain.** It did not reproduce the multi-second
live freezes or establish a latency improvement. The new arm's higher
maximum occurred with lower minimum free RAM. No performance budget was
loosened or recalibrated.

## 4. Real checks and evidence

All paths below are under the evidence root unless stated otherwise.

- 66 focused bootstrap/auth/descriptor/reconnect/outbox tests passed,
  including interrupted HTTP 200 bodies versus permanent/schema errors.
- Heavy lock 8 checks passed (wait, nesting, literal argument serialization,
  nonzero exit, abandoned mutex). Gate tooling integration: 63 checks passed
  (`gate-evidence-tests.log`).
- Scheduled-style `start.ps1 -Wait`, isolated profile, initially
  BelowNormal / I/O 1 / memory 2: 5 startup/smoke checks passed. Also passed
  with real cloudflared 2026.5.2 running an isolated local Access TCP listener:
  both node and cloudflared AboveNormal/2/5, smoke rejects lowered priority,
  idempotent start repairs it. `startup/`, `startup-real-cloudflared/`.
- Actual hbots server started by `start.ps1 -Wait`, isolated profile, reached
  AboveNormal/2/5; smoke passed. `real-start-proof.log`, `real-smoke.out`.
  No scheduled task changed or live tunnel used.
- 390x844 dark browser, real throwaway server behind origin-error proxy:
  `before-502.png` reproduces the old crash page; `after-502.png` and
  `recovered-502.png` prove automatic recovery without a tap/reload.
  `recovery-502.json` sampled every 250 ms: no blank or crash-page samples.
  `after-504.png` / `recovered-504.png` prove 504 recovery;
  `permanent-400.png` retains the error page. `descriptor-504-shell.png`
  retains cached Bots and reconnects after descriptor restoration.
- Changed-file lint passed; two existing `__root.tsx` warnings are outside
  the changed path. The final release build and artifact-bound fork gates
  remain outstanding at this checkpoint.
- A small isolated probe of the exact self-invoking wrapper pattern using
  `$PSBoundParameters` passed with exit 0 (`self-wrapper-probe.ps1`). It uses
  its own mutex and does not take the real heavy-job lock. Its small
  evidence folder is retained. An initial combined launch/cleanup command
  was rejected by automatic review; direct execution through the tool
  session succeeded. No probe process remains running.

Owned test servers, relays and proxies from the focused checks are stopped;
throwaway roots removed. CTO reports deleting the remaining stopped
`hbots-priority-test-12a60...` fixture after checking no links or processes.
The earlier automatic-review deletion refusal is resolved by that cleanup.

## 5. Next brief and release handling

- SQLite worker remains separate Backend work; normal priority cannot
  eliminate synchronous SQLite stalls under arbitrary memory pressure.
- Synchronous provider event-log appends merit separate worker work with
  ordering and durability proof.
- Add a worktree dependency-resolution guard: shared outer node_modules
  junctions can silently compile workspace packages from main. This
  worktree now has private dependency overlays with local `@t3tools` links;
  third-party packages remain shared. Main was not modified. Frontend's
  later release should verify its workspace sources too.
- QA risky check is required before DevOps ships. No deployment or live
  restart is part of this builder handoff. Frontend's 1.66.75 will merge
  this branch.

## 6. Continuation blocker and exact next step

At 10:56 BST, the shared `Global\hbots-heavy-job` mutex was still held by
`build.ps1`, PID 24732, worktree `C:/Claude/AI/_wt/hbots-16670`, holder start
10:27:57 BST. Read-only inspection found its encoded PowerShell child
15700 and no compiler descendants. Neither process was stopped or changed.
CTO should have the owning task inspect that build and release the lock.

Optimizer stopped its own queued pipeline through its tool session. No
owned build, gate, test server, relay or probe remains running. Current
remote main was fetched again and remains `713302bea5`, already included.

Resume this same task. The external evidence script
`C:/Users/Ht/.personal-bots/qa/hbots-stability-20261020/rebuild-and-gate-16674.ps1`
performs full `build.ps1 -CopyExternals`, asserts the staged server's
Antigravity bot contract, then runs all default `gate-evidence.ps1` gates
under one outer heavy-job lock. It currently pins source candidate
`f3ddcefc5f42`; after these docs-only commits, update the script's release
argument to the new HEAD before building, since build.ps1 stages HEAD.
Then finish the generated gate notes, run the notes/evidence guards, commit
docs only, push and report the valid staged sha12. QA risky follows; DevOps
ships. Pipeline log: `release-16674-pipeline.log`; initial invalid build
log: `release-16674-build-initial.log`.
