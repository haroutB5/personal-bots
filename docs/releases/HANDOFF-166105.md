# 1.66.105: a stale usage reading cannot end the fallback, and a busy bot stays on it

Based on 1.66.104 (6fa8290c7c59). No migration; schema remains 114.

QA found two problems in 1.66.104's turn-boundary switch back. Both are fixed here.

**1. A stale usage reading was taken as proof that the limit had reset (new in 1.66.104).** The sweep's two-minute provider re-probe called `refreshInstance` without dropping the driver's cached usage read first (the usage view's own refresh button does drop it). The driver keeps that probe for five minutes, so the re-probe could hand back a reading taken _before_ the limit hit, stamped with the current time. The sweep then ended the row as "recovered" while the bot's own model was still limited; the next turn hit the limit inside the 60-second reswitch cooldown, the fallback was refused, and the task waited for the real reset. QA saw the row end at 11:04:06 while the limit lasted to 11:11:53.

The re-probe now drops the cached usage read (`invalidateUsage`, the same call the usage view's refresh makes) before refreshing, and the decision is made from the snapshots that probe returned instead of the pass-wide list read before it (which was always one pass stale for this check). Early recovery now also requires the reading to come from a probe that started _after_ the row did: `freshAfterMs` on the switch-back input, with the probe start as the floor. A reading with no such probe behind it can never end the row; only the recorded reset time can. The fake home CLI's cached answer can no longer pass as proof.

**2. A second chat's limit hit while the bot was already on its fallback was paused, not run (already in 1.66.103).** `onLimitHit` returned `already_on_fallback` whenever a fallback row existed, and the caller parked the task until the reset. When the hit came from the home model on a turn that had started before the row was written (a second chat of the same bot, or a provider that did not name the instance), the bot was already on the model that could run the work. That hit now continues on the existing row instead of pausing. Only a hit from the fallback's own instance, or from the chat that was switched (its unnamed hit is the fallback's own turn), waits for the reset. A hit whose provider and session both name no instance is trusted once per row, so a limited fallback cannot retry in a loop. The hit's instance is taken from the provider's error, then from the chat's session row when the error has none.

**3. A model with no catalog entry showed its raw id (low).** The Bots list showed `claude-haiku-…` and the chat header read "Working · · fallback" because the short label fell back to the raw model id. A Claude id the provider has not listed now reads "Haiku 5.5 · H" (`unlistedModelName`: `claude-haiku-5-5` -> "Haiku 5.5"); a family the code does not know still keeps its id. The header gets a name short enough to leave the marker room.

Tests: `PersonalModelFallbackService.test.ts` covers the cached pre-hit reading (a re-stamped 10% answer with the probe's fresh invalidation reading 100% keeps the row), the second chat's hit continuing on the row, the chat that was switched waiting, the once-per-row unnamed rescue, and the fallback's own instance waiting; the web label suite covers the unlisted Claude name. The fake home CLI now reports 100% for its spent window (resets_at is the limit's end), so a cached 10% answer can never pass as proof in a live check.

The full gate passed on the staged artifact: server 3,576 tests (six skipped), web 3,148, both typechecks, and 12 of 12 e2e journeys. Targeted before it: `PersonalModelFallbackService.test.ts` 71, the task and resume suites 236, the web personal suite 3,148.

## Gate evidence

<!-- gate-evidence:begin sha=df18cd043c18fa9d4115c4fa1d413a7c7f1317e0 release=df18cd043c18 json-sha256=9db72e90c05801d92c25cedda9984050e8349cb90e6cd618629c6428f3b6f28f result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
