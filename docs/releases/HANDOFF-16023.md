# 1.60.23: unread chats for team lead bots

Harout: "Add an 'unread chat' icon for team lead bots."

Branch `feat/lead-unread` (worktree `C:/Claude/AI/_wt/hbots-unread`), on main aed30cc3d0 (1.60.22). Staged release **bbd48181df3b** (`build.ps1 -CopyExternals -NoActivate`, exit 0). No migration, no new RPC; one additive optional contract field pair.

## How unread works

- Server (`PersonalBotRepository.listThreadLinks`): a link is `unread: true` (+ `lastReplyAt`) when the chat's newest **assistant** message is newer than `personal_bot_threads.last_viewed_at`. Only for chats a list shows: not archived (link or thread), not deleted, not a group relay. One extra indexed `max(created_at)` per eligible link inside the existing list query: no extra request.
- Never-opened chats: `last_viewed_at` falls back to `personal_meta.chat_unread_since`, written once by the first list after this release, so old history does not all light up on upgrade.
- Viewed time: `reportViewing` now stamps `last_viewed_at` at once when a connection leaves a chat (null report, switch chat) and on socket close with a fresh open report. The 1-minute heartbeat throttle is unchanged for the open chat. A reply that lands while the chat is open is therefore read.
- Client (`unreadChats.ts`): `showsUnreadChats(bot)` = team lead (the one switch for other bots later). This device's seen state (in memory): the open+visible chat never counts; a chat left is read up to that moment, so the dot clears without waiting for a refetch.

## What shows where

- Bots list row (lead): count pill at the right of the status line (Settings badge style, 18 px). Spoken ", N unread chats".
- Pinned tile (lead): dot top-right of the face (status badge stays bottom-right). Tile label ends "N unread chat(s)".
- Lead's chat list: dot before the title, title semibold, ", unread" for VoiceOver. Archived rows never. Refetches the list when one of its chats finishes a turn (debounced 400 ms).
- Not in the cold-start snapshot.

## Counts / doesn't count

Counts: any open (non-archived) chat of a lead with a newer assistant reply, including task chats. Doesn't: archived chats, deleted threads, group relays (group conversations are their own rows), the owner's own messages, system/reasoning rows, replies from before the baseline, non-lead bots.

## Tests

Server: `PersonalBotRepository.unread.test.ts` (5), `PersonalPushService.test.ts` (+1 leave stamps viewed). Web: `unreadChats.test.ts` (10), `BotThreadsScreen.unread.test.tsx` (3), `PinnedStrip.test.tsx` (+1).
Throwaway E2E 15/15 on bbd48181df3b: `C:/Users/Ht/.personal-bots/qa/frontend-unread16023/` (`e2e.mjs`, `results.json`, screenshots 390x844 light+dark). 3 Sonnet 5.5 low turns.
