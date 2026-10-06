# Team diagram handoff

## Result

Implemented `/bots/team` for the personal Bots web app, with a measured SVG connector layer behind positioned, accessible owner and bot nodes. Added Team entry points to Settings and the Chats header.

## Files changed

- `apps/web/src/features/personal/TeamScreen.tsx` — Team screen, responsive measurement, SVG arrows/connectors, real bot links, live dots, loading/error/empty states, diagram key and accessible summary.
- `apps/web/src/features/personal/teamDiagramModel.ts` — pure wrapped layout, delegation classification/dedupe, connector path and summary functions.
- `apps/web/src/features/personal/teamDiagramModel.test.ts` — 1/3/8-bot layout, connector path, self/unknown exclusions, dedupe precedence and seven-day classification tests.
- `apps/web/src/features/personal/ChatsScreen.tsx` — 44px Network icon entry point; usage strip and cold-start logic left unchanged.
- `apps/web/src/features/personal/PersonalSettingsScreen.tsx` — Team row in the Bots settings section.
- `apps/web/src/features/personal/personal.css` — AA-contrast diagram tokens.
- `apps/web/src/features/personal/personalMode.ts` and `personalMode.test.ts` — keep the Chats tab active on `/bots/team`.
- `apps/web/src/routes/_personal.bots_.team.tsx` and `apps/web/src/routeTree.gen.ts` — static route and generated route registration.

## Decisions

- Delegation direction is parent task bot → child task bot. Every non-terminal child is active; a terminal child remains recent for seven days using `completedAt`, with `updatedAt` as a legacy fallback.
- Directed bot pairs are deduplicated. Active work wins when both active and recent tasks exist for the same pair. Self-links and bots no longer in the team are excluded.
- Rows contain at most four bots and reduce to three when phone width requires it. `ResizeObserver` only reacts to actual size changes; there is no animation or repaint loop.
- Live dots reuse `isThreadLive` directly from linked thread shells, avoiding the provider-heavy summary model.
- All diagram colors come from scoped `--personal-*` tokens. Solid owner lines and active/recent dashed lines use colors with at least 3:1 graphical contrast on the personal background; text uses existing AA tokens.
- No chart library, canvas, server change, deployment or app-version change.

## Gate output tails

### Personal unit tests

```text
Test Files  25 passed (25)
     Tests  147 passed (147)
  Duration  8.60s
```

Command: `apps/web/node_modules/.bin/vp test run --project unit src/features/personal`

### TypeScript

```text
Process exit code: 0
Zero TypeScript errors. Existing Effect suggestion diagnostics only.
```

Command: `apps/web/../../node_modules/.bin/tsc --noEmit`

### Lint

```text
Process exit code: 0
No lint output.
```

Command: `apps/web/node_modules/.bin/vp lint` on every touched TypeScript/TSX file, including the generated route tree.

### Additional checks

```text
Production build: passed (route tree generated)
Targeted format check: all matched files use the correct format
git diff --check: clean
```
