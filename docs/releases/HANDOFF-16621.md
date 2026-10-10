# HANDOFF 1.66.21

## What changed

1.66.21 carries the message-jump cancellation fix for the 1.66.18 transcript work. It rides the 1.66.20 line (DeepSeek V4.1 Flash provider, transcript window, MCP JSON results); no migrations are included and task concurrency remains 5 (`PersonalTaskService.ts:50`).

- `apps/web/src/features/personal/MessageList.tsx`: a reply-quote jump now supersedes an in-flight "Jump to latest" smooth scroll. `jumpToQuoted` calls `endJump()` (clears the jump timer and any pending re-assert frame), cancels the show timer and clears the anchor before it centres the target, and re-asserts the quoted target on the next animation frame when a latest scroll was settling, which is the case where Chromium delivers a queued smooth-scroll offset after the instant cancellation and clips the quote.
- `MessageList.searchJump.test.tsx`: three new regression tests (queued browser offset, latest-intent and reader-intent cancellation); the web suite is now 2403.

Why: independent QA's review of the 1.66.18 candidate (`cd7d822352b4`) returned NO-SHIP for a rapid navigation race (tap a reply quote; tap Jump to latest; tap the quote again about 180 ms later; the quoted target could end outside the transcript viewport with no reader input). The fix was built and fully gated on `fix/hbots-16618-audit` at `3611c8bc55` (branch pushed as `9430baa675`) after 1.66.20 had shipped without it.

## Verification (QA's blocker replayed)

QA's exact blocker sequence (`C:/Claude/AI/dev-team/qa/qa16618-independent/short-repro.js`) was rebuilt as a scripted driver and re-run against throwaway roots of both builds (390x844, dark, system Chrome headless through the repo e2e harness; canonical UI fixture: one sent reply quoting the first fake-bot reply, 40 rows, about 2.1k px of transcript below the target):

- Live 1.66.20 (`1ed641390dab`): the quoted target ended outside the transcript viewport in 8 of 10 cycles (samples at +30/+220/+720 ms after the quote tap, no reader input).
- Staged 1.66.21 (`f41b04e4dd1a`): the target stayed visible in all 30 samples, 0 of 10 cycles lost it, no page errors.

Evidence: `C:/Users/Ht/.personal-bots/qa/cto-16621/` (`jump-repro-live.json`, `jump-repro-fixed.json`, `fixture-live.png`, `fixture-fixed.png`, driver `jump-repro.mjs`).

Not verified: the physical iPhone (this is a desktop headless proxy), and QA's own focused rerun (QA is at its Codex weekly limit; the replay above follows the same sequence and the harness can be re-run when QA returns).

## Gate evidence

<!-- gate-evidence:begin sha=f41b04e4dd1a3b222b89c4afc4955eed82b2cc7a release=f41b04e4dd1a json-sha256=ef4164afcad7d985449693665f0e3cbe13c4c133c1b3b377b27e05662c312bd1 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-10T18:46:08Z. Version 1.66.21, release `f41b04e4dd1a`, commit `f41b04e4dd1a3b222b89c4afc4955eed82b2cc7a` on `release/hbots-16619`, working tree clean, result **PASS**.

Machine-readable copy: `releases\f41b04e4dd1a\gate-evidence.json` (sha256 `ef4164afcad7d985449693665f0e3cbe13c4c133c1b3b377b27e05662c312bd1`) and the full gate logs in `releases\f41b04e4dd1a\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 249     |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 43.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2403 tests passed, 0 failed, 0 skipped, in 222 files | 33.7    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 3.5     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 58.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-deepseek-flash\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\f41b04e4dd1a" -Json` (in `.`)                                                                                                            | 0    | pass: 12/12 journeys passed                                | 285.1   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `f41b04e4dd1a3b222b89c4afc4955eed82b2cc7a`, at end `f41b04e4dd1a3b222b89c4afc4955eed82b2cc7a`; tracked files modified: none. Staged release: version 1.66.21, sha f41b04e4dd1a, dirty False, externals copied; `dist/bin.mjs` sha256 `8ba695ca155c057e0dbc112dd217fe8c6dc7ea7dc41e91092c9ae6f4d6efc085`.
<!-- gate-evidence:end -->
