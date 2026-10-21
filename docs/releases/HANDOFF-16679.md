# hbots 1.66.79

Risk tier: low (Antigravity usage card only; no credentials, no installer changes). No migration (the maximum stays 111), so the release runner skips the backup. `PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16677`, on top of live 1.66.78 notes commit `732405d80b`.

## Changes

- **Antigravity weekly usage reads right when Gemini is spent.**
  - What happened: on 21 Oct, with the Gemini weekly quota spent until 26 Oct, the Antigravity card showed the 5-hour session at 100% and the weekly at 0% (Harout: "It says 0% used for the weekly").
  - Cause 1: when a model's quota is spent, Google's per-model list leaves `remainingFraction` out (a zero is omitted) and keeps only `resetTime`. hbots skipped those models, fell back to the quota summary, and the summary's Gemini figures read untouched (0% used, reset rolling forward).
  - Cause 2: the quota notice's stated reset ("5 days, 2 hours") was capped at 5 hours before it was classified, so a weekly limit was filed as the 5-hour session.
  - Fix: a Gemini model with a reset but no remaining fraction counts as spent. The per-model figure goes on the weekly window when its reset is more than five hours away, otherwise on the session window. The notice keeps its stated reset to pick the window, and a separate expiry keeps the five-hour trust limit Security asked for in 1.66.77.
  - Live probe through the same requests (numbers only): every Gemini model reported only `resetTime: 2026-10-26T20:56:06Z`; the summary had no Gemini group on the daily host.
  - Tests: spent models read as Weekly 100% with the 26 Oct reset; a near reset stays on the session; a 5-day notice is filed as weekly and stops counting after its five trusted hours. Antigravity usage, driver and provider suites: 143 passed, 32 skipped.

## Risks

- A per-model reset more than five hours out while the 5-hour window binds would show as weekly. The live data shows the per-model reset follows the binding limit, so this matches what the runtime enforces.
