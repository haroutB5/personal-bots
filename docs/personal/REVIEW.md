# hbots review checklist

Target path `personal-bots/docs/personal/REVIEW.md`. Round 2 draft by Architect, 17 Nov 2026, from Verifier's cold run (`/home/harout/Claude/AI/dev-team/qa/verification-article/s3/cold/COLD-RUN.md`). Round 1 is `/home/harout/Claude/AI/dev-team/qa/verification-article/s3/REVIEW.r1.md`. What changed and why is in `/home/harout/Claude/AI/dev-team/qa/verification-article/s3/ROUND2.md`. Builder commits it. Poteto approves.

## What the reviewer pays attention to in this repo

hbots is a fork of T3 Code. Upstream (`pingdotgg/t3code`) merges in every week. Fork code lives under `personal/` folders, `apps/hbots-mobile`, `packages/personal-client` and `scripts/personal`. A fork edit inside an upstream-owned file is the most likely thing a merge silently undoes.

A release is gated by the release tool installed before it, at `/home/harout/.personal-bots/run/hbots-release-linux/`. That copy reads two things from the branch. It reads the gates files (`scripts/personal/node/gates-*.json`), and it recomputes the gate plan to compare with the plan the gate ran. The rest of `scripts/personal/linux/hbots-release/` in the branch first runs after `install.sh`, at the next release. R02 and R03 cover the two reads. The rest is a known gap (end of file).

Migrations change the live database (about 18 GB across two files on 15 Nov). The runner backs it up only when `--migration-before` and `--migration-after` differ. Upstream migrations run here under fork ids from `apps/server/src/persistence/upstreamMigrationIds.ts`.

The phone and the web share one parity matrix. A UI id that moves on one side breaks the release gate unless `parity.ts` and `parity.json` move in the same branch.

Old data must still load. The phone reads JSON from the server, its disk cache and older or newer server versions. A strict decode there fails the whole read, including the update offer.

## Which range to review

The review covers one commit, written as a full sha. A passing review of a commit that has since moved says nothing about the new commits.

- **Head.** The sha the brief names. For a release it is the rc cut, the `chore(release): hbots <version>` bump commit, reviewed before the gate. Never review a later head that already holds gate fix-ups. On 1.67.24 R01 and R04 flag at the rc cut `c9535e493e` and pass at the release head `cff9ad944c11`, because the fix-ups hide what the gate found. If the brief names no sha, use the rc cut for a release and the branch tip at the start of the review for a branch, and write it down.
- **Base.** For a release, the live release sha (`release <sha>` in the live line of `dev-team/apps/personal-bots.md`). For a branch, `git merge-base <target> <head>`, where the target is the branch the brief merges into (`rc/<version>` or `origin/main`).
- **Next round.** Commits added after the reviewed head (gate fix-ups, review fixes, a moved branch) are a new round. Its base is the head the last round reviewed. On 1.67.24 the fix-up round `c9535e493e..cff9ad944c11` matches R01 and R04 only, the two items the rc round flagged.

## How Verifier uses this file

1. **Read the rules from outside the branch.** Take this file from the first place that has it. First `git show <base>:docs/personal/REVIEW.md`. Then `git show origin/main:docs/personal/REVIEW.md`. Then the lead-approved draft `/home/harout/Claude/AI/dev-team/qa/verification-article/s3/REVIEW.md`. Write which source you used in VERIFY.md, with `sha256sum` for the draft. Never use the copy in the branch under review. A branch that adds or edits this file is reviewed under the older copy.
2. **List the range.** `git diff --name-only <base> <head>` and `git log --format='%h %s' <base>..<head>`.
3. **Match triggers with the helper from the same source as step 1.** `python3 -I <(git show <base>:scripts/personal/qa/review-match.py) <(git show <base>:docs/personal/REVIEW.md) <repo> <base> <head>`. While neither is committed, run the draft `/home/harout/Claude/AI/dev-team/qa/verification-article/s3/match.py` on the draft file `/home/harout/Claude/AI/dev-team/qa/verification-article/s3/REVIEW.md`. The committed helper is `scripts/personal/qa/review-match.py`. The helper defines the matching rules below. A hand match must follow them exactly.
4. **Write `Matched: R01, R04, ...` at the top of VERIFY.md.** Check only those items. Each check of a matched item gets one verdict line.
5. **Start from the last round.** Link the previous round's VERIFY.md for this branch or release. Recheck its open flags and `needs run` lines first. Do not recheck items it passed unless the new range matches them.
6. **Record hits.** When a check flags a real fault, set the item's `last-hit` to that date in the next docs commit. A miss that no item caught goes to the lead as a candidate item, with its incident.

### Matching rules

- Paths are relative to the repo root and match the whole path.
- A bare name such as `package.json` matches the root file only.
- `*` matches within one folder. `**/` matches zero or more folders. A trailing `**` matches everything below. `?` matches one character other than `/`. `{a,b}` matches either.
- A `!` glob removes files from that item only.
- `added-lines` keeps a path match only if an added line of that file's `git diff -U0 <base> <head>` matches the regex. `subject` matches a commit subject in the range.
- Regexes are Python `re`, searched within each line. Case follows the regex. Never add `-i`. The shell equivalent for one file is `git diff -U0 <base> <head> -- <file> | grep -v '^+++' | grep '^+' | cut -c2- | grep -P '<regex>'`.

### Verdicts and modes

Each check has a severity and a mode. The verdict is one of four.

- **pass.** With the evidence. A `run` or `ship` check passes only with the command's output pasted or linked.
- **flag.** With the check's severity and the evidence.
- **n/a.** The trigger fired on a file the check does not concern. Give the reason.
- **needs run.** A `run` or `ship` check that this pass could not run. Write the exact command and the static result. List it under Open in VERIFY.md. The gate or the next round settles it. It is never reported as pass.

Modes. **git** needs only git reads. **planner** runs the read-only planner (below), which a review-only pass may run. **run** needs an installed tree, a generator or a test. A review-only pass writes `needs run`. **ship** needs the release params, which exist only at ship time.

Severity. **must-fix** blocks the hand-back. **should-fix** blocks unless the lead accepts it in writing. **nit** is reported only.

### Planner commands

R03 and R05 use these. They run git only and write nothing in the repo (measured on 17 Nov, 0.1 s each, `git status` clean after).

```
T=$(mktemp -d); git archive <head> scripts/personal/linux/hbots-release scripts/personal/node | tar -x -C "$T"
node "$T/scripts/personal/linux/hbots-release/lib/gateScope.mjs" --repo . --base <base> --head <head> --commands > tree-plan.txt
node /home/harout/.personal-bots/run/hbots-release-linux/lib/gateScope.mjs --repo . --base <base> --head <head> \
  --gates-json "$T/scripts/personal/node/gates-linux.scoped.json" --commands > installed-plan.txt
diff tree-plan.txt installed-plan.txt
```

## Checklist

### R01 ui-id-moved
- **trigger:** `apps/web/src/**/*.tsx` `apps/hbots-mobile/src/**/*.tsx` `apps/hbots-mobile/src/parity.ts` `packages/contracts/src/**` `scripts/personal/parity/**` `!**/*.test.*`
- **check 1 (must-fix, git):** If a screen, sheet, dialog, action, setting or RPC was added, renamed or removed, does the range also change `apps/hbots-mobile/src/parity.ts` and every test that lists the old id?
- **check 2 (must-fix, run):** Does `parity.json` stay unchanged after a regeneration in a tree where `pnpm install` has run? The run command is the gate's own, `node scripts/personal/parity/parity-matrix.mjs . --ref HEAD --android-ref HEAD --client-ref HEAD --check --out scripts/personal/parity/parity.json && git diff --exit-code scripts/personal/parity/parity.json`. The static proxy for a review-only pass is `git show <rev>:scripts/personal/parity/parity.json | grep -c '"inPackage": \[$'` at base and head. A drop the diff does not explain is a flag. Measured on 1.67.24 it was 35 at base, 0 at the rc cut, 34 at the release head. No drop gives `needs run`, not pass.
- **incidents:** 12 Nov 2026, 1.67.11 stopped before staging on a renamed setting with no parity entry (`qa/hbots-16711/ship/STOPPED.md`), then failed parity on gate run 2 because `parity.json` was regenerated before `node_modules` existed (`STOPPED-2.md`). 10 Nov 2026, 1.67.3 failed its first gate on a renamed reset dialog, fixed in `669f0f0969` and `39927beab5`. 15 Nov 2026, 1.67.24 stopped before its gate because `831279c246` regenerated the snapshot without installed packages, fixed in `b6a96bf557`. 13 Nov 2026, `0670f399c6` regenerated parity after an upstream sync.
- **added:** 2026-11-17. **last-hit:** 2026-11-15.

### R02 gates-file-read-by-installed-tool
- **trigger:** `scripts/personal/node/gates-linux*.json` `scripts/personal/linux/dev-team-tools/gate-evidence.mjs` `scripts/personal/linux/dev-team-tools/gate-common.mjs` `scripts/personal/linux/dev-team-tools/check-gate-evidence.mjs`
- **check 1 (must-fix, git):** Is every gates file the installed tool reads byte-identical to base (`git diff --exit-code <base> <head> -- <file>`), with any new format in a new file?
- **incidents:** 16 Nov 2026, 1.67.28 stopped at the gate (`qa/hbots-16728/ship/STOPPED.md`). `feat/scoped-checks` put a literal `{args}` into six commands of `gates-linux.json`. The installed tool ran them as text and four checks failed. About 50 min lost. Handbook rule of the same day.
- **added:** 2026-11-17. **last-hit:** 2026-11-16. **retire:** when S5 (gate file read from base) is live.

### R03 planner-or-seal-rule-changed
- **trigger:** `scripts/personal/linux/hbots-release/lib/gateScope.mjs` `scripts/personal/linux/hbots-release/lib/serverTestSelect.mjs` `scripts/personal/linux/hbots-release/lib/seal.mjs` `scripts/personal/linux/hbots-release/lib/pins.mjs` `scripts/personal/linux/hbots-release/lib/testBudget.mjs` `scripts/personal/node/gates-linux.scoped.json` `scripts/personal/linux/dev-team-tools/gate-common.mjs`
- **check 1 (must-fix, planner):** Is the installed planner's plan equal to the tree's plan for this base and head? Proof is the empty `diff` from the planner commands. If they differ, the release must be split so the new rule ships first and is installed before it gates anything.
- **incidents:** 17 Nov 2026, 1.67.34 stopped before arming (`qa/hbots-16734/ship/attempt1-both-merges/STOPPED.md`). The gate ran server-tests WHOLE with the in-tree planner and the installed runner recomputed SKIP, so the seal refused after a 24 min gate. 16 Nov 2026, 1.67.28 first shipped a new `gateScope.mjs` in the same release that used it.
- **added:** 2026-11-17. **last-hit:** 2026-11-17. **retire:** when S5 is live.

### R04 agent-context-budget
- **trigger:** `apps/server/src/mcp/toolkits/**/tools.ts` `apps/server/src/personal/personalBotInstructions.ts` `apps/server/src/personal/agentContextBudget.json` `apps/server/src/provider/agentContextBudget.json`
- **check 1 (must-fix, run):** Is the budget test green on this head? The test asserts exact equality (`agentContextBudget.test.ts:75`), so any byte change after the last budget commit fails it, a shrink included. The run command, in an installed tree, is `cd apps/server && NODE_ENV=test vp test run src/personal/agentContextBudget.test.ts src/provider/AgentContextBudget.test.ts`. The static proxy for a review-only pass is the script below. An UNMEASURED commit that changes tool description or instruction text is a flag. Otherwise `needs run`.
  ```
  BUD=$(git log -1 --no-merges --format=%h <base>..<head> -- apps/server/src/personal/agentContextBudget.json apps/server/src/provider/agentContextBudget.json)
  for c in $(git log --no-merges --format=%h <base>..<head> -- 'apps/server/src/mcp/toolkits/*/tools.ts' apps/server/src/personal/personalBotInstructions.ts); do
    if [ -n "$BUD" ] && git merge-base --is-ancestor "$c" "$BUD"; then echo "$c measured"; else echo "$c UNMEASURED"; fi
  done
  ```
- **check 2 (should-fix, git):** Does every commit in the range that raises a budget value stand alone, carry its measurement, and cite the owner's OK in its body? The rule is in the test (`agentContextBudget.test.ts:46`). A lead's approval is not the owner's OK.
- **incidents:** 15 Nov 2026, 1.67.24 gate run 1 failed server-tests at 74546 against 74511. `47757c4149` lengthened `delegate_task` text after `ce68acb3d8` measured the budget on another branch. The proxy above prints `47757c4149 UNMEASURED` at the rc cut and `measured` at the release head (measured 17 Nov). Fixed by trimming in `cff9ad944c`. 14 Nov 2026, `ce68acb3d8` raised the budget to 74511 and states that the ratchet needs the owner's OK. The only approval on record is the lead's (cold run, check 2). 13 Nov 2026, `0670f399c6` regenerated budgets after an upstream sync.
- **added:** 2026-11-17. **last-hit:** 2026-11-15.

### R05 contract-shape-consumers
- **trigger:** `packages/contracts/src/**` `!**/*.test.*`
- **check 1 (should-fix, git):** When a contract schema gains a required field, renames or narrows one, are the tests and fixtures in every consumer (`apps/web`, `apps/hbots-mobile`, `apps/server`, `packages/personal-client`) updated in the same range? An added optional field needs no fixture change.
- **check 2 (should-fix, planner):** Does the tree's plan (`tree-plan.txt` from the planner commands) run each changed consumer's tests?
- **incidents:** 12 Nov 2026, the 1.67.8 first gate failed web-tests and web-tsc on two stale `apps/web` tests (saved pin order, new `cpuTempC`, `diskTempC`, `fans` fields). Poteto fixed them test-only in `244b94816e` and all nine gates reran.
- **added:** 2026-11-17. **last-hit:** 2026-11-12.

### R06 json-decode-tolerates-old-shape
- **trigger:** `apps/hbots-mobile/src/**/*.ts` `apps/hbots-mobile/src/**/*.tsx` `packages/personal-client/src/**/*.ts` `!**/*.test.*`
- **added-lines:** `Schema\.(decode|decodeUnknown|validate)|toCodecJson|JSON\.parse`
- **check 1 (must-fix, git):** Does each new decode of a body from the server, the disk cache or another app version go through the JSON codec (`Schema.toCodecJson`) and survive a missing or wrongly typed optional field, with a test that feeds an old-shape payload?
- **incidents:** 8 Nov 2026, `a2ccf128f2`. Thread snapshots were decoded with the type-side schema, so every chat open threw on an ISO date and the cache never painted. 16 Nov 2026, `e3f0ff27b3`. A strictly typed `perfOff` made the whole compat read fail, including the minimum version and the update offer.
- **added:** 2026-11-17. **last-hit:** 2026-11-16.

### R07 migration-id-and-backup
- **trigger:** `apps/server/src/persistence/Migrations.ts` `apps/server/src/persistence/Migrations/*.ts` `apps/server/src/persistence/upstreamMigrationIds.ts` `scripts/personal/sync/resolve-migrations.ts` `!**/*.test.*`
- **check 1 (must-fix, git):** Is each new migration, fork or upstream, registered under the next free id with no gap? The max id of a rev is `git show <rev>:apps/server/src/persistence/Migrations.ts | grep -oP '^\s*\[\K\d+(?=,)' | sort -n | tail -1`.
- **check 2 (must-fix, ship):** Do the release params pass `--migration-before <base max id> --migration-after <head max id>`, so the runner takes a backup? Settle with `grep -o -- '--migration-[a-z]* [0-9]*' dev-team/qa/hbots-<version>/ship/params.txt`. Before the params exist, write the expected pair in VERIFY.md as a hand-forward to the Shipper and mark `needs run`.
- **incidents:** 6 Nov 2026, `6357e13b38` held upstream 063 back one release. 13 Nov 2026, `0670f399c6` renumbered upstream 081 to 087 as 149 to 155 after a sync. 16 Nov 2026, `a2d155e852` released 063 as id 160; the 1.67.33 sheet made a skipped backup a STOP.
- **added:** 2026-11-17. **last-hit:** 2026-11-16.

### R08 migration-drops-what-tools-read
- **trigger:** `apps/server/src/persistence/Migrations/*.ts` `apps/server/src/persistence/Migrations.ts` `apps/server/src/persistence/upstreamMigrationIds.ts` `!**/*.test.*`
- **added-lines:** `(?i:drop\s+(table|column)|rename\s+(to|column))|Drop[A-Z]|Rename[A-Z]`
- **check 1 (must-fix, git):** Does every reader of a dropped or renamed table or column still work: server tests that seed it, the release backup check (`hbots-release/lib/dbcheck.mjs`, `lib/fixture.mjs`, `scripts/personal/sqlite-check.cjs`), and the previous release's `dbcheck.mjs` reading a new backup?
- **incidents:** 16 Nov 2026, two changes in the 1.67.33 branch, caught before release. `cc6c0ac50c` stopped server tests seeding `projection_thread_activities`, and `54c5ec469f` moved the backup check off that table. The old tool reads `"rows":null` on a new backup (`qa/hbots-dbsize/build/BUILD.md`).
- **added:** 2026-11-17. **last-hit:** 2026-11-16.

### R09 runtime-version-bump
- **trigger:** `.node-version` `package.json` `pnpm-workspace.yaml` `scripts/personal/linux/hbots-release/lib/config.mjs` `scripts/personal/linux/systemd/hbots-runtime-path.conf`
- **added-lines:** `(?i)"node"\s*:|packageManager|pnpm@|sqlite|/node/\d+\.\d+\.\d+|^\s*v?\d+\.\d+\.\d+\s*$`
- **check 1 (should-fix, run):** Does a Node, SQLite or pnpm version change run the migration tests and the server suite on the new runtime, and does the gate itself run on that runtime?
- **incidents:** 14 Nov 2026, 1.67.22 shipped Node 24.22.3 with "Gates 9 of 9 PASS on Node 24.22.1" (`apps/personal-bots.md`). 15 Nov 2026, `73f65b4518`. SQLite 3.54.1 in Node 24.22.3 stored migration 026's options as strings and its test failed.
- **added:** 2026-11-17. **last-hit:** 2026-11-15.

### R10 upstream-merge-keeps-fork-guards
- **trigger:** `scripts/personal/sync/**`
- **subject:** `(?i)^merge:? upstream|merge upstream`
- **check 1 (must-fix, git):** For each upstream-owned file the merge touched that also carries fork lines (`git log --author=haroutB5 -- <file>`), are the fork's guards and helpers still in the merged file, and do fork tests that encode upstream behavior still state the fork's intent?
- **incidents:** 7 Nov 2026, `86ee38d120` restored v1 helpers the merged bundle still imported. 8 Nov 2026, `5ed016bf4c`. The v2 port dropped the guard that refuses a database whose migration ids would skip the V2 schema. 13 Nov 2026, `0670f399c6` repaired two merge slips (mise guard, "full" reset kind) and `eab58e48f3` fixed upstream code that the fork's pinned playwright-core 1.60 cannot run.
- **added:** 2026-11-17. **last-hit:** 2026-11-13.

### R11 phone-flow-proof
- **trigger:** `apps/hbots-mobile/src/chat/**` `apps/hbots-mobile/src/screens/**` `apps/hbots-mobile/src/shell/**` `apps/hbots-mobile/modules/**/*.kt` `!**/*.test.*` `!**/test/**`
- **check 1 (should-fix, git):** For each daily-use flow the change touches (attach and send photos, camera entry, replies shown in-app), is there an emulator or device record, not only unit tests? Proof lives under `/home/harout/Claude/AI/dev-team/qa/<task>/` as a VERIFY or BUILD file, linked from the brief or found with `grep -rl -e <commit sha> -e <branch> /home/harout/Claude/AI/dev-team/qa --include='*.md'` for each matched commit. The record names the build (sha or APK version), the emulator or device, the flow steps and the counts seen. No record is a flag. A matched file that is in no daily-use flow is n/a with the reason.
- **incidents:** 16 Nov 2026, Harout found by hand that 1.67.27 sent 1 of 3 picked photos and showed a camera in the composer (fixed in 1.67.28), and that 1.67.31 pushed replies on the Tasks tab instead of showing them in-app (fixed in 1.67.32, `src/shell`). Replayed red in `qa/hbots-daily-use/VERIFY.md`.
- **added:** 2026-11-17. **last-hit:** 2026-11-16. **retire:** when S6 (`verify-hbots-android`) runs before each phone release.

### R12 apk-check-allowlist-grew
- **trigger:** `apps/hbots-mobile/scripts/verify-apk*.mjs`
- **check 1 (must-fix, git):** Did a name join the exported-component allowlist (`expectedExported`, `widgetProviders`), or did a check loosen (a FAIL made a warning, a required permission made optional)? Read `git diff -U0 <base> <head> -- apps/hbots-mobile/scripts/verify-apk.mjs`. Each growth needs a cited reason in the file next to the entry or in the commit body: who reaches the component, that it is exported, and which permission guards it. The entries there today each carry one (`ProfileInstallReceiver`, `ShareActivity`, `CtoTileService`, `DebugPushReceiver`, `ShortcutTrampolineActivity`, `FCM_RECEIVER`). A growth with no reason is a flag.
- **check 2 (must-fix, git):** Does each newly allowed exported component also get its own shape check in the same file (exported, permission, actions), as the eight widget providers and the Firebase receiver do? A name in the list with no shape check lets any manifest entry of that name through.
- **check 3 (should-fix, git):** Does the same range add the exported component the allowlist now names (a manifest, plugin or module edit that sets `android:exported="true"`)? An allowlist edit with no component behind it is growth with no reason.
- **incidents:** 12 Nov 2026, 1.67.11 stopped at the APK build (`qa/hbots-16711/ship/STOPPED-3.md`). `dfae33bfcd` added seven exported widget receivers and `expectedExported` listed one, so the `exported` check printed FAIL. The Shipper did not edit the list: "a security allowlist, not bookkeeping". `5a1d157f60` extended it to all eight and added a check that each is exported with no permission and answers only the widget update. The same list grew earlier for the shortcut trampoline (`57c48640d0`) and the Firebase receiver (`04d69f9aae`).
- **added:** 2026-11-18. **last-hit:** 2026-11-12.

## Known gaps

No item covers these. Each gets an item at its first real incident.

- **Release tool files outside R02 and R03.** `hbots-release.mjs`, `PINS.json` and `lib/{dbcheck,fixture,backup,idle}.mjs` from the branch first run after install, at the next release. No stop on record came from them. The ship folders under `dev-team/qa/hbots-167*/` hold STOPPED files only for 1.67.11 (parity, APK allowlist), 1.67.28 (R02) and 1.67.34 (R03). Today they are covered by the release-tools tests the planner selects and by the post-release install dry plan (handbook, 16 Nov). R08 reaches `dbcheck.mjs` and `fixture.mjs` only when a migration rides along.
- **Phone folders outside R11.** `src/work`, `src/tasks`, `src/bots`, `src/sheets`. Both phone faults on record were fixed in R11 paths (`src/chat`, `modules`, `src/shell`).
- **R08 tuning.** Its regex was tuned on the replay set. S9's held-out set should score it.
