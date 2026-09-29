import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BotAvatarShape,
  botNotificationsMutedUntil,
  botTeam,
  CommandId,
  ComposerContextId,
  MessageId,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalBotId,
  personalBotTeamLabel,
  PersonalLeadBotChangeId,
  PersonalLeadBotChangesError,
  type OrchestrationMessageContext,
  type PersonalBot,
  type PersonalBotNotificationMute,
  type PersonalBotUpdateInput,
  type PersonalLeadBotChange,
  type PersonalLeadBotChangeDecideInput,
  type PersonalLeadBotChangeListResult,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import { botModelSelectionForThread } from "../botModelSelection.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { PERSONAL_NOTICE_MESSAGE_ID_PREFIX } from "../personalChatResumePolicy.ts";
import { PERSONAL_SEED_MODEL_ENV } from "../seedModel.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import {
  authorizeLeadBotAction,
  busyRefusal,
  checkBotName,
  LEAD_BOT_CREATE_WINDOW_MS,
  LEAD_BOT_FORBIDDEN_FIELDS,
  looksLikeSecret,
  normalizeBotNameKey,
  rawBotNameKey,
  type LeadBotAction,
  type LeadBotFacts,
  type LeadBotForbiddenField,
  type LeadBotSensitiveField,
} from "./leadBotPolicy.ts";
import {
  LEAD_BOT_CONFIRM_KEEP_MS,
  LEAD_BOT_CONFIRM_SWEEP_MS,
  LEAD_BOT_CONFIRM_WINDOW_MS,
  PERSONAL_LEAD_ANSWER_MESSAGE_ID_PREFIX,
  canonicalJson,
  leadBotAnswerLine,
  leadBotAnswerText,
  leadBotChangeHash,
  type LeadBotAnswer,
} from "./leadBotConfirm.ts";
import {
  leadBotModelLabel,
  resolveLeadModelSelection,
  type LeadModelRequest,
  type LeadModelResult,
} from "./leadBotModel.ts";

export const LEAD_BOT_NAME_MAX = 60;
export const LEAD_BOT_TITLE_MAX = 60;
export const LEAD_BOT_DESCRIPTION_MAX = 500;
export const LEAD_BOT_INSTRUCTIONS_MAX = 20_000;
/** Longest remove_bot reason kept in the chat line and the notification (the audit row keeps it whole). */
export const LEAD_BOT_REASON_MAX = 300;

/** A lead's call was refused or could not be carried out. `reason` is for the calling model. */
export class PersonalLeadBotError extends Schema.TaggedError<PersonalLeadBotError>()(
  "PersonalLeadBotError",
  {
    /** A refusal code from `authorizeLeadBotAction`, or "invalid" (bad input) or "failed" (the server). */
    code: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The fields a lead may pass, and the three it may only be refused for. */
export interface LeadBotFields {
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly instructions?: string | undefined;
  readonly avatarShape?: BotAvatarShape | undefined;
  readonly avatarColor?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly notificationsMute?: PersonalBotNotificationMute | undefined;
  readonly memoryAutoSave?: boolean | undefined;
  /** Present only so a call that carries them is refused rather than silently ignored. */
  readonly team?: unknown;
  readonly lead?: unknown;
  readonly pinned?: unknown;
}

export interface LeadBotCaller {
  readonly botId: string;
  /** The chat the lead is speaking in; the change is written there. */
  readonly threadId: ThreadId;
  /**
   * The turn making the call was started by the user's own message in this chat
   * (the handler reads the chat). Absent reads as false, so a caller that forgets
   * it can never raise a confirm card.
   */
  readonly ownerTurn?: boolean | undefined;
}

export interface LeadBotResult {
  readonly botId: string;
  readonly name: string;
  readonly team: string;
  readonly model: string;
  /** What changed (update); empty for create and remove. */
  readonly changed: ReadonlyArray<string>;
  /** The one line posted in the lead's chat and sent to the user. */
  readonly line: string;
  /** Set when nothing was done yet: the user has a confirm card to answer. */
  readonly pendingChangeId?: string | undefined;
}

const AVATAR_SHAPES: ReadonlyArray<BotAvatarShape> = BotAvatarShape.literals;
const AVATAR_COLORS: ReadonlyArray<string> = [
  "#1A73E8",
  "#F26A1B",
  "#F0457E",
  "#E5323B",
  "#7B61FF",
  "#0F9D58",
  "#00A0B0",
  "#C79100",
];

const hashOf = (text: string): number => {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash;
};

const encodeChangedFields = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const invalid = (reason: string) => new PersonalLeadBotError({ code: "invalid", reason });

/** A step that failed inside the server: logged with its cause, reported to the lead without it. */
const orFail =
  (step: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersonalLeadBotError, R> =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("personal lead bot step failed", { step, cause: String(cause) }),
      ),
      Effect.mapError(
        () =>
          new PersonalLeadBotError({
            code: "failed",
            reason: `Could not ${step}. Nothing was changed; try again, or ask the user.`,
          }),
      ),
    );

/** The sensitive fields this call would really change on the target (see LEAD_BOT_SENSITIVE_FIELDS). */
const sensitiveChangesOf = (
  target: PersonalBot,
  fields: LeadBotFields,
  model: LeadModelResult | null,
): ReadonlyArray<LeadBotSensitiveField> => {
  const changes: Array<LeadBotSensitiveField> = [];
  if (
    fields.name !== undefined &&
    normalizeBotNameKey(fields.name) !== normalizeBotNameKey(target.name)
  ) {
    changes.push("name");
  }
  if (fields.instructions !== undefined && fields.instructions !== target.instructions) {
    changes.push("instructions");
  }
  if (fields.description !== undefined && fields.description !== target.description) {
    changes.push("description");
  }
  if (model !== null && model.ok && model.changed) changes.push("model");
  return changes;
};

const forbiddenFieldsOf = (fields: LeadBotFields): ReadonlyArray<LeadBotForbiddenField> =>
  LEAD_BOT_FORBIDDEN_FIELDS.filter((key) => fields[key] !== undefined);

const modelRequestOf = (fields: LeadBotFields): LeadModelRequest => ({
  provider: fields.provider,
  model: fields.model,
  effort: fields.effort,
});

/** The keys an approved update may write; anything else in a stored payload is ignored. */
const PATCH_KEYS = [
  "name",
  "title",
  "description",
  "instructions",
  "avatarShape",
  "avatarColor",
  "modelSelection",
  "memoryAutoSave",
  "notificationsMute",
] as const;

type Patch = { -readonly [K in keyof PersonalBotUpdateInput]?: PersonalBotUpdateInput[K] };

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const clip = (text: string, max = 60): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The bot's own current value of every field a patch touches (a stale-card guard). */
const baseOf = (current: PersonalBot, patch: Patch): Record<string, unknown> => {
  const base: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (patch[key] === undefined) continue;
    switch (key) {
      // The mute is a moving "until" value, and cosmetic: not compared.
      case "notificationsMute":
        break;
      case "modelSelection":
        base[key] = current.modelSelection;
        break;
      case "memoryAutoSave":
        base[key] = current.memoryAutoSave === true;
        break;
      default:
        base[key] = current[key];
    }
  }
  return base;
};

/** One line per changed field, in words the owner reads on the card. Long text shows only its size. */
const diffLines = (
  current: PersonalBot,
  patch: Patch,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (patch.name !== undefined) {
    lines.push(`name: '${clip(current.name)}' → '${clip(patch.name)}'`);
  }
  if (patch.title !== undefined) {
    lines.push(`title: '${clip(current.title)}' → '${clip(patch.title)}'`);
  }
  if (patch.description !== undefined) {
    lines.push(`description: ${current.description.length} → ${patch.description.length} chars`);
  }
  if (patch.instructions !== undefined) {
    lines.push(`instructions: ${current.instructions.length} → ${patch.instructions.length} chars`);
  }
  if (patch.avatarShape !== undefined) {
    lines.push(`avatar shape: ${current.avatarShape} → ${patch.avatarShape}`);
  }
  if (patch.avatarColor !== undefined) {
    lines.push(`avatar colour: ${current.avatarColor} → ${patch.avatarColor}`);
  }
  if (patch.modelSelection !== undefined) {
    lines.push(
      `model: ${leadBotModelLabel(current.modelSelection, providers)} → ${leadBotModelLabel(patch.modelSelection, providers)}`,
    );
  }
  if (patch.memoryAutoSave !== undefined) {
    lines.push(
      `memory auto-save: ${current.memoryAutoSave === true ? "on" : "off"} → ${patch.memoryAutoSave ? "on" : "off"}`,
    );
  }
  if (patch.notificationsMute !== undefined) {
    lines.push(`notifications: ${patch.notificationsMute === "on" ? "on" : "muted"}`);
  }
  return lines;
};

/** A stored confirmation row, as the queries below return it. */
interface ConfirmationRow {
  readonly confirmationId: string;
  readonly leadBotId: string;
  readonly leadName: string;
  readonly team: string;
  readonly action: "update" | "remove";
  readonly targetBotId: string;
  readonly targetName: string;
  readonly threadId: string;
  readonly payloadJson: string;
  readonly changeHash: string;
  readonly baseJson: string;
  readonly linesJson: string;
  readonly reason: string | null;
  readonly status: PersonalLeadBotChange["status"];
  readonly outcome: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

const CONFIRMATION_COLUMNS = `
  confirmation_id AS "confirmationId", lead_bot_id AS "leadBotId", lead_name AS "leadName",
  team, action, target_bot_id AS "targetBotId", target_name AS "targetName",
  thread_id AS "threadId", payload_json AS "payloadJson", change_hash AS "changeHash",
  base_json AS "baseJson", lines_json AS "linesJson", reason, status, outcome,
  created_at AS "createdAt", expires_at AS "expiresAt", decided_at AS "decidedAt"`;

const linesOf = (row: ConfirmationRow): ReadonlyArray<string> => {
  try {
    const parsed = decodeJson(row.linesJson);
    return Array.isArray(parsed) ? parsed.filter((line) => typeof line === "string") : [];
  } catch {
    return [];
  }
};

const toChange = (row: ConfirmationRow): PersonalLeadBotChange => ({
  changeId: PersonalLeadBotChangeId.make(row.confirmationId),
  changeHash: row.changeHash,
  leadBotId: PersonalBotId.make(row.leadBotId),
  leadName: row.leadName,
  action: row.action,
  targetBotId: PersonalBotId.make(row.targetBotId),
  targetName: row.targetName,
  team: row.team,
  threadId: row.threadId as ThreadId,
  lines: linesOf(row),
  reason: row.reason,
  status: row.status,
  outcome: row.outcome,
  createdAt: DateTime.toUtc(DateTime.makeUnsafe(row.createdAt)),
  expiresAt: DateTime.toUtc(DateTime.makeUnsafe(row.expiresAt)),
  decidedAt: row.decidedAt === null ? null : DateTime.toUtc(DateTime.makeUnsafe(row.decidedAt)),
});

/** What the request was, for the lead's answer and the chat line. */
const describeChange = (row: ConfirmationRow): string =>
  row.action === "remove"
    ? `remove bot '${row.targetName}'`
    : `change bot '${row.targetName}' (${linesOf(row).join("; ")})`;

const changeFailure = (message: string) => new PersonalLeadBotChangesError({ message });

const answerContext: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_CHAT_NOTICE_CONTEXT_KIND),
      label: "Chat notice",
      kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
      payload: { notice: "team-bot-answer", provider: "Team" },
    },
  ],
};

export class PersonalLeadBotService extends Context.Service<
  PersonalLeadBotService,
  {
    /** A new member on the caller's own team. */
    readonly create: (
      caller: LeadBotCaller,
      fields: LeadBotFields,
    ) => Effect.Effect<LeadBotResult, PersonalLeadBotError>;
    /**
     * Changes fields of a member of the caller's own team. A bot the caller did not
     * create is changed only after the user taps Yes on a card: the result then
     * carries `pendingChangeId` and nothing has changed yet.
     */
    readonly update: (
      caller: LeadBotCaller,
      botId: string,
      fields: LeadBotFields,
    ) => Effect.Effect<LeadBotResult, PersonalLeadBotError>;
    /** Soft-deletes a member of the caller's own team (with a card for a bot the caller did not create). */
    readonly remove: (
      caller: LeadBotCaller,
      botId: string,
      reason: string,
    ) => Effect.Effect<LeadBotResult, PersonalLeadBotError>;
    /** Pending requests and the ones settled in the last 7 days. */
    readonly listChanges: () => Effect.Effect<
      PersonalLeadBotChangeListResult,
      PersonalLeadBotChangesError
    >;
    /**
     * The user's answer to a card. Reachable only through the owner's RPC session:
     * no MCP tool, routine or task turn calls it.
     */
    readonly decide: (
      input: PersonalLeadBotChangeDecideInput,
    ) => Effect.Effect<PersonalLeadBotChange, PersonalLeadBotChangesError>;
    /** Cancels every card past its window and tells its lead. */
    readonly sweepExpired: Effect.Effect<void>;
    /** Starts the periodic sweep (every 30 s). Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/personal/leadBots/PersonalLeadBotService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  // Optional so the service stays testable without notifications; the server always has it.
  const push = yield* Effect.serviceOption(PersonalPushService.PersonalPushService);
  // Optional for the same reason: without it a lead is not sent a turn with the answer.
  const projections = yield* Effect.serviceOption(ProjectionSnapshotQuery.ProjectionSnapshotQuery);
  const seedModelOverride = yield* Config.String(PERSONAL_SEED_MODEL_ENV).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  // One action at a time: the daily create count is read and written under it, and
  // a tap on a card cannot interleave with another tap or with the lead asking again.
  const lock = yield* Semaphore.make(1);

  const liveBot = (botId: string) =>
    repository
      .getBotById({ botId: PersonalBotId.make(botId) })
      .pipe(Effect.map(Option.getOrNull), orFail("read the bot"));

  const currentProviders = providers.getProviders.pipe(orFail("read the model list"));

  const createsInWindow = (leadBotId: string, nowMs: number) =>
    sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM personal_lead_bot_actions
      WHERE lead_bot_id = ${leadBotId}
        AND action = 'create'
        AND created_at >= ${DateTime.formatIso(DateTime.makeUnsafe(nowMs - LEAD_BOT_CREATE_WINDOW_MS))}
    `.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      orFail("check your daily limit"),
    );

  /**
   * What a bot is doing right now: tasks that are not finished, and chats with a
   * turn in progress (the same test the restart waiter's idle check uses; a
   * deleted chat's stale session row does not count). Plain reads, so the removal
   * can repeat them inside its own transaction.
   */
  const busyCountsOf = (botId: string) =>
    Effect.gen(function* () {
      const openTasks = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM personal_tasks
        WHERE bot_id = ${botId} AND status NOT IN ${sql.in(PERSONAL_TASK_TERMINAL_STATUSES)}
      `;
      const activeSessions = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n
        FROM projection_thread_sessions session
        JOIN personal_bot_threads link ON link.thread_id = session.thread_id
        LEFT JOIN projection_threads thread ON thread.thread_id = session.thread_id
        WHERE link.bot_id = ${botId}
          AND session.status IN ('starting', 'running')
          AND (thread.thread_id IS NULL OR thread.deleted_at IS NULL)
      `;
      return { openTasks: openTasks[0]?.n ?? 0, activeSessions: activeSessions[0]?.n ?? 0 };
    });

  /** Some lead created this bot (a `create` row in the audit table); a bot the user made has none. */
  const ownedByCaller = (_leadBotId: string, target: PersonalBot) =>
    sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM personal_lead_bot_actions
      WHERE target_bot_id = ${target.botId} AND action = 'create'
    `.pipe(
      Effect.map((rows) => (rows[0]?.n ?? 0) > 0),
      orFail("check who made the bot"),
    );

  const activeRoutinesOf = (botId: string) =>
    routines.list().pipe(
      Effect.map(
        (result) =>
          result.routines.filter((routine) => routine.botId === botId && routine.enabled).length,
      ),
      orFail("read the bot's routines"),
    );

  /**
   * The one gate every action passes through: reads the facts fresh (the
   * caller's lead flag included, on every call), asks `authorizeLeadBotAction`,
   * and fails with its reason unless it says yes. `resolveModel` runs only once
   * a caller row exists; its outcome is part of the facts, and a model that
   * does not exist is reported only after the permission rules have passed.
   */
  const authorize = Effect.fn("PersonalLeadBot.authorize")(function* (input: {
    readonly action: LeadBotAction;
    readonly callerBotId: string;
    readonly targetBotId?: string | undefined;
    readonly ownerTurn?: boolean | undefined;
    /** The user tapped Yes on the card for exactly this change. */
    readonly approvedByOwner?: boolean | undefined;
    readonly fields: LeadBotFields;
    readonly resolveModel?:
      | ((rows: {
          readonly caller: PersonalBot;
          readonly target: PersonalBot | null;
        }) => LeadModelResult)
      | undefined;
  }) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const caller = yield* liveBot(input.callerBotId);
    const target = input.targetBotId === undefined ? null : yield* liveBot(input.targetBotId);
    const model =
      input.resolveModel === undefined || caller === null
        ? null
        : input.resolveModel({ caller, target });
    const busy =
      input.action === "remove" && target !== null
        ? yield* busyCountsOf(target.botId).pipe(orFail("check what the bot is doing"))
        : { openTasks: 0, activeSessions: 0 };
    const facts: LeadBotFacts = {
      action: input.action,
      caller,
      target,
      forbiddenFields: forbiddenFieldsOf(input.fields),
      requestedModel:
        model !== null && model.ok
          ? {
              instanceId: model.selection.instanceId,
              model: model.selection.model,
              // A create is always a change; an update only when it moves model, provider or effort.
              changed: input.action === "create" || model.changed,
            }
          : null,
      createsInWindow:
        input.action === "create" && caller !== null
          ? yield* createsInWindow(caller.botId, nowMs)
          : 0,
      sensitiveChanges:
        input.action === "update" && target !== null
          ? sensitiveChangesOf(target, input.fields, model)
          : [],
      targetOwnedByCaller:
        target !== null && caller !== null ? yield* ownedByCaller(caller.botId, target) : false,
      ownerTurn: input.ownerTurn === true,
      approvedByOwner: input.approvedByOwner === true,
      targetOpenTasks: busy.openTasks,
      targetActiveSessions: busy.activeSessions,
      targetActiveRoutines:
        input.action === "remove" && target !== null ? yield* activeRoutinesOf(target.botId) : 0,
    };
    const verdict = authorizeLeadBotAction(facts);
    if (!verdict.allowed) {
      yield* Effect.logWarning("personal lead bot action refused", {
        action: input.action,
        callerBotId: input.callerBotId,
        targetBotId: input.targetBotId ?? null,
        code: verdict.code,
      });
      return yield* new PersonalLeadBotError({ code: verdict.code, reason: verdict.reason });
    }
    if (model !== null && !model.ok) return yield* invalid(model.reason);
    // The verdict only allows a real, live lead, so the caller row is present.
    return { caller: caller!, target, team: verdict.team, model, confirm: verdict.confirm };
  });

  /**
   * Length, secrets and a unique, plain name: the checks about the text, not about
   * the caller. Returns the name in its normal form (NFKC, single spaces), which
   * is what gets stored and what every comparison uses.
   */
  const validateText = Effect.fn("PersonalLeadBot.validateText")(function* (
    fields: LeadBotFields,
    current: PersonalBot | null,
  ) {
    const texts = [
      ["name", fields.name, LEAD_BOT_NAME_MAX],
      ["title", fields.title, LEAD_BOT_TITLE_MAX],
      ["description", fields.description, LEAD_BOT_DESCRIPTION_MAX],
      ["instructions", fields.instructions, LEAD_BOT_INSTRUCTIONS_MAX],
    ] as const;
    for (const [label, value, max] of texts) {
      if (value === undefined) continue;
      if (value.length > max) {
        return yield* invalid(`The ${label} is too long: at most ${max} characters.`);
      }
      if (looksLikeSecret(value)) {
        return yield* invalid(
          `The ${label} looks like it contains a secret (a key, token or PB_SECRET_ variable). Never put secret values in a bot; only the user gives a bot access to secrets.`,
        );
      }
    }
    if (fields.name === undefined) return { name: undefined };
    // Restating a bot's own current name is not a rename: it is left as it is.
    if (current !== null && fields.name.trim() === current.name) return { name: current.name };
    const checked = checkBotName(fields.name);
    if (!checked.ok) return yield* invalid(checked.reason);
    // Unique in normal form AND as submitted, against every live bot.
    const wanted = normalizeBotNameKey(checked.name);
    const wantedRaw = rawBotNameKey(fields.name);
    const all = yield* repository.listBots().pipe(orFail("read the bot list"));
    const clash = all.find(
      (bot) =>
        bot.botId !== current?.botId &&
        (normalizeBotNameKey(bot.name) === wanted ||
          normalizeBotNameKey(bot.name) === normalizeBotNameKey(fields.name!) ||
          rawBotNameKey(bot.name) === wantedRaw),
    );
    if (clash !== undefined) {
      return yield* invalid(
        `A bot called '${clash.name}' already exists; delegation finds bots by name, so pick a different name.`,
      );
    }
    return { name: checked.name };
  });

  const context: OrchestrationMessageContext = {
    version: 1,
    records: [
      {
        version: 1,
        contextId: ComposerContextId.make(PERSONAL_CHAT_NOTICE_CONTEXT_KIND),
        label: "Chat notice",
        kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
        payload: { notice: "team-bot-change", provider: "Team" },
      },
    ],
  };

  const bestEffort =
    (what: string, actionId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(`personal lead bot change: ${what}`, {
                actionId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

  /** A system row in the lead's chat (assistant role, the "team-bot-change" notice). */
  const writeChatLine = (input: {
    readonly threadId: ThreadId | string;
    readonly messageKey: string;
    readonly commandKey: string;
    readonly line: string;
    readonly nowIso: string;
  }) =>
    engine
      .dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`${input.commandKey}:notice:delta`),
        threadId: input.threadId as ThreadId,
        messageId: MessageId.make(PERSONAL_NOTICE_MESSAGE_ID_PREFIX + input.messageKey),
        delta: input.line,
        context,
        createdAt: input.nowIso,
      })
      .pipe(
        Effect.andThen(
          engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`${input.commandKey}:notice:complete`),
            threadId: input.threadId as ThreadId,
            messageId: MessageId.make(PERSONAL_NOTICE_MESSAGE_ID_PREFIX + input.messageKey),
            createdAt: input.nowIso,
          }),
        ),
      );

  /**
   * After the change has happened: the audit row (which the daily create limit
   * counts), the audit log line, the line in the lead's chat and the
   * notification. None of these can undo the change, so none of them fails the call.
   */
  const record = Effect.fn("PersonalLeadBot.record")(function* (input: {
    readonly caller: PersonalBot;
    readonly team: string;
    readonly action: LeadBotAction;
    readonly target: { readonly botId: string; readonly name: string };
    readonly changed: ReadonlyArray<string>;
    /** The old and new value of every changed field (see the migration). */
    readonly before: Record<string, unknown>;
    readonly after: Record<string, unknown>;
    readonly reason: string | null;
    readonly line: string;
    readonly pushTitle: string;
    readonly pushBody: string;
    readonly threadId: ThreadId;
    /** The confirm card the user approved, when there was one. */
    readonly confirmationId?: string | null | undefined;
  }) {
    const actionId = NodeCrypto.randomUUID();
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO personal_lead_bot_actions (
        action_id, lead_bot_id, lead_name, team, action, target_bot_id, target_name,
        changed_fields_json, before_json, after_json, reason, summary, thread_id, created_at,
        confirmation_id
      ) VALUES (
        ${actionId}, ${input.caller.botId}, ${input.caller.name}, ${input.team},
        ${input.action}, ${input.target.botId}, ${input.target.name},
        ${encodeChangedFields(input.changed)}, ${encodeJson(input.before)},
        ${encodeJson(input.after)}, ${input.reason}, ${input.line}, ${input.threadId}, ${nowIso},
        ${input.confirmationId ?? null}
      )
    `.pipe(bestEffort("audit row not written", actionId));
    yield* Effect.logInfo("personal lead bot action", {
      actionId,
      action: input.action,
      leadBotId: input.caller.botId,
      leadName: input.caller.name,
      team: input.team,
      targetBotId: input.target.botId,
      targetName: input.target.name,
      changed: input.changed,
      reason: input.reason,
      confirmationId: input.confirmationId ?? null,
    });
    yield* writeChatLine({
      threadId: input.threadId,
      messageKey: `lead-${actionId}`,
      commandKey: `personal-lead-bot:${actionId}`,
      line: input.line,
      nowIso,
    }).pipe(bestEffort("line not written in the chat", actionId));
    if (Option.isSome(push)) {
      yield* push.value
        .notifyTeamBotChange({
          actionId,
          leadBotId: input.caller.botId,
          title: input.pushTitle,
          body: input.pushBody,
        })
        .pipe(bestEffort("notification not sent", actionId));
    }
  });

  /**
   * Tells a lead how its request was answered: a line in its chat (for every answer
   * that changed nothing; an applied change already wrote its own line) and a turn
   * message with the outcome, so the lead reads it and carries on. Best effort: the
   * answer is already recorded, and a chat that is gone has nobody to tell.
   */
  const answerLead = Effect.fn("PersonalLeadBot.answerLead")(function* (
    row: ConfirmationRow,
    answer: LeadBotAnswer,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    if (answer.kind !== "approved") {
      yield* writeChatLine({
        threadId: row.threadId,
        messageKey: `lead-answer-${row.confirmationId}`,
        commandKey: `personal-lead-answer:${row.confirmationId}`,
        line: leadBotAnswerLine(row.leadName, answer),
        nowIso,
      }).pipe(bestEffort("answer line not written", row.confirmationId));
    }
    if (Option.isNone(projections)) return;
    const shell = yield* projections.value
      .getThreadShellById(row.threadId as ThreadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell) || shell.value.archivedAt != null) return;
    const modelSelection = yield* botModelSelectionForThread(
      repository,
      row.threadId as ThreadId,
      shell.value.modelSelection,
    );
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`personal-lead-answer:${row.confirmationId}:turn.start`),
        threadId: row.threadId as ThreadId,
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        message: {
          messageId: MessageId.make(PERSONAL_LEAD_ANSWER_MESSAGE_ID_PREFIX + row.confirmationId),
          role: "user",
          text: leadBotAnswerText(answer),
          attachments: [],
          context: answerContext,
        },
        runtimeMode: shell.value.runtimeMode,
        interactionMode: shell.value.interactionMode,
        createdAt: nowIso,
      })
      .pipe(bestEffort("lead not told", row.confirmationId));
  });

  const create: PersonalLeadBotService["Service"]["create"] = (caller, fields) =>
    lock.withPermit(
      Effect.gen(function* () {
        const all = yield* currentProviders;
        const {
          caller: leadRow,
          team,
          model,
        } = yield* authorize({
          action: "create",
          callerBotId: caller.botId,
          fields,
          // From the lead's own provider unless one is named; an omitted model
          // is the seed choice (Opus 5.5 medium), never the lead's own, which
          // might be one only the user may pick.
          resolveModel: ({ caller: row }) =>
            resolveLeadModelSelection({
              providers: all,
              base: row.modelSelection,
              seedFallback: true,
              seedOverride: seedModelOverride,
              request: modelRequestOf(fields),
            }),
        });
        if (fields.name === undefined || fields.name.trim() === "") {
          return yield* invalid("A new bot needs a name.");
        }
        const { name } = yield* validateText(fields, null);
        const selection = (model as Extract<LeadModelResult, { ok: true }>).selection;
        const created = yield* bots
          .create({
            botId: PersonalBotId.make(`bot-${NodeCrypto.randomUUID()}`),
            name: name!,
            title: (fields.title ?? "").trim(),
            description: fields.description ?? "",
            instructions: fields.instructions ?? "",
            avatarShape: fields.avatarShape ?? AVATAR_SHAPES[hashOf(name!) % AVATAR_SHAPES.length]!,
            avatarColor: fields.avatarColor ?? AVATAR_COLORS[hashOf(name!) % AVATAR_COLORS.length]!,
            modelSelection: selection,
            // Always the lead's own team, never a lead, never pinned.
            team,
            lead: false,
            pinned: false,
            memoryAutoSave: fields.memoryAutoSave ?? false,
          })
          .pipe(orFail("create the bot"));
        const modelLabel = leadBotModelLabel(created.modelSelection, all);
        const teamLabel = personalBotTeamLabel(botTeam(created));
        const line = `${leadRow.name} created bot '${created.name}' (${modelLabel}) on ${teamLabel}`;
        yield* record({
          caller: leadRow,
          team: botTeam(created),
          action: "create",
          target: created,
          changed: [],
          before: {},
          after: {
            name: created.name,
            title: created.title,
            description: created.description,
            instructions: created.instructions,
            avatarShape: created.avatarShape,
            avatarColor: created.avatarColor,
            model: created.modelSelection,
            team: botTeam(created),
            memoryAutoSave: created.memoryAutoSave === true,
          },
          reason: null,
          line,
          pushTitle: `${leadRow.name} created bot '${created.name}'`,
          pushBody: `${modelLabel} on ${teamLabel}`,
          threadId: caller.threadId,
        });
        return {
          botId: created.botId,
          name: created.name,
          team: botTeam(created),
          model: modelLabel,
          changed: [],
          line,
        };
      }),
    );

  /** The fields this call would change on `current`, as an update patch (plus their names). */
  const computePatch = (
    current: PersonalBot,
    fields: LeadBotFields,
    nextName: string | undefined,
    model: LeadModelResult | null,
    nowMs: number,
  ) => {
    const changed: Array<string> = [];
    const patch: Patch = {};
    const setText = (
      key: "name" | "title" | "description" | "instructions",
      next: string | undefined,
    ) => {
      if (next === undefined) return;
      const value = key === "title" ? next.trim() : next;
      if (value !== current[key]) {
        patch[key] = value;
        changed.push(key);
      }
    };
    setText("name", nextName);
    setText("title", fields.title);
    setText("description", fields.description);
    setText("instructions", fields.instructions);
    if (fields.avatarShape !== undefined && fields.avatarShape !== current.avatarShape) {
      patch.avatarShape = fields.avatarShape;
      changed.push("avatarShape");
    }
    if (fields.avatarColor !== undefined && fields.avatarColor !== current.avatarColor) {
      patch.avatarColor = fields.avatarColor;
      changed.push("avatarColor");
    }
    if (model !== null && model.ok && model.changed) {
      patch.modelSelection = model.selection;
      changed.push("model");
    }
    if (
      fields.memoryAutoSave !== undefined &&
      fields.memoryAutoSave !== (current.memoryAutoSave === true)
    ) {
      patch.memoryAutoSave = fields.memoryAutoSave;
      changed.push("memoryAutoSave");
    }
    if (fields.notificationsMute !== undefined) {
      const mutedNow = botNotificationsMutedUntil(current, nowMs) !== null;
      if (fields.notificationsMute !== "on" || mutedNow) {
        patch.notificationsMute = fields.notificationsMute;
        changed.push("notificationsMute");
      }
    }
    return { changed, patch };
  };

  /** Writes the patch, then records it (audit row, chat line, notification). */
  const applyUpdate = Effect.fn("PersonalLeadBot.applyUpdate")(function* (input: {
    readonly leadRow: PersonalBot;
    readonly current: PersonalBot;
    readonly patch: Patch;
    readonly changed: ReadonlyArray<string>;
    readonly team: string;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly threadId: ThreadId;
    readonly confirmationId: string | null;
  }) {
    const { leadRow, current, patch, changed, team } = input;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const updated = yield* bots
      .update({ ...patch, botId: current.botId })
      .pipe(orFail("update the bot"));
    const modelLabel = leadBotModelLabel(updated.modelSelection, input.providers);
    const teamLabel = personalBotTeamLabel(team);

    // The old and new value of every changed field, kept whole for the audit
    // row; the line and the notification carry only what changed, and for
    // long text just its size.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of changed) {
      switch (key) {
        case "model":
          before[key] = current.modelSelection;
          after[key] = updated.modelSelection;
          break;
        case "notificationsMute":
          before[key] = botNotificationsMutedUntil(current, nowMs);
          after[key] = botNotificationsMutedUntil(updated, nowMs);
          break;
        case "memoryAutoSave":
          before[key] = current.memoryAutoSave === true;
          after[key] = updated.memoryAutoSave === true;
          break;
        default:
          before[key] = current[key as "name"];
          after[key] = updated[key as "name"];
      }
    }
    const what = changed
      .map((key) => {
        if (key === "model") return `model → ${modelLabel}`;
        if (key === "instructions" || key === "description") {
          return `${key}: ${current[key].length} → ${updated[key].length} chars`;
        }
        if (key === "name") return `name: '${current.name}' → '${updated.name}'`;
        return key;
      })
      .join(", ");
    const approved = input.confirmationId === null ? "" : " (approved by the user)";
    const line = `${leadRow.name} edited bot '${updated.name}' (${what}) on ${teamLabel}${approved}`;
    yield* record({
      caller: leadRow,
      team,
      action: "update",
      target: updated,
      changed,
      before,
      after,
      reason: null,
      line,
      pushTitle: `${leadRow.name} edited bot '${updated.name}'`,
      pushBody: `${what} on ${teamLabel}`,
      threadId: input.threadId,
      confirmationId: input.confirmationId,
    });
    return { botId: updated.botId, name: updated.name, team, model: modelLabel, changed, line };
  });

  /**
   * Puts a change to the user: stores it with a hash of exactly what it would do,
   * replaces an older card of the same lead for the same bot, and tells the user.
   * Nothing about the bot changes here.
   */
  const raiseConfirmation = Effect.fn("PersonalLeadBot.raiseConfirmation")(function* (input: {
    readonly leadRow: PersonalBot;
    readonly team: string;
    readonly action: "update" | "remove";
    readonly target: PersonalBot;
    /** An update's patch, or a removal's `{ reason }`: what a tap applies and the hash covers. */
    readonly values: Record<string, unknown>;
    readonly base: Record<string, unknown>;
    readonly lines: ReadonlyArray<string>;
    readonly reason: string | null;
    readonly threadId: ThreadId;
  }) {
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const changeHash = leadBotChangeHash({
      botId: input.target.botId,
      action: input.action,
      values: input.values,
    });
    // The same request again while its card is still open is the same card.
    const open = yield* sql<ConfirmationRow>`
      SELECT ${sql.literal(CONFIRMATION_COLUMNS)} FROM personal_lead_bot_confirmations
      WHERE lead_bot_id = ${input.leadRow.botId} AND target_bot_id = ${input.target.botId}
        AND status = 'pending' AND expires_at > ${nowIso}
      ORDER BY created_at DESC
    `.pipe(orFail("look for an open request"));
    const same = open.find((row) => row.changeHash === changeHash);
    if (same !== undefined) return same.confirmationId;

    const confirmationId = NodeCrypto.randomUUID();
    const expiresIso = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) + LEAD_BOT_CONFIRM_WINDOW_MS),
    );
    yield* sql`
      UPDATE personal_lead_bot_confirmations
      SET status = 'superseded', outcome = 'Replaced by a newer request', decided_at = ${nowIso}
      WHERE lead_bot_id = ${input.leadRow.botId} AND target_bot_id = ${input.target.botId}
        AND status = 'pending'
    `.pipe(orFail("replace an older request"));
    yield* sql`
      INSERT INTO personal_lead_bot_confirmations (
        confirmation_id, lead_bot_id, lead_name, team, action, target_bot_id, target_name,
        thread_id, payload_json, change_hash, base_json, lines_json, reason, status,
        created_at, expires_at
      ) VALUES (
        ${confirmationId}, ${input.leadRow.botId}, ${input.leadRow.name}, ${input.team},
        ${input.action}, ${input.target.botId}, ${input.target.name}, ${input.threadId},
        ${encodeJson(input.values)}, ${changeHash}, ${encodeJson(input.base)},
        ${encodeJson(input.lines)}, ${input.reason}, 'pending', ${nowIso}, ${expiresIso}
      )
    `.pipe(orFail("save the request"));
    yield* Effect.logInfo("personal lead bot change requested", {
      confirmationId,
      action: input.action,
      leadBotId: input.leadRow.botId,
      targetBotId: input.target.botId,
      expiresAt: expiresIso,
    });
    if (Option.isSome(push)) {
      const verb = input.action === "remove" ? "remove" : "change";
      yield* push.value
        .notifyTeamBotChange({
          actionId: `confirm-${confirmationId}`,
          leadBotId: input.leadRow.botId,
          title: `${input.leadRow.name} asks to ${verb} bot '${input.target.name}'`,
          body: "Open the chat and tap Yes or No. It expires in 15 minutes.",
          url: `/bots/${encodeURIComponent(input.leadRow.botId)}/${encodeURIComponent(input.threadId)}`,
        })
        .pipe(bestEffort("notification not sent", confirmationId));
    }
    return confirmationId;
  });

  const pendingResult = (
    leadRow: PersonalBot,
    target: PersonalBot,
    team: string,
    changed: ReadonlyArray<string>,
    providersList: ReadonlyArray<ServerProvider>,
    what: string,
    changeId: string,
  ): LeadBotResult => ({
    botId: target.botId,
    name: target.name,
    team,
    model: leadBotModelLabel(target.modelSelection, providersList),
    changed,
    line: `Asked Harout to confirm: ${leadRow.name} would ${what}. Nothing has changed yet.`,
    pendingChangeId: changeId,
  });

  const update: PersonalLeadBotService["Service"]["update"] = (caller, botId, fields) =>
    lock.withPermit(
      Effect.gen(function* () {
        const all = yield* currentProviders;
        const wantsModel =
          fields.model !== undefined ||
          fields.provider !== undefined ||
          fields.effort !== undefined;
        const {
          caller: leadRow,
          target,
          team,
          model,
          confirm,
        } = yield* authorize({
          action: "update",
          callerBotId: caller.botId,
          targetBotId: botId,
          ownerTurn: caller.ownerTurn,
          fields,
          resolveModel: wantsModel
            ? ({ target: row }) =>
                row === null
                  ? { ok: false, reason: "No such bot." }
                  : resolveLeadModelSelection({
                      providers: all,
                      base: row.modelSelection,
                      seedFallback: false,
                      request: modelRequestOf(fields),
                    })
            : undefined,
        });
        const current = target!;
        const { name: nextName } = yield* validateText(fields, current);
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const { changed, patch } = computePatch(current, fields, nextName, model, nowMs);
        if (changed.length === 0) {
          return {
            botId: current.botId,
            name: current.name,
            team,
            model: leadBotModelLabel(current.modelSelection, all),
            changed,
            line: `Nothing changed: '${current.name}' already has those settings.`,
          };
        }
        if (confirm) {
          const lines = diffLines(current, patch, all);
          const changeId = yield* raiseConfirmation({
            leadRow,
            team,
            action: "update",
            target: current,
            values: patch,
            base: baseOf(current, patch),
            lines,
            reason: null,
            threadId: caller.threadId,
          });
          return pendingResult(
            leadRow,
            current,
            team,
            changed,
            all,
            `change '${current.name}' (${lines.join("; ")})`,
            changeId,
          );
        }
        return yield* applyUpdate({
          leadRow,
          current,
          patch,
          changed,
          team,
          providers: all,
          threadId: caller.threadId,
          confirmationId: null,
        });
      }),
    );

  /** Soft-deletes the bot (busy test repeated in the transaction), then records it. */
  const applyRemove = Effect.fn("PersonalLeadBot.applyRemove")(function* (input: {
    readonly leadRow: PersonalBot;
    readonly current: PersonalBot;
    readonly team: string;
    readonly reason: string;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly threadId: ThreadId;
    readonly confirmationId: string | null;
  }) {
    const { leadRow, current, team } = input;
    // A soft delete only: the row is marked deleted and drops out of every
    // list, while its chats, memories, secrets and history stay where they
    // are, so the user can bring it back. (The user's own Delete in the app
    // goes further and purges them; a lead never does.)
    //
    // The busy test runs again inside the transaction that deletes, so a task
    // or turn that began after the first check cannot slip past it: SQLite
    // holds every other writer until this commits.
    const refused = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const counts = yield* busyCountsOf(current.botId);
          const busy = busyRefusal(current, counts.openTasks, counts.activeSessions);
          if (busy !== null) return busy;
          yield* bots.remove({ botId: current.botId });
          return null;
        }),
      )
      .pipe(orFail("remove the bot"));
    if (refused !== null && !refused.allowed) {
      yield* Effect.logWarning("personal lead bot action refused", {
        action: "remove",
        callerBotId: leadRow.botId,
        targetBotId: current.botId,
        code: refused.code,
      });
      return yield* new PersonalLeadBotError({ code: refused.code, reason: refused.reason });
    }
    const teamLabel = personalBotTeamLabel(team);
    const shownReason =
      input.reason.length > LEAD_BOT_REASON_MAX
        ? `${input.reason.slice(0, LEAD_BOT_REASON_MAX)}…`
        : input.reason;
    const approved = input.confirmationId === null ? "" : ", approved by the user";
    const line = `${leadRow.name} removed bot '${current.name}' on ${teamLabel} (chats kept; it can be restored${approved}). Reason: ${shownReason}`;
    yield* record({
      caller: leadRow,
      team,
      action: "remove",
      target: current,
      changed: [],
      before: {
        name: current.name,
        title: current.title,
        description: current.description,
        instructions: current.instructions,
        avatarShape: current.avatarShape,
        avatarColor: current.avatarColor,
        model: current.modelSelection,
        team: botTeam(current),
        memoryAutoSave: current.memoryAutoSave === true,
      },
      after: { removed: true },
      reason: input.reason,
      line,
      pushTitle: `${leadRow.name} removed bot '${current.name}'`,
      pushBody: `on ${teamLabel}. Reason: ${shownReason}. Its chats are kept and it can be restored.`,
      threadId: input.threadId,
      confirmationId: input.confirmationId,
    });
    return {
      botId: current.botId,
      name: current.name,
      team,
      model: leadBotModelLabel(current.modelSelection, input.providers),
      changed: [],
      line,
    };
  });

  const remove: PersonalLeadBotService["Service"]["remove"] = (caller, botId, reason) =>
    lock.withPermit(
      Effect.gen(function* () {
        const {
          caller: leadRow,
          target,
          team,
          confirm,
        } = yield* authorize({
          action: "remove",
          callerBotId: caller.botId,
          targetBotId: botId,
          ownerTurn: caller.ownerTurn,
          fields: {},
        });
        const current = target!;
        const trimmedReason = reason.trim();
        if (looksLikeSecret(trimmedReason)) {
          return yield* invalid(
            "The reason looks like it contains a secret (a key, token or PB_SECRET_ variable). Give the reason in plain words.",
          );
        }
        const all = yield* currentProviders;
        if (confirm) {
          const shown =
            trimmedReason.length > LEAD_BOT_REASON_MAX
              ? `${trimmedReason.slice(0, LEAD_BOT_REASON_MAX)}…`
              : trimmedReason;
          const changeId = yield* raiseConfirmation({
            leadRow,
            team,
            action: "remove",
            target: current,
            values: { reason: trimmedReason },
            base: { name: current.name, team: botTeam(current) },
            lines: [`remove ${current.name} (its chats and memory are kept; you can restore it)`],
            reason: shown,
            threadId: caller.threadId,
          });
          return pendingResult(
            leadRow,
            current,
            team,
            [],
            all,
            `remove '${current.name}'`,
            changeId,
          );
        }
        return yield* applyRemove({
          leadRow,
          current,
          team,
          reason: trimmedReason,
          providers: all,
          threadId: caller.threadId,
          confirmationId: null,
        });
      }),
    );

  // ---- the owner's answer -------------------------------------------------

  const setStatus = (
    confirmationId: string,
    from: PersonalLeadBotChange["status"],
    status: PersonalLeadBotChange["status"],
    outcome: string | null,
  ) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql<{ readonly id: string }>`
        UPDATE personal_lead_bot_confirmations
        SET status = ${status}, outcome = ${outcome}, decided_at = COALESCE(decided_at, ${nowIso})
        WHERE confirmation_id = ${confirmationId} AND status = ${from}
        RETURNING confirmation_id AS id
      `;
      return rows.length > 0;
    });

  const getRow = (confirmationId: string) =>
    sql<ConfirmationRow>`
      SELECT ${sql.literal(CONFIRMATION_COLUMNS)} FROM personal_lead_bot_confirmations
      WHERE confirmation_id = ${confirmationId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const sweepUnlocked = Effect.gen(function* () {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const due = yield* sql<ConfirmationRow>`
      UPDATE personal_lead_bot_confirmations
      SET status = 'expired', outcome = 'Not answered in time', decided_at = ${nowIso}
      WHERE status = 'pending' AND expires_at <= ${nowIso}
      RETURNING ${sql.literal(CONFIRMATION_COLUMNS)}
    `;
    for (const row of due) {
      yield* Effect.logInfo("personal lead bot change expired", {
        confirmationId: row.confirmationId,
        leadBotId: row.leadBotId,
        targetBotId: row.targetBotId,
      });
      yield* answerLead(row, { kind: "expired", what: describeChange(row) });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal lead bot sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  /**
   * Carries out an approved change. Every rule is asked again against the bot and
   * the lead as they are NOW (the lead may have been demoted, the bot moved or
   * renamed since the card was raised), and the bot's own values must still be the
   * ones the card was raised against.
   */
  const applyApproved = Effect.fn("PersonalLeadBot.applyApproved")(function* (
    row: ConfirmationRow,
  ) {
    const all = yield* currentProviders;
    const stored = decodeJson(row.payloadJson) as Record<string, unknown>;
    const patch: Patch = {};
    if (row.action === "update") {
      for (const key of PATCH_KEYS) {
        if (stored[key] !== undefined) (patch as Record<string, unknown>)[key] = stored[key];
      }
    }
    const patchModel = patch.modelSelection;
    const {
      caller: leadRow,
      target,
      team,
    } = yield* authorize({
      action: row.action,
      callerBotId: row.leadBotId,
      targetBotId: row.targetBotId,
      ownerTurn: true,
      approvedByOwner: true,
      fields: {},
      resolveModel:
        patchModel === undefined
          ? undefined
          : ({ target: found }) =>
              found === null
                ? { ok: false, reason: "No such bot." }
                : { ok: true, selection: patchModel, changed: true },
    });
    const current = target!;
    const expectedBase = canonicalJson(decodeJson(row.baseJson));
    const nowBase =
      row.action === "update"
        ? canonicalJson(baseOf(current, patch))
        : canonicalJson({ name: current.name, team: botTeam(current) });
    if (expectedBase !== nowBase) {
      return yield* new PersonalLeadBotError({
        code: "stale",
        reason: `${current.name} has changed since the request was made, so it was not applied.`,
      });
    }
    if (row.action === "remove") {
      return yield* applyRemove({
        leadRow,
        current,
        team,
        reason: typeof stored.reason === "string" ? stored.reason : "",
        providers: all,
        threadId: row.threadId as ThreadId,
        confirmationId: row.confirmationId,
      });
    }
    // The text rules and the name's uniqueness are asked again too.
    const { name: nextName } = yield* validateText(
      {
        name: patch.name,
        title: patch.title,
        description: patch.description,
        instructions: patch.instructions,
      },
      current,
    );
    const changed = Object.keys(patch).map((key) => (key === "modelSelection" ? "model" : key));
    if (nextName !== undefined && patch.name !== undefined) patch.name = nextName;
    return yield* applyUpdate({
      leadRow,
      current,
      patch,
      changed,
      team,
      providers: all,
      threadId: row.threadId as ThreadId,
      confirmationId: row.confirmationId,
    });
  });

  const decideUnlocked = (input: PersonalLeadBotChangeDecideInput) =>
    Effect.gen(function* () {
      yield* sweepUnlocked;
      const row = yield* getRow(input.changeId);
      if (row === null) return yield* changeFailure("That request was not found.");
      if (row.status !== "pending") {
        return yield* changeFailure(
          row.status === "expired"
            ? "That request timed out. Ask the lead to send it again."
            : `That request was already answered (${row.status}).`,
        );
      }
      // The tap is bound to exactly this change: the hash the card showed, and the
      // hash of the values actually stored, must both equal the recorded one.
      const recomputed = leadBotChangeHash({
        botId: row.targetBotId,
        action: row.action,
        values: decodeJson(row.payloadJson),
      });
      if (input.changeHash !== row.changeHash || recomputed !== row.changeHash) {
        return yield* changeFailure(
          "This request no longer matches what the card showed. Ask the lead to send it again.",
        );
      }

      if (input.decision === "declined") {
        yield* setStatus(row.confirmationId, "pending", "declined", "Declined by the user");
        yield* Effect.logInfo("personal lead bot change declined", {
          confirmationId: row.confirmationId,
        });
        yield* answerLead(row, { kind: "declined", what: describeChange(row) });
      } else {
        // Claim it: one tap, one use. A second tap (another device, a retry) finds it spent.
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const claimed = yield* sql<{ readonly id: string }>`
          UPDATE personal_lead_bot_confirmations
          SET status = 'approved', outcome = NULL, decided_at = ${nowIso}
          WHERE confirmation_id = ${row.confirmationId}
            AND status = 'pending' AND expires_at > ${nowIso}
          RETURNING confirmation_id AS id
        `;
        if (claimed.length === 0) {
          return yield* changeFailure("That request timed out or was already answered.");
        }
        const applied = yield* Effect.result(applyApproved(row));
        if (applied._tag === "Success") {
          yield* setStatus(
            row.confirmationId,
            "approved",
            "approved",
            `Done: ${applied.success.line}`,
          );
          yield* answerLead(row, { kind: "approved", what: describeChange(row) });
        } else {
          const why = Schema.is(PersonalLeadBotError)(applied.failure)
            ? applied.failure.reason
            : "The change could not be applied.";
          yield* setStatus(row.confirmationId, "approved", "failed", why);
          yield* Effect.logWarning("personal lead bot change approved but not applied", {
            confirmationId: row.confirmationId,
            why,
          });
          yield* answerLead(row, { kind: "failed", what: describeChange(row), why });
        }
      }
      const settled = yield* getRow(row.confirmationId);
      return toChange(settled ?? row);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const failure = Cause.findErrorOption(cause);
        if (Option.isSome(failure) && Schema.is(PersonalLeadBotChangesError)(failure.value)) {
          return Effect.fail(failure.value);
        }
        return Effect.logWarning("personal lead bot change decide failed", {
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(Effect.fail(changeFailure("Could not save your answer. Try again."))),
        );
      }),
    );

  const listChanges: PersonalLeadBotService["Service"]["listChanges"] = () =>
    lock
      .withPermit(
        Effect.gen(function* () {
          yield* sweepUnlocked;
          const cutoff = DateTime.formatIso(
            DateTime.makeUnsafe(
              DateTime.toEpochMillis(yield* DateTime.now) - LEAD_BOT_CONFIRM_KEEP_MS,
            ),
          );
          const rows = yield* sql<ConfirmationRow>`
            SELECT ${sql.literal(CONFIRMATION_COLUMNS)} FROM personal_lead_bot_confirmations
            WHERE status = 'pending' OR COALESCE(decided_at, created_at) >= ${cutoff}
            ORDER BY created_at ASC
          `;
          return { changes: rows.map(toChange) };
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("personal lead bot change list failed", {
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.andThen(
                  Effect.fail(changeFailure("Could not read the requests. Try again.")),
                ),
              ),
        ),
      );

  const decide: PersonalLeadBotService["Service"]["decide"] = (input) =>
    lock.withPermit(decideUnlocked(input));

  const sweepExpired = lock.withPermit(sweepUnlocked);

  const start: PersonalLeadBotService["Service"]["start"] = () =>
    forkParked(
      sweepExpired.pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(LEAD_BOT_CONFIRM_SWEEP_MS))),
        Effect.asVoid,
      ),
    );

  return {
    create,
    update,
    remove,
    listChanges,
    decide,
    sweepExpired,
    start,
  } satisfies PersonalLeadBotService["Service"];
});

export const layer = Layer.effect(PersonalLeadBotService, make);
