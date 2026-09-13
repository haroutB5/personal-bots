# Handoff: Claude + GPT token-usage windows in personal Bots UI (ms-usage-ui)

## Plan (written before code)

- Data hook: NO new server endpoint. Provider `usageLimits` already arrive on the
  web config stream (`serverEnvironment` subscribes with `usageLimitsCommand: true`;
  `primaryServerProvidersAtom` in `apps/web/src/state/server.ts`). The personal
  settings screen already reads that atom for bot provider lines. A manual
  Refresh button reuses the existing `serverEnvironment.refreshProviders` command
  (same as mobile `useRefreshLimits`).
- New pure module `apps/web/src/features/personal/usagePresentation.ts`:
  - `selectUsageCards(providers, now)` → one card per driver (`claudeAgent` →
    "Claude", `codex` → "GPT"), each with a session window (kind `session`) and a
    weekly window (kind `weekly`), plus status: `ready | unavailable | notreported`.
  - `formatResetCountdown(resetsAt, now)` → "resets in Xh Ym" / "resets in Xm" /
    "resets now" / null (own helper; `relativeTime.ts` only formats the past).
  - Reuses `remainingPercent`/`limitsNotice` from `@t3tools/shared/usageLimits`
    for math both clients agree on.
- New component `apps/web/src/features/personal/PersonalUsageSection.tsx`:
  - `<section aria-labelledby="settings-usage">` with one card per provider,
    labelled `<progress>`-role bars (`role="progressbar"` + aria-valuenow/min/max/label),
    reset lines, unavailable/stale states ("not reported", never 0%).
  - Styling: `personal.css` `--personal-*` tokens only; light tokens exist today,
    dark inherits app default (verify contrast by inspection).
  - Countdowns tick via existing `useMinuteNow()`.
- Wire into `PersonalSettingsScreen.tsx` between Bots and Routines sections.
  No new tab (`PersonalTabBar.tsx` untouched).
- Tests: `usagePresentation.test.ts` next to the module (pure model tests, same
  pattern as `taskPresentation.test.ts`).

## What changed (files)

- `apps/web/src/features/personal/usagePresentation.ts` (new): pure model —
  `selectUsageCards(providers, now)` (Claude via `claudeAgent`, GPT via `codex`;
  session = kind `session`/`five_hour`, weekly = kind `weekly`/`seven_day*`;
  freshest instance wins; `unavailable` vs `not-reported`, never 0%) and
  `formatResetCountdown(resetsAt, now)` ("resets in 2h 30m" / "resets now" / null).
- `apps/web/src/features/personal/usagePresentation.test.ts` (new): 9 tests,
  same `vite-plus/test` pattern as `taskPresentation.test.ts`.
- `apps/web/src/features/personal/PersonalUsageSection.tsx` (new): "Usage"
  section — one `--personal-*`-token card per provider, labelled progress bars
  (`role="progressbar"` + valuenow/min/max), reset lines, `Updated Xm ago` via
  `formatRelativeTime`, 44px refresh button reusing
  `serverEnvironment.refreshProviders` (no new endpoint; data arrives on the
  existing config stream via `primaryServerProvidersAtom`). Countdowns tick via
  `useMinuteNow()`.
- `apps/web/src/features/personal/PersonalSettingsScreen.tsx` (edit): mounts
  `<PersonalUsageSection />` between Bots and Routines sections. No new tab.

## Gate output

- New tests: `vp test run --project unit src/features/personal/usagePresentation.test.ts`
  → 1 file, 9 tests, all pass.
- `tsc --noEmit` (apps/web) → 0 errors.
- `vp lint --report-unused-disable-directives` on the 4 touched files → clean.
- Full web suite: 393/394 files pass (4930/4933 tests). The 3 failures are in
  `src/cloud/connectCliAuth.test.ts` and are PRE-EXISTING on clean HEAD
  (verified via `git stash -u` + rerun: same 3 fail without my changes;
  env-dependent Clerk/relay config assertions, untouched by this work).

## Open issues / not done

- None. Did NOT: new tabs, new server endpoints, mobile changes, deploys.
- Contrast note: bars are decorative (text + aria carry the values); all text
  uses `--personal-text` / `--personal-text-secondary` like sibling sections.
