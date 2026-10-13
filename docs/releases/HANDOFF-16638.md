# HANDOFF 1.66.38

## What changed

Harout's fix, written outside the Bots app (commit `659448c849` on `fix/hbots-sliding-browser-sessions`), shipped on its own on top of live 1.66.36 (`f9fe982d10`). Branch `release/hbots-16638`: that commit plus the version bump (`377a63c35c`). Staged release `377a63c35c96`, externals copied, 4 env keys loaded. Migration max **106 -> 106** (no migration; a new `extendExpiry` UPDATE on `auth_sessions`). `PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

**Problem.** The paired iPhone PWA was signed out exactly 30 days after pairing however often it was used: the session row and its cookie had a fixed expiry and nothing renewed them.

**Change.** `SessionStore.renew` (`apps/server/src/auth/SessionStore.ts`) slides a browser-session-cookie's expiry forward by its full lifetime, at most once a day (once per half lifetime for shorter sessions). It verifies the signature (timing-safe) and claims first, skips the dev token, bearer/non-cookie methods and expired tokens, and extends the DB row only when it is live (`AuthSessions.extendExpiry`: `UPDATE ... WHERE revoked_at IS NULL AND expires_at > now`). `http.ts` `refreshSessionCookie` re-sets the cookie (same `appendSessionCookie` as pairing: HttpOnly, SameSite=Lax, Path=/) on `/api/auth/session`, which every app load calls, and on the environment-API endpoints that require the principal; `/api/personal/*` and `/ws` do not renew. A failed renewal is a WARN and never fails the request. The legacy cookie still migrates to the current name.

**Proof.**

- Gates below PASS; plus `vp test run src/auth src/persistence/AuthSessions` in `apps/server`: 12 files, 97 tests passed (includes the 2 new SessionStore renewal tests; the fork gate does not run `src/auth`).
- **Security** (task 0e381d81, 13 Oct): SHIP, no changes required. Checked validation before renewal, revocation of old and renewed tokens, cookie attribute parity with pairing, relay pass-through of Set-Cookie, concurrency (single atomic UPDATE), no token in any log line, error paths. Low, accepted: unbounded sliding (a used cookie never expires; revocable from the clients list; an optional absolute cap via `issued_at` was offered, not built). Info: no `Secure` flag on either path, unchanged from pairing.
- **QA** (task 296c6c3a, 13 Oct, report `~/.personal-bots/qa/16638/REPORT-16638.md`): SHIP, 6/6. Throwaways with a `Date.now` offset preload: no new cookie at +0 / +12 h / +23 h 50 m; at +24 h 10 m one Set-Cookie with pairing's name and attributes, DB `expires_at` moved 12 Nov -> 13 Nov, at most once a day, app works on the new cookie (chat sent, reply came back); at +30 d 2 h renewed sessions still signed in, the never-used one signed out and its row not extended; revoke ends both old and renewed cookies at once; legacy cookie migrates then renews; bearer tokens never get a cookie; regression (pairing link, Bots list, chat, send) clean, 0 console errors, 0 ERROR, no token in any log.

**What to watch live.** The first renewal on Harout's phone happens about a day after its current cookie was issued, on an app load; the server log shows nothing on success (a failure would be a WARN "Failed to renew browser session.").

**Coordination.** The 1.66.37 Performance tab (`release/hbots-16637`) and the 1.67.x redesign were both cut from 1.66.36 and must merge `fix/hbots-sliding-browser-sessions` before they stage, or they undo this fix.

## Gate evidence

<!-- gate-evidence:begin sha=377a63c35c9610f80d3d5fb5b35282b3e4b76c44 release=377a63c35c96 json-sha256=b4ae51b828163b78ad21a6225101c1a52115c3849df916d2329d9725246ce5a7 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-13T10:27:02Z. Version 1.66.38, release `377a63c35c96`, commit `377a63c35c9610f80d3d5fb5b35282b3e4b76c44` on `release/hbots-16638`, working tree clean, result **PASS**.

Machine-readable copy: `releases\377a63c35c96\gate-evidence.json` (sha256 `b4ae51b828163b78ad21a6225101c1a52115c3849df916d2329d9725246ce5a7`) and the full gate logs in `releases\377a63c35c96\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2526 tests passed, 0 failed, 3 skipped, in 181 files | 358.2   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 63.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2502 tests passed, 0 failed, 0 skipped, in 227 files | 37.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 32.1    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 100.3   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16638\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\377a63c35c96" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 303.1   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `377a63c35c9610f80d3d5fb5b35282b3e4b76c44`, at end `377a63c35c9610f80d3d5fb5b35282b3e4b76c44`; tracked files modified: none. Staged release: version 1.66.38, sha 377a63c35c96, dirty False, externals copied; `dist/bin.mjs` sha256 `493c10a380183dfed372d263f16293acf0a3e594eada750fe893174840ebe026`.
<!-- gate-evidence:end -->
