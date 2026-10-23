# hbots 1.66.86: the compact work log in chat

The chat drew each batch of tool work as its own large card ("22 steps", "Working · 44 steps"). Harout approved the T3 mobile work-log mockup on 23 Oct; this release builds it.

## Changes

- **One compact summary line per batch.** 32px tall, no border or card: a small chevron, a family icon, one muted label, and a red failed count on the right. A batch of one family reads as an action: "Ran 3 commands", "Read 8 files", "Edited 2 files", "Browsed 2 pages". Mixed work keeps the neutral "N steps". Failures always ride the line: "Ran 3 commands · 1 failed".
- **Live work is a single line.** While the turn runs, the summary shows the current action (for example "Ran vp test run") with a pulsing dot and the step count on the right, instead of a "Working · N steps" card.
- **The expanded list is compact.** 30px rows, one line each, a muted second line only when the entry has a detail different from its label, and a red x on a failed row. Related calls stay behind the summary until tapped.
- The Settings hint now says "The compact work rows showing what a bot did between replies, like 'Ran 3 commands'."
- No schema change, no provider change, task concurrency stays 5.

## Validation

- New pure tests for the summary: one-family actions, mixed work, a failed count, reads and edits, an empty live batch (4 tests passed).
- Focused web tests for the personal chat and settings pass; web typecheck passed; changed-file lint and formatting passed.
- The approved mockup is `C:/Claude/AI/dev-team/published/hbots-working-steps-mockup.html` (same layout and metrics at 390px).

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `17cea25c5c35` (binary only) if the smoke fails. This is a web-only chat change; the steering fix from 1.66.85 is already live.
