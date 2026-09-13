import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { CommandId, PERSONAL_TASK_TERMINAL_STATUSES, type PersonalBotId } from "@t3tools/contracts";

import type * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import type * as PersonalMemoryService from "./memory/PersonalMemoryService.ts";
import type * as PersonalBotService from "./PersonalBotService.ts";
import type * as PersonalRoutineService from "./routines/PersonalRoutineService.ts";
import type * as PersonalSecretService from "./secrets/PersonalSecretService.ts";
import type * as PersonalTaskService from "./tasks/PersonalTaskService.ts";

export interface PersonalBotPurgeServices {
  readonly bots: PersonalBotService.PersonalBotService["Service"];
  readonly tasks: PersonalTaskService.PersonalTaskService["Service"];
  readonly routines: PersonalRoutineService.PersonalRoutineService["Service"];
  readonly memory: PersonalMemoryService.PersonalMemoryService["Service"];
  readonly secrets: PersonalSecretService.PersonalSecretService["Service"];
  readonly engine: OrchestrationEngine.OrchestrationEngineService["Service"];
}

/**
 * Deletes a bot completely: stops its work (active tasks, pending secret
 * requests), removes its routines, chats, bot-scoped memories and the secrets
 * only it used, then tombstones the bot row. Shared memories and secrets stay.
 * Each cleanup step is best-effort so one failure never leaves the bot alive.
 */
export const purgePersonalBot = Effect.fn("purgePersonalBot")(function* (
  services: PersonalBotPurgeServices,
  botId: PersonalBotId,
) {
  const { bots, tasks, routines, memory, secrets, engine } = services;
  const step =
    (name: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("personal bot delete step failed; continuing", {
                botId,
                step: name,
                cause: Cause.pretty(cause),
              }),
        ),
      );

  const { tasks: botTasks } = yield* tasks
    .list({ botId })
    .pipe(Effect.orElseSucceed(() => ({ tasks: [] as const })));
  for (const task of botTasks) {
    if (PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status)) continue;
    yield* tasks.cancel({ taskId: task.taskId }).pipe(step("cancel task"));
  }

  const { requests } = yield* secrets
    .listPending()
    .pipe(Effect.orElseSucceed(() => ({ requests: [] as const })));
  for (const request of requests) {
    if (request.botId !== botId || request.status !== "pending") continue;
    yield* secrets.cancel({ requestId: request.requestId }).pipe(step("cancel secret request"));
  }

  const { routines: allRoutines } = yield* routines
    .list()
    .pipe(Effect.orElseSucceed(() => ({ routines: [] as const })));
  for (const routine of allRoutines) {
    if (routine.botId !== botId) continue;
    yield* routines.remove({ routineId: routine.routineId }).pipe(step("remove routine"));
  }

  const { threads } = yield* bots.list();
  for (const link of threads) {
    if (link.botId !== botId) continue;
    yield* engine
      .dispatch({
        type: "thread.delete",
        // Deterministic so a retried delete reuses the command receipt.
        commandId: CommandId.make(`personal-bots:thread.delete:${link.threadId}`),
        threadId: link.threadId,
      })
      .pipe(step("delete chat"));
  }

  const entries = yield* memory
    .list({ scope: "bot", scopeId: botId })
    .pipe(Effect.orElseSucceed(() => []));
  for (const entry of entries) {
    yield* memory.remove({ memoryId: entry.memoryId }).pipe(step("remove memory"));
  }

  const { secrets: stored } = yield* secrets
    .list()
    .pipe(Effect.orElseSucceed(() => ({ secrets: [] as const })));
  for (const secret of stored) {
    const onlyThisBot =
      !secret.shared && secret.botIds.length > 0 && secret.botIds.every((id) => id === botId);
    if (!onlyThisBot) continue;
    yield* secrets.remove({ name: secret.name }).pipe(step("remove secret"));
  }

  yield* bots.remove({ botId });
});
