# HANDOFF 1.66.34

Base `b4e2f8e26c` (live 1.66.33). Branch `feat/hbots-16634-update-status`. Staged release `296ee22474ce`.
No migration (max stays 106). `PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

## What changed

### A small status line on the Bots page (/bots)

Harout (12 Oct): "can you add a small status saying server is deploying, restarting, health check
etc. in the main page?" Nothing on the phone said a release was moving, so the minutes a release
takes read as a crash ("Laptop offline" under the reconnect banner), and the restart the team
caused was indistinguishable from a real outage.

The line speaks in the release runner's own phases:

- `starting` / `guards` / `notes_check` / `evidence_check` / `preflight` -> "Preparing update 1.66.x"
- `waiting_for_idle` -> "Update 1.66.x ready, installs when the bots are idle" (amber)
- `backing_up` -> "Backing up before update"
- `activating` -> "Restarting for update"
- `smoking` -> "Checking update 1.66.x"
- `live_verified` (and `live_verified_doc_update_failed`) -> "Updated to 1.66.x", shown for about
  ten minutes, tap to dismiss (remembered per device for 24 h)
- `rolled_back` -> "Update failed, still on 1.66.y"; `rolling_back` / `rollback_failed` / `failed`
  -> "Update problem, the team is on it"
- `superseded_before_activation` -> nothing, and nothing at all when no update is running or
  recently finished

**How it is read.** Server: `GET /api/personal/update/status` (signed in, the same session scope as
the other personal routes) reads the release runner's newest `run\restart-<version>-result.json`
(the `-dryrun-` / `-prepare-` / `-guards-` files are not runs and never match) and answers
`{phase, version, previousVersion, updatedAt}`, cached for five seconds. Every read is async Effect
FileSystem (`readdir` / `stat` / `readFile`); the Node implementation behind it is the callback and
promises API (checked in `@effect/platform-node-shared`), so no sync fs work touches the event loop
(the 1.66.33 stall fixes). A result file older than 48 h is history; a finished phase lives for ten
minutes; a progress phase whose file has not moved for two hours is a dead runner and shows
nothing (`waiting_for_idle` is exempt - the idle gate may sit for up to 48 h).
`previousVersion` is the version this server is running (its own `version.txt`), which is exactly
"still on y" after a rollback. The run folder is the sibling `run\` of a `dev` / `prod` data root
(the live layout) or `run\` inside a throwaway root.

**How it is delivered.** Web: one reserved 16 px line under the Bots header, empty and invisible
when there is nothing to say - the list below never moves when the words appear or go. Polling runs
only while the page is visible (10 s with an update moving, 60 s idle, 15 s after a failed ask;
coming back on screen asks at once, and a hidden page asks nothing). When the server goes down
after `waiting_for_idle` / `backing_up` / `activating` / `rolling_back` was seen in the last 30
minutes, the line says "Restarting for update" instead of leaving only the generic reconnect
banner, and picks the phase up again by itself when the server is back.

### The two other restart paths: report only, nothing changed here

- **Nightly Updates pipeline** (04:00, `scripts/personal/updates`): writes `run.json` once at
  preflight, a `lock.json` with a coarse `stage` ('bot' / 'pipeline'), and `outcome.json` /
  `last-outcome.json` only when the run ends (result: shipped / rolled-back / down / busy / ...).
  Nothing readable says waiting / backup / restart / smoke while it restarts the server (it calls
  `restart.ps1` + `smoke.ps1` directly, not through the runner). **Not covered**; it would need a
  phase marker written per step.
- **Weekly upstream sync** (Saturdays 09:00, `scripts/personal/upstream-sync.ps1`): per-run triage
  and verdict JSONs, and `state.json` gains `lastResult` / `lastRelease` only when the run ends;
  its restart also calls `restart.ps1` + `smoke.ps1` directly. **Not covered**; same fix needed.

Changing those pipelines was out of scope on purpose (release tooling changes are a separate,
risky job). While either restarts the server, the Bots page shows only the generic reconnect
banner.

## Verification (small-fix tier: builder proof, no QA)

Throwaway server on the staged release `296ee22474ce` (fake Claude CLI, Sonnet seed, 390x844 dark,
Chrome headless). Script: `C:\Claude\AI\_wt\hbots-16634-scratch\update-status-check.mjs`;
screenshots: `C:\Claude\AI\_wt\hbots-16634-shots\`. **17/17 checks passed** (exit 0):

- endpoint: 401 without a session; 200 signed in, `{phase: null}` with nothing in progress;
- each phase shows its exact line, one screenshot each (`01-preparing` ... `01-rollback_failed`);
- live_verified: a tap dismisses "Updated to 1.66.34" and a relaunch keeps it dismissed
  (`02-dismissed`); a superseded waiter (`03`) and an empty run folder (`04`) show nothing;
- the connection-drop case: with "Update 1.66.35 ready" on screen the throwaway server was stopped
  (`-Down`, exactly what a restart does); the line read **"Restarting for update"** (with the
  generic "Reconnecting to your laptop..." banner above it, unchanged), then a `smoking` file was
  written and the server restarted (`-Up`) and the page read "Checking update 1.66.35" again
  (`05-restarting-offline`, `06-after-reconnect`);
- no uncaught page errors, and the fake CLI's "Session 10%" reading confirmed no real provider.

Phone page with every screenshot:
<http://192.168.0.50:8765/7dec0aa14220f34d/hbots-16634-update-status/index.html>.

## Tests

New: 17 server tests (`apps/server/src/personal/updateStatus/updateStatus.test.ts`,
`updateStatusRoute.test.ts`) and 23 web tests (`apps/web/src/features/personal/updateStatus.test.ts`,
`UpdateStatusLine.test.tsx`, plus one placement test in `ChatsScreen.test.tsx`). They pin the file
name rule, the BOM read, every status -> line or nothing, the 10-minute / 48-hour / 2-hour windows,
the future-mtime case, 401/403 before any read, both run-folder layouts, newest-run-wins with
dry-runs and superseded waits ignored, the five-second cache answering with the file deleted, every
phase's text/tone/dismissibility, the offline "restarting" window and its bound, dismissal memory,
the reserved empty slot, visible-only polling, and "nothing asked before pairing".

Fork gates on this branch: server `vp test run src/personal` 2178 passed / 3 skipped (156 files),
`tsc --noEmit` clean; web `vp test run --project unit src/features/personal` 2484 passed (227
files), `tsc --noEmit` clean. The official evidence run below covers `src/personal src/mcp` and the
full phone e2e. The first evidence pass failed web-tests on a known flake - `PersonalUsageStrip.test`
awaits the lazy `import("./PersonalResetCredits")` and hit the 15 s test ceiling on a loaded laptop;
the rerun of that one gate (`-Gates web-tests -Merge`, same commit and sealed artifact) passed
2484/2484, which is the result recorded below. No code changed between the two runs.

## DevOps: ship steps

- **No migration**: runner numbers `-MigrationBefore 106 -MigrationAfter 106`. No new env var, no
  kill switch, no runner or classifier change. The phase list follows `run/hbots-release.ps1` as it
  is (a status this build does not know shows nothing by design).
- The app sheet got one line for the new endpoint and behaviour (kept short).
- Nothing here touches the live server, the live DB, `current.txt` or the release runner.

## Open for the CTO

- Keep the generic reconnect banner under the line during a restart (current behaviour: the banner
  says the app is reconnecting, the line names why), or suppress it on /bots while a restart is
  expected? One small follow-up either way.
- The nightly Updates pipeline and the upstream sync would show the same line if they wrote a phase
  marker per step (e.g. reusing the runner's status file shape). Separate job.

## Gate evidence

<!-- gate-evidence:begin sha=296ee22474ceb478b9c5a720f4c3db55048d6516 release=296ee22474ce json-sha256=393cf596fe67c70021494580cee978379116152ee8832616e2c54c10572b0140 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-12T19:56:13Z. Version 1.66.34, release `296ee22474ce`, commit `296ee22474ceb478b9c5a720f4c3db55048d6516` on `feat/hbots-16634-update-status`, working tree clean, result **PASS**.

Machine-readable copy: `releases\296ee22474ce\gate-evidence.json` (sha256 `393cf596fe67c70021494580cee978379116152ee8832616e2c54c10572b0140`) and the full gate logs in `releases\296ee22474ce\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2526 tests passed, 0 failed, 3 skipped, in 181 files | 323.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 115.7   |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2484 tests passed, 0 failed, 0 skipped, in 227 files | 43.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 62.1    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 63.9    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16634\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\296ee22474ce" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 290.8   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `296ee22474ceb478b9c5a720f4c3db55048d6516`, at end `296ee22474ceb478b9c5a720f4c3db55048d6516`; tracked files modified: none. Staged release: version 1.66.34, sha 296ee22474ce, dirty False, externals copied; `dist/bin.mjs` sha256 `f937d5f1acd680fc91751b898221d5c7ffee4e535b00ef23a1cf4bba425c5645`.
<!-- gate-evidence:end -->
