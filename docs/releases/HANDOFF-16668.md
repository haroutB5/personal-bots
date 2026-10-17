# HANDOFF 1.66.68

One UI change on top of 1.66.67: on the Bots home a bot that is working right now always sorts
above an idle bot, however much newer the idle bot's last activity is (Harout, 17 Oct: "Always sort
the working bots at first on top"). No migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5. Staged only; nothing is activated.

Branch `release/hbots-16668`, cut from `release/hbots-16667` `ccef0ef080` (which contains
`personal-bots/main` `99d7c00a8a`, so main can fast-forward). Code and version commit `a2f48a233b`;
staged release `a2f48a233bf0` (version 1.66.68, externals copied). Gate evidence: below.

## 1. Working bots first on the Bots home

The home list order was built in `buildBotSummaries` (`apps/web/src/features/personal/botSummaries.ts`)
by `lastActivityMs` alone. It now compares the working flag first, then falls back to exactly the
old order (newest activity, then the bot's own order, then name):

- **The working signal is `summary.live`**, the same derived flag the row already uses for its green
  dot and its "Working" label: `BotRow` draws the dot on `summary.live` and the label comes from
  `botStatus(summary)`, whose working branch is `summary.live`. `live` is
  `busyShells.some(isThreadLive)`, built from every linked thread, archived ones included, and a
  turn parked on a provider rate limit is not live. Sorting therefore cannot disagree with what the
  row shows.
- **Among working bots**, the old newest-activity order still applies. **Everyone else** keeps the
  old activity order; a bot with no chat stays last. The fallback tie-breaks are unchanged.
- **The pinned avatar strip** (`partitionPinnedSummaries`, the team-leads rail at the top of the
  home) now puts working pins first, newest activity first among them, then keeps its designed
  order for the rest (dev lead, assistant lead, other pins in list order). With no working pin the
  strip is exactly as before.
- **Search results** come from `filterBotSummaries`, which filters the already-sorted summaries and
  never re-sorts, so bot search results carry the working-first order with no separate change.
  Message search (`MessageSearchResults`) lists messages, not bots, and is unchanged.
- **Performance:** one boolean comparison per sort pair, no new subscriptions, timers or per-row
  memos. The per-bot activity memo, the windowing and every performance kill switch are untouched;
  the existing `newestFirst` decoration and `activity-memo` switch work as before.

Deliberately left alone:

- The **Team view** layout and the constellation/diagram positions (fixed by design; Harout's
  brief says so).
- The **chat chips inside a bot chat** (`chatChipOrder.ts`): pinned first, then latest activity,
  frozen while on the chat screen (Harout's 7 Oct rule).
- Groups in the home list stay together in their own block; snoozed chats stay in the Snoozed
  section.
- The cold-start snapshot keeps its stored render order; it is written from the same sorted list,
  so it picks up the new order without a format change.

## 2. Builder verification

- Targeted unit tests, web: `vp test run --project unit src/features/personal/botSummaries.test.ts
src/features/personal/botSummaries.pinned.test.ts` -> **45 passed, 0 failed**.
  - New: a bot working in an older chat sorts above a bot whose chat is three hours newer, and the
    same two bots return to activity order when that turn completes.
  - New: a working pin sorts above an idle lead, newest working pin first.
  - Updated: the old "orders by latest activity" fixture now expects its live bot first.
- Fork web gate, full personal suite: `vp test run --project unit src/features/personal` ->
  **2879 passed, 0 failed, 257 files** (was 2877; the two new tests).
- Typecheck: `tsc --noEmit` in `apps/web` exit 0. `vp lint` on the three touched files: 0 warnings,
  0 errors. `vp fmt` run on them.
- **Browser check on a throwaway fake-CLI server** (staged release `a2f48a233bf0`, fresh root,
  dark, 430 x 873, Chrome via the team's `ab.cmd` runner; screenshots and steps in
  `C:\Users\Ht\.personal-bots\qa\hbots-16668-sort\`):
  - `05-snoozed-working-top.png`: Planner is working (green dot, "Working") in a chat that is
    snoozed and so contributes no activity, and sits **first**, above Developer, which is Ready and
    2 minutes newer by activity.
  - `06-dropped-back-to-activity.png`: after that turn ended, Planner ("Ready") dropped to the
    bottom of the list and Developer is first: plain activity order again.
  - `03-working-above-newer-idle.png`: the same jump in the ordinary case, Planner working above
    Developer, whose "quick note" chat is newer.
  - `errors` was empty; the only console line was one Clerk `api_response_error` warning, which a
    throwaway root produces because it has no live Clerk session. No page errors.
  - The reviewed `ab.cmd` runner is Chrome-only (it refuses any other engine) and the repo's own
    e2e suite runs Chrome at 390 x 844 for the documented reason that Playwright WebKit taps do not
    fire on this app (`scripts/personal/e2e/stall-load.mjs`). The check therefore ran Chrome at the
    brief's 430 x 873 rather than WebKit. Nothing on the phone Safari rendering path changed: the
    edit is a comparator in shared list code.
- No migration; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## 3. What QA should focus on

A small, contained UI fix, so the builder proof above is the tier. If QA picks it up: on a
throwaway root, start a long turn on a bot that is not the newest, go back to the Bots home and
confirm that row is first with its green dot and "Working"; when the turn ends it must fall back to
its activity position. Check the pinned strip follows with a working pin. No new screen, no server
change.

## 4. Rollback

Binary only, to whichever release is live when this one ships: `64665fc15c30` (1.66.67, already
staged and waiting for idle) if that has landed first, otherwise `c29f265b50a9` (1.66.66). No
database change and no migration, so nothing to restore.

## Gate evidence

## Gate evidence

<!-- gate-evidence:begin sha=a2f48a233bf0068b6b345f9a5c312fc7f13f940c release=a2f48a233bf0 json-sha256=3d70f4c6b732b8a553d714c5ca4c1bb517d16881b01e72e06988fd4e6d0d520f result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-17T18:54:25Z. Version 1.66.68, release `a2f48a233bf0`, commit `a2f48a233bf0068b6b345f9a5c312fc7f13f940c` on `release/hbots-16668`, working tree clean, result **PASS**.

Machine-readable copy: `releases\a2f48a233bf0\gate-evidence.json` (sha256 `3d70f4c6b732b8a553d714c5ca4c1bb517d16881b01e72e06988fd4e6d0d520f`) and the full gate logs in `releases\a2f48a233bf0\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2926 tests passed, 0 failed, 4 skipped, in 210 files | 233.3   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 20.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2879 tests passed, 0 failed, 0 skipped, in 257 files | 33.2    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.5     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 262 checks ok, 0 failed                              | 70.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16668\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\a2f48a233bf0" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 260.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `1f5704746747a0f1fd17a6c9f43044d0755190d4`, at end `1f5704746747a0f1fd17a6c9f43044d0755190d4`; tracked files modified: none. Staged release: version 1.66.68, sha a2f48a233bf0, dirty False, externals copied; `dist/bin.mjs` sha256 `d4b3788c3ad9974cb78a5dde3895b8fbff73fa53cb02770b44877fcf1e44886b`.
<!-- gate-evidence:end -->
