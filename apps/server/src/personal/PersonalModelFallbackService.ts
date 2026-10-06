import {
  CommandId,
  ComposerContextId,
  type ModelSelection,
  MessageId,
  type OrchestrationMessageContext,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  type PersonalBot,
  type PersonalBotId,
  type PersonalChatNoticeMarker,
  type ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  isProviderAvailable,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { withStallJob } from "../observability/stallJobs.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import {
  decideFallback,
  decideSwitchBack,
  FALLBACK_RESWITCH_COOLDOWN_MS,
  FALLBACK_SWEEP_MS,
  fallbackModelLabel,
  modelFallbackEnabledByEnv,
  PERSONAL_MODEL_FALLBACK_ENV,
} from "./personalModelFallbackPolicy.ts";
import {
  formatResumeTime,
  PERSONAL_NOTICE_MESSAGE_ID_PREFIX,
  providerLabel,
} from "./personalChatResumePolicy.ts";

/**
 * Usage-limit model fallback (1.65.0).
 *
 * When a bot's provider reports a usage limit on a chat turn or a delegated
 * task, the bot switches to its fallback model (default Claude Sonnet 5.5,
 * effort high, 1M context) instead of waiting for the reset, if the fallback has
 * room. The bot's saved model is never touched: the switch is a row in
 * `personal_bot_fallbacks`, read by `botModelSelectionForThread`, so every turn
 * the server starts (chat, task, routine, retry, resume) runs on the fallback
 * while the row exists, through the same provider-switch path a bot moved to
 * another provider takes (a fresh session that carries the chat over).
 *
 * The switch back is a sweep: once the original limit has reset and the bot is
 * idle (no turn running, no task running), the row is deleted. Never mid-turn.
 *
 * Kill switch: `PERSONAL_MODEL_FALLBACK=off`. Each switch and switch back is
 * logged.
 */
export class PersonalModelFallback extends Context.Service<
  PersonalModelFallback,
  {
    /**
     * A provider limit stopped a turn of `botId`. Switches the bot to its fallback
     * when that is allowed and has room; `switched` is then true and the caller
     * continues the interrupted work now instead of waiting for the reset. Also
     * true for a hit that came from the home provider after the bot had already
     * switched (a turn that was in flight). Never fails.
     */
    readonly onLimitHit: (input: LimitHitInput) => Effect.Effect<LimitHitResult>;
    /** Starts the switch-back sweep. Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One switch-back pass (the start() loop runs it every 30 s). */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/personal/PersonalModelFallbackService/PersonalModelFallback") {}

export type PersonalModelFallbackShape = PersonalModelFallback["Service"];

export interface LimitHitInput {
  readonly botId: PersonalBotId;
  /** The chat the limit stopped; the muted line goes here. Null: no line. */
  readonly threadId: ThreadId | null;
  readonly source: "chat" | "task";
  /** The provider instance that reported the limit, when known. */
  readonly instanceId?: string | null | undefined;
  /** The provider's driver name ("codex", "claudeAgent"), for the label. */
  readonly providerName?: string | null | undefined;
  readonly reason?: string | null | undefined;
  /** When the provider says the limit resets (ISO). */
  readonly retryAt?: string | null | undefined;
}

export interface LimitHitResult {
  readonly switched: boolean;
  /** The fallback's short label ("Sonnet 5.5 · H"), when switched. */
  readonly modelLabel?: string;
  /** Why it did not switch (a log word), when it did not. */
  readonly skipped?: string;
}

const noticeContext = (marker: PersonalChatNoticeMarker): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_CHAT_NOTICE_CONTEXT_KIND),
      label: "Chat notice",
      kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
      payload: marker,
    },
  ],
});

const PROBE_TIMEOUT = Duration.seconds(30);
/** A provider re-probe for one bot at most this often. */
const PROBE_MIN_GAP_MS = 2 * 60_000;

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  /** Read on every call, so the switch can be turned off without a restart of the code path. */
  const killSwitchOn = Config.String(PERSONAL_MODEL_FALLBACK_ENV).pipe(
    Config.option,
    Config.map((value) => modelFallbackEnabledByEnv(Option.getOrUndefined(value))),
    Effect.orElseSucceed(() => true),
  );

  const lastSwitchBackAtMs = new Map<string, number>();
  const lastProbeAtMs = new Map<string, number>();

  const providerSnapshot = (instanceId: string) =>
    providers.getProviders.pipe(
      Effect.map((list) => list.find((candidate) => candidate.instanceId === instanceId)),
    );

  const providerReady = (snapshot: ServerProvider | undefined) =>
    snapshot !== undefined &&
    snapshot.enabled &&
    isProviderAvailable(snapshot) &&
    snapshot.status !== "error" &&
    snapshot.status !== "disabled";

  /** The muted line, as the whole text of an assistant-role notice row. Best effort. */
  const postNotice = (threadId: string, text: string, marker: PersonalChatNoticeMarker) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      const messageId = MessageId.make(`${PERSONAL_NOTICE_MESSAGE_ID_PREFIX}fallback-${uuid}`);
      const createdAt = iso(yield* nowMs);
      const id = ThreadId.make(threadId);
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`personal-model-fallback:${uuid}:notice:delta`),
        threadId: id,
        messageId,
        delta: text,
        context: noticeContext(marker),
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`personal-model-fallback:${uuid}:notice:complete`),
        threadId: id,
        messageId,
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal model fallback could not write its line", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /** Tasks that were waiting out the home limit run now, on the fallback. */
  const releaseWaitingTasks = (botId: string, atMs: number) =>
    sql<{ readonly taskId: string }>`
      UPDATE personal_tasks
      SET available_at = ${iso(atMs)}
      WHERE bot_id = ${botId}
        AND status = 'rate_limited'
        AND (available_at IS NULL OR available_at > ${iso(atMs)})
      RETURNING task_id AS "taskId"
    `.pipe(
      Effect.map((rows) => rows.length),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal model fallback could not release waiting tasks", {
              botId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(0)),
      ),
    );

  const onLimitHit: PersonalModelFallbackShape["onLimitHit"] = (input) =>
    Effect.gen(function* () {
      const botOption = yield* bots.getBotById({ botId: input.botId });
      if (Option.isNone(botOption)) return { switched: false, skipped: "no_bot" };
      const bot = botOption.value;
      const fallback = bot.fallback ?? {
        enabled: true,
        modelSelection: PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
      };
      const now = yield* nowMs;
      const on = yield* killSwitchOn;
      const active = bot.fallbackActive;

      // A turn that was already running on the home provider when the bot
      // switched: it died on the home limit, so it continues on the fallback too.
      if (active !== undefined && on && input.instanceId != null) {
        const states = yield* bots.listFallbackStates();
        const state = states.find((candidate) => candidate.botId === bot.botId);
        if (state !== undefined && state.fromInstanceId === input.instanceId) {
          return {
            switched: true,
            modelLabel: fallbackModelLabel(active.modelSelection),
          } satisfies LimitHitResult;
        }
      }

      const fallbackProvider = yield* providerSnapshot(fallback.modelSelection.instanceId);
      const homeProvider = yield* providerSnapshot(bot.modelSelection.instanceId);
      const retryAtMs = input.retryAt == null ? Number.NaN : Date.parse(input.retryAt);
      const lastBack = lastSwitchBackAtMs.get(bot.botId);
      if (lastBack !== undefined && now - lastBack < FALLBACK_RESWITCH_COOLDOWN_MS) {
        return { switched: false, skipped: "cooldown" };
      }
      const decision = decideFallback({
        killSwitchOn: on,
        botFallbackEnabled: fallback.enabled,
        home: bot.modelSelection,
        fallback: fallback.modelSelection,
        onFallback: active !== undefined,
        reason: input.reason,
        retryAtMs: Number.isFinite(retryAtMs) ? retryAtMs : null,
        nowMs: now,
        fallbackProvider,
        fallbackProviderReady: providerReady(fallbackProvider),
        homeProvider,
      });
      if (decision.kind === "none") {
        yield* Effect.logInfo("personal model fallback not used", {
          botId: bot.botId,
          source: input.source,
          reason: decision.reason,
          home: bot.modelSelection.model,
          fallback: fallback.modelSelection.model,
        });
        return { switched: false, skipped: decision.reason };
      }

      const fromProvider = providerLabel(
        input.providerName ?? homeProvider?.driver ?? bot.modelSelection.instanceId,
      );
      const started = yield* bots.startFallback({
        botId: bot.botId,
        fallbackModel: fallback.modelSelection,
        fromInstanceId: input.instanceId ?? bot.modelSelection.instanceId,
        fromProvider,
        reason: input.reason ?? null,
        startedAt: iso(now),
        resetAt: decision.resetAtMs === null ? null : iso(decision.resetAtMs),
        noticeThreadId: input.threadId,
      });
      const modelLabel = fallbackModelLabel(fallback.modelSelection);
      if (!started) {
        // Another hit switched it a moment ago: this turn continues there.
        return { switched: true, modelLabel };
      }
      const released = yield* releaseWaitingTasks(bot.botId, now);
      yield* Effect.logInfo("personal model fallback switched", {
        botId: bot.botId,
        source: input.source,
        from: bot.modelSelection.model,
        fromProvider,
        to: fallback.modelSelection.model,
        reason: input.reason ?? null,
        resetAt: decision.resetAtMs === null ? null : iso(decision.resetAtMs),
        tasksReleased: released,
      });
      if (input.threadId !== null) {
        const until =
          decision.resetAtMs === null
            ? "until it resets"
            : `until it resets (about ${formatResumeTime(decision.resetAtMs, now)})`;
        yield* postNotice(
          input.threadId,
          `${fromProvider} hit its usage limit. ${bot.name} is on ${modelLabel} ${until}.`,
          {
            notice: "model-fallback-on",
            provider: fromProvider,
            ...(decision.resetAtMs === null ? {} : { resumeAt: iso(decision.resetAtMs) }),
          },
        );
      }
      return { switched: true, modelLabel };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal model fallback failed; the bot waits for the reset", {
              botId: input.botId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ switched: false, skipped: "error" } satisfies LimitHitResult)),
      ),
    );

  /** No turn of the bot is running and no task is running for it. */
  const botIsIdle = (botId: string) =>
    sql<{ readonly busy: number }>`
      SELECT 1 AS "busy"
      FROM personal_bot_threads t
      JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      WHERE t.bot_id = ${botId} AND s.status IN ('running', 'starting')
      UNION ALL
      SELECT 1 AS "busy" FROM personal_tasks WHERE bot_id = ${botId} AND status = 'running'
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length === 0));

  const probe = (bot: PersonalBot, instanceId: string, now: number) =>
    Effect.gen(function* () {
      const last = lastProbeAtMs.get(bot.botId);
      if (last !== undefined && now - last < PROBE_MIN_GAP_MS) return;
      lastProbeAtMs.set(bot.botId, now);
      yield* providers
        .refreshInstance(instanceId as ProviderInstanceId)
        .pipe(Effect.timeoutOption(PROBE_TIMEOUT), Effect.asVoid);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logDebug("personal model fallback could not re-probe the provider", {
              botId: bot.botId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const switchBack = (
    state: PersonalBotRepository.PersonalBotFallbackState,
    bot: PersonalBot | undefined,
    reason: string,
    now: number,
  ) =>
    Effect.gen(function* () {
      const ended = yield* bots.endFallback(state.botId);
      if (!ended) return;
      lastSwitchBackAtMs.set(state.botId, now);
      yield* Effect.logInfo("personal model fallback ended", {
        botId: state.botId,
        reason,
        fromProvider: state.fromProvider,
        heldMs: now - Date.parse(state.startedAt),
      });
      if (bot === undefined || state.noticeThreadId === null) return;
      const home = fallbackModelLabel(bot.modelSelection);
      yield* postNotice(
        state.noticeThreadId,
        `${state.fromProvider} usage limit has reset. ${bot.name} is back on ${home}.`,
        { notice: "model-fallback-off", provider: state.fromProvider },
      );
    });

  const sweepOnce = Effect.gen(function* () {
    const states = yield* bots.listFallbackStates();
    if (states.length === 0) return;
    const now = yield* nowMs;
    const on = yield* killSwitchOn;
    for (const state of states) {
      const botOption = yield* bots.getBotById({ botId: state.botId });
      // A bot that was removed has nothing to switch back; drop the row.
      if (Option.isNone(botOption)) {
        yield* switchBack(state, undefined, "bot_gone", now);
        continue;
      }
      const bot = botOption.value;
      const enabled = bot.fallback?.enabled !== false;
      const startedAtMs = Date.parse(state.startedAt);
      const resetAtMs = state.resetAt === null ? null : Date.parse(state.resetAt);
      const idle = yield* botIsIdle(state.botId);
      const evaluate = (list: ReadonlyArray<ServerProvider>) =>
        decideSwitchBack({
          killSwitchOn: on,
          botFallbackEnabled: enabled,
          nowMs: now,
          startedAtMs,
          resetAtMs: resetAtMs !== null && Number.isFinite(resetAtMs) ? resetAtMs : null,
          home: bot.modelSelection,
          homeProvider: list.find(
            (candidate) => candidate.instanceId === bot.modelSelection.instanceId,
          ),
          idle,
        });
      let decision = evaluate(yield* providers.getProviders);
      // The reset has probably passed: ask the provider once more before going back.
      if (decision.kind === "back" && decision.reason !== "disabled") {
        yield* probe(bot, bot.modelSelection.instanceId, now);
        decision = evaluate(yield* providers.getProviders);
      }
      if (decision.kind === "extend") {
        yield* bots.updateFallbackReset({ botId: state.botId, resetAt: iso(decision.resetAtMs) });
        continue;
      }
      if (decision.kind === "back") yield* switchBack(state, bot, decision.reason, now);
    }
  });

  const sweep: PersonalModelFallbackShape["sweep"] = sweepOnce.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal model fallback sweep failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const start: PersonalModelFallbackShape["start"] = Effect.fn("PersonalModelFallback.start")(
    function* () {
      // A fallback that was active at shutdown is picked up by the first pass.
      yield* forkParked(
        sweep.pipe(
          withStallJob("job:model-fallback-sweep"),
          Effect.repeat(Schedule.spaced(FALLBACK_SWEEP_MS)),
          Effect.asVoid,
        ),
      );
    },
  );

  return { onLimitHit, start, sweep } satisfies PersonalModelFallbackShape;
});

export const layer = Layer.effect(PersonalModelFallback, make);

/** The model a bot runs on while on its fallback, for callers that only have the bot. */
export const activeFallbackModel = (bot: PersonalBot): ModelSelection | undefined =>
  bot.fallbackActive?.modelSelection;
