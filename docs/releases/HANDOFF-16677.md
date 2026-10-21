# hbots 1.66.77

Risk tier: risky. It installs third-party agents and carries 29 upstream T3 Code fixes. QA and Security check it before DevOps ships. No migration (the maximum stays 111), so per Harout's rule the release runner skips the production backup. `PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16677`, cut from live 1.66.76 notes commit `7d402784fd`.

## Changes

### Add provider (provider-setup release 2)

- **Catalogue.** Settings > Providers > Add provider lists the ACP registry: Popular first, then All (A to Z), with search, cost chips and an empty state.
  - The server fetches the registry in the background (a daily fetch with the last good copy kept on disk) and serves `provider.catalog.list`, `provider.catalog.add` and `provider.catalog.installFacts`.
  - Icons come from the reviewed-SVG route `GET /api/provider-catalog/icon/:catalogId` (signed-in only, CSP `default-src 'none'`, nosniff, cached a day).
  - The overlay is bundled only; no remote overlay is read.
- **Installer.** Binary archives are checked against the registry sha256 before they unpack; npm packages are pinned to an exact version with integrity. HTTPS only, every redirect hop checked, bounded unpacking, a trimmed environment with no server secrets, one previous version kept for Go back.
- **Driver.** Registry agents run through the new `RegistryAcpDriver` (lease, spawn input, `AcpSessionRuntime`). The adapter passes the bot persona with `withBotInstructions`, so bots can use registry agents.
- **Owner-only.** Install, add, remove and Go back refuse a bot session, an MCP token and a request with no session.
- **Remove guard.** Remove is refused while any bot uses the agent (primary, fallback, scheduled or active model).
- **Phone screens** (SPEC sections 4 and 5): catalogue browse, agent page with cost and details, unsupported reasons in plain words with no Install button, install confirmation with facts and warning, install progress phases including resolving and starting, the installed page with test, Go back and Remove, and an "Add a provider" link from the bot form.
  - Every fact shown comes from the server. When the registry cannot be loaded, the list falls back to the built-in providers from the live snapshots, with a note.
- **Local proof** (throwaway root, no live server): Kilo 7.8.15, checksum-pinned. List 283 ms, add 2 ms, install 8.2 s, session start with ACP initialize 2.4 s, remove 1.0 s. Evidence: `dev-team/reviews/hbots-16677-catalog-backend/local-proof.json`.

### Antigravity usage and limits

- **Usage strip.** Claude, Codex and Antigravity sit on one row with compact labels ("Sess 21% · Wk 58%"); four or more cards scroll sideways. Accessible labels stay in full words. The Show usage switch appears for every provider that can show a card.
- **Quota source.** Antigravity limits come from `loadCodeAssist` plus `retrieveUserQuotaSummary` (Gemini and Claude & GPT groups, 5-hour and weekly windows). The strip shows Gemini only; the sheet shows both groups.
- **Quota notice.** Antigravity answers a spent quota with an ordinary reply ("Usage Limit Reached ... Your limit will reset in 3 hours, 15 minutes.") and ends the turn as a success.
  - A reply that is only that notice now fails the turn as `rate_limited`, with the reset as `retryAt`, so the bot's fallback model and the limit resume take over as they do for Claude and Codex. On 20 Oct this notice ended Frontend's and Backend's tasks instead.
  - The quota summary read 0% while the runtime refused prompts, so the notice also marks the matching window 100% until its reset.
- **Credentials** are handled as in 1.66.76: the token refresh goes only to `https://oauth2.googleapis.com/token` (any other `token_uri` is refused), the quota calls go only to cloudcode-pa, the access token is cached in memory keyed by profile directory, and nothing is logged.

### Upstream T3 Code nightly fixes

- Merged `fix/hbots-upstream-fixes` (`3b5e369bd8`), the 29 picks staged earlier as 5718aeee6024 that never shipped. Triage: `dev-team/reviews/hbots-upstream-nightly-20261020.md`.
- The higher-risk picks are sweeps (1d6f23b519), image prep (ff2fda7d6d), Antigravity attachments by path (def34c28b8), IndexedDB reopen (9c49228f54) and browser host grace (5c715c6941). QA covers them.
- `PreviewAutomationTimeoutError` now logs as one WARN line, so a browser action timeout no longer trips the release runner's ERROR scan.

### Backups

- `backup.ps1` keeps the newest 3 timestamped backups (Harout, 20 Oct); pre-migration backups are never pruned.

## Builder proof

- Server and web tsc pass on the merged tree.
- Antigravity adapter, usage, driver and provider tests: 70 passed, 11 skipped. Catalogue, driver and RPC tests pass (Backend's focused run 460 passed).
- Personal web tests: 2,968 passed. Web build passes.
- Live quota probe through the code path returned both groups and both windows (numbers only, no tokens).
- Three older server tests fail the same way on base `7d402784fd` (ClaudeAdapter personal-bot session options, ClaudeAdapter.botDeny "trims the bot", server.test "transfer budgets"). They are outside the release gate's suites and unchanged by this release.

## Risks

- Third-party agents run with the bots' powers once installed. The confirm sheet says so, and only the owner can install.
- The Antigravity quota summary may keep reading 0% for the models the bots use. The quota notice override covers the moment the limit is hit; Harout compares the card with the Antigravity app after release.

## Security review (21 Oct)

Security's Codex limit was reached, so a Claude reviewer stood in. First verdict BLOCK on one P1: on a registry agent's permission prompt, Cancel selected `allow_once`. Fixed in `2e8c4779da`: only accept, acceptForSession and acceptAlways allow; decline picks the agent's reject option; cancel and anything else refuse (tests: cancel ends the turn interrupted, accept completes). P2 fixed too: the Antigravity quota-notice override lasts at most 5 hours and the next normal turn clears it. P3: registry links kept only when https; reserved Windows names completed. Re-check verdict: CLEARED WITH CONDITIONS (gates re-run on this commit; deferred P3s tracked in `dev-team/reviews/hbots-16677-security/FOLLOWUPS.md`).

## QA round 1 fixes (21 Oct)

QA's first verdict was FIX (`dev-team/qa/hbots-16677-qa/RESULT.md`). Fixed:

- F2: registry agents get a real snapshot from a probe (ACP initialize plus session/new in the managed loop): models from the agent, a provider test, and "Needs sign-in" with the agent's own hint. A signed-out turn fails within about 45 s with the sign-in message instead of hanging.
- F3: the installed page shows only facts from the snapshot (sign-in state, registry source, models).
- F1: agents install under the server's own state directory, so a throwaway server cannot touch live files.
- F4: `server.updateSettings` is owner-only.
- F5/F6: Remove stops idle chats, names a busy one, and deletes the agent's instances from settings after the files are gone.
- The EPERM ERROR on `caches/<provider>.json` is gone: cache writes are serialized and retried.
- A quota hit keeps the other Antigravity usage window.
  Security re-check: CLEARED WITH CONDITIONS (gates re-run; new P3s in `dev-team/reviews/hbots-16677-security/FOLLOWUPS.md`). Known: one upstream ClaudeAdapter test (custom alias colliding with a built-in) fails as it did on the upstream branch; follow-up 9.

## Gate evidence

<!-- gate-evidence:begin sha=816769b00a5b1f1994a34ccab1c463f6d909dfb2 release=816769b00a5b json-sha256=6c5038e47a636424211119a5d0b981621f399de584e824c9b6b15dc81da37322 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-21T04:39:41Z. Version 1.66.77, release `816769b00a5b`, commit `816769b00a5b1f1994a34ccab1c463f6d909dfb2` on `feat/hbots-16677`, working tree clean, result **PASS**.

Machine-readable copy: `releases\816769b00a5b\gate-evidence.json` (sha256 `6c5038e47a636424211119a5d0b981621f399de584e824c9b6b15dc81da37322`) and the full gate logs in `releases\816769b00a5b\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2949 tests passed, 0 failed, 4 skipped, in 214 files | 291.2   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 33.6    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3000 tests passed, 0 failed, 0 skipped, in 262 files | 37.5    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 8.1     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 104.5   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\816769b00a5b" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 264.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `816769b00a5b1f1994a34ccab1c463f6d909dfb2`, at end `816769b00a5b1f1994a34ccab1c463f6d909dfb2`; tracked files modified: none. Staged release: version 1.66.77, sha 816769b00a5b, dirty False, externals copied; `dist/bin.mjs` sha256 `e85b5587a34ecdac67a5e708aea134cdaafb49e8dbc6f8340923ef4ba656933e`.
<!-- gate-evidence:end -->
