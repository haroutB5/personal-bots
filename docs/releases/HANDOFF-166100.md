# 1.66.100 — smaller bot context, throwaway cleanups that finish the job, and an honest web gate

**No migration, no schema change** (latest remains 114). Built on live 1.66.99
(`87733cbec191`) from its notes commit `32274116c7`. This release merges Optimizer's context-cut
branch and adds two follow-ups from the 1.66.99 release.

## Context cuts (`perf/hbots-context-cuts`, head `602b6949c7`, 9 commits)

- **A context budget test now guards the per-step cost** (`test(server)`).
  `apps/server/src/personal/agentContextBudget.json` records the measured budget and
  `agentContextBudget.test.ts` fails when the tool list or the bot rules grow past it, so the next
  release cannot quietly put tens of thousands of characters back into every bot step.
- **Every MCP tool advertises a compact input schema** (`perf(server)`). Descriptions and schema
  shape are reduced without changing any tool name, argument or behaviour: the whole tool list is
  **29% smaller**. Kill switch: `PERSONAL_MCP_COMPACT_SCHEMAS=off` restores the old schema text.
- **The bot rules wording is tighter, with every rule kept** (`perf(server)`): 1,890 to 1,783
  tokens. The reviewer checked rule by rule that nothing was dropped; the meaning of each rule is
  unchanged.
- **Tool descriptions are trimmed per toolkit** (`perf(server)`): bots/tasks/delegation, memory/
  research/routines, preview/pull-request, computer/device/connection. No capability was removed;
  the same tools are offered with shorter copy.
- **Tool-use eval: 53/60 after, 52/60 before**, so the cuts did not cost correctness. The one
  changed tool description (`preview_set_appearance`) names the browser and dark/light mode again
  after review.

## Throwaway servers clean up their whole tree (`fix(tools)`)

Arming 1.66.99 found **136 orphaned fake Claude CLI processes** from QA's deleted throwaway roots
inside the hbots cgroup; they would have held the release's idle gate shut. The cause: both
helpers killed only the recorded server PID, and a server that had already crashed left its
process group (fake CLIs and grandchildren) running while the root was deleted under them.

- `scripts/personal/node/throwaway.mjs` and the team's
  `/home/harout/Claude/AI/dev-team/tools/throwaway-server.mjs` now record the detached server's
  process group and stop the **whole tree**: the group, the leader, and every process whose
  command line still names the throwaway root. This works when the leader is already dead.
- The root is deleted **only after a verification pass** finds no group member and no root-named
  process left. Leftovers are reported with their PIDs and the root is kept, instead of leaving
  processes running from a deleted folder.
- Tests: two in `scripts/personal/node/test/throwaway-cleanup.test.mjs` (orphaned group after a
  crashed leader; live leader's whole group) and two in the dev-team tool's
  `tests/throwaway-stop.test.mjs`. Each starts a real leader + fake CLI + grandchild and asserts
  every PID and the group are gone and the root is deleted.

## The web gate refuses a borrowed test tree (`fix(tools)`)

Worktrees have borrowed each other's `node_modules` by symlink. pnpm then resolves workspace
packages from the other checkout, and the web suite fails en masse with `act is not a function`
while looking like the change under test.

- `scripts/personal/node/check-test-tree.mjs` now runs as the first web-gate command. It refuses a
  checkout whose root or app `node_modules` is a symlink outside the repo, or whose
  `@t3tools/client-runtime` resolves outside it, and prints the link target plus
  `Run vp i in this worktree`.
- Unit tests in `scripts/personal/node/test/test-tree.test.mjs` cover a clean tree, a borrowed root,
  a borrowed app tree and a workspace package resolving outside the checkout.

## One stale ClaudeAdapter test (`test(server)`)

Optimizer saw 3 ClaudeAdapter failures in its worktree. In a clean tree with its own
`node_modules` only **one** remained: "starts personal-bot sessions with only built-ins and the
t3-code server" expected `disallowedTools` to be undefined, but since 1.66.62 a bot session removes
four built-in tools no bot calls (`Workflow`, `ReportFindings`, `ScheduleWakeup`,
`AskUserQuestion`). The test was outside the server gate path and failed on live 1.66.99 too.
The assertion now matches the documented contract; **ClaudeAdapter.test.ts passes 187/187**.

## Gate

All five gates and gate evidence run from this commit in a clean worktree with its own
`node_modules`; the result is in the Gate evidence section below. The preview/computer tool merge
stays out of scope.
