# HANDOFF: hbots 1.64.1 (6 Oct 2026)

Branch `perf/1641` (off live main aacedd39cf, merged with origin personal-bots/main f1534b4c8a + 2a1f112ab7, a net-zero SDK bump and its
revert). Release **1e2d1a02d7a0**, staged with `build.ps1 -NoActivate -CopyExternals` (4 `.env` keys loaded, `externals=copied`,
dirty=False), not active; live stays 1.64.0 da8db6301b18. Commits after the release commit are tooling and notes only (budget.json,
perf README/scripts, this file). No migration. Concurrency stays 5. Evidence: `C:/Users/Ht/.personal-bots/qa/perf1641/` (RESULT.md is the index).

## What changed in the app (all web, no server behaviour change except one log line)

- **Bots list while bots work (the big one).** `buildBotSummaries` sorted each bot's chats with a comparator that parsed five date
  strings twice per comparison and rebuilt on every shell update; with five bots streaming it held the phone's main thread (19.3 s of long
  tasks in 25 s at 4x CPU). Now each chat's activity is read once and memoised per shell (validated against the shell's own fields),
  and each bot's open links are grouped once. Streaming scenario, 1.64.1 vs 1.64.0: long tasks 19344 -> 5347 ms (-72%), script
  683 -> 293 ms/s, frame p95 214 -> 71 ms, frames over 100 ms 127 -> 21. Kill switch: `localStorage bots:perf-off=activity-memo`.
- **Team**: candidate layouts measured once instead of twice per comparison: Team long tasks -23%, script -37%, wall unchanged. Switch `layout-once`.
  The Team screenshot is pixel-identical to 1.64.0 in both themes.
- Pure caches: one `Intl.DateTimeFormat` per zone (`formatLocalDateTime`), bounded memo for `plainPreviewLine`.

## Leftovers

- (a) `vp lint` clean: 12 errors in 6 files (not the 14 in 7 of 5 Oct: the nightly's own log shows 12) fixed (namespace node imports, one
  `it.effect`, two targeted `no-global-process-runtime` disables with reasons, as `browserPriority.ts` does). Exit 0.
- (b) `build.ps1` no longer crashes without an `upstream` remote: `Get-PbUpstreamBase` (common.ps1) returns '' (PowerShell 5.1 casts the empty
  `git merge-base` output to $null). Tested against a real scratch repo; the real staged build ran on a checkout that has upstream.
- (c) `nightly-pipeline.ps1` removes a failed build's half-built release folder before it clears the name
  (`Remove-UpdatesFailedBuildRelease`: never the active or running release, name must be a sha, junctions unlinked first).
- (d) The SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning (bypassPermissions wording only) is dropped by one `process.emitWarning` wrapper
  (`claudeSdkWarnings.ts`). Not by removing `canUseTool`: `AskUserQuestion` and `ExitPlanMode` still go through it in bypass mode, so
  that would change behaviour. The `allowedTools` variant of the same code stays visible. Live proof on throwaway servers: 1.64.0 logs it 3 times
  for two turns, 1.64.1 0 times.
- (e, CTO, 6 Oct) The nightly lint gate: `vp lint` piped prints its default layout (`  x rule(name): text`, then `,-[file:line:col]`), which the
  parser could not read, so the 04:00 run called a normal exit 1 a crash and reverted. `Get-UpdatesLintErrorFiles` reads both layouts;
  `Get-UpdatesLintSummary` reads "Found N warnings and M errors." (no summary or a timeout = crash = red; errors counted but none tied to a file =
  red; errors in unchanged files pass). Fixture: the real log of that run, trimmed (`updates/fixtures/lint-default-layout-6oct.log`), plus the whole log when present.

## Gates (exit codes, 4:39 to 4:45 on the merged code)

server `vp test run src/personal src/mcp` 0 (1984 passed, 3 skipped); server `tsc --noEmit` 0; web `vp test run --project unit src/features/personal` 0
(1770 passed); web `tsc --noEmit` 0; `vp lint --report-unused-disable-directives` 0; `updates.tests.ps1` 0 (all passed). `perf:check`: see below.

## perf:check and budgets

On the rig (synthetic root, 4x, 5 runs) the committed gate **fails J2.chatShell (ceiling 237) on 1.64.0 itself** (p50 309, 316) and on 1.64.1
(277, 282, 278), and J1-warm.wall (1785) sits at its edge on both (1.64.0 1631 to 2008, 1.64.1 1564 to 2008). Not loosened. Ratcheted only the four
deterministic counters (J1-warm requests 196 -> 126, jsKB 3632 -> 2289; J1-deep requests 246 -> 185, jsKB 4321 -> 3642), identical across 16 runs of each build.
`check.mjs` now takes `--origin` and `--bot` (a throwaway server has no bot called Frontend) and keeps the previous provenance in `ratchetHistory`.

## Risk notes for the QA tier

- Web changes: pure refactors with equivalence tests (memo vs fresh, flag on vs off builds the same rows, decorated vs comparator sort). Low.
- **Release tooling touched** (build.ps1 helper, nightly failed-build cleanup, lint-gate parser): the handbook's risky tier. Tested with real
  processes and real git in `updates.tests.ps1`; the failed-build cleanup was not run end to end (needs a failing nightly build).
- Server: one `process.emitWarning` wrapper at ClaudeAdapter import. Low.
