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
