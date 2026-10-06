# Model and effort instead of the bot title in the headers (1.53.2)

2026-09-29, Frontend (CTO task 8fc8e935). Branch feat/header-model-label (worktree C:/Claude/AI/_wt/hbots-153), on 1.53.1 (7bb7af8c05, release 54f42c2d5571). Harout: "in each bot chat, instead of the title of the bot showing, replace it with model and effort (ie. opus 5.5 H for cto)"; later: the Bots list rows use the same short form.

## What changed (web only)

One function, `botModelShortLabel` (botModelLabel.ts, the pinned tiles' function): "Opus 5.5 · H", "Sonnet 5.5 · H", "GPT-6-Astra · M". L / M / H / X / Max, model only when no effort is set. It now drives all four places:

- Pinned tiles (unchanged).
- Bots list rows: `BotRow` draws `summary.modelShortLabel` beside the name instead of the long "Sonnet 5.5 high". The full label stays on the summary for assistive text on the pinned tile.
- Chat header second line: `ConversationSubtitle` (new file) reads "<dot> <status> · <model label>", e.g. "Working · Opus 5.5 · H", "Waiting on Assistant · Sonnet 5.5". The bot title is gone from it.
- Bot's chats-list header (`BotThreadsScreen`): under the name, the short label replaces the title line. The 1.50 label beside the name is gone from this header (it would repeat the same words); title-less rows are unchanged.

**Provider name dropped from the chat header** ("Claude Code · Working" is now "Working · Opus 5.5 · H"). The model label already names the runtime. `conversationHeaderParts` (prefix + status) became `conversationHeaderStatus` only; "Update broke Claude Code" still names the provider, since that is the point of that state. Shrink order: the status never shrinks (shrink-0), only the model label truncates. At 390 px "Waiting on Assistant" leaves room for "Sonnet …"; "Waiting on 3 bots" or two long names can push the label out entirely, by design.

The bot title stays editable in the bot form and stays in the team diagram, the group sheets, the new-group picker and the search rows. Only the two chat headers and the list rows changed.

Live update: the label reads the bot from the list and the provider catalog, so a model or effort change shows on the device that saves it without a reload (checked: Developer effort Medium to High to Default, chat header "GPT-6-Astra · M" then "· H" then "GPT-6-Astra", list row the same, page `load` count stayed 1). Other open devices update on their next list refresh, as with the 1.50 label.

## Verification

- Gates on the head: web personal 0 (119 files, 1158), web tsc 0. Server and contracts untouched. New tests: ConversationSubtitle.test.tsx (status first, no provider name or title, status shrink-0 and label truncates, no label without a model), botSummaries.updateBroke.test.ts (status only), botSummaries.test.ts (row carries `modelShortLabel` "Opus 5.5 · H", full "Opus 5.5 high").
- Throwaway server (release 504ed790dcbb, fake Claude CLI by binaryPath, PERSONAL_SEED_MODEL=claude-sonnet-5-5, cap 5, Codex probed only and never messaged, root deleted; evidence ~/.personal-bots/qa/frontend-1532/): 390x844 dark and light.
  - a-chat-assistant (Claude with effort, Working), a-chat-planner (Claude, no effort, Idle), a-chat-developer (Codex, Idle);
  - a-threads-* (chats-list headers for the same three);
  - b-chat-planner ("Waiting on Assistant", from a seeded delegation task);
  - a-list / b-list (Bots list rows), live-after-change.png, edit.mjs / live.mjs (live change).

## Release

Release 504ed790dcbb (commits 9d2f57f2e3 header + version, 504ed790dc rows). An earlier staging 9d2f57f2e381 (headers only, before Harout added the list rows) is superseded. Rollback 1.53.1 = 54f42c2d5571.
