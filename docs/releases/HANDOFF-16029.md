# hbots 1.60.29: chat chips in the chat header

Branch `feat/chat-chips` (from `personal-bots/main` 22eb8c6b67 = 1.60.28). Web only: no server or contract change, no migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5.

Spec: `C:/Claude/AI/dev-team/design/hbots/chat-switcher/SPEC-b-chat-strip.md`, layout H (Harout chose B on 3 Oct). Screenshots and measurements: `.../chat-switcher/build-1.60.29/`.

## What changed

- A bot's chat header shows slim chips for every chat the owner started with that bot: 24 px pills inside a 44 px tap band that overlaps nothing, one tap to switch, with "+" (new chat, optional name) and "All N" (the full list). Every bot, not only team leads. Group chats get no strip.
- Layout H: with 2 or more chips the header goes from 64 to 72 px. Line 1 is the name, context badge, state dot and word, and the model label (it truncates first); the chat's title is the highlighted current chip. With one chat nothing changes (64 px, no strip).
- `chatChipRows.ts`: which chats, in what order, and each chip's state.
  - Owner chats only: group relays and archived chats are dropped; a task or routine-run chat is dropped when a task in the feed points at it and was created at or before it (+ 5 s). A routine that runs inside an owner chat keeps that chat.
  - Order is creation time, oldest first; activity never moves a chip.
  - A task, routine or archived chat that is open gets a temporary first chip ("Task · title" / "Archived · title"); it is gone after switching away. The strip shows when owner chats + that chip are 2 or more.
  - One dot, the strongest wins: needs you > rate limited > working > waiting on a bot > unread (unread also makes the text heavier). Unread is not gated on `showsUnreadChats`, so non-lead bots show it; the Bots-list badges stay lead-only.
- `ChatChips.tsx`: the row (scrolls sideways with edge fades, the open chip is centred on open and smoothly after a switch, arrow keys move between chips), `NewChatDialog.tsx` for "+".
- Switching is `replace` with the current history state kept (`chatChipNavigation.ts`), so Back is still one tap to /bots, or to /bots/team when the chat was opened from Team. Drafts stay per chat. A tap on a chip does not blur a focused composer, and the next chat's composer takes the focus (`composerRefocus.ts`, expires after 3 s), so the keyboard stays up on iPhone.
- `startBotChat.ts`: `start({ replace, keepState, onCreated })`; a typed name is saved with the existing rename command before the chat opens (no server field).
- When another chip's chat finishes a turn the bots list is refetched (debounced, only while the strip shows), because the list carries the unread flag.
- A switch eases the new transcript in (8 px, 180 ms; reduced motion: a 120 ms fade), and the header-only first frame of a chat (`ConversationShellHeader`) is already 72 px when the header showed chips last time, so the chat does not drop 8 px as it mounts (`chatChipHandoff.ts`).
- Light theme: new tokens `--personal-chip-live` (darker team green) and `--personal-chip-review-dot` / `--personal-chip-dot-edge` (darker amber edge), per the spec's contrast numbers.

## Left out

- The old transcript's 120 ms fade-out on a switch (the transcript unmounts while the next chat loads); the new one fades in.
- "Line 1 fades in 160 ms" when the strip appears or goes away.
- A `chatKind` on the list link: a very old task chat whose task has left the feed can still show a chip (the spec's known gap).
- Pins and a server change, as decided.

## Gate

web unit `src/features/personal`, `tsc --noEmit` (web), changed-file lint 0 errors, `build.ps1 -CopyExternals -NoActivate`. Throwaway-root browser run at 390 px (dark and light) and 1280 px, with the fake Claude CLI and no model turns.
