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
