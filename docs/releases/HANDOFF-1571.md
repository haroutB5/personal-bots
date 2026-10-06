# Delegated results arrive as each child finishes (1.57.1)

2026-09-29, Backend (CTO task 09b114de). Branch feat/task-results-as-they-finish, on 1.57.0 (0b931a027c, release b5158a1b080d, staged). Commit 31180c4000. Release 31180c4000ce, staged with -CopyExternals -NoActivate, build exit 0, not live; live is 1.56.1 (dd3e98877796).

Harout's rule: "Make each task separate. If QA finishes it needs to come back to you unless another task is returning at the same time then it waits for you to go idle or waiting and then it sends it to you."

## What changed (apps/server/src/personal/tasks/PersonalTaskService.ts)

- `wakeParent` (~line 621): no longer waits for every sibling. A parent that is `waiting_for_agent` is queued as soon as any handoff is `returned`. A parent in a turn or already queued is left alone; the result stays `returned` and the next claim delivers it. The status guard is unchanged, so duplicate completions find the parent already queued.
- `resolveAfterTurn` (~line 667): returned-but-undelivered now wins over pending. A turn that ends with any returned result queues ONE continuation carrying all of them; only when none are returned and some are pending does the task park in `waiting_for_agent`; only when neither is left does it complete and `returnToParent` (so a partial continuation never completes the task or sends a summary up the tree, at any depth).
- `claim` / `startTurn` / `buildTurnText` (~lines 770, 960): the claim also returns the handoffs still pending. With siblings still running the continuation reads "[Task continuation] These delegated tasks have finished. Their results:", the results, "Still running: <titles>. Their results will follow in a later continuation.", and "Do not give a final answer yet". With nothing pending the old wording is kept ("Your delegated tasks have finished ... give your final answer").
- Routine, group-chat and nested tasks share this path (all go through `returnToParent`/`wakeParent`/`resolveAfterTurn`), so they behave the same.
- Web: no change. "Waiting on X and Y" (`waitingLabelsByThread`) and the task cards derive from open children, so they shrink as children finish; while the parent runs a continuation it shows Working, and it returns to "Waiting on <the rest>" after.

## Tests (PersonalTaskService.test.ts, 45 tests, all pass; the 6 that depend on the change fail on the old code)

New: a finished child is delivered at once while its sibling runs (wording, parks again, second continuation, no duplicate on replay and sweep, completes only after the last, handoffs delivered, attempts 1-3); children finishing during the parent's turn come back in one continuation (three children, marker lists the two, then the third); a child finishing while the parent is queued (a user turn holds the thread) merges into the same continuation; a failed and an interrupted child are delivered the same way; nested depth 2 (the middle task continues per child, parks, does not complete or report up until its last child, then the root hears once). Two existing tests were updated to the new order (waiting parent slot release, cancel cascade). Sibling order is not fixed (created_at ties), so assertions on sibling lists are order-independent.

## Gates

server `vp test run src/personal` exit 0 (96 files, 1059 tests), server tsc exit 0. Web and contracts untouched, not run. Build exit 0.

## Throwaway

`~/.personal-bots/qa/backend-1571/` (report.txt, continuations.txt, run.mjs, server-log-copy.txt, build.log, gate-*.txt). Release 31180c4000ce, fake Claude CLI (a copy with DELAY_MS support), PERSONAL_SEED_MODEL=claude-sonnet-5-5, port 38625, server stopped by captured PID, root deleted. Assistant delegated Developer ("Fast part") and Researcher ("Slow part", 25 s): the fast result posted a continuation in the parent's chat at +1.7 s with "Still running: Slow part" while Slow was running (header "Waiting on Researcher"); the slow result arrived as a second continuation at +27 s ("Your delegated tasks have finished ... final answer"); the parent completed after that (completed_at after slow's), both handoffs delivered, exactly 2 continuations.

## Notes

Not tested live: a real provider, the phone, a routine or group chat (same code path, covered by the unit tests only). After it goes live: /version.txt 1.57.1; delegate to two bots of different speed and check the first result lands in the chat before the second finishes. CTO combines this with Frontend's animation change (worktree hbots-anim) into one release.
