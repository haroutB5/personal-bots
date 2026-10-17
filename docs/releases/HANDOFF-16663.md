# HANDOFF 1.66.63

Three fixes from QA's overnight bug hunt of 17 Oct and QA on 1.66.62, on top of the live
1.66.62. No live data is touched: nothing here edits the database by hand and there is no
migration (the maximum stays 111). Staged only; nothing is activated.

**This release was rebuilt after two failed smoke runs.** The first staging, `ea54da1ead84`, was
built in this worktree with no `.env`, so `apps/server/vite.config.ts` baked an empty T3 Connect
public config into its bundle: it could not pair or sign in, release smoke failed twice and rolled
back, and live stayed 1.66.62. `ea54da1ead84` and its notes commit `998ee0d834` are left in place,
unshipped. The release staged now is `9d0d33b46120` (display name 1.66.63): the same app code plus
the build guard in section 5, built after the repo `.env` was copied into the worktree (gitignored;
`git status` stayed clean; no value was printed or committed).

Branch `release/hbots-16663`, based on the live notes commit `b32a929dd4`; `origin/personal-bots/main`
(`9abfb8b4d1`, the merge of the 1.66.62 notes into main) is merged in as `8a4acc3ae4` with no content
change, so main can fast-forward to the notes commit afterwards. Code commits: `8015bb6501` (the
composer echo guard), `5eba7ba930` (the stranded pending turn-start row), `8517c42843` (three more
hidden skills, plus the version bump), `9d0d33b461` (the build-time T3 Connect config guard; tooling
only, no app code).
`PERSONAL_TASKS_CONCURRENCY` stays 5. Nothing about compaction changed: no `autoCompactWindow`, no
compaction setting or cadence touched.

## 1. A quick second send is no longer mistaken for a keyboard echo

**Symptom** (QA hunt, `SUMMARY.md` finding 1, medium): send "Meet at 7", paste "Meet at 8" and send
within 1.5 s, and the second message disappears; the composer is empty, Send disabled, no draft and
no send. Reproduced at about 385 ms and 940 ms, not at 1.9 s.

**Root cause, in the client** (`apps/web/src/features/personal/PersonalComposer.tsx`): not the
offline outbox, not the send-once path and not the server. The composer's echo guard
(`SENT_ECHO_WINDOW_MS = 1_500`, 1.66.x) drops any change that `isSentTextEcho` matches, and that
content test accepted "the same text with its last word committed differently" - the stem rule
added for iOS predictive text. A genuinely new message that kept the stem and changed the last word
was therefore thrown away as if the keyboard had re-applied the sent text. The same rule also ate
the last character of a typed second message whenever the field reached that exact text, so a real
iOS paste was the visible case of a wider hole.

**Fix**: the content rule now only says what _could_ be an echo, and the event decides.
`isCommittedEcho(value, sent, input)` drops a stem match only when the event is a keyboard commit -
`isComposing`, `insertCompositionText`, `insertFromComposition` or `insertReplacementText` - and
never when the input is one a person drove (`insertFromPaste`, `insertFromDrop`, `insertFromYank`,
`deleteByCut`, `deleteByDrag`, `historyUndo`, `historyRedo`). The sent text itself is still dropped
as before (that is the guard's original job), except when it arrives as a paste. The first change
that is not an echo ends the guard for good, which is what the old code already did, so ordinary
typing or a paste cannot be swallowed by a later event either.

**Tests**: `PersonalComposer.test.tsx` - two new cases (a pasted correction, and a whole-text
insertion with no commit signal, both sharing the sent message's stem) plus the rewritten existing
echo case, which now reports the composition the way iOS does; `isCommittedEcho` has its own two
cases. 60/60 in that file.

## 2. A pending turn-start row can no longer outlive its turn

**Symptom** (QA on 1.66.28, `qa16628/REPORT.md`: "stale pending turn row"): a message steered into a
running turn leaves a `projection_turns` row with `turn_id` NULL, `state` `pending`, forever. Two
such rows were in the live DB from 10 Oct; migration 106 (1.66.33) removed those, and 1.66.33 also
cleared the row when the provider reported the steered message taken in (`user-message.delivered`,
`ProjectionPipeline.ts`).

**What was still broken**: a `thread.session-set` that ends a turn with status `ready` only cleared
pending rows when its command id started with `server:provider-session-set:` - a prefix **no code in
the repo ever emits**, so that branch was dead. A provider that queues a mid-turn send as its own
turn (DeepSeek's dsh engine, Codex) holds the row until that turn starts; when the running turn ends
and the queued one never comes (queue dropped, process replaced) the row stayed pending for good.
Found live: a fresh row on thread `4ac75eaa` from a steer at 04:53 BST on 17 Oct, after 1.66.62 was
live, on a DeepSeek bot - the deliver-activity path does not apply there at all.

**Fix, cause**: in `ProjectionPipeline.ts`, every session status that has **no turn ahead of it**
(`idle`, `ready`, `error`, `stopped`, `interrupted`) clears the thread's pending turn-start row;
`starting` keeps it, because that is the turn about to run. `running` is untouched (it consumes the
row, as before). A queued send that is drained re-issues its own `thread.turn-start-requested`, so
it gets a fresh row and nothing about its timings is lost; the worst case of the wider clear is a
turn row that falls back to the session-set time for `requestedAt`/`startedAt`.

**Fix, cleanup**: `apps/server/src/orchestration/strandedTurnStarts.ts` - an additive, idempotent
repair forked once per server start (`server.ts`, next to the task-title backfill). At boot no
provider session is running, so a pending turn start is stale by definition; it deletes exactly the
stranded shape (the same `turn_id IS NULL AND state = 'pending' AND checkpoint_turn_count IS NULL`
as migration 106) and logs the count. Nothing writes to the live DB: it is the server's own boot.

**Idle classifier: unchanged, and no pin change.** `run/idle-classification-16617.mjs` has counted
`projection_turns` since 1.66.54: a pending turn-start row younger than its 10-minute horizon holds
the release gate, an older one is reported (`stalePending=`) and never blocks, so a stuck row cannot
hang a release forever. It also already counts `running`/`starting` sessions and a non-null
`active_turn_id`, so a live queued send is busy through the session anyway. The runner and its
hash pin are untouched, and `hbots-release.tests.ps1` does not need rerunning for this.

**Tests**: `ProjectionPipeline.test.ts` - a queued send whose turn ends on a provider-issued
`ready` session-set leaves no pending row (state `completed`), and a `starting` session-set keeps
one. `strandedTurnStarts.test.ts` - clears only the stranded shape, twice safely. Both files: 40/40
and 1/1. These live outside the fork gate's `src/personal` selection, so the builder ran them
separately (see the evidence below); DevOps' runner gate is unchanged.

## 3. Three more bundled skills are hidden, and the list is now 4

QA's 1.66.62 discrepancy 1 counted **7** advertised skills where the review promised 4:
`workflow-authoring`, `run` and `security-review` were still offered. They join
`PERSONAL_BOT_HIDDEN_SKILLS` (`apps/server/src/personal/personalContextBudget.ts`) as
`user-invocable-only`, so they leave the model's list while `/run` and `/security-review` still work
as slash commands. Kill switch unchanged: `PERSONAL_BOT_SKILL_TRIM=off`.

**Proof** (local mock-API capture, `dev-team/qa/hbots-16663-skill/RESULTS.md`): the installed Claude
CLI 2.1.302 driven through the SDK with the release's own policy module and the live shared plugin,
against a loopback mock that answers 500 so no tokens are spent. Trimmed: exactly **hbots-shared,
dataviz, update-config, claude-api** (4). With `PERSONAL_BOT_SKILL_TRIM=off`: 14, the same 4 plus the
three new names and the eight of 1.66.62, and the three `disallowedTools` names reappear. `/run` still
expands: its capture carries `<command-name>/run</command-name>` and the bundled `run` skill body.

## 4. The three untriaged WebKit fetch errors: browser artifact, not app code

The hunt's `back-results.json` holds three `pageerror` events, two for `/version.txt` and one for
`/.well-known/t3/environment`, all reading "Fetch API cannot load ... due to access control checks."
Triaged, not changed:

- Every app path that reads `/version.txt` catches its own failure: `bootVersionText` ends in
  `.catch(() => null)` and `readAppVersion` wraps the read in try/catch (`appVersion.ts`), and the
  chunk-recovery probe catches too (`chunkLoadRecovery.ts`). The descriptor read goes through Effect
  (`client-runtime/environment/descriptor.ts`), where a failure is a typed failure, not a throw.
- The wording is WebKit's for a request torn down by navigation, not a CORS policy the app sets: the
  server serves both paths same-origin.
- The same artifact is already on record from QA on 1.66.30 and in `HANDOFF-16631.md` ("the aborted
  in-flight `/version.txt` read on unload"), where the app reads were checked the same way.
- Each of the three arrives in a fresh document (the viewport warning repeats beside it), which is the
  unload/navigation shape, and the back flows all landed on the expected pages.

No fix: aborting the boot reads on unload would add code to hide a browser report and would cost the
stale-release check its whole purpose. QA can confirm with request-level tracing on the next back-phase
run, as its report asks.

## 5. A build without the T3 Connect public config is refused

**Cause of the two failed smoke runs**: `apps/server/vite.config.ts` defines
`__T3CODE_BUILD_RELAY_URL__`, `__T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__`,
`__T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__` and the relay OTLP values from `loadRepoEnv()`, which
reads the repo `.env`/`.env.local` and then the process env. A worktree created without `.env` bakes
empty strings silently; nothing in the build complained. `ea54da1ead84`'s `dist/bin.mjs` held **0**
occurrences of the relay URL (the live `6344f5b8527e` holds it) and its `bin.mjs connect status
--json` answered "T3 Connect is unavailable in builds without public configuration".

**Guard**: `scripts/personal/build.ps1` now calls two helpers from `scripts/personal/common.ps1`:

- `Assert-PbPublicBuildConfig`, before the build: refuses when `T3CODE_RELAY_URL` or
  `T3CODE_CLERK_PUBLISHABLE_KEY` resolves empty after `.env` is loaded, so a no-`.env` worktree fails
  in a second instead of after a 10-minute build.
- `Get-PbMissingBakedPublicConfig`, on `apps\server\dist\bin.mjs` after the build and **before the
  release folder is touched**: refuses when the bundle does not contain every value the env
  provided - the two required keys, plus `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` and the three
  `T3CODE_RELAY_CLIENT_OTLP_TRACES_*` values when they are set. A refused build stages and activates
  nothing.

Both print key **names** only, never values.

**Tests**: `release-safety.tests.ps1` has 9 new checks: the up-front pass and a whitespace-only
refusal, the refusal text naming no value, a bundle with both values (pass), a bundle without them
(both keys named), an optional key missing from the bundle, a fully baked bundle (pass), and the
wiring order (guard after `.env` loads and before `vp build`; bundle check before the release copy).
The suite reports 262 checks, 0 failed.

**Proof on the rebuilt release `9d0d33b46120`**: `dist/bin.mjs` sha256
`66be3d65033a837055826b8c43c5024fdcabc0789c34d9504555d843b6f7c895` contains the relay URL, the Clerk
publishable key and the CLI OAuth client id (compared in memory). From a shell with every
`T3CODE_*`/`PERSONAL_*`/`DSH_*` variable cleared first (`VITE_*`/`EXPO_PUBLIC_*` aliases too;
`env.remaining=0`), `node <release>\dist\bin.mjs connect status --json --base-dir ...\dev` exits 0
with valid JSON: `linked: true`, `authenticated: true`, `relayUrl: https://relay.t3.codes`,
`endpointUrl: https://prod-3b13e30646369ab7.t3coderelay.com/`. The failed `ea54da1ead84` answers the
same command with the "unavailable" text and the help only. Evidence:
`%USERPROFILE%\.personal-bots\qa\hbots-16663-connect-probe\rebuild-connect-proof.log`.

The app code is unchanged from `ea54da1ead84`; only `scripts/personal` differs.

## Builder verification

Run from the release worktree on the commit above, with `T3CODE_*`/`PERSONAL_*`/`DSH_*` cleared:

- `apps/server`: `vp test run src/orchestration/Layers/ProjectionPipeline.test.ts` 40/40,
  `vp test run src/orchestration/strandedTurnStarts.test.ts src/personal/personalContextBudget.test.ts`
  12/12.
- `apps/web`: `vp test run --project unit src/features/personal/PersonalComposer.test.tsx` 60/60.
- Build guard: `release-safety.tests.ps1` all passed (9 new checks); the rebuilt bundle's
  `connect status --json` answer is proven in section 5.
- `PERSONAL_TASKS_CONCURRENCY` is 5 at this commit; the idle classifier and its pin are unchanged; no
  migration; no compaction change.
- The fork gate (server tests + tsc, web tests + tsc, PowerShell tests, e2e) and the staged release are
  in the Gate evidence section below.

## What QA should focus on

1. The lost second send on a throwaway, phone-sized: send, then paste _and_ type a correction that
   keeps the first message's words and changes the last one, inside 1.5 s; both must survive and
   send as their own messages. Then the echo case: the sent text re-applied after Send must still be
   dropped, and `/` typed later must not be swallowed.
2. A steer into a running turn (Claude) and a mid-turn send on a DeepSeek/Codex bot: after the turn
   ends, `projection_turns` must hold no row with `turn_id` NULL and `state` 'pending'.
3. The skill list on a fresh bot session (Settings > the bot's chat): 4 skills, and `/run` still
   expands.
4. The new part in this rebuild: the phone pairs, signs in and reconnects through the relay on the
   shipped release, which is what the two failed smoke attempts covered. The app code itself is
   unchanged from the first staging.

## Gate evidence

<!-- gate-evidence:begin sha=9d0d33b461202491c7cc419af3139ba8d6c1b757 release=9d0d33b46120 json-sha256=5fcb9a505dc81660f9fde5a355db85e9f68063f540a580dbba5996e117d711be result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-17T05:37:39Z. Version 1.66.63, release `9d0d33b46120`, commit `9d0d33b461202491c7cc419af3139ba8d6c1b757` on `release/hbots-16663`, working tree clean, result **PASS**.

Machine-readable copy: `releases\9d0d33b46120\gate-evidence.json` (sha256 `5fcb9a505dc81660f9fde5a355db85e9f68063f540a580dbba5996e117d711be`) and the full gate logs in `releases\9d0d33b46120\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2920 tests passed, 0 failed, 4 skipped, in 210 files | 222.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 21.2    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2867 tests passed, 0 failed, 0 skipped, in 256 files | 37.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.4     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 262 checks ok, 0 failed                              | 63.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16663\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\9d0d33b46120" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 257.3   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `9d0d33b461202491c7cc419af3139ba8d6c1b757`, at end `9d0d33b461202491c7cc419af3139ba8d6c1b757`; tracked files modified: none. Staged release: version 1.66.63, sha 9d0d33b46120, dirty False, externals copied; `dist/bin.mjs` sha256 `66be3d65033a837055826b8c43c5024fdcabc0789c34d9504555d843b6f7c895`.
<!-- gate-evidence:end -->
