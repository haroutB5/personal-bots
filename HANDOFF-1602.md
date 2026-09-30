# HANDOFF 1.60.2: a reopened task no longer runs hidden in an archived chat

Backend, CTO task e4e36412. Branch `fix/archived-busy-task`, worktree `C:/Claude/AI/_wt/hbots-arch`, on 1.60.1 + perf budget (53c10c03e7).
Release staged, NOT activated: see the app sheet Status for the sha. Server + web, no migration, no contract change.

## What happened (30 Sep)

QA's task 49b34ed3 ("hbots full bug hunt", thread 2a187da6) finished; auto-archive (1.51) archived its
chat at 00:55:44Z, correctly. CTO reopened it with `steer_task` at 12:38Z. The continuation turn
started in the archived chat and nothing unarchived it, so:

- the chat stayed out of QA's list (`personal_bot_threads.archived_at` still set);
- the Bots row said Ready: `buildBotSummaries` computed live/thinking/waiting only from visible chats;
- at 13:00:45Z Harout tapped QA's row. With no visible chat, the row starts a new one
  (`BotRow` -> `useStartBotChat`), so the empty "New chat" f06d5830 is Harout's tap
  (`personal-bots:thread.create:*`, actor client, viewed 200 ms later). Not a stray create on reopen;
  a symptom of the hidden chat.

Root causes:

- `apps/server/src/personal/tasks/PersonalTaskService.ts` `reopen` (~1966) and every other turn
  source dispatch `thread.turn.start` without touching the chat's archive state.
- `apps/web/src/features/personal/botSummaries.ts` `buildBotSummaries` skipped archived links before
  computing `live`, `liveThread`, `thinking`, `waitingFor`; `TeamScreen` `liveBotIds` the same.

## Fix

Server, `PersonalTaskChatArchiveService`:

- `start()` also listens to `thread.turn-start-requested`; `unarchiveForTurn` clears `archived_at` and
  `auto_archived_at` when the chat is archived (never a group relay). One place for every source:
  reopen, steer, task continuation, routine run, the owner's message, group and lead turns.
  Clearing `auto_archived_at` makes it an ordinary chat again: once the new work finishes and sits
  30 min it can auto-archive again.
- Each sweep first unarchives an archived chat whose active turn was requested after the archive and
  is still running (`ARCHIVED_BUSY_CHATS_SQL`), even with auto-archive off. A turn older than the
  archive is the one the archive is stopping, so it never counts. This also heals the live QA case
  within 5 minutes of the restart if that turn is still running.
- Before archiving a candidate, the sweep re-reads the chat's task state (`TASK_CHAT_OPEN_WORK_SQL`);
  a task reopened after the candidate list was read keeps its chat. Live turn, background work and
  pending requests were already re-checked.

Web:

- `buildBotSummaries`: live, liveThread, thinking and waitingFor count every linked chat, archived
  or not. The row's chat, preview, titles and order stay on visible chats.
- `TeamScreen` live set counts archived chats too.
- `useRefreshBotsForTaskThreads` (Chats and bot chats screens): refetches the list when a chat it has
  as archived starts a turn (`archivedLiveThreadsKey`), so the unarchived chat appears without a reload.

## Tests

- Server `PersonalTaskChatArchiveService.test.ts`: turn starts from reopen, steer, routine and the
  owner unarchive (relay stays archived); an open chat is untouched; the sweep skips a chat whose task
  reopened or whose child opened after the list was read; the sweep heals an archived chat with a newer
  running turn and leaves one whose turn predates the archive.
- Web `botSummaries.test.ts`: archived running chat makes the row Working, never Ready; row chat stays
  visible-only; waiting label from an archived chat. `useRefreshBotsForTaskThreads.test.ts`:
  `archivedLiveThreadsKey`.

## After it goes live

- /version.txt 1.60.2.
- QA's 2a187da6: if its reopened turn is still running at restart, the first sweep (at startup)
  unarchives it; otherwise the next turn in it does. No one-off DB write needed.
- The empty QA "New chat" f06d5830 is harmless; Harout can delete it.
