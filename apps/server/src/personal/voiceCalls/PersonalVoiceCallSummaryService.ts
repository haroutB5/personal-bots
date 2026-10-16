/**
 * Writing a call's summary, and keeping that work off the card's critical path.
 *
 * Harout, 16 Oct 2026: after a call that answered a real question (Court 3 free
 * 11:00-12:00 before his Saturday booking) the chat showed nothing, and he
 * wanted to remember it. The card is stored the moment the call ends; this
 * service then reads its transcript back and asks Gemini text for one sentence,
 * a few concrete bullets and the owner's last decision.
 *
 * How it behaves, and why:
 *
 * - **It never blocks or breaks a card.** Nothing here is called by `finish`.
 *   A worker sweeps for calls that have a transcript and no summary, so a
 *   failure, a missing key or an empty account simply leaves the card with its
 *   transcript, exactly as it was before this feature existed.
 * - **A failed call is retried about a minute later**, twice, then left alone.
 *   The wait also means a quota error or a flaky network is not hammered.
 * - **The boot sweep is the backfill.** Calls stored before this existed are
 *   found by the same query on the next start, so nothing has to be migrated.
 * - **The transcript goes to Google and nowhere else.** The prompt carries the
 *   owner's own words and the same brokered key a call uses; no log line in
 *   this file ever contains a transcript or a summary, only ids and counts.
 */
import {
  profileVoiceCallSettings,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  VOICE_CALL_SUMMARY_FALLBACK_MODEL,
  VOICE_CALL_SUMMARY_MAX_ATTEMPTS,
  VOICE_CALL_SUMMARY_MODEL,
  VOICE_CALL_SUMMARY_RETRY_MS,
  type ThreadId,
  type VoiceCallRecord,
  type VoiceCallSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { redactSecrets } from "../secretText.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";
import * as VoiceCallGemini from "./voiceCallGemini.ts";
import { buildVoiceCallSummaryPrompt, parseVoiceCallSummary } from "./voiceCallSummary.ts";

/**
 * How often the worker looks for a call that still needs a summary. Short
 * enough that a card gains its summary while the owner is still looking at the
 * chat, long enough that an idle laptop does nothing measurable.
 */
export const VOICE_CALL_SUMMARY_SWEEP_MS = 30_000;

/** At most this many calls are examined per sweep. */
export const VOICE_CALL_SUMMARY_SWEEP_LIMIT = 5;

/** At most this many relaying lines are handed to the summariser. */
export const VOICE_CALL_SUMMARY_RELAY_MAX = 10;

export class PersonalVoiceCallSummaryService extends Context.Service<
  PersonalVoiceCallSummaryService,
  {
    /** Starts the worker. Safe to call twice; the second call does nothing. */
    readonly start: () => Effect.Effect<void, never>;
    /**
     * Summarises one call now. The worker's body and the tests' entry point:
     * resolves to the summary it wrote, or null when there is nothing to write
     * (no transcript, no usable answer) or the attempt failed. Never fails.
     */
    readonly summarise: (callId: string) => Effect.Effect<VoiceCallSummary | null, never>;
    /**
     * One sweep of the worker: every call that needs a summary and is due for
     * an attempt. Returns how many were attempted. Never fails.
     */
    readonly sweep: () => Effect.Effect<number, never>;
  }
>()("t3/personal/voiceCalls/PersonalVoiceCallSummaryService") {}

export const make = Effect.gen(function* () {
  const calls = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
  const sessions = yield* PersonalSessionAccess.PersonalSessionAccess;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const botService = yield* PersonalBotService.PersonalBotService;
  const http = yield* VoiceCallGemini.VoiceCallHttp;
  const sql = yield* SqlClient.SqlClient;

  // One summary at a time: a sweep and a lazy nudge can overlap, and Google's
  // free tier does not need two of these in flight.
  const lock = yield* Semaphore.make(1);
  /** When each call was last attempted, so a failure waits its minute. */
  const lastAttemptAtMs = new Map<string, number>();
  /** How many times each call has been attempted, in total. */
  const attempts = new Map<string, number>();
  const started = { value: false };

  /**
   * The key a summary runs on: the same saved brokered `GEMINI_API_KEY` bound
   * to Google that a call mints its token with. Missing, or saved the wrong
   * way, means no summary: never an error the card would have to show.
   */
  const summaryKey = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const saved = yield* sessions
        .secretsForThread(threadId)
        .pipe(
          Effect.orElseSucceed(
            () => [] as ReadonlyArray<PersonalSessionAccess.PersonalSessionSecret>,
          ),
        );
      return saved.find(
        (secret) =>
          secret.name === VOICE_CALL_SECRET_NAME &&
          secret.mode === "brokered" &&
          secret.origins.includes(VOICE_CALL_SECRET_ORIGIN),
      );
    });

  /**
   * The messages the voice posted into the chat while the call was on, in
   * order. They are the call's own words and are bounded twice: by the call's
   * own window, and by a cap here.
   */
  const relayedMessages = (record: VoiceCallRecord) =>
    sql<{ readonly text: string }>`
      SELECT text AS "text"
      FROM projection_thread_messages
      WHERE thread_id = ${record.threadId}
        AND role = 'user'
        AND created_at >= ${DateTime.formatIso(record.startedAt)}
        AND created_at <= ${DateTime.formatIso(record.endedAt)}
        AND length(trim(text)) > 0
      ORDER BY created_at ASC, message_id ASC
      LIMIT ${VOICE_CALL_SUMMARY_RELAY_MAX}
    `.pipe(
      Effect.map((rows) => rows.map((row) => ({ text: redactSecrets(row.text).slice(0, 2_000) }))),
      Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly text: string }>),
    );

  /** One model's answer, as text. A refusal, a quota error or a bad body is no text. */
  const askModel = (
    model: string,
    prompt: string,
    key: PersonalSessionAccess.PersonalSessionSecret,
  ) =>
    http.call(VoiceCallGemini.voiceCallSummaryRequest({ model, prompt }), [key]).pipe(
      Effect.map((outcome) => VoiceCallGemini.voiceCallSummaryText(outcome)),
      Effect.orElseSucceed(() => null),
    );

  const summarise: PersonalVoiceCallSummaryService["Service"]["summarise"] = (callId) =>
    Effect.gen(function* () {
      const stored = yield* calls
        .get(callId)
        .pipe(Effect.orElseSucceed(() => Option.none<VoiceCallRecord>()));
      if (Option.isNone(stored)) return null;
      const record = stored.value;
      // Already done (a retry that raced a sweep, or a backfill of a call that
      // was summarised while the worker was restarting): nothing to write.
      if (record.summary !== undefined) return record.summary;
      if (record.transcript.every((entry) => entry.text.trim().length === 0)) return null;
      const key = yield* summaryKey(record.threadId);
      if (key === undefined) return null;
      const profile = yield* botService
        .getProfile()
        .pipe(Effect.orElseSucceed(() => ({ displayName: "", voiceCalls: undefined })));
      const bot = yield* bots
        .getBotById({ botId: record.botId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const relayed = yield* relayedMessages(record);
      const prompt = buildVoiceCallSummaryPrompt({
        botName: Option.isSome(bot) ? bot.value.name : "your assistant",
        startedAt: DateTime.formatIso(record.startedAt),
        durationSeconds: record.durationSeconds,
        transcript: record.transcript,
        relayed,
        languages: profileVoiceCallSettings(profile).languages,
      });
      const primary = yield* askModel(VOICE_CALL_SUMMARY_MODEL, prompt, key);
      const answer = primary ?? (yield* askModel(VOICE_CALL_SUMMARY_FALLBACK_MODEL, prompt, key));
      const summary = parseVoiceCallSummary(answer);
      if (summary === null) {
        // Ids and counts only: the answer is the owner's own words.
        yield* Effect.logInfo("personal voice call summary was not usable", { callId });
        return null;
      }
      const written = yield* calls
        .setSummary({ callId, summary })
        .pipe(Effect.orElseSucceed(() => false));
      if (!written) return null;
      yield* Effect.logInfo("personal voice call summary stored", {
        callId,
        threadId: record.threadId,
        points: summary.points.length,
        hasDecision: summary.decision !== null,
        relayed: relayed.length,
      });
      return summary;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("personal voice call summary failed; the card keeps its transcript", {
          callId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  const sweep: PersonalVoiceCallSummaryService["Service"]["sweep"] = () =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const ids = yield* calls
            .listNeedingSummary({ limit: VOICE_CALL_SUMMARY_SWEEP_LIMIT })
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
          let attempted = 0;
          for (const callId of ids) {
            const tries = attempts.get(callId) ?? 0;
            if (tries >= VOICE_CALL_SUMMARY_MAX_ATTEMPTS) continue;
            const last = lastAttemptAtMs.get(callId);
            // A first attempt runs at once; a retry waits its minute, so the
            // attempts are spread out and then the call is left alone.
            if (last !== undefined && nowMs - last < VOICE_CALL_SUMMARY_RETRY_MS) continue;
            attempts.set(callId, tries + 1);
            lastAttemptAtMs.set(callId, nowMs);
            attempted += 1;
            const written = yield* summarise(callId);
            // A written call is forgotten (the maps stay the size of the work
            // still to do). A call that is out of attempts keeps its count, so
            // it is skipped from now on instead of starting over: the card
            // shows its transcript, which is what it would have shown anyway.
            if (written !== null) {
              attempts.delete(callId);
              lastAttemptAtMs.delete(callId);
            }
          }
          return attempted;
        }),
      )
      .pipe(Effect.orElseSucceed(() => 0));

  const start: PersonalVoiceCallSummaryService["Service"]["start"] = () =>
    Effect.suspend(() => {
      if (started.value) return Effect.void;
      started.value = true;
      const worker = Effect.forever(
        // The first sweep doubles as the backfill: every call stored before
        // this feature existed is found by the same query the worker uses.
        Effect.gen(function* () {
          yield* sweep();
          yield* Effect.sleep(VOICE_CALL_SUMMARY_SWEEP_MS);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("personal voice call summary worker stopped", { cause }),
        ),
      );
      return Effect.asVoid(Effect.forkDetach(worker));
    });

  return { start, summarise, sweep } satisfies PersonalVoiceCallSummaryService["Service"];
});

export const layer = Layer.effect(PersonalVoiceCallSummaryService, make);

/**
 * Everything the worker needs that is not already in the app's own layer
 * chain. Order matters, as everywhere in this repo's chains: a later step
 * feeds the requirements opened by the earlier ones, so the shared
 * `PersonalBotRepository` comes last and the bot service (which reads it) sits
 * above it.
 */
export const layerLive = layer.pipe(
  Layer.provideMerge(PersonalBotService.layer),
  Layer.provideMerge(PersonalVoiceCallRepository.layer),
  Layer.provideMerge(PersonalSessionAccess.layerLive),
  Layer.provideMerge(VoiceCallGemini.layerLive),
  Layer.provideMerge(PersonalBotRepository.layer),
);
