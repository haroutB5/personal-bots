import * as NodeCrypto from "node:crypto";

import {
  botTeam,
  DEFAULT_PERSONAL_BOT_TEAM,
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalTaskStatus,
  personalBotTeamLabel,
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
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { isPersonalTaskMessageId } from "../../../personal/personalThreadTitles.ts";
import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as PersonalBrowser from "../../../personal/browser/PersonalBrowser.ts";
import * as PersonalGroupService from "../../../personal/groups/PersonalGroupService.ts";
import * as PersonalSecretService from "../../../personal/secrets/PersonalSecretService.ts";
import * as PersonalLoginService from "../../../personal/secrets/PersonalLoginService.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  BotsToolError,
  BotsToolkit,
  BROWSER_HELP_REASON_MAX_LENGTH,
  type DelegateTaskInput,
  type TaskSummary,
} from "./tools.ts";

export const STEERED_NOTE =
  "Delivered into the task's running turn; the bot continues with it and keeps its progress. Its result still arrives on its own.";
export const STEER_QUEUED_NOTE =
  "The task is not in a turn right now; the update opens its next one, so for a queued task it is part of the brief it starts with.";

/**
 * A tool call is not a viewer session, so there is no session id to pass.
 * `status` only uses one to decide whether a *human* controller is this caller,
 * and a bot is never that, so any non-session value reads correctly here.
 */
const MCP_SESSION_ID = "mcp";

export const DELEGATE_NOTE =
  "You will receive the result in a follow-up message; end your turn now.";
export const CALL_VOTE_NOTE =
  "The vote is open. Cast your own ballot now with cast_vote, then end your turn: the others answer in their own turns. Nothing happens until the user approves the result.";
export const CAST_VOTE_OPEN_NOTE =
  "Your ballot is recorded. Waiting on the other members; you cannot vote again.";
export const CAST_VOTE_DECIDED_NOTE =
  "Your ballot was the last one, so the vote is resolved and the user has been shown the tally. Do not act on the result: wait to be told it was approved.";
export const REQUEST_SECRET_NOTE =
  "Requested. The user will enter it in a secure form; you'll be resumed. Never ask for it in chat.";

/**
 * The help reason as the user sees it: one line, at most
 * `BROWSER_HELP_REASON_MAX_LENGTH` characters, ending in an ellipsis when cut.
 * Counted in code points so an emoji is never split in half.
 */
export const shortenBrowserHelpReason = (reason: string): string => {
  const characters = Array.from(reason.replace(/\s+/g, " ").trim());
  if (characters.length <= BROWSER_HELP_REASON_MAX_LENGTH) {
    return characters.join("");
  }
  return `${characters
    .slice(0, BROWSER_HELP_REASON_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
};

const toolError = (reason: string) => new BotsToolError({ reason });

const PERSONAL_TASK_STATUSES_OPEN = PersonalTaskStatus.literals.filter(
  (status) => !PERSONAL_TASK_TERMINAL_STATUSES.includes(status),
);

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

/**
 * Does this message name the bot? Whole-word and case-insensitive, by name or
 * by id, so "ask Planner to draft it" names Planner while "our planners" does
 * not. This is how the owner lifts the cross-team delegation block, so it
 * deliberately does not match a fragment of a longer word.
 */
export function messageNamesBot(
  text: string,
  bot: { readonly botId: string; readonly name: string },
): boolean {
  return [bot.name.trim(), bot.botId.trim()]
    .filter((needle) => needle.length > 0)
    .some((needle) => {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
    });
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
  const logins = yield* PersonalLoginService.PersonalLoginService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const threadMessages = yield* ProjectionThreadMessageRepository;
  const browser = yield* PersonalBrowser.PersonalBrowser;
  const groups = yield* PersonalGroupService.PersonalGroupService;

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
    const bot = yield* botRepository
      .getBotById({ botId: link.value.botId })
      .pipe(Effect.mapError(() => toolError("Could not look up this thread's bot.")));
    return {
      threadId: scope.threadId,
      botId: link.value.botId,
      botName: Option.isSome(bot) ? bot.value.name : "Bot",
      team: Option.isSome(bot) ? botTeam(bot.value) : DEFAULT_PERSONAL_BOT_TEAM,
      lead: Option.isSome(bot) && bot.value.lead === true,
    };
  });

  /**
   * "Unless I tell him": crossing teams needs the owner's own most recent
   * message in this thread to name the target. Turn messages the task service
   * writes carry a `personal-task-` id and are not the owner speaking, so a
   * delegation brief that happens to mention a bot cannot authorise reaching
   * it — otherwise one bot could widen its own reach by writing a name.
   */
  const ownerNamedBot = Effect.fn("BotsToolkit.ownerNamedBot")(function* (
    threadId: ThreadId,
    target: PersonalBot,
  ) {
    const messages = yield* threadMessages
      .listByThreadId({ threadId })
      .pipe(Effect.mapError(() => toolError("Could not read this chat's messages.")));
    const latest = messages.findLast(
      (message) => message.role === "user" && !isPersonalTaskMessageId(message.messageId),
    );
    return latest !== undefined && messageNamesBot(latest.text, target);
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
    // A group member thread only ever runs the round's turns. Adopting one as
    // a task would later start a "[Task continuation]" turn on it that no
    // round knows about: its answer never reaches the group, and it can
    // overlap the member's next group turn.
    const group = yield* groups.groupNameForMemberThread(caller.threadId);
    if (Option.isSome(group)) {
      return yield* toolError(
        `You are speaking in the group "${group.value}", and a group turn cannot hand out, stop or park tasks. Answer in the group instead; if the work needs another bot or the user's help, say so there.`,
      );
    }
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

  /** Unfinished tasks of the caller's team's bots, newest first (team leads). */
  const teamOpenTasks = Effect.fn("BotsToolkit.teamOpenTasks")(function* (team: string) {
    const bots = yield* listBots;
    const teamBotIds = new Set<string>(
      bots.filter((bot) => botTeam(bot) === team).map((bot) => bot.botId),
    );
    const open = yield* tasks
      .list({ statuses: PERSONAL_TASK_STATUSES_OPEN })
      .pipe(Effect.mapError(readable));
    return open.tasks.filter((task) => teamBotIds.has(task.botId));
  });

  /**
   * The task a caller may read or act on, with the tasks its children are
   * read from. Every bot reaches its own request's tree. A team lead also
   * reaches any unfinished task of a bot on its own team, whatever request
   * or routine started it; never another team's. Anything else reads as
   * absent, so an id from elsewhere is not a lever.
   */
  const reachableTask = Effect.fn("BotsToolkit.reachableTask")(function* (
    caller: { readonly threadId: ThreadId; readonly team: string; readonly lead: boolean },
    taskId: PersonalTask["taskId"],
  ) {
    const root = yield* tasks.rootTaskIdForThread(caller.threadId).pipe(Effect.mapError(readable));
    const tree = Option.isSome(root) ? yield* treeOf(root.value) : [];
    const inTree = tree.find((entry) => entry.taskId === taskId);
    if (inTree !== undefined) {
      return { task: inTree, tree };
    }
    if (!caller.lead) {
      return yield* notInTree();
    }
    const team = yield* teamOpenTasks(caller.team);
    const task = team.find((entry) => entry.taskId === taskId);
    if (task === undefined) {
      return yield* notInTree();
    }
    return { task, tree: yield* treeOf(task.rootTaskId) };
  });

  return BotsToolkit.of({
    list_bots: () =>
      Effect.gen(function* () {
        const caller = yield* callerBot();
        const bots = yield* listBots;
        return {
          // Own team only. The other team is not this bot's to reach, and a
          // roster it cannot delegate to would only invite it to try.
          bots: bots
            .filter((bot) => bot.enabled && botTeam(bot) === caller.team)
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
        // Resolved across both teams on purpose: a bot that exists but is out
        // of reach deserves a better answer than "no such bot".
        const target = resolveTargetBot(yield* listBots, input.targetBot);
        const teamMates = (bots: ReadonlyArray<PersonalBot>) =>
          bots
            .filter(
              (bot) => bot.enabled && bot.botId !== caller.botId && botTeam(bot) === caller.team,
            )
            .map((bot) => bot.name);
        if (target === null) {
          const available = teamMates(yield* listBots);
          return yield* toolError(
            `No enabled bot is called '${input.targetBot}'. Available: ${available.join(", ") || "none"}.`,
          );
        }
        if (target.botId === caller.botId) {
          return yield* toolError("You cannot delegate a task to yourself.");
        }
        if (botTeam(target) !== caller.team) {
          const asked = yield* ownerNamedBot(caller.threadId, target);
          if (!asked) {
            const available = teamMates(yield* listBots);
            return yield* toolError(
              `${target.name} is on the ${personalBotTeamLabel(botTeam(target))}, not yours, so you cannot hand work over. Tell the user what you need from ${target.name} and ask them to request it; once their own latest message names ${target.name}, this works. On your team you can ask: ${available.join(", ") || "nobody"}.`,
            );
          }
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
        const caller = yield* callerBot();
        const { task, tree } = yield* reachableTask(caller, input.taskId);
        const names = yield* botNames;
        const steers = yield* tasks.steers({ taskId: task.taskId }).pipe(Effect.mapError(readable));
        return {
          task: summarize(task, names),
          children: tree
            .filter((entry) => entry.parentTaskId === task.taskId)
            .map((entry) => summarize(entry, names)),
          steers: steers.map((steer) => ({
            text: steer.text,
            sentAt: DateTime.formatIso(steer.createdAt),
            delivered: steer.deliveredAt !== null,
          })),
        };
      }),
    list_tasks: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerBot();
        const root = yield* callerRoot();
        const tree = Option.isSome(root) ? yield* treeOf(root.value) : [];
        const inTree = new Set<string>(tree.map((task) => task.taskId));
        const team = caller.lead ? yield* teamOpenTasks(caller.team) : [];
        const names = yield* botNames;
        const wanted = (task: PersonalTask) =>
          input.status === undefined || task.status === input.status;
        return {
          rootTaskId: Option.getOrNull(root),
          tasks: tree.filter(wanted).map((task) => summarize(task, names)),
          teamTasks: team
            .filter((task) => !inTree.has(task.taskId) && wanted(task))
            .map((task) => summarize(task, names)),
        };
      }),
    stop_task: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerTask();
        // Scoped exactly like get_task: a task id guessed from elsewhere reads
        // as absent rather than as a lever.
        const { task: target } = yield* reachableTask(caller, input.taskId);
        if (target.taskId === caller.task.taskId) {
          return yield* toolError("You cannot stop your own task; finish your turn instead.");
        }
        const stopped = yield* tasks
          .cancel({ taskId: target.taskId })
          .pipe(Effect.mapError(readable));
        if (input.redirectObjective === undefined) {
          return { taskId: stopped.taskId, status: stopped.status, redirectedTaskId: null };
        }
        // Redirecting in the same call is what keeps a stopped task from
        // becoming a dropped one: the bot that lost its objective gets the new
        // one before this tool returns.
        const replacement = yield* tasks
          .delegate({
            parentTaskId: caller.task.taskId,
            targetBotId: target.botId,
            brief: briefOf({ targetBot: target.botId, objective: input.redirectObjective }),
            idempotencyKey: delegationIdempotencyKey(
              caller.turnId,
              target.botId,
              input.redirectObjective,
            ),
          })
          .pipe(Effect.mapError(readable));
        return {
          taskId: stopped.taskId,
          status: stopped.status,
          redirectedTaskId: replacement.taskId,
        };
      }),
    steer_task: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerTask();
        const { task: target } = yield* reachableTask(caller, input.taskId);
        if (target.taskId === caller.task.taskId) {
          return yield* toolError("That is your own task; just carry on with the change yourself.");
        }
        const steered = yield* tasks
          .steer({ taskId: target.taskId, fromName: caller.botName, message: input.message })
          .pipe(Effect.mapError(readable));
        return {
          taskId: steered.task.taskId,
          outcome: steered.outcome,
          status: steered.task.status,
          note: steered.outcome === "steered" ? STEERED_NOTE : STEER_QUEUED_NOTE,
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
    use_login: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerBot();
        return yield* logins
          .use({
            threadId: caller.threadId,
            labelOrOrigin: input.login,
          })
          .pipe(Effect.mapError(readable));
      }),
    request_browser_help: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerTask();
        yield* browser
          .requestHelp({
            threadId: caller.threadId,
            botId: caller.botId,
            botName: caller.botName,
            taskId: caller.task.taskId,
            reason: shortenBrowserHelpReason(input.reason),
          })
          .pipe(Effect.mapError(readable));
        return {
          requested: true as const,
          note: "The user has been asked to take control from the browser panel in this chat. Tell them in one sentence what to do there, then end your turn. You continue automatically when they return control; do not ask them to tell you.",
        };
      }),
    // Which thread opened the browser does not gate this: the browser is
    // shared, and a bot the user asked to close it should be able to. A human
    // at the controls does, because closing under them would yank the page
    // they are reading. That check is the browser service's, taken inside the
    // same lease lock as the teardown; the read below only turns the common
    // case into a better sentence than the lease's own.
    call_vote: (input) =>
      Effect.gen(function* () {
        // callerBot(), not callerTask(): a group turn is not a task turn, and
        // resolving a task here would refuse the call for the wrong reason.
        const caller = yield* callerBot();
        const opened = yield* groups
          .callVote({
            threadId: caller.threadId,
            question: input.question,
            options: input.options,
          })
          .pipe(Effect.mapError(readable));
        return {
          voteId: opened.vote.voteId,
          options: opened.vote.options,
          voters: opened.voterNames,
          note: CALL_VOTE_NOTE,
        };
      }),
    cast_vote: (input) =>
      Effect.gen(function* () {
        const caller = yield* callerBot();
        const vote = yield* groups
          .castVote({
            threadId: caller.threadId,
            voteId: input.voteId,
            option: input.option,
            reason: input.reason,
          })
          .pipe(Effect.mapError(readable));
        return {
          voteId: vote.voteId,
          option:
            vote.ballots.find((ballot) => ballot.botId === caller.botId)?.option ?? input.option,
          status: vote.status,
          ballotsCast: vote.ballots.length,
          note: vote.status === "open" ? CAST_VOTE_OPEN_NOTE : CAST_VOTE_DECIDED_NOTE,
        };
      }),
    close_browser: () =>
      Effect.gen(function* () {
        const caller = yield* callerBot();
        const before = yield* browser.status(MCP_SESSION_ID);
        if (before.controller._tag === "Human") {
          return yield* toolError(
            "The user is using the browser right now. Leave it open; they will close it or hand control back.",
          );
        }
        const wasRunning = before.state !== "offline";
        yield* browser
          .closeBrowser({
            sessionId: MCP_SESSION_ID,
            byThreadId: caller.threadId,
          })
          .pipe(
            // A takeover that landed after the read above is refused by the
            // service, and the bot is told the browser is still open.
            Effect.mapError((error) =>
              toolError(
                `The browser was not closed: ${error.message} Leave it open; the user will close it or hand control back.`,
              ),
            ),
          );
        return {
          closed: wasRunning,
          note: wasRunning
            ? "The browser is closed. It starts again on your next browser tool call."
            : "The browser was already closed.",
        };
      }),
  });
});

export const BotsToolkitHandlersLive = BotsToolkit.toLayer(make);
