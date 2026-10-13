# HANDOFF 1.66.39

The Computer > Performance tab and Harout's sliding-session fix, merged and shipped together, plus one small web fix
that closes QA round 2's single open item. What QA should look at is at the end.

This release merges two branches that were each cut from live 1.66.36 (`f9fe982d10`) and proven on their own:

- `release/hbots-16637` - the **Performance tab** (Computer > Performance). QA round 2 SHIP on staged `2c4c91ccf831`;
  the full story (design references, the two NO-SHIP fixes, request parity, the A/A speed control) is in
  `HANDOFF-16637.md`.
- `release/hbots-16638` - **sliding browser sessions** (`659448c849`, Harout's fix). QA 6/6 and Security SHIP on
  staged `377a63c35c96`; the full story is in `HANDOFF-16638.md`.

Branch `release/hbots-16639`: 16637's head `721274e8f1`, plus the scrub fix `af5feffe1c`, the merge of
`origin/release/hbots-16638` (`1ed9e69b2d`), the merge of `feat/hbots-1672-perf` (`a1905ad73c`) and the version bump
(`b03c41d7853b`). Both branches are pushed; `release/hbots-1670` (the 1.67.0 core) already merged 16638
(`4f0459795d`), so no staged branch can undo the session fix.

Staged release `b03c41d7853b`, externals copied, 4 env keys loaded.
Migration max **106 -> 106** (no migration; the session fix is a single `UPDATE` on `auth_sessions`).
`PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

## The scrub over a gap reads "Not measured" (fixed here)

QA round 2 left one item "known, not blocking": dragging the scrub across a chart gap showed the reading from before
the gap, with its own time. The spec's Gap state says "Not measured" (CTO, 13 Oct: "dragging over a chart gap will
show 'Not measured'"), so the build now conforms to the spec.

`axisSlotMap` (`apps/web/src/features/personal/computer/performanceModel.ts`) now mirrors what the chart actually
draws: the sample for a slot the line covers, `null` where the chart has nothing (a stretch nobody watched, or the
empty side before the history begins). The CPU, Memory and Temperatures scrub readouts render "Not measured" for a
`null` slot. Ticks closer than `PERF_GAP_MS` (6 s) still bridge, so a live line's micro-gap (a sampler restart) keeps
its reading.

Tests: the model test that asserted the old carry-forward behaviour was rewritten for read-what-is-drawn, with a
bridge case added, and a new pane test scrubs across a gap and asserts the readout (`PerformancePane.test.tsx`).
Web fork gate on this branch: 2536 tests (the 1.66.37 staged gate ran 2534); the computer-folder suite 181 (179
before).

## What else ships in this release

- **Performance tab** (16637): a 4th segment on the Computer screen; summary line, KPI row, CPU chart with the
  thread strip, temperatures and fans, heaviest right now, battery, storage; one server sampler for all viewers,
  history kept 15 minutes, helper started on the first viewer and ended about 10 s after the last one leaves, so
  there is zero cost when the tab is closed. Round 2 fixed the charts to plot by time with a real break where nobody
  watched, and the fans row to show live fans independently of the sensors app.
- **Sliding browser sessions** (16638): a browser-session cookie's expiry slides forward by its full lifetime at most
  once a day, so the paired phone stays signed in while it is used. Details, Security notes and the QA matrix are in
  `HANDOFF-16638.md`.

## Proof

- 1.66.37 round 2: QA SHIP on `2c4c91ccf831` (`HANDOFF-16637.md`) - gap and fans fixes verified on throwaways,
  request parity with 1.66.36 exact, speed A/A-controlled, e2e 12/12.
- 1.66.38: QA 6/6 and Security SHIP on `377a63c35c96` (`HANDOFF-16638.md`).
- The scrub fix: builder-tested, above; its targeted suites are green on this branch.
- This staged release: the gate evidence table below (all gates on `b03c41d7853b`, e2e on the staged release).

## What to watch live

- The phone: the first session renewal happens about a day after its current cookie was issued, on an app load; the
  server log stays quiet on success (a failure is a WARN "Failed to renew browser session.").
- The Performance tab: one helper process starts on the first viewer and ends about 10 s after the last one leaves;
  no helper, no requests and no cost while nobody has the tab open.

## What QA should look at (if a re-test is called)

- The scrub: drag across a gap on CPU, Memory and Temperatures; the readout reads "Not measured" with no time. A
  gap of a few seconds (the sampler restart case) still carries the reading. 390 px dark, throwaway server.
- The merged build as a whole: pairing link and an app load (the session fix path), then the smoke - bots list,
  open a chat, send a message.
- Regression: the Performance segment's own round-2 checks (a real gap break after leaving the tab, fans live while
  the sensors app is down) as they were re-run for `HANDOFF-16637.md`.

## Gate evidence

<!-- gate-evidence:begin sha=b03c41d7853b99a2f98628292a976877489e44d1 release=b03c41d7853b json-sha256=7042f3e80e94dace52b6015ec79bd3601274328d1f4dbe4b5703681719edbb24 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-13T13:07:11Z. Version 1.66.39, release `b03c41d7853b`, commit `b03c41d7853b99a2f98628292a976877489e44d1` on `release/hbots-16639`, working tree clean, result **PASS**.

Machine-readable copy: `releases\b03c41d7853b\gate-evidence.json` (sha256 `7042f3e80e94dace52b6015ec79bd3601274328d1f4dbe4b5703681719edbb24`) and the full gate logs in `releases\b03c41d7853b\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2563 tests passed, 0 failed, 3 skipped, in 186 files | 297.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 66.6    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2536 tests passed, 0 failed, 0 skipped, in 233 files | 46.9    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.8     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 119.4   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-1672-perf\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\b03c41d7853b" -Json` (in `.`)                                                                                                                 | 0    | pass: 12/12 journeys passed                                | 293.3   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `b03c41d7853b99a2f98628292a976877489e44d1`, at end `b03c41d7853b99a2f98628292a976877489e44d1`; tracked files modified: none. Staged release: version 1.66.39, sha b03c41d7853b, dirty False, externals copied; `dist/bin.mjs` sha256 `bea3d107454127389c4b511726700461bb18838344dab8317639eccb07be8a7f`.
<!-- gate-evidence:end -->
