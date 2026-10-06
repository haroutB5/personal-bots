# 1.60.20: read archived chats

Harout: "If i click on an archived chat, i want to be able to just read it so i know what it is about and if i want to unarchive it."

Branch `feat/archived-read-only` (worktree `C:/Claude/AI/_wt/hbots-archread`), on main e29303b253 (1.60.19). Web only, no server change, no migration, no contract change. Staged release **7c1fabe01aca** (`build.ps1 -CopyExternals -NoActivate`, exit 0).

## What changed

- **Bot chat list** (`BotThreadsScreen.tsx`): an archived row is now a link to the chat. Swipe Unarchive/Delete and the desktop-only buttons stay.
- **Archived bot chat** (`ConversationScreen.tsx`): archived = the shell's or the bots-list link's `archivedAt` is set. It opens read-only:
  - `ArchivedChatBar` (new, shared) in the composer's place: "Archived. Unarchive to send messages again." with Delete and Unarchive (44 px).
  - No session prewarm and no viewing report (that writes `personal_bot_threads.last_viewed_at`, the task-chat auto-archive clock). Both wait until the shell and the bots list are loaded, so a cold open can't fire them before the archive state is known.
  - `MessageList readOnly`: cards (questions, secrets, logins, connection approvals, lead-bot changes, memory changes) stay readable inside a disabled `<fieldset>`; pinned approvals hidden; no Retry; Wrapup disabled; routines strip hidden; the menu says "Unarchive chat".
  - Unarchive restores in place (composer back). Delete uses the existing confirm and returns to the bot's chats.
  - Unchanged: a chat reopened by a PWA relaunch that has since been archived still goes quietly back to Bots (`useLeaveResumedChatIfGone`). Back rules unchanged.
- **Archived group** (`GroupConversationScreen.tsx`): it already opened read-only with Unarchive. It now uses the same bar, adds Delete (opens the existing delete sheet), passes `readOnly`, and hides the round Continue card and the vote card while archived (both start work).

## Tests

- `ConversationScreen.archived.test.tsx` (7), `BotThreadsScreen.archived.test.tsx` (2), `GroupConversationScreen.archived.test.tsx` (3), `MessageList.test.tsx` (+2).
- Throwaway E2E, 18/18 PASS on 7c1fabe01aca: `C:/Users/Ht/.personal-bots/qa/frontend-archived16020/` (`seed.mjs`, `browser.mjs`, `results.json`, screenshots at 390x844 in dark and light). Seed used one Sonnet 5.5 low turn. The first build (072232aec162, without the viewing fix) showed opening an archived chat wrote `last_viewed_at`; that run is kept in `run1-build072232/`.
