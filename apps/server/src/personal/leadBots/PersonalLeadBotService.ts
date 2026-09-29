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
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import {
  authorizeLeadBotAction,
  LEAD_BOT_CREATE_WINDOW_MS,
  LEAD_BOT_FORBIDDEN_FIELDS,
  looksLikeSecret,
  type LeadBotAction,
  type LeadBotFacts,
  type LeadBotForbiddenField,
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
    ) => Effect.Effect<LeadBotResult, PersonalLeadBotError>;
  }
>()("t3/personal/leadBots/PersonalLeadBotService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const tasks = yield* PersonalTaskService.PersonalTaskService;
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

  const openTasksOf = (botId: string) =>
    tasks.list({ botId: PersonalBotId.make(botId) }).pipe(
      Effect.map(
        (result) =>
          result.tasks.filter((task) => !PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status))
            .length,
      ),
      orFail("read the bot's tasks"),
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
    const facts: LeadBotFacts = {
      action: input.action,
      caller,
      target,
      forbiddenFields: forbiddenFieldsOf(input.fields),
      requestedModel:
        model !== null && model.ok
          ? { instanceId: model.selection.instanceId, model: model.selection.model }
          : null,
      createsInWindow:
        input.action === "create" && caller !== null
          ? yield* createsInWindow(caller.botId, nowMs)
          : 0,
      targetOpenTasks:
        input.action === "remove" && target !== null ? yield* openTasksOf(target.botId) : 0,
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

  /** Length, secrets and a unique name: the checks about the text, not about the caller. */
  const validateText = Effect.fn("PersonalLeadBot.validateText")(function* (
    fields: LeadBotFields,
    exceptBotId: string | null,
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
    if (fields.name !== undefined) {
      const wanted = fields.name.trim().toLowerCase();
      if (wanted === "") return yield* invalid("The name cannot be empty.");
      const all = yield* repository.listBots().pipe(orFail("read the bot list"));
      const clash = all.find(
        (bot) => bot.botId !== exceptBotId && bot.name.trim().toLowerCase() === wanted,
      );
      if (clash !== undefined) {
        return yield* invalid(
          `A bot called '${clash.name}' already exists; delegation finds bots by name, so pick a different name.`,
        );
      }
    }
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
        changed_fields_json, summary, thread_id, created_at
      ) VALUES (
        ${actionId}, ${input.caller.botId}, ${input.caller.name}, ${input.team},
        ${input.action}, ${input.target.botId}, ${input.target.name},
        ${encodeChangedFields(input.changed)}, ${input.line}, ${input.threadId}, ${nowIso}
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
        yield* validateText(fields, null);
        const selection = (model as Extract<LeadModelResult, { ok: true }>).selection;
        const name = fields.name.trim();
        const created = yield* bots
          .create({
            botId: PersonalBotId.make(`bot-${NodeCrypto.randomUUID()}`),
            name,
            title: (fields.title ?? "").trim(),
            description: fields.description ?? "",
            instructions: fields.instructions ?? "",
            avatarShape: fields.avatarShape ?? AVATAR_SHAPES[hashOf(name) % AVATAR_SHAPES.length]!,
            avatarColor: fields.avatarColor ?? AVATAR_COLORS[hashOf(name) % AVATAR_COLORS.length]!,
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
        yield* validateText(fields, current.botId);

        const changed: Array<string> = [];
        const patch: {
          -readonly [K in keyof PersonalBotUpdateInput]?: PersonalBotUpdateInput[K];
        } = {};
        const setText = (
          key: "name" | "title" | "description" | "instructions",
          next: string | undefined,
        ) => {
          if (next === undefined) return;
          const value = key === "name" || key === "title" ? next.trim() : next;
          if (value !== current[key]) {
            patch[key] = value;
            changed.push(key);
          }
        };
        setText("name", fields.name);
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
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
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
        const what = changed
          .map((key) => (key === "model" ? `model → ${modelLabel}` : key))
          .join(", ");
        const line = `${leadRow.name} edited bot '${updated.name}' (${what}) on ${teamLabel}`;
        yield* record({
          caller: leadRow,
          team,
          action: "update",
          target: updated,
          changed,
          line,
          pushTitle: `${leadRow.name} edited bot '${updated.name}'`,
          pushBody: `${what} on ${teamLabel}`,
          threadId: caller.threadId,
        });
        return { botId: updated.botId, name: updated.name, team, model: modelLabel, changed, line };
      }),
    );

  const remove: PersonalLeadBotService["Service"]["remove"] = (caller, botId) =>
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
          fields: {},
        });
        const current = target!;
        const all = yield* currentProviders;
        // A soft delete only: the row is marked deleted and drops out of every
        // list, while its chats, memories, secrets and history stay where they
        // are, so the user can bring it back. (The user's own Delete in the app
        // goes further and purges them; a lead never does.)
        yield* bots.remove({ botId: current.botId }).pipe(orFail("remove the bot"));
        const teamLabel = personalBotTeamLabel(team);
        const line = `${leadRow.name} removed bot '${current.name}' on ${teamLabel} (chats kept; it can be restored)`;
        yield* record({
          caller: leadRow,
          team,
          action: "remove",
          target: current,
          changed: [],
          line,
          pushTitle: `${leadRow.name} removed bot '${current.name}'`,
          pushBody: `on ${teamLabel}. Its chats are kept and it can be restored.`,
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
