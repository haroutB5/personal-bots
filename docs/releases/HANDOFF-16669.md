# HANDOFF 1.66.69

Three changes on top of 1.66.68: the nightly memory tidy-up can no longer archive an entry without a
replacement (and restores the rule that 14 Oct's change 270 archived with none), the nightly Claude
Code update can no longer take a version number or push `personal-bots/main` while a release is
staged or waiting, and a new read-only `usage_status` MCP tool gives bots the live usage limits the
Bots home header shows (Harout's rule: stop assuming usage from memory). No migration (the maximum
stays 111); `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged only; nothing is activated.

Branch `release/hbots-16669`, cut from `personal-bots/main` `aa8de45d0f` (live 1.66.68). Code
commits `a3dbac7877`, `214363c8d9`, `771da5dc50` and `9bb580cc29`; staged release `9bb580cc2975`
(version 1.66.69, externals copied). Gate evidence: below.

## 1. Memory tidy: a supersede never archives without a replacement

**Root cause.** The 14 Oct nightly run applied change 270 as a supersede that archived Harout's rule
`77a0035b` with `superseded_by = NULL`, even though its own reason said "Leave as is". The tidy-up
prompt offered a "supersede with `by = null`" retirement, and `validateDecisions` accepted it;
`autoAll` (the default since 1.60.42) then made it without anyone reading the reason. Nothing
required a replacement entry, and nothing noticed that the verdict was "leave".

**Guard** (`apps/server/src/personal/memory/memoryTidy.ts`):

- `reasonSaysLeave()` recognises a reason that is really a verdict, such as "Leave as is",
  "Keep both", "Leave them unchanged" (an opening leave/keep, or leave/keep followed by
  it/them/these/this/both/all/as/alone/unchanged). Such a decision is recorded as a `leave` with
  its reason, whatever action it named.
- A `supersede` with no replacement (`by = null`) is always recorded as a `leave`: "A supersede
  needs a replacement entry; nothing is archived without one". The existing checks for an unknown,
  reused or newer-entry replacement stay, so a replacement id that does not exist is also a leave.
- The prompt no longer offers retirement: a rule with no successor is to be left.
- `applyDecision` refuses a `supersede` with no replacement as well, so an old pending or approved
  row, or any other caller, cannot archive one either. A merge still inserts its replacement entry
  and archives into it inside the same SQLite transaction, so a failed insert rolls the whole
  change back.

**Startup repair** (`repairOrphanedSupersedes` in `PersonalMemoryTidyService.ts`): additive,
idempotent, runs at every start (with or without the tidy switch), before the pending-change settle.
It finds tidy changes with `action = 'supersede'`, `result_memory_id IS NULL`, status
`applied`/`approved` **and a reason that says leave/keep** (the bug's exact shape, found by the same
`reasonSaysLeave`); for each named entry it clears `superseded_at`/`superseded_by`/
`superseded_reason` only when the row is still archived with `superseded_by IS NULL` and the
tidy-up's own retirement reason (`Retired by the tidy-up:%`), and only when no current entry with
the same scope, kind, apps and text already exists (so the repair can never create a duplicate).
When it restores anything it marks that change `undone`, so the tidy-up never proposes the archive
again, and logs one INFO line with the count and ids. A second boot restores nothing. A by-null
supersede with an ordinary reason (the old, deliberate retirement of a stale note) is not touched.

**Would it restore on the live data:** a read-only count on the 17 Oct 20:51 pre-migration backup
(a copy of the live `state.sqlite`) found 11 applied/approved supersedes with no replacement,
covering 18 entries. Only change 270's reason is a leave verdict ("Leave as is; E2 is the user's
current rule and is not superseded. Replaced below by leave."), so the repair restores exactly
**1** entry: rule `77a0035b` (a test-bot scheduling rule, team reach). No current duplicate of its
text exists. The other 17 entries keep their ordinary reasons and stay archived: old release and
waiter notes, a passed date, and a placeholder rule. The repaired change's row is then marked
`undone`.

Deliberately unchanged: the user-rule wording guard, the refusal of rules from web pages and other
bots, the exact-duplicate fold, the nightly caps, merges of rules (they are still new wording and
still need the rules' own words), and every `autoAll` / cards-mode switch.

## 2. Nightly Updates: never reuse a version, never push main during a release

**Root cause.** `nightly-pipeline.ps1` decided its version from the checkout's
`scripts/personal/app-version.txt` alone, bumped the last part and pushed the commit straight to
`personal-bots/main` (commit title "release <version>: nightly Claude Code update"). On 17 Oct at
04:04-04:12 BST the checkout said 1.66.61 while the real 1.66.62 was built, pushed and waiting to
install (main is fast-forwarded only after a release is live). The nightly therefore published its
own "1.66.62" onto main, then reverted it: main diverged and our version number had been reused.

**Fix:**

- `Get-UpdatesArmedWaiter` reads `run\restart-*-result.json`: a status before the terminal ones
  (`starting`, `guards`, `notes_check`, `evidence_check`, `preflight`, `waiting_for_idle`,
  `backing_up`, `activating`, `smoking`) is an active waiter. A result file can be left saying
  `waiting_for_idle` for ever when its process died (`restart-1.60.6-result.json` has said so since
  30 Sep), so an active status is confirmed by a live `hbots-release` PID. A `restart-*.pid` counts
  only when its process is alive **and** its command line is `hbots-release` (old pid files are kept
  for ever, so a file alone would block every night).
- `Get-UpdatesReservedVersions` returns the version of every release folder from the last fortnight
  that has no main waiter result yet (built and staged, not installed), the current release, and any
  active waiter. A release that finished (`live_verified`, `rolled_back`, `failed`,
  `superseded_before_activation`) stops reserving its number, and an abandoned folder from an older
  line ages out after 14 days; a failed nightly's version is not reused because the next bump
  starts above `origin/main`.
- The preflight refuses the night (posts its report and returns `ok=false`) when a waiter is armed
  or when the next version is already reserved. The pipeline repeats both checks immediately before
  the version commit, and `Push-Run` refuses to push `personal-bots/main` while a waiter is armed
  (reverts are withheld too). Results are `skipped-release-in-flight` and
  `skipped-version-in-use`; nothing is built or restarted, and the run says why.
- The bump base is the higher of the checkout's and `origin/personal-bots/main`'s
  `app-version.txt`, so a checkout that lags a release can never pick a published number.

Tests (`scripts/personal/updates/updates.tests.ps1`): version comparison and refusal of a
non-`x.y.z`; a staged release folder reserves its version; a failed release stops reserving it; an
active waiter reserves its version and is seen as armed; a finished waiter with a stale pid file is
not armed; an old active result with no live runner is neither armed nor reserved.

## 3. `usage_status`: the live limits, never quoted from memory

Harout's new rule is "stop making assumptions from memory, always check live status data from our
app". Bots had no way to read the usage figures the Bots home header shows, so the CTO quoted stale
numbers from memory.

**The tool** (`apps/server/src/mcp/toolkits/personal/`, `usage_status`): read-only, no parameters.
It returns:

- `readAt`: when the reading was taken (ISO 8601).
- `providers`: one entry for each enabled, installed provider, as the header draws it:
  `instanceId`, `driver`, `name`, `status`, `checkedAt` (when the provider last reported), a
  `session` window (id, label, `usedPercent`, `resetsAt`), every `weekly` window, and `unavailable`
  when the provider gave a reason for having no figures.
- `fallbackBots`: every bot whose turns currently use another model, with `botName`, the saved
  `homeModel`, the `activeModel` and its label, and why: `usage_limit`, `deepseek_peak` or
  `schedule`, plus `fromProvider`, `since` and `resetAt` when the provider gave one.

**One source, no second fetch.** The handler calls `ProviderRegistry.getProviders` (the published
snapshots `server.getConfig` gives the header; no refresh or probe) and
`PersonalBotRepository.listBots` (the same `fallbackActive` rows the home renders). The window
choice (first `session`/`five_hour`, every `weekly`/`seven_day`) matches the header's own
`usagePresentation`. The tool description says: "Call usage_status before stating usage limits;
never quote them from memory."

**Proof on a throwaway server** (`throwaway-server.ps1 -Name 16669-tool -Release
9bb580cc2975`, fake Claude CLI with the `usage-weekly` flag, Chrome at 390 x 844, dark; the fake
CLI's own `MCPTOOL` trigger called the tool through the real MCP endpoint):

```
MCPTOOL usage_status ok:
{"readAt":"2026-10-17T23:39:14.904Z",
 "providers":[
   {"instanceId":"claudeAgent","driver":"claudeAgent","name":"Claude","status":"ready",
    "checkedAt":"2026-10-17T23:38:46.691Z","unavailable":null,
    "session":{"id":"five_hour","label":"Session","usedPercent":10,
               "resetsAt":"2026-10-18T00:38:46.949Z"},
    "weekly":[{"id":"seven_day","label":"Weekly","usedPercent":31,
               "resetsAt":"2026-10-20T23:38:46.949Z"}]},
   {"instanceId":"claudeLimited","driver":"claudeAgent","name":"Home (limited)", ...}],
 "fallbackBots":[]}
```

No page errors. The fake root has no bot on a fallback, so `fallbackBots` was empty there; the unit
tests cover the usage-limit, DeepSeek-peak and scheduled rows, with their active model, provider and
reset time.

## 4. Builder verification

- Memory: `vp test run src/personal/memory` in `apps/server` -> **277 passed, 0 failed, 2 skipped**
  (the two skipped are the pre-existing measure tests).
  - New unit tests: a supersede with no replacement is a leave; a replacement id not in the list is
    a leave; a reason "Leave as is" or "Keep both" is a leave with that reason; `autoAll` no longer
    makes a retirement.
  - New service tests: a run whose judge returns a no-replacement supersede and a "Leave as is"
    reason archives nothing and records both as left; the startup repair restores an archived entry,
    is a no-op on the second call, and marks the change undone.
  - Updated the two existing suites that expected a retirement to be applied (cards mode and auto
    mode): they now expect the rule to stay current and the changes to wait or be left accordingly.
- Updates pipeline: `powershell -NoProfile -ExecutionPolicy Bypass -File
scripts\personal\updates\updates.tests.ps1` -> **All passed** (including the new reservation and
  armed-waiter checks).
- Usage status: `vp test run src/mcp/toolkits/personal/usageStatus.test.ts` in `apps/server` ->
  **4 passed, 0 failed**: the session and every weekly window with reset times, the five-hour /
  seven-day fallback when kinds are absent, duplicate weekly ids folded, disabled or uninstalled
  providers left out, an unavailable reason carried through, and the fallback-bot rows for a usage
  limit, DeepSeek peak and a model schedule.
- Usage status end to end on a throwaway server: the fake CLI's `MCPTOOL usage_status {}` returned
  the figures above (session 10%, weekly 31%, reset times, `readAt`) with no page errors.
- Server typecheck: `tsc --noEmit` in `apps/server` -> exit 0, no `error TS`.
- Lint and format on every touched TypeScript file: 0 errors; the only warnings are pre-existing.
- No migration; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## 5. What QA should focus on

Memory is a risky area, so a focused check of the new parts on a throwaway root is worth it:

1. Seed a preference, then (with the real DB never touched) make an applied tidy change with
   `result_memory_id NULL` and archive its entry the old way; restart the throwaway server and
   confirm the entry is current again, the change shows `undone`, and a second restart changes
   nothing.
2. Run the tidy-up with a fake judge that returns a supersede with no replacement and a "Leave as
   is" reason: both must appear as `left`, and the entry must still be current.
3. Approve an old pending supersede that has no replacement: it must refuse and leave the entry.
4. For the nightly fix, no live run is needed: run `updates.tests.ps1`; optionally stage a fake
   release folder under a throwaway root and confirm the preflight refuses with the reservation
   message. The real nightly must skip, not publish, while a release is armed.
5. For `usage_status`: on a throwaway root send `MCPTOOL usage_status {}` in a bot chat and compare
   the session and weekly figures with the Bots home header (with the `usage-weekly` fake flag the
   weekly row reads 31%). Then check a fallback bot appears in `fallbackBots` while it runs on its
   fallback model.

## 6. Rollback

Binary only, to whichever release is live when this one ships: `aa8de45d0f0e` (1.66.68) if no later
release has landed, otherwise that one. No database change and no migration, so nothing to restore.
The startup repair is additive and safe to leave in place after a binary rollback (the restored
entry simply stays restored).

## Gate evidence
