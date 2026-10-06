# HANDOFF: hbots 1.64.5 (6 Oct 2026)

Branch `feat/newchat-name` (off 1.64.4, e8114cce7d). Web only: no server change, no migration. Concurrency stays 5.
Staged with `build.ps1 -NoActivate` (4 `.env` keys loaded), not active.

## What changed

Every "New chat" button now opens the existing "New chat with <bot>" name sheet (`NewChatDialog`) first, so Harout can type the title straight away
instead of renaming through the "..." menu. The name stays optional: empty + Start chat keeps the auto-title from the first message (two taps).
The chat is created and titled before it opens (`onCreated` rename), so it never shows "New chat" first.

Entry points (all through `useNewChatPrompt`, a small hook over `useStartBotChat` + `useRenameChat` that owns the sheet state):

- chat header "..." menu > New chat (`ConversationScreen`, plain push as before)
- "+" in the chat chips (`ConversationScreen`, replace + keepState + `markChatSwitched` as before)
- "New chat" button on a bot's chat list `/bots/$botId` (`BotThreadsScreen`)
- a bot row with no chats yet on the Bots page (`BotRow`)
- a pinned bot tile with no chats yet (`PinnedBotTile`)

The sheet mounts on first use, so a Bots list full of rows carries no extra listeners. Each entry point passes its own navigation options, so the Back rule
(chat back goes to /bots, Team-opened chats back to /bots/team) is untouched.

`useStartBotChat` now guards with a ref as well as the `starting` state, so two quick taps before a re-render still make one chat.

Left alone: the group chat "Message privately" action (`GroupConversationScreen`). It is not a New chat button: it reuses the bot's empty private chat when one
exists and only creates one otherwise, so a name prompt would not fit.

## Tests

`useNewChatPrompt.test.tsx` (named start renames before navigate, empty start does not rename, cancel creates nothing, per-opening options, double start) and
`startBotChat.test.tsx` (double start creates one chat). Browser proof on a throwaway root: `C:/Users/Ht/.personal-bots/qa/newchat-1645/` (`shots/`, `RESULT.md`).
