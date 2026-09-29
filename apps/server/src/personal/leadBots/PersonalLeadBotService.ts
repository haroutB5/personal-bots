import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  type OrchestrationMessageContext,
  type PersonalBot,
  type PersonalBotNotificationMute,
  type PersonalBotUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
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
  type LeadBotAction,
  type LeadBotFacts,
  type LeadBotForbiddenField,
  type LeadBotOwnerRequest,
  type LeadBotSensitiveField,
} from "./leadBotPolicy.ts";
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
   * Update and remove: whether the user's own message in this chat names the
   * target (the handler reads the chat). Absent reads as "not_named", so a
   * caller that forgets it is refused, not allowed.
   */
  readonly ownerRequest?: LeadBotOwnerRequest | undefined;
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

export class PersonalLeadBotService extends Context.Service<
  PersonalLeadBotService,
  {
    /** A new member on the caller's own team. */
    readonly create: (
      caller: LeadBotCaller,
      fields: LeadBotFields,
    ) => Effect.Effect<LeadBotResult, PersonalLeadBotError>;
    /** Changes fields of a member of the caller's own team. */
    readonly update: (
      caller: LeadBotCaller,
      botId: string,
      fields: LeadBotFields,
    ) => Effect.Effect<LeadBotResult, PersonalLeadBotError>;
    /** Soft-deletes a member of the caller's own team. */
    readonly remove: (
      caller: LeadBotCaller,
      botId: string,
      reason: string,
    ) => Effect.Effect<LeadBotResult, PersonalLeadBotError>;
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
  const seedModelOverride = yield* Config.String(PERSONAL_SEED_MODEL_ENV).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  // One action at a time: the daily create count is read and written under it.
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

  /** Some lead created this bot (a create row in the audit table); a bot the user made has none. */
  const createdByALead = (botId: string) =>
    sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM personal_lead_bot_actions
      WHERE target_bot_id = ${botId} AND action = 'create'
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
    readonly ownerRequest?: LeadBotOwnerRequest | undefined;
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
      targetCreatedByLead: target !== null ? yield* createdByALead(target.botId) : false,
      ownerRequest: input.ownerRequest ?? "not_named",
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
    return { caller: caller!, target, team: verdict.team, model };
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
    const wanted = normalizeBotNameKey(checked.name);
    const all = yield* repository.listBots().pipe(orFail("read the bot list"));
    const clash = all.find(
      (bot) => bot.botId !== current?.botId && normalizeBotNameKey(bot.name) === wanted,
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
  }) {
    const actionId = NodeCrypto.randomUUID();
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO personal_lead_bot_actions (
        action_id, lead_bot_id, lead_name, team, action, target_bot_id, target_name,
        changed_fields_json, before_json, after_json, reason, summary, thread_id, created_at
      ) VALUES (
        ${actionId}, ${input.caller.botId}, ${input.caller.name}, ${input.team},
        ${input.action}, ${input.target.botId}, ${input.target.name},
        ${encodeChangedFields(input.changed)}, ${encodeJson(input.before)},
        ${encodeJson(input.after)}, ${input.reason}, ${input.line}, ${input.threadId}, ${nowIso}
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
    });
    const messageId = PERSONAL_NOTICE_MESSAGE_ID_PREFIX + `lead-${actionId}`;
    yield* engine
      .dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`personal-lead-bot:${actionId}:notice:delta`),
        threadId: input.threadId,
        messageId: MessageId.make(messageId),
        delta: input.line,
        context,
        createdAt: nowIso,
      })
      .pipe(
        Effect.andThen(
          engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`personal-lead-bot:${actionId}:notice:complete`),
            threadId: input.threadId,
            messageId: MessageId.make(messageId),
            createdAt: nowIso,
          }),
        ),
        bestEffort("line not written in the chat", actionId),
      );
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
        } = yield* authorize({
          action: "update",
          callerBotId: caller.botId,
          targetBotId: botId,
          ownerRequest: caller.ownerRequest,
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

        const changed: Array<string> = [];
        const patch: {
          -readonly [K in keyof PersonalBotUpdateInput]?: PersonalBotUpdateInput[K];
        } = {};
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
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (fields.notificationsMute !== undefined) {
          const mutedNow = botNotificationsMutedUntil(current, nowMs) !== null;
          if (fields.notificationsMute !== "on" || mutedNow) {
            patch.notificationsMute = fields.notificationsMute;
            changed.push("notificationsMute");
          }
        }
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
        const updated = yield* bots
          .update({ ...patch, botId: current.botId })
          .pipe(orFail("update the bot"));
        const modelLabel = leadBotModelLabel(updated.modelSelection, all);
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
        const line = `${leadRow.name} edited bot '${updated.name}' (${what}) on ${teamLabel}`;
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
          threadId: caller.threadId,
        });
        return { botId: updated.botId, name: updated.name, team, model: modelLabel, changed, line };
      }),
    );

  const remove: PersonalLeadBotService["Service"]["remove"] = (caller, botId, reason) =>
    lock.withPermit(
      Effect.gen(function* () {
        const {
          caller: leadRow,
          target,
          team,
        } = yield* authorize({
          action: "remove",
          callerBotId: caller.botId,
          targetBotId: botId,
          ownerRequest: caller.ownerRequest,
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
            callerBotId: caller.botId,
            targetBotId: current.botId,
            code: refused.code,
          });
          return yield* new PersonalLeadBotError({ code: refused.code, reason: refused.reason });
        }
        const teamLabel = personalBotTeamLabel(team);
        const shownReason =
          trimmedReason.length > LEAD_BOT_REASON_MAX
            ? `${trimmedReason.slice(0, LEAD_BOT_REASON_MAX)}…`
            : trimmedReason;
        const line = `${leadRow.name} removed bot '${current.name}' on ${teamLabel} (chats kept; it can be restored). Reason: ${shownReason}`;
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
          reason: trimmedReason,
          line,
          pushTitle: `${leadRow.name} removed bot '${current.name}'`,
          pushBody: `on ${teamLabel}. Reason: ${shownReason}. Its chats are kept and it can be restored.`,
          threadId: caller.threadId,
        });
        return {
          botId: current.botId,
          name: current.name,
          team,
          model: leadBotModelLabel(current.modelSelection, all),
          changed: [],
          line,
        };
      }),
    );

  return { create, update, remove } satisfies PersonalLeadBotService["Service"];
});

export const layer = Layer.effect(PersonalLeadBotService, make);
