import * as NodeCrypto from "node:crypto";

import {
  personalSecretEnvVar,
  type PersonalBot,
  type PersonalDelegationBrief,
  type PersonalTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as PersonalSecretService from "../../../personal/secrets/PersonalSecretService.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BotsToolError, BotsToolkit, type DelegateTaskInput, type TaskSummary } from "./tools.ts";

export const DELEGATE_NOTE =
  "You will receive the result in a follow-up message; end your turn now.";
export const REQUEST_SECRET_NOTE =
  "Requested. The user will enter it in a secure form; you'll be resumed. Never ask for it in chat.";

const toolError = (reason: string) => new BotsToolError({ reason });

/** The service errors carry messages written for people; they read fine to a model too. */
const readable = (error: { readonly message: string }) => toolError(error.message);

/** Same bot + objective in the same turn is one delegation, however often the model retries. */
export const delegationIdempotencyKey = (turnId: string, targetBotId: string, objective: string) =>
  `delegate:${turnId}:${targetBotId}:${NodeCrypto.createHash("sha256")
    .update(objective)
    .digest("hex")
    .slice(0, 24)}`;

/** Finds the target by exact id, then by case-insensitive name, among enabled bots. */
export function resolveTargetBot(
  bots: ReadonlyArray<PersonalBot>,
  target: string,
): PersonalBot | null {
  const enabled = bots.filter((bot) => bot.enabled);
  const byId = enabled.find((bot) => bot.botId === target);
  if (byId !== undefined) return byId;
  const wanted = target.trim().toLowerCase();
  return enabled.find((bot) => bot.name.trim().toLowerCase() === wanted) ?? null;
}

function summarize(task: PersonalTask, names: ReadonlyMap<string, string>): TaskSummary {
  return {
    taskId: task.taskId,
    rootTaskId: task.rootTaskId,
    parentTaskId: task.parentTaskId,
    botId: task.botId,
    botName: names.get(task.botId) ?? null,
    title: task.title,
    objective: task.objective,
    status: task.status,
    resultSummary: task.result?.summary ?? null,
    errorMessage: task.errorMessage,
    createdAt: DateTime.formatIso(task.createdAt),
    completedAt: task.completedAt === null ? null : DateTime.formatIso(task.completedAt),
  };
}

function briefOf(input: DelegateTaskInput): PersonalDelegationBrief {
  const title = input.title ?? input.objective.split("\n")[0]!.trim().slice(0, 80);
  return {
    title: title.length > 0 ? title : "Delegated task",
    objective: input.objective,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
    ...(input.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: input.acceptanceCriteria }
      : {}),
    ...(input.expectedOutput !== undefined ? { expectedOutput: input.expectedOutput } : {}),
  };
}

const make = Effect.gen(function* () {
  const tasks = yield* PersonalTaskService.PersonalTaskService;
  const botRepository = yield* PersonalBotRepository.PersonalBotRepository;
  const secrets = yield* PersonalSecretService.PersonalSecretService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const listBots = botRepository
    .listBots()
    .pipe(Effect.mapError(() => toolError("Could not read the bot list; try again.")));

  const botNames = listBots.pipe(
    Effect.map((bots) => new Map(bots.map((bot) => [bot.botId as string, bot.name]))),
  );

  // The capability says the credential belongs to a personal bot's thread;
  // the link lookup says which bot, and re-checks it.
  const callerBot = Effect.fn("BotsToolkit.callerBot")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("bots");
    const link = yield* botRepository
      .getThreadLink({ threadId: scope.threadId })
      .pipe(Effect.mapError(() => toolError("Could not look up this thread's bot.")));
    if (Option.isNone(link)) {
      return yield* toolError("This thread does not belong to a personal bot.");
    }
    return { threadId: scope.threadId, botId: link.value.botId };
  });

  const currentTurnId = Effect.fn("BotsToolkit.currentTurnId")(function* (threadId: ThreadId) {
    const shell = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.mapError(() => toolError("Could not read this thread.")));
    const turnId = Option.isSome(shell)
      ? (shell.value.session?.activeTurnId ?? shell.value.latestTurn?.turnId ?? null)
      : null;
    if (turnId === null) {
      return yield* toolError("No turn is running in this thread; call this tool during a turn.");
    }
    return turnId;
  });

  const callerTask = Effect.fn("BotsToolkit.callerTask")(function* () {
    const caller = yield* callerBot();
    const turnId = yield* currentTurnId(caller.threadId);
    const task = yield* tasks
      .resolveCallerTask({ threadId: caller.threadId, botId: caller.botId, turnId })
      .pipe(Effect.mapError(readable));
    return { ...caller, turnId, task };
  });

  const callerRoot = Effect.fn("BotsToolkit.callerRoot")(function* () {
    const caller = yield* callerBot();
    return yield* tasks.rootTaskIdForThread(caller.threadId).pipe(Effect.mapError(readable));
  });

  const treeOf = (rootTaskId: PersonalTask["rootTaskId"]) =>
    tasks.list({ rootTaskId }).pipe(
      Effect.map((result) => result.tasks),
      Effect.mapError(readable),
    );

  const notInTree = () => toolError("That task is not in your task tree.");

  return BotsToolkit.of({
    list_bots: () =>
      Effect.gen(function* () {
        const caller = yield* callerBot();
        const bots = yield* listBots;
        return {
          bots: bots
            .filter((bot) => bot.enabled)
            .map((bot) => ({
              botId: bot.botId,
              name: bot.name,
              description: bot.description,
              provider: bot.modelSelection.instanceId,
              model: bot.modelSelection.model,
              isYou: bot.botId === caller.botId,
            })),
        };
      }),
    delegate_task: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerTask();
        const target = resolveTargetBot(yield* listBots, input.targetBot);
        if (target === null) {
          const available = (yield* listBots)
            .filter((bot) => bot.enabled && bot.botId !== caller.botId)
            .map((bot) => bot.name);
          return yield* toolError(
            `No enabled bot is called '${input.targetBot}'. Available: ${available.join(", ") || "none"}.`,
          );
        }
        if (target.botId === caller.botId) {
          return yield* toolError("You cannot delegate a task to yourself.");
        }
        const child = yield* tasks
          .delegate({
            parentTaskId: caller.task.taskId,
            targetBotId: target.botId,
            brief: briefOf(input),
            idempotencyKey: delegationIdempotencyKey(caller.turnId, target.botId, input.objective),
          })
          .pipe(Effect.mapError(readable));
        return {
          childTaskId: child.taskId,
          targetBotId: target.botId,
          status: child.status,
          note: DELEGATE_NOTE,
        };
      }),
    get_task: (input) =>
      Effect.gen(function* () {
        const root = yield* callerRoot();
        if (Option.isNone(root)) {
          return yield* notInTree();
        }
        const tree = yield* treeOf(root.value);
        const task = tree.find((entry) => entry.taskId === input.taskId);
        if (task === undefined) {
          return yield* notInTree();
        }
        const names = yield* botNames;
        return {
          task: summarize(task, names),
          children: tree
            .filter((entry) => entry.parentTaskId === task.taskId)
            .map((entry) => summarize(entry, names)),
        };
      }),
    list_tasks: (input) =>
      Effect.gen(function* () {
        const root = yield* callerRoot();
        if (Option.isNone(root)) {
          return { rootTaskId: null, tasks: [] };
        }
        const tree = yield* treeOf(root.value);
        const names = yield* botNames;
        return {
          rootTaskId: root.value,
          tasks: tree
            .filter((task) => input.status === undefined || task.status === input.status)
            .map((task) => summarize(task, names)),
        };
      }),
    request_secret: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerTask();
        const result = yield* secrets
          .request({
            task: caller.task,
            threadId: caller.threadId,
            botId: caller.botId,
            name: input.name,
            label: input.label,
            purpose: input.purpose,
          })
          .pipe(Effect.mapError(readable));
        const envVar = personalSecretEnvVar(input.name);
        return {
          requestId: result.request.requestId,
          name: input.name,
          envVar,
          status: result.status,
          note:
            result.status === "fulfilled"
              ? `${input.name} is already stored. It is ${envVar} in sessions started after it was saved; do not print it.`
              : REQUEST_SECRET_NOTE,
        };
      }),
  });
});

export const BotsToolkitHandlersLive = BotsToolkit.toLayer(make);
