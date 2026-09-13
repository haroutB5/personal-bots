# Handoff: show ALL weekly windows per provider (Fable only)

## What changed

- `apps/web/src/features/personal/usagePresentation.ts`: replaced single `weekly: UsageWindowRow | null` with `weeklies: readonly UsageWindowRow[]` (all `kind === "weekly"`, fallback id contains `seven_day`/`week`, server order, deduped by id). `session` unchanged.
- `apps/web/src/features/personal/PersonalUsageSection.tsx`: renders `card.weeklies` as list (same bar markup per row); zero rows → `MissingRow "Weekly"` as before.
- `apps/web/src/features/personal/usagePresentation.test.ts`: updated assertions + new test for `five_hour` + `seven_day` + `seven_day_fable`.
- No server changes.

## Gate output

- pending (running)
