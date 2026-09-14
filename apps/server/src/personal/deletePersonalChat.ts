import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { PERSONAL_TASK_TERMINAL_STATUSES, type ThreadId } from "@t3tools/contracts";

import type * as PersonalBotService from "./PersonalBotService.ts";
import type * as PersonalTaskService from "./tasks/PersonalTaskService.ts";

export interface PersonalChatDeleteServices {
  readonly bots: PersonalBotService.PersonalBotService["Service"];
  readonly tasks: PersonalTaskService.PersonalTaskService["Service"];
}

/**
 * Deletes exactly one chat: first stops the work still bound to its thread,
 * then removes the thread and its bot-thread link row.
 *
 * The cancel step is what keeps the delete final. `PersonalTask` rows hold the
 * thread id independently of the thread, so a task left alive on a deleted
 * thread re-claims that id the moment it is woken (a delegated child
 * finishing, a sweep, a retry) and starts a provider turn on a chat the user
 * was told was removed. The bot purge has always done this
 * (`purgePersonalBot`); a single-chat delete needs it for the same reason.
 *
 * Cancelling is best-effort — one failed cancel must not strand the chat — but
 * the delete itself surfaces so the client can retry. Composition lives here
 * rather than inside `PersonalBotService` because `PersonalTaskService`
 * already depends on the bot service; the reverse edge would be a layer cycle.
 */
export const deletePersonalChat = Effect.fn("deletePersonalChat")(function* (
  services: PersonalChatDeleteServices,
  threadId: ThreadId,
) {
  const { bots, tasks } = services;
  const { tasks: all } = yield* tasks
    .list({})
    .pipe(Effect.orElseSucceed(() => ({ tasks: [] as const })));
  for (const task of all) {
    if (task.threadId !== threadId) continue;
    if (PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status)) continue;
    // Cancel cascades to the task's descendants, so a delegated child running
    // on its own thread stops with the chat that asked for it.
    yield* tasks.cancel({ taskId: task.taskId }).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal chat delete could not cancel a task; continuing", {
              threadId,
              taskId: task.taskId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  }

  yield* bots.deleteThread({ threadId });
});
