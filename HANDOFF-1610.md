# hbots 1.61.0: a routine's bot decides whether a run notifies

Branch `feat/bot-decides-notify`, on top of `69383589f1` (the 1.60.45 HANDOFF commit), no force. Harout asked: "Is there an option for a bot to decide to trigger notification depending on their result?" Typical use: an hourly check that should only buzz when something changed. `PERSONAL_TASKS_CONCURRENCY` stays 5. Migration 098 (additive). Staged with `build.ps1 -NoActivate -CopyExternals`; `current.txt` untouched.

## What it does

- **Routine setting `notifyMode`**: `always` (default, exactly today's behaviour; every existing routine keeps it), `bot_decides`, `never`.
- **New bot tool `notify_user { notify: boolean, message?: string }`** (bots toolkit, next to `update_work_record`). Works inside a task or routine run; in a plain chat it is refused ("the user is already notified when you reply"). The last call in a run wins. The message is made one line, key-shaped strings are hidden, cut at 200 characters (`push/notifyDecision.ts`).
- **Push rules at run end** (`PersonalPushService.notifyTask`, decided by the pure `taskNotifyVerdict`):
  - `always`: as today; if the bot called `notify_user(true, msg)` the push body is `msg` instead of the task title.
  - `bot_decides`: a COMPLETED run pushes only after `notify_user(true)`, with its message as the body (the task title if it gave none); otherwise silent.
  - `never`: a completed run is silent.
  - In every mode a failed run and a "needs you" run (secret request, browser help, `waiting_for_user`) still push. Mute, notification preferences and Updates quiet hours still apply after this. The result still lands in the chat and Tasks; only the push/banner changes.
  - Log: `personal notification path` with `path: "bot-skipped"` or `"routine-never"`.
- **Prompt line**: a `bot_decides` run's objective gets one line appended (`BOT_DECIDES_NOTIFY_LINE`): this routine only notifies the user if you call `notify_user` with notify true; call it when the result is worth their attention, with a one-line message.
- **MCP**: `create_routine` and `update_routine` take `notifyMode`; `list_routines` shows it; their summaries say so when it is not `always`.
- **Web**: "Notify me" radio group (Every run / When the bot decides / Never) in the routine form (create and edit, schedule and event routines), and a "Notify me" row on the routine detail screen.

## Storage (migration 098, additive only)

- `personal_routines.notify_mode TEXT NOT NULL DEFAULT 'always'` (CHECK in the three values).
- `personal_tasks.notify_mode` (the mode the run STARTED with, copied from its routine inside the insert transaction, so editing or deleting the routine mid-run, or a one-off deleted right after it fires, does not change the run), `notify_decision` (0/1) and `notify_message`. All NULL for every existing task.
- A finished task queued again (retry, steer reopen) clears the old decision and message (`writeTask`); a task that merely waits for the user and resumes keeps them.
- Relay routines (no model turn) cannot be `bot_decides` (server refuses on create and update; the form hides the option). `never` and `always` are fine for them.

## Tests and checks

- Gate (exit codes read): server `vp test run src/personal` exit 0 (134 files, 1668 tests, 3 skipped); `src/mcp` + `src/persistence/Migrations` exit 0 (63 files, 357 tests); server `npx tsc --noEmit` exit 0; web `vp test run --project unit src/features/personal` exit 0 (174 files, 1755 tests); web `npx tsc --noEmit` exit 0.
- Unit tests per rule: `push/notifyDecision.test.ts` (verdict table, message cleaning), `PersonalPushService.test.ts` end of file (always and no-mode unchanged, bot_decides yes/no/never-called, never, failed and needs-you in every mode, mute on top), `PersonalRoutineService.test.ts` end of file (default always, prompt line, mode snapshot survives edit and delete, event routines, relay refusal), `PersonalTaskRepository.notify.test.ts` (decision, last call wins, requeue clears), `bots/handlers.test.ts` (`notify_user`: plain chat refused, recorded, cap, per-mode notes), `routineHandlers.test.ts`, migration `098_*.test.ts`, three web test files.
- Real check on a throwaway root (staged release `a92277edbf75`, port 39980, fake Claude CLI that calls the app's real MCP server, `PERSONAL_SEED_MODEL=claude-sonnet-5-5`, no real model call): `C:/Users/Ht/.personal-bots/qa/backend-notify1610/` (`e2e.mjs`, `e2e-result.json`, `root/` with the database and `server.log`). Five routines Run now: bot_decides + notify_user(true,"Price dropped to 120") queued ONE push, body "Price dropped to 120"; bot_decides + notify_user(false) queued none (log `path: 'bot-skipped'`); bot_decides never calling it queued none (`bot-skipped`); never queued none (`routine-never`); a routine made without a mode queued one push (path `push`). 2 outbox rows in total, 0 ERROR lines.
- Screenshots at 390 px, dark and light: `.../shots/m-{dark,light}-{create,detail,edit}-notify.png`.

## Rollback

Binary only: migration 098 only adds columns, so the previous release (1.60.45 = `21f7f6597c37`) runs on the migrated database and ignores them.
