# `-Mode Probe`: nightly upstream early warning

Branch `feat/sync-probe` (from `fix/reply-retry` = live release f65c6c313, v1.18.1).
Three commits, all in `scripts/personal/upstream-sync.ps1` plus a README section.
Nothing deployed, nothing pushed, nothing restarted.

```
7c0005b16 fix(sync): probe reported green gates as red, and owner edits as a trace
3a76e2725 feat(sync): probe proves it left no trace, and can rehearse a clean merge
7e1c7c93b feat(sync): -Mode Probe, a nightly upstream early-warning run
```

Run it with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\AI\personal-bots\scripts\personal\upstream-sync.ps1 -Mode Probe
```

## What it does

1. Honours the existing sync lock (a running sync always wins) and takes its own
   `probe-lock`, so two probes never overlap.
2. `git fetch origin` + `git fetch upstream`.
3. `git merge-tree --write-tree --name-only` between `origin/personal-bots/main`
   and `upstream/main`. This is the whole dry merge: it touches no ref, no index
   and no worktree. It yields the merged tree plus the conflicting paths.
4. Reports pending commit count, how many touch our build, clean or not, and the
   conflicting file names.
5. If the merge is clean **and** something touches our build, it checks the
   merged tree out into a throwaway detached worktree, installs, and runs the two
   fast gates only: `apps\server` `vp test run src/personal` and `apps\web`
   `vp test run --project unit src/features/personal`. Failures listed in
   `scripts/personal/sync/known-test-failures.txt` are ignored through the
   existing `Get-KnownFailures` / `Get-VitestFailures` helpers, and a failing
   file gets the same single isolated re-run Auto uses, so only a test that
   fails twice counts.
6. Notifies through the existing `Send-Notify` / `Send-HookMessage` webhook.

Reused rather than reinvented: `Invoke-Git`, `Invoke-Proc`, `Get-KnownFailures`,
`Get-VitestFailures`, `Invoke-Gates` (given `-Root` / `-LogDir` parameters that
default to today's values, so Auto's behaviour is byte-identical), `Send-Notify`,
`Write-SyncLog`, and the lock file format.

### Two conflict classes

`apps/web/src/routeTree.gen.ts` and `apps/server/src/persistence/Migrations.ts`
are **not** findings. The Saturday run resolves those itself (`checkout --ours`
plus a regeneration, and `resolve-migrations.ts`). `routeTree.gen.ts` conflicts
on practically every sync, so treating it as a finding would have made the probe
fire every single morning and trained the owner to ignore it. They are logged,
never notified.

### When it stays quiet

A clean probe writes one line to `%USERPROFILE%\.personal-bots\upstream-sync\probe.log`
and sends nothing at all. A push happens only for:

- a real (non-auto-resolved) merge conflict,
- a non-whitelisted gate failure on the merged tree,
- a backlog at or above `-ProbeBacklogWarn` (default 250; the sync refuses above
  400), bucketed per 50 commits so a growing backlog warns roughly once per 50,
  not every morning.

An unchanged finding repeats at most once every `-ProbeRemindDays` (default 7),
so a conflict that sits there for a month costs one push a week, not thirty.
The dedupe key is the sorted set of conflicting files (or of gate failures), so
a _new_ file joining the conflict is new information and does notify.

## Cleanup guarantee

The design principle was the one you asked for: prefer never creating the
artefact over deleting it afterwards.

- The dry merge is `git merge-tree --write-tree`. It creates **no ref, no branch,
  no tag, no stash, no index entry and no worktree** - only loose objects. On the
  conflict path (the common one) that is the entire run: there is literally
  nothing to clean up.
- Running gates needs a real checkout, so the merged tree is wrapped by
  `git commit-tree`. That commit is never pointed at by a branch, tag, note,
  stash, or by any HEAD that survives the run, so it stays unreachable and `git
gc` reaps it. No ref is created, therefore no ref has to be deleted.
- The scratch worktree is detached at that unreachable commit and lives at
  `%USERPROFILE%\.personal-bots\upstream-sync\probe-scratch`, outside every
  checkout.
- It is removed in a `finally`, **and** `Remove-ProbeScratch` also runs as the
  first action of every probe. So a scratch left behind by a kill -9, a reboot or
  a closed laptop is gone before the next run starts. Cleanup is idempotent, not
  best-effort. If removal genuinely fails, the function throws and the run
  reports it rather than silently accumulating.
- Cleanup is `cmd /c rmdir /s /q` followed by `git worktree prune`, deliberately
  **not** `git worktree remove`. Measured here: `git worktree remove` fails with
  `error: failed to delete 'C:/Claude/AI/pb-probe-timing': Filename too long` on
  pnpm's deep `node_modules` paths - _after_ it has already deregistered the
  worktree, which orphans the directory with git no longer aware of it.
  `rmdir /s /q` handles those paths (153 s on a 3.4 GB tree) and unlinks reparse
  points instead of following them, so pnpm's symlink farm is removed and never
  dereferenced.
- Every run fingerprints every registered worktree (HEAD, branch, dirty count,
  and all of `refs/heads` + `refs/tags` + `refs/stash`) before and after, lists
  any stray worktree, and logs the result. The run proves it left no trace
  instead of claiming it.

## Real runs

### Run 1 - as-is, `upstream/main`. 25 s.

```
18:26:14 upstream probe 20260917-182614, sync worktree C:\Claude\AI\personal-bots
18:26:39 probe: upstream 2d8378b44, 88 commit(s) pending, 78 touching our build, 6 conflicted path(s) (1 auto-resolved)
18:26:39 probe: auto-resolved conflicts (not a finding): apps/web/src/routeTree.gen.ts
18:26:39 NOTIFY: Bots upstream probe: the weekly sync will hit 5 merge conflict(s) (upstream 2d8378b44, 88 commit(s) pending). Files: apps/server/src/mcp/PreviewAutomationBroker.test.ts, apps/server/src/provider/Layers/ClaudeAdapter.ts, apps/server/src/provider/Layers/OpenCodeAdapter.ts, apps/server/src/server.ts, apps/web/src/components/sidebar/SidebarChrome.tsx. Nothing was merged, built or deployed.
18:26:39 probe result: conflict
18:26:40 probe: no stray worktrees (4 registered, same as before)
18:26:41 probe: C:\Claude\AI\personal-bots untouched (HEAD 7e1c7c93b, 19 modified path(s), refs identical)
18:26:43 probe: C:\Claude\AI\personal-bots-kbd untouched (HEAD 16812614f, 2 modified path(s), refs identical)
18:26:45 probe: C:\Claude\AI\personal-bots-sync untouched (HEAD f65c6c313, 559 modified path(s), refs identical)
18:26:47 probe: C:\Claude\AI\personal-bots-uxb untouched (HEAD be963bcf2, 2 modified path(s), refs identical)
```

It found `PreviewAutomationBroker.test.ts` - the conflict you already know about -
plus four more, in 25 seconds, with no agent and no LLM call. The hook returned
202 (no fallback entry was written to `urgot\data\alerts\personal-bots-sync.md`),
so the message reached the "Sync reports" bot.

### Run 2 - immediate repeat. The dedupe.

```
18:31:02 probe: upstream 2d8378b44, 88 commit(s) pending, 78 touching our build, 6 conflicted path(s) (1 auto-resolved)
18:31:02 notify suppressed (same finding as 0.0 day(s) ago): Bots upstream probe: the weekly sync will hit 5 merge conflict(s) ...
18:31:02 probe result: conflict (nothing notified)
```

### Run 3 - a different conflicting state, `-ProbeUpstreamRef 3efdcc529`. 34 s.

```
18:32:42 probe: probing 3efdcc529 instead of upstream/main (-ProbeUpstreamRef)
18:32:44 probe: upstream 3efdcc529, 4 commit(s) pending, 4 touching our build, 1 conflicted path(s) (0 auto-resolved)
18:32:45 NOTIFY: Bots upstream probe: the weekly sync will hit 1 merge conflict(s) (upstream 3efdcc529, 4 commit(s) pending). Files: apps/server/src/mcp/PreviewAutomationBroker.test.ts. Nothing was merged, built or deployed.
18:32:45 probe result: conflict
```

A different conflict set, so this one notified rather than being suppressed -
which is the intended behaviour, and it shows the dedupe keys on _content_, not
on "have I spoken today".

### Run 4 - the clean-merge path, `-ProbeUpstreamRef 24b711b7f`. 451 s. **Found a bug.**

```
18:35:17 probe: upstream 24b711b7f, 2 commit(s) pending, 2 touching our build, 0 conflicted path(s) (0 auto-resolved)
18:35:17 probe: merge is clean; running the two fast gates in the scratch worktree
18:35:18 scratch worktree at C:\Users\Ht\.personal-bots\upstream-sync\probe-scratch (unreferenced commit 63763d396)
18:38:11 scratch install exited 0
18:38:11 gate test-server ...
18:38:56 gate test-web ...
18:39:25 NOTIFY: ... 1 fast gate(s) fail on the merged tree: System.String[]. ...
```

Both gates had in fact passed - `gate-probe-test-server.log` says `Test Files 25
passed (25) / Tests 290 passed (290)` and `gate-probe-test-web.log` says `53
passed (53) / 390 passed (390)`. `Invoke-Gates` returns a comma-wrapped array so
an empty result survives the return; my call site wrapped that in `@()`, which
turns "no red gates" into a single element that prints as `System.String[]`.
A probe that reports green as red is worse than no probe - it is the thing that
trains you to ignore the push. Fixed in 7c0005b16 by assigning the result the way
Auto does. Control, through the same plumbing shape:

```
GREEN count=0 (nothing notified)
RED count=1 msg=test-server: PreviewAutomationBroker.test.ts > boom (log x)
RED count=2 msg=test-server: a.test.ts > one | test-web: b.test.ts > two
```

The same run also warned that the main checkout "changed" - because I edited the
README while it ran. Only HEAD, branch and refs can be disturbed by the probe, so
only those warn now; the modified-path count is reported, not alarmed about.

### Run 5 - the clean path after the fix. 436 s (7m16s). Green and silent.

```
18:48:58 probe: probing 24b711b7f instead of upstream/main (-ProbeUpstreamRef)
18:49:00 probe: upstream 24b711b7f, 2 commit(s) pending, 2 touching our build, 0 conflicted path(s) (0 auto-resolved)
18:49:00 probe: merge is clean; running the two fast gates in the scratch worktree
18:49:00 scratch worktree at C:\Users\Ht\.personal-bots\upstream-sync\probe-scratch (unreferenced commit c0939bdbb)
18:51:43 scratch install exited 0
18:51:43 gate test-server ...
18:52:32 gate test-web ...
18:53:01 probe: fast gates green on the merged tree
18:53:02 probe result: clean (nothing notified)
18:53:02 removing scratch worktree C:\Users\Ht\.personal-bots\upstream-sync\probe-scratch
18:55:56 probe: no stray worktrees (4 registered, same as before)
18:55:56 probe: C:\Claude\AI\personal-bots untouched (HEAD 7c0005b16, branch feat/sync-probe, refs identical)
18:55:57 probe: C:\Claude\AI\personal-bots-kbd untouched (HEAD f65c6c313, branch feat/secret-requests, refs identical)
18:55:58 probe: C:\Claude\AI\personal-bots-kbd has 2 -> 4 modified path(s) (someone else was editing; not the probe)
18:56:00 probe: C:\Claude\AI\personal-bots-sync untouched (HEAD f65c6c313, branch sync/upstream-20260917, refs identical)
18:56:01 probe: C:\Claude\AI\personal-bots-uxb untouched (HEAD be963bcf2, branch ux/provider-updates, refs identical)
```

Clean merge, gates green, **nothing notified**, scratch gone. Another agent was
working in the `-kbd` worktree at the same time and the probe correctly reported
that as someone else editing rather than as its own trace.

Cost breakdown of the expensive path: 2m43s checkout + `vp i` (fully from the
local pnpm store, 0 packages downloaded), 1m18s for the two gates, 2m54s to
remove the scratch. The conflict path, which is what most mornings will hit, is
~30 s.

### Run 6 - deference to a running sync.

With a sync lock holding a live pid:

```
Another upstream sync is running (pid 8524, since 2026-09-17T18:00:47.4893180Z).
PROBE EXIT=0
```

No fetch, no scratch, exit 0.

## Proof that nothing was left behind

- `state.json` MD5 before the first probe and after the last:
  `32e85245fc2a5c7eb50271f1672101c1` both times. Probe never wrote the file the
  Saturday run depends on.
- Sync worktree `C:\Claude\AI\personal-bots-sync`: unchanged throughout -
  `HEAD f65c6c313aa9`, branch `sync/upstream-20260917`, 559 modified paths,
  `MERGE_HEAD d4d5d12e8` still in place. Its interrupted merge is exactly as I
  found it.
- `git worktree list`: 4 entries, same 4 as before. No `probe-scratch`.
- `git branch --list`: the only diff versus the start of the session is
  `feat/sync-probe` (mine, intentional) and `feat/secret-requests` (the
  concurrent `input-kbd` agent). No `sync/*`, no probe branch.
- `git stash list`: 2 entries, both dated 2026-09-14 and 2026-09-13. Pre-existing;
  nothing stashed today.
- `C:\Claude\AI\urgot\data\alerts\personal-bots-sync.md` does not exist - the hook
  path worked and no fallback alert was needed.

## What Probe deliberately does not do

- **No LLM, at all.** No triage agent, no resolve agent, no codex. Pure script.
- **No merge on the sync branch, and no touch of the sync worktree** - it does not
  even require a clean one. That is why it works today, with a stopped sync
  parked mid-merge in `personal-bots-sync`.
- **No write to `state.json`** and so no effect on `lastSyncedUpstream`,
  `lastResult` or `consecutivePreflightSkips`. The Saturday run's preflight,
  its skip counter and the launcher's retry logic are untouched.
- **No write to `held-upstream.json`**, no version bump, no commit, no branch.
- **No `vp i` in the sync worktree or the main checkout** - installs happen only
  inside the scratch.
- **No build, no `backup.ps1`, no migration rehearsal, no `restart.ps1`, no
  `smoke.ps1`, no deploy, no push.** Nothing restarts the server.
- **No typecheck gates and no unfiltered `vp test run` in `apps\server`** (that
  wedges for 15+ minutes). Only the two fast filtered runs.
- **No scheduled task** and nothing in the Bots app, as asked. It is a plain
  command, ready for a 07:00 bot routine.

## Notes for you

- Probe is the only mode allowed to run from the main checkout. Requiring the
  sync worktree would mean a half-finished merge silently disables the early
  warning - precisely when it matters most. Auto and DryRun still refuse.
- `-ProbeUpstreamRef <sha>` probes one upstream commit instead of `upstream/main`.
  I added it to rehearse the clean path (upstream/main has been conflicted all
  day), and it is useful on its own: "how far up upstream could we go cleanly?"
- Tunables: `-ProbeBacklogWarn` (250), `-ProbeRemindDays` (7).
- `probe-state.json` had a stale `lastNotifiedKey` of `gates:System.String[]` left
  by the run-4 bug; I cleared the three `lastNotified*` fields so your first real
  notification is not read against junk.
- Separate from this work: `personal-bots-sync` is sitting on an unfinished
  `sync/upstream-20260917` merge (`state.json` says `stopped-judgment` at 17:14
  today), and `launch.ps1` refuses to start while that worktree is dirty. Until
  you finish or abandon that merge, the weekly sync will not run - the probe will
  keep telling you about the conflicts either way.
