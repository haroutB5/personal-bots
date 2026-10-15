# hbots 1.66.51: no per-request delegation cap

PROOF_PLACEHOLDER: focused risky-tier QA is pending. This is a builder handoff, not clearance to activate.

Staged release: `89c8ca93aadf`, branch `feat/hbots-no-delegation-cap`, based on 1.66.50 notes `62af60bf03ea` (1.66.49 live). No migration: 108 -> 108. `PERSONAL_TASKS_CONCURRENCY = 5` unchanged. Build loaded all four public `.env` keys (each value verified present in the staged dist) and copied all runtime externals. The live release pointer remains `9203dde389b7`.

## What changed

Harout (15 Oct): "Remove the cap i dont see it useful and its just constraining your work." A request may now delegate as many tasks as the work needs.

- `PERSONAL_TASKS_DEFAULT_MAX_CHILDREN = 4` is gone. A root row stores `0` (no cap) unless a caller passes its own `maxChildren`; the two-level depth limit (`PERSONAL_TASKS_DEFAULT_MAX_DEPTH = 2`) is unchanged.
- New kill switch `PERSONAL_TASKS_MAX_CHILDREN`: unset (the live default) = no cap; a positive whole number caps every request at that many delegated tasks. Read on every delegation, so it needs no restart. When set, the old refusal returns with the real number: `Delegation limit reached (at most N delegated tasks per request).` The tighter of the kill switch and a root's own stored limit applies.
- What still bounds work, unchanged: `PERSONAL_TASKS_CONCURRENCY = 5` (bots/tasks running at once; extra tasks queue), the depth limit, the same-bot-and-objective-in-one-turn dedup, and `steer_task` (a reopen creates no task, so no cap can refuse it).
- Text: the `delegate_task` description said "past the request's limits, by default two levels of delegation and four delegated tasks per request" and `steer_task` said a reopen "does not count against the delegation limit". Both now describe the depth limit only and say there is no cap on how many tasks one request may delegate (extras queue behind five). Bots are no longer told about a cap that does not exist.
- The web task UI, Task detail and team views never showed "x of 4" (they only carry `maxChildren` in test fixtures), so nothing there changed. `max_children INTEGER NOT NULL` stays, so no migration.
- Test-tool fix: the fake Claude CLI ran only the first `MCPTOOL`/`MCPONCE` call in an owner message. It now runs every call in that message, in order, one answer line each, so a test can delegate six tasks in the one turn.

## Unit tests (fork gate)

- One request delegates six tasks: all six accepted, six rows; five run at once and the rest queue; a sixth delegation with the same bot and objective in the same turn is still the same task (dedup).
- `PERSONAL_TASKS_MAX_CHILDREN=4`: the fifth delegation is refused with "at most 4 delegated tasks per request", a cancelled child is still reopened by `steer_task`, and the next new delegation is refused again.
- Depth: root -> child -> grandchild accepted, a third level refused with "depth limit".
- Pure cap resolution: unset/blank/non-numeric/0/-3 = no cap; "4" = 4; stored limit and switch combine to the tighter one.
- Tool level (`handlers.test.ts`): six `delegate_task` calls in one turn all land, six distinct child ids.
- Fake CLI (`cli.test.mjs`): several `MCPTOOL` calls in one owner message all run in order, a bad call among good ones is reported as refused and the good ones still run.

Gate counts: server-tests 2692 passed / 0 failed / 3 skipped in 194 files (was 2689; +3 new tests), web-tests 2626 passed, ps-tests 247 checks ok, e2e 12/12 journeys.

## Throwaway checks (fake CLI, staged release 89c8ca93aadf)

Root `%TEMP%\hbots-tw-16651b`, seeded bots, fake Claude CLI, dark 390 x 844. One owner message with six `MCPONCE delegate_task` calls to Developer, each child objective slowed (`SLOW15`, written as a JSON unicode escape so the delegating message itself never matches the fake's SLOW trigger); the root's SQLite was sampled read-only every second.

- Six delegations accepted in the one turn (six `MCPTOOL delegate_task ok` lines, zero refusals), six child rows, all six completed ~31 s later.
- Peak running tasks 5, peak active attempts 5, peak delegated running 5, peak queued 2: nothing ran above `PERSONAL_TASKS_CONCURRENCY`, and the sixth task waited for a free slot instead of being refused.
- No uncaught page error. Samples: `six-delegations-samples.jsonl`, summary `six-delegations.json`, screenshot `six-delegations-390-dark.png`.

Kill switch live: a second throwaway (`%TEMP%\hbots-tw-16651c`) started with `PERSONAL_TASKS_MAX_CHILDREN=4`. One owner message with five `MCPONCE delegate_task` calls: four landed, the fifth was refused in the chat with "at most 4 delegated tasks per request", and only four child rows existed. Summary `five-with-cap.json`, screenshot `five-with-cap-390-dark.png`.

Observed with the fake CLI, not an app defect: with `MCPTOOL` (which the fake repeats on every `[Task continuation]` turn, unlike `MCPONCE`) the request re-delegated the same six briefs each time a child finished. The tree grew to 271 children in about 2.5 minutes, all accepted and queued; running tasks and active attempts still never exceeded 5, and the server stayed responsive (the phone answered normally throughout). The dedup does not collapse that: the tool's idempotency key includes the caller's turn, so the same objective in a later turn is new work by design. The queue is what `PERSONAL_TASKS_MAX_CHILDREN` is for; nothing else bounds it.

QA checks:

- [ ] A single request delegates six tasks (six `delegate_task` calls in one turn): all six are created, five run at once, the rest queue, all finish.
- [ ] `PERSONAL_TASKS_MAX_CHILDREN=4` on a throwaway root: the fifth delegation is refused with "at most 4 delegated tasks per request" and no task is created; unset returns to no cap.
- [ ] The depth limit still refuses a third level, and `steer_task` still reopens a stopped part at a full request.
- [ ] `delegate_task` and `steer_task` descriptions no longer promise a four-task cap (Tools text in a bot's session).

## Builder validation and evidence

Evidence folder: `C:/Users/Ht/.personal-bots/qa/hbots-16651/` (both throwaway scripts, their JSON summaries and sample lines, both 390 px dark screenshots, the read-only sampler). No live database was opened or changed: the only SQL was read-only `SELECT`s against the throwaway roots, which were stopped and deleted with `throwaway-server.ps1 -Stop`. No browser other than the throwaway's own paired context was used. The app sheet (`dev-team/apps/personal-bots.md`) records the new switch and the new default; `HANDBOOK.md` lines 37 and 39 still describe the old "4-delegations-per-request limit" and need the CTO's edit.

The builder did not restart or activate hbots: the live pointer is untouched and DevOps alone ships.

## Gate evidence

<!-- gate-evidence:begin sha=89c8ca93aadf817011f56257bb8c705fc3c4cfad release=89c8ca93aadf json-sha256=bd68138f6945ff9aa4f9d7dc633fb7b5f5bb4df7436b1419f4540533362ef90c result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T15:21:39Z. Version 1.66.51, release `89c8ca93aadf`, commit `89c8ca93aadf817011f56257bb8c705fc3c4cfad` on `feat/hbots-no-delegation-cap`, working tree clean, result **PASS**.

Machine-readable copy: `releases\89c8ca93aadf\gate-evidence.json` (sha256 `bd68138f6945ff9aa4f9d7dc633fb7b5f5bb4df7436b1419f4540533362ef90c`) and the full gate logs in `releases\89c8ca93aadf\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2692 tests passed, 0 failed, 3 skipped, in 194 files | 302.5   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 44.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2626 tests passed, 0 failed, 0 skipped, in 238 files | 41.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 8.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 70      |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-freeze-1\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\89c8ca93aadf" -Json` (in `.`)                                                                                                                  | 0    | pass: 12/12 journeys passed                                | 301.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `89c8ca93aadf817011f56257bb8c705fc3c4cfad`, at end `89c8ca93aadf817011f56257bb8c705fc3c4cfad`; tracked files modified: none. Staged release: version 1.66.51, sha 89c8ca93aadf, dirty False, externals copied; `dist/bin.mjs` sha256 `fba9eda417d29ffb08454cd0d4cd033e415425f76edf88500b1c9af7937451d3`.
<!-- gate-evidence:end -->
