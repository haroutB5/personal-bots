# HANDOFF 1.66.14

## What changed

Frontend. Branch `feat/hbots-quiet-notice`, code commit `9c0bcf8e8d67`, staged with `build.ps1 -CopyExternals` (4 .env keys loaded), not activated. Web only; no migration of its own, no contract or server change.

**Harout's rule (9 Oct):** drop the "No response from <provider> · 2m" notice, it makes a healthy bot look broken. A working bot keeps its normal working status however long it goes quiet.

**Based on main `db5e24fec1` (1.66.13, staged as `413a892b8a81`, not live).** This release therefore also carries 1.66.13's migration 104 and memory changes. Live is still 1.66.12. DevOps needs the pre-migration backup (migration 103) and 1.66.13's own QA/Security clearance still applies. The unmerged branch `feat/hbots-16614` (context meter number, one commit) is not included.

- Removed `chatSilence.ts` (`useQuietSince`, `quietNoticeText`, `SILENCE_THRESHOLD_MS`, `ownerCardPending`, `formatSilence`, `lastOutputMs`) and `QuietNoticeLine.tsx`, with their tests. `ownerCardPending` was only used by the quiet logic, so it went too.
- `ConversationSubtitle` no longer takes `quiet`: the dot and status are always the real state.
- `ConversationScreen`: the header avatar motion uses the real state (it was forced to "idle" while quiet, which made a working bot look stopped); the progress note line is always shown.
- `GroupConversationScreen`: the quiet hook, the member-thread read that only fed it, the muted dot, the "No response" label and the notice line are gone.
- `botSummaries.providerShortName` deleted (only the notice used it).
- Other places checked: Bots list, Team screen, task cards, server and e2e scripts. None showed or used it. `No response` no longer appears anywhere in `apps/*/src`, scripts or docs source (the unrelated auth "(no response)" error is untouched).
- New test: `ConversationSubtitle.test.tsx` "keeps a working bot reading as working": status "Working", live dot, no "No response".

**Proof (throwaway server, fake Claude `QUIET` trigger, 390x844, dark, release `9c0bcf8e8d67`).** 1:1 chat (Researcher) and a two-bot group, sampled at 5 s, 95 s and 125 s after the fake went silent: 1:1 header "Working · Sonnet 5.5 · M" with the green live dot at all three; group header "Assistant is replying" with the green live dot at all three; no "No response" in the page text and no `quiet-notice` element; no page errors. Screenshots: `C:/Claude/AI/_wt/hbots-quiet-shots/` (`1to1-quiet-95s.png`, `1to1-quiet-125s.png`, `group-quiet-95s.png`, `group-quiet-125s.png`, plus the early shots); script `C:/Claude/AI/_wt/hbots-quiet-scratch/quiet-check.mjs` and `quiet-group-check.mjs`.

Tier: small fix, builder-tested. QA only if 1.66.13 needs it anyway.

## Gate evidence

<!-- gate-evidence:begin sha=9c0bcf8e8d6732c91fb39a205bcd55fa0162a1a9 release=9c0bcf8e8d67 json-sha256=a0d3c488006b5475ad9f9ada4b88a0d2a9e521ccaca3211c68a3beca4172ebfd result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-09T11:34:18Z. Version 1.66.14, release `9c0bcf8e8d67`, commit `9c0bcf8e8d6732c91fb39a205bcd55fa0162a1a9` on `feat/hbots-quiet-notice`, working tree clean, result **PASS**.

Machine-readable copy: `releases\9c0bcf8e8d67\gate-evidence.json` (sha256 `a0d3c488006b5475ad9f9ada4b88a0d2a9e521ccaca3211c68a3beca4172ebfd`) and the full gate logs in `releases\9c0bcf8e8d67\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2488 tests passed, 0 failed, 3 skipped, in 178 files | 269.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 47.3    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2347 tests passed, 0 failed, 0 skipped, in 217 files | 34.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 57.1    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 64.3    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-quiet\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\9c0bcf8e8d67" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 295.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `9c0bcf8e8d6732c91fb39a205bcd55fa0162a1a9`, at end `9c0bcf8e8d6732c91fb39a205bcd55fa0162a1a9`; tracked files modified: none. Staged release: version 1.66.14, sha 9c0bcf8e8d67, dirty False, externals copied; `dist/bin.mjs` sha256 `868fe47e7b39a0da3526956f1a1d9bd9b0362eb97e7b416638f56db5f9749906`.
<!-- gate-evidence:end -->
