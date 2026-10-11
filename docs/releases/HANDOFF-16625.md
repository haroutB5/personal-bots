# HANDOFF 1.66.25

## What changed

The composer measures its draft without temporarily collapsing the live textarea.
That intermediate layout let WebKit clamp the transcript backward by 22–66 pixels
on same-line typing, even though the final composer size had not changed. The
1.66.24 tween guard could not prevent the browser's native clamp. A hidden sibling
field now supplies the measurement; the live field receives only its final height.
The shared PersonalComposer covers individual and group chats. Growing, shrinking,
the five-line cap and empty draft retain their existing sizing formulas. Unlaid-out
fields keep their height rather than falling back to a live collapse.

Provider maintenance lookup failures no longer stay cached for an hour. Successful
resolutions retain the one-hour TTL; failed exits expire immediately and the next
ordinary read recomputes. A fresh read starts a new cache generation through the
typed cachedWithTTL API. Three regression tests cover interruption and defect
recovery, concurrent ordinary readers, success expiry and explicit fresh reads.

Six Windows provider test failures are corrected at their fixtures: Antigravity
uses the injected platform's temporary-directory variables; attachment references
expect encoded string paths; the OpenCode POSIX fixture supplies its POSIX Path
service; Cursor uses a Windows directory junction and keeps its original skill
containment assertions. No new skips and no product path-handling changes.

## Focused proof and review

- QA verdict: SHIP for the focused typing fix on exact release 203c6b284bcb,
  client index-DcV2k-HX.js. Windows WebKit 26.4, dark, 390x480, DPR 3:
  baseline same-size backward movement 66 pixels; candidate zero, settled gap zero,
  all three original rows survive both native typing and Backspace. Acceptance
  runner exit 0, including 296 wrap frames and 225 unwrap frames.
- Cap overflow, shrinking, width probes after input, streaming, send, quoted reply
  and search pass. Reading above bottom preserves 80/80 rows and scrollTop 5235
  while typing. Hidden-field accessibility, selectors and layout checks pass.
  Group route shares the fixed component; it was reviewed rather than separately
  exercised. Independent report: C:/Claude/AI/dev-team/qa/qa16625-candidate/REPORT.md.
- The original runner hung during browser teardown after recording passing frames.
  Its interrupted exit is not counted as a pass. QA's bounded-cleanup copy keeps
  the same interactions and assertions and completes with exit 0. Failed harness
  attempts and their corrected completion remain in the evidence.
- Provider suite on source-identical provider code at 6534456eee: exit 0,
  1678 passed and 58 existing skipped. Focused maintenance suite: 18 passed,
  13 existing skipped. The recovery tests reject the original one-hour failure TTL.
  Targeted provider and composer lint pass; final integrated typechecks pass in
  the gates below. Proof: C:/Users/Ht/.personal-bots/qa/backend-16624-provider-review/CTO-RECOVERY.md.
- Builder's composer suite: 49 passed. Build exit 0, four public connection
  settings loaded and privately matched by DevOps, externals copied, clean source.
  Builder evidence: C:/Users/Ht/.personal-bots/qa/frontend-typing2/.

## Release limits and safety

Physical iPhone painted flicker and native keyboard panning remain unverified;
Windows WebKit reproduces the layout clamp but does not supply UIKit or the real
keyboard. The numeric typing recorder stays active for live confirmation. Pure
width changes without input still wait for the next keystroke to remeasure, as
the resize effect's prompt-only dependency is unchanged.

No new migration, credential change or concurrency change; migration 104 and
concurrency 5 remain. Live baseline and binary rollback: 1.66.24 d0bf3c833880.
DevOps ships only through the idle waiter after notes and evidence validation,
fresh integrity-checked backup and the staged smoke. A failed smoke rolls back
the binary, never the database. Optional glide extensions, unrelated interruption
log sites and the separate failed-version-fetch cache are deferred by CTO.

QA's automatic approval review refused deleting its private temporary pairing
artifact with "blocked by policy". It remains local and unpublished; its test
server and data root are deleted, so that pairing link cannot be used.

## Gate evidence

<!-- gate-evidence:begin sha=203c6b284bcbb8f438615737a3523da9a0b2c8f3 release=203c6b284bcb json-sha256=ade95947b821e153662951245a6c9fccb80da3d3bc7227b0dd8dd2b8454276fb result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T08:52:04Z. Version 1.66.25, release `203c6b284bcb`, commit `203c6b284bcbb8f438615737a3523da9a0b2c8f3` on `fix/hbots-typing-flicker`, working tree clean, result **PASS**.

Machine-readable copy: `releases\203c6b284bcb\gate-evidence.json` (sha256 `ade95947b821e153662951245a6c9fccb80da3d3bc7227b0dd8dd2b8454276fb`) and the full gate logs in `releases\203c6b284bcb\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 262.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 49.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2457 tests passed, 0 failed, 0 skipped, in 224 files | 32.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 10.6    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 60.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-typing2\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\203c6b284bcb" -Json` (in `.`)                                                                                                                   | 0    | pass: 12/12 journeys passed                                | 291.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `203c6b284bcbb8f438615737a3523da9a0b2c8f3`, at end `203c6b284bcbb8f438615737a3523da9a0b2c8f3`; tracked files modified: none. Staged release: version 1.66.25, sha 203c6b284bcb, dirty False, externals copied; `dist/bin.mjs` sha256 `caeba288daea118c611f4802df6394d5eaadfea07a4634a45692550aa1c57dc0`.
<!-- gate-evidence:end -->
