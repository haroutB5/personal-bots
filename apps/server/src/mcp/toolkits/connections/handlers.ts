import type { PersonalBotId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as Gateway from "../../../personal/connections/gateway.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ConnectionsToolError, ConnectionsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const gateway = yield* Gateway.PersonalConnectionGateway;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const tasks = yield* PersonalTaskService.PersonalTaskService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const refuse = (reason: string) => new ConnectionsToolError({ reason });

  // The same identity the other personal toolkits use: the capability says
  // this credential belongs to a personal bot's thread, the link says which
  // bot. No second auth path, and nothing the model can assert about itself.
  const callerBot = Effect.fn("ConnectionsToolkit.callerBot")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("bots");
    const link = yield* bots
      .getThreadLink({ threadId: scope.threadId })
      .pipe(Effect.mapError(() => refuse("Could not look up this thread's bot.")));
    if (Option.isNone(link)) {
      return yield* refuse("These tools are available only in a personal bot chat.");
    }
    return { threadId: scope.threadId, botId: link.value.botId };
  });

  /**
   * The task an approval parks, when there is one.
   *
   * Best effort by design: a chat with no running task still gets its card,
   * the bot is just not resumed automatically. Failing the call instead would
   * mean the gate is unavailable exactly when the bookkeeping is unusual.
   */
  const callerTaskId = Effect.fn("ConnectionsToolkit.callerTaskId")(function* (caller: {
    readonly threadId: ThreadId;
    readonly botId: PersonalBotId;
  }) {
    const shell = yield* snapshots
      .getThreadShellById(caller.threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<never>()));
    const turnId = Option.isSome(shell)
      ? (shell.value.session?.activeTurnId ?? shell.value.latestTurn?.turnId ?? null)
      : null;
    if (turnId === null) return null;
    const task = yield* tasks
      .resolveCallerTask({ threadId: caller.threadId, botId: caller.botId, turnId })
      .pipe(Effect.option);
    return Option.isSome(task) ? task.value.taskId : null;
  });

  return ConnectionsToolkit.of({
    list_connections: () =>
      Effect.gen(function* () {
        yield* callerBot();
        const described = yield* gateway
          .describe()
          .pipe(Effect.mapError((error) => refuse(error.reason)));
        return {
          connections: described.map((entry) => ({
            vendor: entry.vendorId,
            displayName: entry.displayName,
            operations: entry.operations,
          })),
        };
      }),
    connection_call: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerBot();
        const taskId = yield* callerTaskId(caller);
        const outcome = yield* gateway
          .call({
            operation: input.operation,
            arguments: input.arguments,
            caller: { threadId: caller.threadId, botId: caller.botId, taskId },
          })
          .pipe(Effect.mapError((error) => refuse(error.reason)));
        return outcome._tag === "completed"
          ? {
              status: "completed" as const,
              operation: outcome.operationId,
              result: outcome.result,
              approvalId: outcome.approvalId,
              summary: null,
              note: null,
            }
          : {
              status: "awaiting_approval" as const,
              operation: input.operation,
              result: null,
              approvalId: outcome.approvalId,
              summary: outcome.summary,
              note: outcome.note,
            };
      }),
  });
});

export const ConnectionsToolkitHandlersLive = ConnectionsToolkit.toLayer(make);
