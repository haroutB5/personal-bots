# hbots 1.60.39: a bot chat always follows its bot's provider (stale phone selection no longer refused)

Branch `fix/bot-chat-provider-wins`, on main `5aca0b4857` (1.60.38). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -CopyExternals -NoActivate`.

## The bug

Harout moved several bots from Codex to Claude Sonnet 5.5 around 18:55 on 4 Oct. At 18:57:42 the reactor moved the Assistant's "Babolat" chat to Claude ("moving a bot chat to its bot's provider") and a turn ran. At 19:01:00 and 19:01:09 his next message, and its Retry, failed with "Couldn't send: Thread '1b59d447…' is bound to driver 'claudeAgent' and cannot switch to 'codex'."

Cause: the phone sent its own copy of the chat's model selection (still Codex: a PWA backgrounded across the move). The reactor's `botProviderSwitch` returned nothing when the bot was already on the chat's current instance ("the send's own selection applies"), so the stale Codex selection went through, and `buildSendTurnRequestForThread` refused a driver change on a started thread. Retry re-sent the same stale copy.

## The fix

- **Server** (`ProviderCommandReactor.ts`, `botProviderSwitch`): for any bot chat the bot's current model selection now wins on every turn, not only when the chat has to move. When the bot is on the chat's instance it returns the bot's selection with `freshSession: false` (no new session, the chat keeps resuming). When the bot is on another instance nothing changed: fresh session, chat and attachments carried over, `thread.meta.update` to the bot's selection. Covers every path that dispatches `thread.turn.start`: typed message, Retry, wrap-up, group rounds, task and steer turns, routines. A thread that is not a bot chat is untouched.
- **Web** (`chatModelSelection.ts`, new): `chatTurnModelSelection(bot, thread)` is the bot's selection whenever the bot is loaded, the thread's only as a fallback while it is not. Used by `PersonalComposer`, Retry (`buildRetryTurnInput`) and Wrap-up (`buildWrapupTurnInput`). Before, all three sent the thread's copy whenever the bot was on another instance.
- **Draft store**: the Bots composer does not read a persisted model selection from `composerDraftStore` (only the prompt and attachments), so there was no stale persisted draft selection to clear. The stale copies were the thread's and the bot's in memory on the phone, now both overridden by the server.

## Tests

- `ProviderCommandReactor.test.ts`: "a stale client selection never refuses a bot chat that already follows its bot": Codex bot, chat sends, bot moved to Claude Sonnet, next message moves the chat (existing path), then two more messages from the stale phone (Codex): both run on Claude Sonnet with no new session, no `provider.turn.start.failed`, thread selection stays Claude. Verified to fail on 5aca0b4857's reactor and pass with the fix.
- Web: `chatModelSelection.test.ts` (new), `failedTurn.test.ts` and `wrapupChat.test.ts` updated: the bot's selection wins on another provider, the thread's only while the bot is unknown.
- Full `vp test run src/orchestration/Layers/ProviderCommandReactor.test.ts src/personal` (server): 119 files, 1472 tests pass. Web `vp test run --project unit src/features/personal`: 170 files, 1688 tests pass. `npx tsc --noEmit` clean in apps/server and apps/web.

## Notes for QA

- Throwaway root, fake or free-model bots: put a bot on one provider, send, move the bot to another, send (chat moves), then send again with the old selection (the web test above, or `thread.turn.start` over the WebSocket with the old `modelSelection`): the turn must run, and the log must show no "bound to driver" error.
- Retry on a failed message re-sends with the bot's selection; a Retry after a provider switch works.
- Reactor log line "moving a bot chat to its bot's provider" appears once per real move, not on every turn.
- Kill switch: none; this removes a refusal. Rollback is the previous release.
