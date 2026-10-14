import {
  CommandId,
  ComposerContextId,
  DeepSeekSettings,
  type ModelSelection,
  MessageId,
  type OrchestrationMessageContext,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
  type PersonalBot,
  type PersonalBotId,
  type PersonalChatNoticeMarker,
  ProviderInstanceId,
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
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { withStallJob } from "../observability/stallJobs.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import {
  PERSONAL_DEEPSEEK_PEAK_ENV,
  PERSONAL_DEEPSEEK_PEAK_NOW_ENV,
  deepSeekPeakEnabledByEnv,
  isPeakAt,
  isPeakFallback,
  parsePeakClockOverride,
  peakDecisionNowMs,
  planPeakFallback,
} from "./personalDeepSeekPeakPolicy.ts";
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
 * Usage-limit model fallback (1.65.0) and the DeepSeek peak-hours switch
 * (1.66.44).
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
 * The DeepSeek peak switch rides the same row with the reason `deepseek_peak`:
 * while a DeepSeek peak window is open (01:00-04:00 or 06:00-10:00 UTC, Mon-Fri;
 * `isDeepSeekPeakTime`), every bot whose own model is DeepSeek is put on Claude
 * Sonnet 5.5 High, and the row's `resetAt` is the window's own end. The sweep
 * applies it on boot too, so a restart inside a window never puts bots back on
 * DeepSeek, and clears it when the window closes.
 *
 * The switch back is a sweep: once the original limit has reset (or the peak
 * window has closed) and the bot is idle (no turn running, no task running), the
 * row is deleted. Never mid-turn.
 *
 * Kill switches: `PERSONAL_MODEL_FALLBACK=off` (limits) and
 * `PERSONAL_DEEPSEEK_PEAK_SWITCH=off` (peak), plus the DeepSeek instance's own
 * "during peak hours" setting. Each switch and switch back is logged.
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
/** A limit hit from the home provider this soon after the switch is a turn that was already running. */
const IN_FLIGHT_WINDOW_MS = 5 * 60_000;
/** A provider re-probe for one bot at most this often. */
const PROBE_MIN_GAP_MS = 2 * 60_000;
/** The drivers the peak switch keys on. */
const DEEPSEEK_DRIVER = "deepseek";
const CLAUDE_DRIVER = "claudeAgent";

/** Decodes one DeepSeek instance config; a non-DeepSeek config decodes to none. */
const decodeDeepSeekSettings = Schema.decodeUnknownOption(DeepSeekSettings);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const settingsService = yield* ServerSettings.ServerSettingsService;
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
  /** `PERSONAL_DEEPSEEK_PEAK_SWITCH=off` turns the peak switch off server-wide. */
  const peakKillSwitchOn = Config.String(PERSONAL_DEEPSEEK_PEAK_ENV).pipe(
    Config.option,
    Config.map((value) => deepSeekPeakEnabledByEnv(Option.getOrUndefined(value))),
    Effect.orElseSucceed(() => true),
  );
  /** Tests: `PERSONAL_DEEPSEEK_PEAK_NOW` replaces the clock for the peak decision only. */
  const peakClockOverride = Config.String(PERSONAL_DEEPSEEK_PEAK_NOW_ENV).pipe(
    Config.option,
    Config.map((value) => parsePeakClockOverride(Option.getOrUndefined(value))),
    Effect.orElseSucceed(() => null),
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

  /**
   * The Claude selection a peak switch uses: the bot's own fallback instance
   * when that is a Claude one (so a renamed or extra Claude instance is
   * honoured), else the default. Always Sonnet 5.5 High, whatever the bot's
   * own fallback model is. Null when no such instance is ready to run turns.
   */
  const peakTargetSelection = (
    bot: PersonalBot,
    list: ReadonlyArray<ServerProvider>,
    driverOf: (instanceId: string) => string | undefined,
  ): ModelSelection | null => {
    const own = bot.fallback?.modelSelection;
    const candidates: ModelSelection[] =
      own === undefined || own.instanceId === PERSONAL_BOT_DEFAULT_FALLBACK_MODEL.instanceId
        ? [PERSONAL_BOT_DEFAULT_FALLBACK_MODEL]
        : [
            { ...PERSONAL_BOT_DEFAULT_FALLBACK_MODEL, instanceId: own.instanceId },
            PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
          ];
    for (const candidate of candidates) {
      if (driverOf(candidate.instanceId) !== CLAUDE_DRIVER) continue;
      if (!providerReady(list.find((entry) => entry.instanceId === candidate.instanceId))) continue;
      return candidate;
    }
    return null;
  };

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
      if (Option.isNone(botOption)) {
        yield* Effect.logInfo("personal model fallback not used", {
          botId: input.botId,
          source: input.source,
          reason: "no_bot",
        });
        return { switched: false, skipped: "no_bot" };
      }
      const bot = botOption.value;
      const fallback = bot.fallback ?? {
        enabled: true,
        modelSelection: PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
      };
      const now = yield* nowMs;
      const on = yield* killSwitchOn;
      const active = bot.fallbackActive;
      // The DeepSeek peak switch is a fallback row too, but not a limit one: a
      // limit on the peak model is a limit on what the bot is actually running,
      // so the bot's own fallback chain starts from there (1.66.44).
      const peakActive =
        active !== undefined && active.reason === PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK
          ? active
          : undefined;

      // A turn that was already running on the home provider when the bot
      // switched: it died on the home limit, so it continues on the fallback too.
      if (active !== undefined && on && input.instanceId != null) {
        const states = yield* bots.listFallbackStates();
        const state = states.find((candidate) => candidate.botId === bot.botId);
        // Only a hit from the home provider, soon after the switch (a turn that was
        // in flight). A fallback on the home provider itself cannot tell its own
        // hits from the home's, and a late hit means the fallback is limited too.
        if (
          state !== undefined &&
          state.fromInstanceId === input.instanceId &&
          fallback.modelSelection.instanceId !== input.instanceId &&
          now - Date.parse(state.startedAt) < IN_FLIGHT_WINDOW_MS
        ) {
          return {
            switched: true,
            modelLabel: fallbackModelLabel(active.modelSelection),
          } satisfies LimitHitResult;
        }
      }

      const fallbackProvider = yield* providerSnapshot(fallback.modelSelection.instanceId);
      // On the peak switch the model that just hit its limit is the peak model.
      const decisionHome = peakActive?.modelSelection ?? bot.modelSelection;
      const homeProvider = yield* providerSnapshot(decisionHome.instanceId);
      const retryAtMs = input.retryAt == null ? Number.NaN : Date.parse(input.retryAt);
      const lastBack = lastSwitchBackAtMs.get(bot.botId);
      if (lastBack !== undefined && now - lastBack < FALLBACK_RESWITCH_COOLDOWN_MS) {
        // Same line as every other guard that holds a switch back, with the time left.
        yield* Effect.logInfo("personal model fallback not used", {
          botId: bot.botId,
          source: input.source,
          reason: "cooldown",
          secondsLeft: Math.ceil((FALLBACK_RESWITCH_COOLDOWN_MS - (now - lastBack)) / 1000),
          home: bot.modelSelection.model,
          fallback: fallback.modelSelection.model,
        });
        return { switched: false, skipped: "cooldown" };
      }
      const decision = decideFallback({
        killSwitchOn: on,
        botFallbackEnabled: fallback.enabled,
        home: decisionHome,
        fallback: fallback.modelSelection,
        // A peak switch does not count as "already on a fallback": the chain
        // from the peak model to the bot's own fallback must still run.
        onFallback: active !== undefined && peakActive === undefined,
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
          home: decisionHome.model,
          fallback: fallback.modelSelection.model,
        });
        return { switched: false, skipped: decision.reason };
      }

      const fromProvider = providerLabel(
        input.providerName ?? homeProvider?.driver ?? decisionHome.instanceId,
      );
      const nextState = {
        botId: bot.botId,
        fallbackModel: fallback.modelSelection,
        fromInstanceId: input.instanceId ?? decisionHome.instanceId,
        fromProvider,
        reason: input.reason ?? null,
        startedAt: iso(now),
        resetAt: decision.resetAtMs === null ? null : iso(decision.resetAtMs),
        noticeThreadId: input.threadId,
      };
      // A peak row already exists for this bot: the real limit replaces it, so
      // the bot is on its own fallback for the rest of the peak window too.
      const started =
        peakActive === undefined
          ? yield* bots.startFallback(nextState)
          : yield* bots.switchFallback(nextState);
      const modelLabel = fallbackModelLabel(fallback.modelSelection);
      if (!started) {
        // Another hit switched it a moment ago: this turn continues there.
        return { switched: true, modelLabel };
      }
      const released = yield* releaseWaitingTasks(bot.botId, now);
      yield* Effect.logInfo(
        peakActive === undefined
          ? "personal model fallback switched"
          : "personal model fallback switched off the deepseek peak model",
        {
          botId: bot.botId,
          source: input.source,
          from: decisionHome.model,
          fromProvider,
          to: fallback.modelSelection.model,
          reason: input.reason ?? null,
          resetAt: decision.resetAtMs === null ? null : iso(decision.resetAtMs),
          tasksReleased: released,
        },
      );
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
      const last = lastProbeAtMs.get(instanceId);
      if (last !== undefined && now - last < PROBE_MIN_GAP_MS) return;
      lastProbeAtMs.set(instanceId, now);
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
      // Persist the switch and wakeups together: a restart cannot lose the
      // release after the fallback row has disappeared. Workers keep ownership
      // of claiming tasks and chats; this never starts a turn itself.
      const ended = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* botIsIdle(state.botId))) return false;
          const ended = yield* bots.endFallback(state.botId);
          if (!ended || bot === undefined || reason === "disabled") return ended;
          yield* sql`
          UPDATE personal_tasks SET available_at = ${iso(now)}
          WHERE bot_id = ${state.botId} AND status = 'rate_limited'
            AND (available_at IS NULL OR available_at > ${iso(now)})
            AND NOT EXISTS (
              SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = personal_tasks.thread_id
                AND s.provider_instance_id IS NOT NULL
                AND s.provider_instance_id NOT IN (${state.fromInstanceId}, ${state.fallbackModel.instanceId})
            )
        `;
          yield* sql`
          UPDATE personal_chat_resumes SET resume_at = ${iso(now)}, fallback = 0
          WHERE status = 'scheduled' AND resume_at > ${iso(now)}
            AND thread_id IN (SELECT thread_id FROM personal_bot_threads WHERE bot_id = ${state.botId})
            AND NOT EXISTS (
              SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = personal_chat_resumes.thread_id
                AND s.provider_instance_id IS NOT NULL
                AND s.provider_instance_id NOT IN (${state.fromInstanceId}, ${state.fallbackModel.instanceId})
            )
        `;
          return ended;
        }),
      );
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

  /**
   * Clears a DeepSeek peak state. Idle-gated like every other model change: a
   * turn already running finishes on the peak model, the next one uses the
   * bot's own. No notice and no task or chat wakeup: nothing was waiting.
   */
  const endPeakFallback = (
    state: PersonalBotRepository.PersonalBotFallbackState,
    reason: string,
    now: number,
  ) =>
    Effect.gen(function* () {
      const ended = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* botIsIdle(state.botId))) return false;
          return yield* bots.endFallback(state.botId);
        }),
      );
      if (!ended) return;
      yield* Effect.logInfo("personal deepseek peak switch ended", {
        botId: state.botId,
        reason,
        heldMs: now - Date.parse(state.startedAt),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal deepseek peak switch could not end", {
              botId: state.botId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const sweepOnce = Effect.gen(function* () {
    const realNow = yield* nowMs;
    const on = yield* killSwitchOn;
    const peakOn = yield* peakKillSwitchOn;
    const override = yield* peakClockOverride;
    const peakNow = peakDecisionNowMs(realNow, override);
    const peakAt = isPeakAt(peakNow);
    const states = yield* bots.listFallbackStates();
    const stateByBot = new Map(states.map((state) => [state.botId as string, state] as const));
    let now = realNow;

    // The peak switch needs the providers for the instance's driver and for the
    // Claude side's readiness, and settings for the instance's own toggle. Both
    // are read once per pass, and only when a peak could matter.
    const list = yield* providers.getProviders;
    const peakingNow = peakAt || states.some((state) => isPeakFallback(state));
    const settings = peakingNow
      ? yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    const driverOf = (instanceId: string): string | undefined =>
      list.find((candidate) => candidate.instanceId === instanceId)?.driver ??
      settings?.providerInstances[ProviderInstanceId.make(instanceId)]?.driver;
    /** The DeepSeek instance's own "during peak hours" setting; on unless turned off. */
    const instanceSettingOn = (instanceId: string): boolean => {
      const instance = settings?.providerInstances[ProviderInstanceId.make(instanceId)];
      if (instance === undefined) return true;
      const decoded = decodeDeepSeekSettings(instance.config ?? {});
      return Option.isNone(decoded) ? true : decoded.value.peakSwitch;
    };

    const peakPlanFor = (
      bot: PersonalBot | undefined,
      homeIsDeepSeek: boolean,
      onPeakFallback: boolean,
      onUsageLimitFallback: boolean,
    ) =>
      planPeakFallback({
        atMs: peakNow,
        killSwitchOn: peakOn,
        // A bot that is gone has no instance left to ask; only the off path matters.
        instanceSettingOn:
          bot === undefined ? true : instanceSettingOn(bot.modelSelection.instanceId),
        homeIsDeepSeek,
        onUsageLimitFallback,
        onPeakFallback,
      });

    for (const state of states) {
      const botOption = yield* bots.getBotById({ botId: state.botId });
      const bot = Option.isNone(botOption) ? undefined : botOption.value;

      // ----- The DeepSeek peak switch (1.66.44) -----
      if (isPeakFallback(state)) {
        const homeIsDeepSeek =
          bot !== undefined && driverOf(bot.modelSelection.instanceId) === DEEPSEEK_DRIVER;
        const plan = peakPlanFor(bot, homeIsDeepSeek, true, false);
        if (plan.kind === "keep") {
          if (plan.untilMs !== null && state.resetAt !== iso(plan.untilMs)) {
            yield* bots.updateFallbackReset({
              botId: state.botId,
              resetAt: iso(plan.untilMs),
            });
          }
          continue;
        }
        if (plan.kind === "switch_off") {
          yield* endPeakFallback(state, plan.reason, realNow);
        }
        continue;
      }

      // ----- A usage-limit fallback -----
      // A bot that was removed has nothing to switch back; drop the row.
      if (bot === undefined) {
        yield* switchBack(state, undefined, "bot_gone", now);
        continue;
      }
      const enabled = bot.fallback?.enabled !== false;
      const startedAtMs = Date.parse(state.startedAt);
      const resetAtMs = state.resetAt === null ? null : Date.parse(state.resetAt);
      // Early redemption can happen outside this app. Probe on the same bounded
      // cadence even when the recorded reset is still days away.
      if (on && enabled) yield* probe(bot, bot.modelSelection.instanceId, now);
      now = yield* nowMs;
      const idle = yield* botIsIdle(state.botId);
      const evaluate = (providers: ReadonlyArray<ServerProvider>) =>
        decideSwitchBack({
          killSwitchOn: on,
          botFallbackEnabled: enabled,
          nowMs: now,
          startedAtMs,
          resetAtMs: resetAtMs !== null && Number.isFinite(resetAtMs) ? resetAtMs : null,
          home: bot.modelSelection,
          recoveryProviderReady:
            state.fromInstanceId === bot.modelSelection.instanceId &&
            providerReady(
              providers.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId),
            ),
          limitReason: state.reason,
          homeProvider: providers.find(
            (candidate) => candidate.instanceId === bot.modelSelection.instanceId,
          ),
          idle,
        });
      const decision = evaluate(list);
      if (decision.kind === "extend") {
        yield* bots.updateFallbackReset({ botId: state.botId, resetAt: iso(decision.resetAtMs) });
        continue;
      }
      if (decision.kind === "back") yield* switchBack(state, bot, decision.reason, now);
    }

    // ----- Put DeepSeek bots on the peak model while a window is open -----
    if (!peakAt) return;
    const all = yield* bots.listBots();
    for (const bot of all) {
      const state = stateByBot.get(bot.botId);
      // A peak row was kept or cleared by the loop above; a usage-limit row is
      // never touched by this switch.
      if (state !== undefined && isPeakFallback(state)) continue;
      const homeInstanceId = bot.modelSelection.instanceId;
      const plan = peakPlanFor(
        bot,
        driverOf(homeInstanceId) === DEEPSEEK_DRIVER,
        false,
        state !== undefined,
      );
      if (plan.kind !== "switch_on") continue;
      const target = peakTargetSelection(bot, list, driverOf);
      if (target === null) {
        yield* Effect.logInfo("personal deepseek peak switch skipped", {
          botId: bot.botId,
          reason: "no_claude_provider",
        });
        continue;
      }
      const started = yield* bots.startFallback({
        botId: bot.botId,
        fallbackModel: target,
        fromInstanceId: homeInstanceId,
        fromProvider: providerLabel(driverOf(homeInstanceId) ?? homeInstanceId),
        reason: PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
        startedAt: iso(realNow),
        resetAt: iso(plan.untilMs),
        // No notice: nothing was interrupted, and the caption says why.
        noticeThreadId: null,
      });
      if (started) {
        yield* Effect.logInfo("personal deepseek peak switch started", {
          botId: bot.botId,
          from: bot.modelSelection.model,
          to: target.model,
          until: iso(plan.untilMs),
        });
      }
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
