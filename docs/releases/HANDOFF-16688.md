# hbots 1.66.88: one arrow on a step row, and an honest OpenCode dollar line

Two small fixes from the first look at the new work log.

## Changes

- **One arrow per step summary.** The compact row had the disclosure chevron and a family icon (terminal `>_` for commands), which read as two arrows. The family icon is gone; the chevron is the only arrow. The label and the red failed count are unchanged.
- **The OpenCode dollar line says what it is.** It used to read "API price $1.93 this week", which looked like the provider's Cost on opencode.ai and invited a comparison. It now reads "Our 7-day estimate: $1.93", with "plus unpriced tokens" when some local records have no list rate. The allowance percentages above it are read live from OpenCode's Go endpoint; they can differ from the dashboard by one point when the provider rounds the same figure differently. The dashboard's Cost, Requests and Tokens come from the signed-in Console session, which the app cannot read with the Go API key.
- No schema change, no provider change, task concurrency stays 5.

## Validation

- Focused web tests: the new estimate label with and without unpriced tokens; the compact summary; web typecheck passed; changed-file lint and formatting passed.
- Live Go endpoint check: `/zen/go/v1/usage` answered 200 with `cache-control: no-store` and the same 3% weekly / 1% monthly the app card showed. The dashboard's 4% / 2% is its own rounding of the same allowance.

## Runtime and activation

No migration (112 to 112), no production backup (retention is now 1). Roll back to `3a30fe68488b` (binary only) if the smoke fails. The compact work log from 1.66.86 and the narration from 1.66.87 are already live.

## Gate evidence

<!-- gate-evidence:begin sha=28880c61873357abdfe308a7d2c661f593833ea0 release=28880c618733 json-sha256=8eaf398a13c0b88b4fef4dcffbfa7203e7250fca587596b56cd1008a89d18087 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-23T15:21:46Z. Version 1.66.88, release `28880c618733`, commit `28880c61873357abdfe308a7d2c661f593833ea0` on `fix/hbots-opencode-v2-go`, working tree clean, result **PASS**.

Machine-readable copy: `releases\28880c618733\gate-evidence.json` (sha256 `8eaf398a13c0b88b4fef4dcffbfa7203e7250fca587596b56cd1008a89d18087`) and the full gate logs in `releases\28880c618733\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands                                                                                                                                                                                           | Exit | Result                      | Seconds |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------- | ------- |
| e2e  | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\28880c618733" -Json` (in `.`) | 0    | pass: 12/12 journeys passed | 251     |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `909e7c1000a694a7958e48dbeafebd98afb80463`, at end `909e7c1000a694a7958e48dbeafebd98afb80463`; tracked files modified: none. Staged release: version 1.66.88, sha 28880c618733, dirty False, externals copied; `dist/bin.mjs` sha256 `82c6bbbada757523865b45582a0ffd93787e8085b4506d53f94ebd1660c56fcc`.
<!-- gate-evidence:end -->
