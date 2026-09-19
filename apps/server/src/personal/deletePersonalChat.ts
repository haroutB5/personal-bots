import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalBotsError,
  type ThreadId,
} from "@t3tools/contracts";

import type * as PersonalGroupService from "./groups/PersonalGroupService.ts";
import type * as PersonalBotService from "./PersonalBotService.ts";
import type * as PersonalTaskService from "./tasks/PersonalTaskService.ts";

export interface PersonalChatDeleteServices {
  readonly bots: PersonalBotService.PersonalBotService["Service"];
  readonly tasks: PersonalTaskService.PersonalTaskService["Service"];
  readonly groups: PersonalGroupService.PersonalGroupService["Service"];
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
  const { bots, tasks, groups } = services;
  // A member thread is the bot's whole memory of a group conversation, and the
  // group's catch-up cursor points into it. Deleting it behind the group's back
  // would leave a member that has "read" messages it can no longer see, so the
  // only way out of a group is to remove the bot from it.
  const memberOf = yield* groups.groupNameForMemberThread(threadId);
  if (Option.isSome(memberOf)) {
    return yield* new PersonalBotsError({
      message: `This chat belongs to the group '${memberOf.value}'. Remove the bot from the group instead.`,
    });
  }

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
