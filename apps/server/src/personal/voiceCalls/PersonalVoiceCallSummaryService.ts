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
  botTakesVoiceCalls,
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
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  threadExposureKey,
} from "../browser/sensitiveExposureStore.ts";
import * as PersonalTaskRepository from "../tasks/PersonalTaskRepository.ts";
import { redactSecrets } from "../secretText.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";
import * as VoiceCallGemini from "./voiceCallGemini.ts";
import { buildVoiceCallSummaryPrompt, parseVoiceCallSummary } from "./voiceCallSummary.ts";

/**
 * An error's own class and nothing else: a decode error carries the row it
 * rejected, and that row holds the summary text (Astra review, finding 7).
 */
const errorTagOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause) as { readonly _tag?: unknown } | null;
  const tag = error?._tag;
  return typeof tag === "string" ? tag : "unknown";
};

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
  const taskRepository = yield* PersonalTaskRepository.PersonalTaskRepository;
  const http = yield* VoiceCallGemini.VoiceCallHttp;
  const sql = yield* SqlClient.SqlClient;

  // One summary at a time: a sweep and a lazy nudge can overlap, and Google's
  // free tier does not need two of these in flight.
  const lock = yield* Semaphore.make(1);
  /**
   * When each call was last tried in THIS process, so a failed attempt waits
   * about a minute before the next. The count itself is in the database
   * (`summary_attempts`), so a restart cannot hand a call unlimited tries.
   */
  const lastAttemptAtMs = new Map<string, number>();
  const started = { value: false };

  /**
   * A chat that has had a site the owner marked sensitive open sends nothing to
   * Google from here, and the read fails closed: a lookup that cannot be
   * answered counts as exposed. This is the same taint a call itself checks at
   * `start` (Astra review, finding 1: the worker used to skip it entirely). It
   * reads the same persisted store through the same key builders the browser
   * writes, plus the task root's key when the chat belongs to a task tree, so
   * the worker cannot be a quieter way round the browser's own gate.
   */
  const sensitiveExposure = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const store = makeSensitiveExposureStore(sql);
      const keys: Array<string> = [threadExposureKey(threadId)];
      const task = yield* taskRepository
        .latestTaskForThread(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(task)) keys.push(rootExposureKey(task.value.rootTaskId));
      const exposure = yield* store.read(keys);
      return [...exposure.sources].toSorted();
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("personal voice call summary exposure unreadable; treating as exposed", {
          threadId,
          errorTag: errorTagOf(cause),
        }).pipe(Effect.as(["unreadable"] as ReadonlyArray<string>)),
      ),
    );

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
   * The messages the voice itself posted into the chat during this call, in
   * order. They are picked by the call's own marker (`context_json` carries
   * `personal-voice-call` and this call's id), never by a time window: a
   * message the owner typed during the call is his chat, not the call's, and
   * must not be sent to Google by this path (Astra review, finding 1).
   */
  const relayedMessages = (record: VoiceCallRecord) =>
    sql<{ readonly text: string }>`
      SELECT text AS "text"
      FROM projection_thread_messages
      WHERE thread_id = ${record.threadId}
        AND role = 'user'
        AND instr(context_json, '"personal-voice-call"') > 0
        AND instr(context_json, ${`"callId":"${record.callId}"`}) > 0
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

  /**
   * Writes one call's summary, or answers null with nothing to write.
   *
   * Null is not one thing, and the difference matters to the worker: a call
   * that is missing, already summarised, without a transcript, not from a team
   * lead, in a sensitive chat or without a key is *skipped* and costs no
   * attempt; a call whose model answer was unusable costs one. Attempts are
   * recorded in the row before the first request goes out.
   */
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
      const bot = yield* bots
        .getBotById({ botId: record.botId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      // Voice calls are for team leads (Harout, 16 Oct). A bot that is not one
      // has no call to summarise, and a bot that cannot be read is skipped
      // rather than guessed at.
      if (Option.isNone(bot) || !botTakesVoiceCalls(bot.value)) return null;
      const exposed = yield* sensitiveExposure(record.threadId);
      if (exposed.length > 0) {
        // Deliberate: this chat must not reach Google at all, so this is not a
        // failed attempt and is never retried.
        yield* Effect.logInfo("personal voice call summary skipped for a sensitive chat", {
          callId,
          threadId: record.threadId,
        });
        return null;
      }
      const key = yield* summaryKey(record.threadId);
      // No key: not an attempt. Adding the key later must still get these
      // calls summarised (Astra review, finding 5).
      if (key === undefined) return null;
      yield* calls.recordSummaryAttempt(callId).pipe(Effect.orElseSucceed(() => undefined));
      const profile = yield* botService
        .getProfile()
        .pipe(Effect.orElseSucceed(() => ({ displayName: "", voiceCalls: undefined })));
      const relayed = yield* relayedMessages(record);
      const prompt = buildVoiceCallSummaryPrompt({
        botName: bot.value.name,
        startedAt: DateTime.formatIso(record.startedAt),
        durationSeconds: record.durationSeconds,
        transcript: record.transcript,
        relayed,
        languages: profileVoiceCallSettings(profile).languages,
      });
      // Parse each model's answer on its own: a primary that answers with
      // something unusable must still leave the fallback model a chance
      // (Astra review, finding 8).
      const primary = parseVoiceCallSummary(yield* askModel(VOICE_CALL_SUMMARY_MODEL, prompt, key));
      const summary =
        primary ??
        parseVoiceCallSummary(yield* askModel(VOICE_CALL_SUMMARY_FALLBACK_MODEL, prompt, key));
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
      // The class of the failure, never the cause: a decode error carries the
      // row it rejected, and that row holds the summary text (Astra review,
      // finding 7).
      Effect.catchCause((cause) =>
        Effect.logWarning("personal voice call summary failed; the card keeps its transcript", {
          callId,
          errorTag: Cause.hasInterruptsOnly(cause) ? "interrupted" : errorTagOf(cause),
        }).pipe(Effect.as(null)),
      ),
    );

  const sweep: PersonalVoiceCallSummaryService["Service"]["sweep"] = () =>
    lock
      .withPermit(
        Effect.gen(function* () {
          // The attempt cap is in the query, so a call that is out of attempts
          // can no longer push the older calls out of the window (Astra review,
          // finding 5).
          const ids = yield* calls
            .listNeedingSummary({
              limit: VOICE_CALL_SUMMARY_SWEEP_LIMIT,
              maxAttempts: VOICE_CALL_SUMMARY_MAX_ATTEMPTS,
            })
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
          let attempted = 0;
          for (const callId of ids) {
            const last = lastAttemptAtMs.get(callId);
            // A first attempt runs at once; a retry waits its minute, so the
            // attempts are spread out and then the call is left alone.
            if (last !== undefined && nowMs - last < VOICE_CALL_SUMMARY_RETRY_MS) continue;
            lastAttemptAtMs.set(callId, nowMs);
            attempted += 1;
            const written = yield* summarise(callId);
            // A written call is forgotten. One that was only skipped (no key,
            // sensitive chat, not a lead) keeps its place in the map so the
            // wait applies to it too, and its attempt count is untouched.
            if (written !== null) lastAttemptAtMs.delete(callId);
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
          Effect.logWarning("personal voice call summary worker stopped", {
            errorTag: Cause.hasInterruptsOnly(cause) ? "interrupted" : errorTagOf(cause),
          }),
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
  Layer.provideMerge(PersonalTaskRepository.layer),
  Layer.provideMerge(PersonalVoiceCallRepository.layer),
  Layer.provideMerge(PersonalSessionAccess.layerLive),
  Layer.provideMerge(VoiceCallGemini.layerLive),
  Layer.provideMerge(PersonalBotRepository.layer),
);
