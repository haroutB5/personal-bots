# HANDOFF 1.66.67

Two changes on top of 1.66.66: the nightly 04:00 Updates review now watches the DeepSeek
Harness (`@deepseek-ai/dsh`) as well as Claude Code and the Agent SDK, and Code mode's deny plugin
now inspects PTC `run_code` program text. No migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5. Staged only; nothing is activated.

Branch `release/hbots-16667`, cut from `personal-bots/main` `99d7c00a8a` (the 1.66.66 notes commit);
code and version commit `bf80ccf674`. Staged release and gate evidence: below.

## 1. The Updates reviewer watches the DeepSeek Harness

Harout approved this on 17 Oct. The review preparation now also reads
`https://registry.npmjs.org/@deepseek-ai/dsh` with the same 30-second bounded fetch the two
`/latest` npm reads already use. It reads only the **`latest`** and **`next`** dist-tags, takes
the highest by semver (prereleases included: `0.2.1-rc.2` sorts below `0.2.1`, `rc.10` above
`rc.2`), and compares it with `DSH_PINNED_VERSION` in
`apps/server/src/provider/Drivers/DeepSeekEngine.ts`. The `alpha` tag is never read, so it can
never propose a pin move.

When the candidate is newer, a review is due even when Claude Code and the SDK are up to date.
The run data's `review.deepseekHarness` carries the four versions, `moved`, the install script and
runtime package folder, the launch patch, the A/B rig path, and `pinMoveInstructions`:

1. Register **one** proposal in the existing ledger (`Move DeepSeek Harness pin to <candidate>`),
   after `<ledger> list`; any existing proposal for the candidate is reused and a rejected one
   stays rejected.
2. Read the dsh release notes and `apps/server/src/provider/acp/DshAcpSupport.ts`: every row the
   launch patch names (session log, telemetry, web search, DeepSeek web API, plugin inventory,
   `tool-working-directory`) must still exist, and a new tool row that can change the session cwd
   or reach bot state must be disabled there (the 1.66.66 `working_directory` lesson).
3. Prepare the candidate before the A/B: regenerate `scripts/personal/dsh-runtime/package.json` and
   `package-lock.json` with the exact version, bump `DSH_PINNED_VERSION` and the `install-dsh.ps1
-Version` default, install the runtime side by side (which copies the deny plugin), and copy
   `hbots-deny-plugin.mjs` beside both runtimes if its sha256 changed, reporting the hash.
4. Copy the A/B rig into the run folder, point it at the worktree and the old/new runtimes, and run
   it once per runtime on the current live release with a throwaway root; T3b and T3c must pass on
   both.
5. Rate it **risky** unless the A/B is 100% green on both runtimes: the uncommitted worktree edits
   are reverted, the installed runtime folder stays, and the pin does not move until
   `approve P<n>`. Only a green A/B (and preflight's `dependencyChangesAllowed`) keeps the changes
   and implements them as a normal SAFE proposal with tests and one commit.

The steps live in the run data, not only in the routine prompt: the routine's stored prompt is the
user's and an upgrade never rewrites it. The prompt source (`updatesNightlyPrompt`) carries the
same step for new installs, and the bot's starting instructions/description now mention the
harness.

The review label names the harness when it moved (`dsh-0.2.2-rc.1`, or
`2.1.283+dsh-0.2.2-rc.1` when both moved), so the review file, the ship command's
`-ReviewLabel` and the morning report's "New release review ..." line all name the version found;
what was done appears in the report's applied/skipped proposal lines. A risky pin move therefore
reads as `Skipped (reply 'approve P<n>' ...)` with the harness version in the title.

A failed harness registry fetch is logged like the other optional fetches and leaves the Claude
Code review exactly as it was: the check is independent, and `review.deepseekHarness` is null.
Equal or older dist-tags, and alpha-only releases, produce no review and no proposal.

No new UI and no new dependency: the registry read reuses the existing fetch, and the proposal is
the existing ledger entry.

## 2. Code mode: `run_code` program text is denied

QA's 1.66.66 r2 report (finding 1) showed that in Code mode the plugin never looked at
`run_code`'s `code` argument: a literal `fs.readFileSync('../userdata/secrets/<canary>')` inside
the program read the canary, and `writeFileSync` created a file in the store. The sub-tools
`run_code` calls through the SDK were already checked; direct `fs` inside the program was not.

The plugin now, for `run_code` only:

- folds the program text the same way the shell rule folds a command (separators, `.`, duplicate
  separators, case) and denies when it contains a protected command form (the full root or its
  last two segments, e.g. `userdata/secrets`);
- takes the program's string literals (bounded: 400 chars each, 200 literals) and resolves every
  path-shaped one against the session cwd through the same `pathDenied` canonicalization the file
  tools use, so a bare `secrets/x` from a data-root cwd is denied even though it matches no
  command form. Database **reads** stay open, as they are for the file tools.

It is still a tool-level deny, not an OS boundary. A program that builds the path at run time
(a variable, `join`, a template, `String.fromCharCode`) is not stopped, and a literal direct write
to the write-only roots mirrors the shell rule's limit; a separate OS user for the server remains
the real fix.

`DshDenyPlugin.test.ts` grows to 10 tests and uses the production layout
(`<baseDir>/userdata`, `<baseDir>/dsh`, `<baseDir>/personal-workspace`). New cases: the QA literal
read, a double-backslash write, mixed case, duplicate separators, a data-root cwd with a bare
`secrets/...` path, plus allowed workspace code, a database read and an empty payload. The existing
PTC assertion that a secret path in `tools.read({file_path})` was allowed now expects a deny.

## 3. Deny plugin install

The changed plugin (`scripts/personal/dsh-runtime/hbots-deny-plugin.mjs`) has sha256
`8E867E426B9AC338CE64F46A1F5F12EB625FAA86ECE8B10E051CAAF0BD6CBDA5` and is copied beside both
installed runtimes, `runtimes/dsh-0.2.0-rc.2` and `runtimes/dsh-0.2.1-rc.2` (the same copy
`install-dsh.ps1` performs). New DeepSeek chats load it without a restart; a chat whose dsh process
is already running keeps the module it loaded until the release restarts it. The alpha runtime
beside them is not live and was not touched.

QA's plugin harness (the 1.66.66 r2 rig) against the installed copy: **45/45 gating cases pass**;
its one INFO row, "run_code (not inspected)", now reports deny instead of allow, which is the
intended change.

## 4. Builder verification

- Targeted: `vp test run src/personal/claudeCodeReview src/provider/acp/DshDenyPlugin.test.ts` in
  `apps/server`: **73 passed** (28 review, 17 versions, 13 ledger, 10 deny plugin, 5 quiet hours).
- Fork gate, server: `vp test run src/personal src/mcp` in `apps/server`:
  **2926 passed, 4 skipped, 0 failed, 210 files** (233.9 s).
- Fork gate, web: `vp test run --project unit src/features/personal` in `apps/web`:
  **2877 passed, 0 failed, 257 files** (28.5 s).
- Typecheck: `tsc --noEmit` exit 0 in `apps/server` and `apps/web`.
- `scripts/personal/updates/updates.tests.ps1`: all passed.
- `vp fmt` on the touched files; `vp lint` on them reports only the five pre-existing findings in
  the plugin and its test (namespace imports, `reverse`, `filter().at(-1)`), none new.
- No migration; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## 5. What QA should focus on

Code mode on a throwaway root and stub DeepSeek key: the QA literal `fs` read and write must be
denied, and ordinary workspace code (read a workspace file, write `notes.md`, call `tools.read` /
`tools.write` on workspace paths) must still run. Standard and Minimal: a quick regression of the
1.66.66 denied relative spellings, the workdir cases and the database-read allowance. Nightly: a
stub registry with `next` ahead must produce `moved: true` with the pin-move instructions; `alpha`
ahead and equal/older tags must not; a down registry must not stop a Claude Code review. No new
screen is involved.

## 6. Rollback

Binary only: `restart.ps1 -Release c29f265b50a9 -NoPrune` returns to 1.66.66. No database change
and no migration, so nothing to restore. The plugin copy beside both runtimes stays at the 1.66.67
hash; it only adds checks and is safe on 1.66.66.
