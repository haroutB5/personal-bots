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
  PERSONAL_FALLBACK_REASON_SCHEDULE,
  type PersonalBot,
  type PersonalBotId,
  type PersonalChatNoticeMarker,
  scheduleMatchesOwnModel as modelSelectionsMatch,
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
  isScheduleFallback,
  modelScheduleEnabledByEnv,
  PERSONAL_MODEL_SCHEDULE_ENV,
  PERSONAL_MODEL_SCHEDULE_NOW_ENV,
  PERSONAL_MODEL_SCHEDULE_TZ_ENV,
  scheduleState,
  scheduleTimeZone,
} from "./personalModelSchedulePolicy.ts";
import {
  decideFallback,
  decideSwitchBack,
  FALLBACK_RESWITCH_COOLDOWN_MS,
  FALLBACK_SWEEP_MS,
  fallbackModelLabel,
  isProviderCapacityError,
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
 * The per-bot model schedule (reason `schedule`) rides it as well: while a bot's
 * daily window ("Use a different model at set times") is open its row names the
 * scheduled model and its `resetAt` is the window's end. Precedence: a usage
 * limit hit wins (the bot's own fallback), then the schedule, then the DeepSeek
 * peak switch; a scheduled DeepSeek model in a peak window runs on Sonnet 5.5
 * High like any DeepSeek bot.
 *
 * The switch back is a sweep: once the original limit has reset (or the peak
 * window or the scheduled window has closed) and the bot is idle (no turn
 * running, no task running), the row is deleted. A schedule or a peak row also
 * starts only while the bot is idle for the schedule (between turns). Never
 * mid-turn.
 *
 * Kill switches: `PERSONAL_MODEL_FALLBACK=off` (limits),
 * `PERSONAL_DEEPSEEK_PEAK_SWITCH=off` (peak) and `PERSONAL_MODEL_SCHEDULE=off`
 * (schedule), plus the DeepSeek instance's own "during peak hours" setting. Each
 * switch and switch back is logged.
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
  /** The provider was at capacity rather than out of a usage window. */
  readonly capacity?: boolean;
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

  /** `PERSONAL_MODEL_SCHEDULE=off` turns every bot's model schedule off. */
  const scheduleKillSwitchOn = Config.String(PERSONAL_MODEL_SCHEDULE_ENV).pipe(
    Config.option,
    Config.map((value) => modelScheduleEnabledByEnv(Option.getOrUndefined(value))),
    Effect.orElseSucceed(() => true),
  );
  /** Tests: `PERSONAL_MODEL_SCHEDULE_NOW` replaces the clock for the schedule decision only. */
  const scheduleClockOverride = Config.String(PERSONAL_MODEL_SCHEDULE_NOW_ENV).pipe(
    Config.option,
    Config.map((value) => parsePeakClockOverride(Option.getOrUndefined(value))),
    Effect.orElseSucceed(() => null),
  );
  /** The laptop's own time zone (schedule times are wall-clock times there); tests may name one. */
  const timeZoneOverride = Config.String(PERSONAL_MODEL_SCHEDULE_TZ_ENV).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
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
      // The DeepSeek peak switch and the model schedule are fallback rows too,
      // but not limit ones: a limit on that model is a limit on what the bot is
      // actually running, so the bot's own fallback chain starts from there
      // (1.66.44; the schedule rides the same rule).
      const peakActive =
        active !== undefined &&
        (active.reason === PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK ||
          active.reason === PERSONAL_FALLBACK_REASON_SCHEDULE)
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
      // On the peak switch or the schedule the model that just hit its limit is the one the row names.
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
        capacityHit: input.capacity === true,
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
      // A peak or schedule row already exists for this bot: the real limit
      // replaces it, so the bot is on its own fallback until the limit resets.
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
          : "personal model fallback switched off the deepseek peak or scheduled model",
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
          input.capacity === true
            ? `${fromProvider} is at capacity. ${bot.name} is on ${modelLabel} ${
                decision.resetAtMs === null
                  ? "and will retry its own model shortly"
                  : `until about ${formatResumeTime(decision.resetAtMs, now)}`
              }.`
            : `${fromProvider} hit its usage limit. ${bot.name} is on ${modelLabel} ${until}.`,
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
    /** The model the bot runs on next when that is not its own (a schedule window is open). */
    backOn?: ModelSelection,
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
      const home = fallbackModelLabel(backOn ?? bot.modelSelection);
      yield* postNotice(
        state.noticeThreadId,
        isProviderCapacityError(state.reason)
          ? `${state.fromProvider} is available again. ${bot.name} is back on ${home}.`
          : `${state.fromProvider} usage limit has reset. ${bot.name} is back on ${home}.`,
        { notice: "model-fallback-off", provider: state.fromProvider },
      );
    });

  /**
   * Clears a DeepSeek peak or model schedule state. Idle-gated like every other
   * model change: a turn already running finishes on the model it started on,
   * the next one uses the bot's own. No notice and no task or chat wakeup:
   * nothing was waiting.
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
      yield* Effect.logInfo(
        isScheduleFallback(state)
          ? "personal model schedule ended"
          : "personal deepseek peak switch ended",
        {
          botId: state.botId,
          reason,
          heldMs: now - Date.parse(state.startedAt),
        },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal deepseek peak or schedule switch could not end", {
              botId: state.botId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const sweepOnce = Effect.gen(function* () {
    const realNow = yield* nowMs;
    const on = yield* killSwitchOn;
    const peakOn = yield* peakKillSwitchOn;
    const scheduleOn = yield* scheduleKillSwitchOn;
    const override = yield* peakClockOverride;
    const peakNow = peakDecisionNowMs(realNow, override);
    const peakAt = isPeakAt(peakNow);
    const scheduleNow = peakDecisionNowMs(realNow, yield* scheduleClockOverride);
    const timeZone = scheduleTimeZone(yield* timeZoneOverride);
    const states = yield* bots.listFallbackStates();
    let now = realNow;

    // The peak switch needs the providers for the instance's driver and for the
    // Claude side's readiness, and settings for the instance's own toggle. Both
    // are read once per pass, and settings only when a peak or a schedule could
    // matter.
    const list = yield* providers.getProviders;
    const scheduled =
      scheduleOn || states.some((state) => isScheduleFallback(state))
        ? (yield* bots.listBots()).some((bot) => bot.schedule?.enabled === true)
        : false;
    const peakingNow = peakAt || scheduled || states.some((state) => isPeakFallback(state));
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

    /**
     * What a bot's model schedule asks for right now: the model to run on and
     * when the window closes, or why it asks for nothing. A scheduled DeepSeek
     * model while a peak window is open runs on Sonnet 5.5 High, as any DeepSeek
     * bot does; a scheduled model whose provider cannot run is not applied.
     */
    const scheduleFor = (
      bot: PersonalBot,
    ):
      | { readonly kind: "open"; readonly untilMs: number; readonly selection: ModelSelection }
      | { readonly kind: "closed"; readonly reason: string } => {
      const decided = scheduleState({
        atMs: scheduleNow,
        timeZone,
        killSwitchOn: scheduleOn,
        schedule: bot.schedule,
        home: bot.modelSelection,
      });
      if (decided.kind === "closed") return decided;
      let selection = decided.selection;
      if (
        peakAt &&
        peakOn &&
        driverOf(selection.instanceId) === DEEPSEEK_DRIVER &&
        instanceSettingOn(selection.instanceId)
      ) {
        selection = peakTargetSelection(bot, list, driverOf) ?? selection;
      }
      if (!providerReady(list.find((entry) => entry.instanceId === selection.instanceId))) {
        return { kind: "closed", reason: "provider_not_ready" };
      }
      return { kind: "open", untilMs: decided.untilMs, selection };
    };

    for (const state of states) {
      const botOption = yield* bots.getBotById({ botId: state.botId });
      const bot = Option.isNone(botOption) ? undefined : botOption.value;

      // ----- The model schedule -----
      if (isScheduleFallback(state)) {
        const wanted =
          bot === undefined ? ({ kind: "closed", reason: "bot_gone" } as const) : scheduleFor(bot);
        if (wanted.kind === "closed") {
          yield* endPeakFallback(state, wanted.reason, realNow);
          continue;
        }
        const nextResetAt = iso(wanted.untilMs);
        if (!modelSelectionsMatch(state.fallbackModel, wanted.selection)) {
          // The window is still open but the model it names moved (the schedule
          // was edited, or a peak window opened or closed on a scheduled DeepSeek
          // model): between turns only.
          if (yield* botIsIdle(state.botId)) {
            const swapped = yield* bots.switchFallback({
              ...state,
              fallbackModel: wanted.selection,
              resetAt: nextResetAt,
            });
            if (swapped) {
              yield* Effect.logInfo("personal model schedule model changed", {
                botId: state.botId,
                to: wanted.selection.model,
                until: nextResetAt,
              });
            }
          }
          continue;
        }
        if (state.resetAt !== nextResetAt) {
          yield* bots.updateFallbackReset({ botId: state.botId, resetAt: nextResetAt });
        }
        continue;
      }

      // ----- The DeepSeek peak switch (1.66.44) -----
      if (isPeakFallback(state)) {
        // A schedule outranks the peak switch: the bot moves onto its scheduled
        // model, between turns.
        const wanted = bot === undefined ? undefined : scheduleFor(bot);
        if (wanted !== undefined && wanted.kind === "open") {
          if (yield* botIsIdle(state.botId)) {
            const swapped = yield* bots.switchFallback({
              botId: state.botId,
              fallbackModel: wanted.selection,
              fromInstanceId: state.fromInstanceId,
              fromProvider: state.fromProvider,
              reason: PERSONAL_FALLBACK_REASON_SCHEDULE,
              startedAt: iso(realNow),
              resetAt: iso(wanted.untilMs),
              noticeThreadId: null,
            });
            if (swapped) {
              yield* Effect.logInfo(
                "personal model schedule started over the deepseek peak switch",
                {
                  botId: state.botId,
                  to: wanted.selection.model,
                  until: iso(wanted.untilMs),
                },
              );
            }
          }
          continue;
        }
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
          // The stored reason is the provider's own text: a capacity hit keeps
          // its fixed hold instead of being cut short by healthy usage readings.
          capacityHit: isProviderCapacityError(state.reason),
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
      if (decision.kind === "back") {
        // Back to the model the bot runs on next: its scheduled one while a window is open.
        const next = scheduleFor(bot);
        yield* switchBack(
          state,
          bot,
          decision.reason,
          now,
          next.kind === "open" ? next.selection : undefined,
        );
      }
    }

    // ----- Put bots on their scheduled or the peak model while a window is open -----
    if (!peakAt && !scheduled) return;
    // Read after the pass above, so a row it ended or swapped is seen as it now is.
    const all = yield* bots.listBots();
    for (const bot of all) {
      // A row of any kind (a usage limit, the peak switch or the schedule) was
      // kept or cleared by the loop above; a usage-limit row is never touched.
      if (bot.fallbackActive !== undefined) continue;
      const homeInstanceId = bot.modelSelection.instanceId;

      // The schedule outranks the peak switch. It starts between turns only.
      const wanted = scheduleFor(bot);
      if (wanted.kind === "open") {
        if (!(yield* botIsIdle(bot.botId))) continue;
        const started = yield* bots.startFallback({
          botId: bot.botId,
          fallbackModel: wanted.selection,
          fromInstanceId: homeInstanceId,
          fromProvider: providerLabel(driverOf(homeInstanceId) ?? homeInstanceId),
          reason: PERSONAL_FALLBACK_REASON_SCHEDULE,
          startedAt: iso(realNow),
          resetAt: iso(wanted.untilMs),
          // No notice: nothing was interrupted, and the caption says why.
          noticeThreadId: null,
        });
        if (started) {
          yield* Effect.logInfo("personal model schedule started", {
            botId: bot.botId,
            from: bot.modelSelection.model,
            to: wanted.selection.model,
            until: iso(wanted.untilMs),
          });
        }
        continue;
      }

      if (!peakAt) continue;
      const plan = peakPlanFor(bot, driverOf(homeInstanceId) === DEEPSEEK_DRIVER, false, false);
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
