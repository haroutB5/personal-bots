/**
 * Writing a call's summary, and keeping that work off the card's critical path.
 *
 * Harout, 16 Oct 2026: after a call that answered a real question (Court 3 free
 * 11:00-12:00 before his Saturday booking) the chat showed nothing, and he
 * wanted to remember it. The card is stored the moment the call ends; this
 * service then reads its transcript back and asks for one sentence, a few
 * concrete bullets and the owner's last decision.
 *
 * Which model, and why (Harout, 16 Oct 2026, later the same day): **Claude
 * Haiku 5.5 first**, through the same tool-less structured text call chat
 * titles already use on his own Claude Code subscription (see
 * `voiceCallSummaryClaude.ts`), with the Gemini Flash Lite path behind it as
 * the fallback, so a summary still appears when Claude is on a usage limit, the
 * CLI errors or the call times out. The model that wrote it is stored on the
 * summary as `model` and logged by id, never by its text.
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
 * - **No log line in this file ever contains a transcript or a summary**, only
 *   ids, counts and model ids.
 * - **A chat that has had a sensitive site open sends nothing anywhere from
 *   here**, Claude included: the gate is unchanged and runs before every model.
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
import type {
  VoiceCallSummaryCandidate,
  VoiceCallSummaryCursor,
} from "./PersonalVoiceCallRepository.ts";
import * as VoiceCallGemini from "./voiceCallGemini.ts";
import { buildVoiceCallSummaryPrompt, parseVoiceCallSummary } from "./voiceCallSummary.ts";
import { VoiceCallSummaryClaude, claudeLayer } from "./voiceCallSummaryClaude.ts";

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

/** At most this many calls are examined per page of one sweep. */
export const VOICE_CALL_SUMMARY_SWEEP_LIMIT = 5;

/**
 * How many pages one sweep may walk before it gives up and waits for the next.
 * A row that can never be summarised (a sensitive chat, a bot that is not a
 * team lead) is skipped rather than failed, so without paging a run of them
 * would pin the sweep to the newest rows and starve every older call forever
 * (Astra re-check R3). Bounded so an old ineligible backlog stays cheap.
 */
export const VOICE_CALL_SUMMARY_SWEEP_PAGES = 8;

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
  const claude = yield* VoiceCallSummaryClaude;
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
      // A task association that cannot be read is NOT "no task": its root key is
      // one this call cannot rule out, so the failure is left to the handler
      // below, which treats an unreadable read as exposed. Folding it to
      // `Option.none()` here was fail-open (Astra re-check R1).
      const task = yield* taskRepository.latestTaskForThread(threadId);
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
   * The key the Gemini fallback runs on: the same saved brokered
   * `GEMINI_API_KEY` bound to Google that a call mints its token with. It is
   * read only when Claude did not answer, so a missing key costs nothing while
   * Claude works; missing on the fallback means no summary rather than an error
   * the card would have to show.
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
   * must not be sent to a model by this path (Astra review, finding 1).
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
   * Whether this chat must not leave the laptop at all, answered right now.
   *
   * The gate is not a one-off check at the top of the job: a sensitive site can
   * be opened while the worker is between steps (a model request alone may take
   * 30 seconds), so it is asked again before the transcript's relays are read
   * and again immediately before each model request (Astra re-check R1). It
   * guards the Claude path exactly as it guards Google.
   */
  const exposedNow = (threadId: ThreadId) =>
    sensitiveExposure(threadId).pipe(Effect.map((sources) => sources.length > 0));

  /**
   * Writes one call's summary, or answers null with nothing to write.
   *
   * Null is not one thing, and the difference matters to the worker: a call
   * that is missing, already summarised, without a transcript, not from a team
   * lead or in a sensitive chat is *skipped* and costs no attempt; a call whose
   * model answers were unusable costs one. Attempts are recorded in the row
   * before the first request goes out.
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
      const skipSensitive = () =>
        // Ids only, never a word of the chat.
        Effect.logInfo("personal voice call summary skipped for a sensitive chat", {
          callId,
          threadId: record.threadId,
        });
      if (yield* exposedNow(record.threadId)) {
        // Deliberate: this chat must not leave the laptop at all, so this is not
        // a failed attempt and is never retried.
        yield* skipSensitive();
        return null;
      }
      const profile = yield* botService
        .getProfile()
        .pipe(Effect.orElseSucceed(() => ({ displayName: "", voiceCalls: undefined })));
      // The gate runs again here, after the profile read and before the attempt
      // is charged, so a chat that turned sensitive in between costs nothing
      // (Astra re-check R1).
      if (yield* exposedNow(record.threadId)) {
        yield* skipSensitive();
        return null;
      }
      yield* calls.recordSummaryAttempt(callId).pipe(Effect.orElseSucceed(() => undefined));
      const relayed = yield* relayedMessages(record);
      const prompt = buildVoiceCallSummaryPrompt({
        botName: bot.value.name,
        startedAt: DateTime.formatIso(record.startedAt),
        durationSeconds: record.durationSeconds,
        transcript: record.transcript,
        relayed,
        languages: profileVoiceCallSettings(profile).languages,
      });
      /**
       * Claude first (Harout, 16 Oct 2026): the owner's own Claude Code
       * subscription, Haiku 5.5 at the background effort, no tools. Anything
       * that stops it answering (usage limit, CLI error, timeout, an answer the
       * parser will not take) falls through to Gemini below, so a card still
       * gets its summary. The gate runs again first, so a chat that turned
       * sensitive while the worker was reading costs nothing and never reaches
       * a model.
       */
      let summary: VoiceCallSummary | null = null;
      if (yield* exposedNow(record.threadId)) {
        yield* skipSensitive();
        return null;
      }
      summary = yield* claude.ask(prompt).pipe(
        Effect.map((answer) =>
          answer === null ? null : ({ ...answer, model: claude.model } satisfies VoiceCallSummary),
        ),
        Effect.catch((reason) =>
          // The class only. Nothing here holds the owner's words.
          Effect.logWarning("personal voice call summary: Claude did not answer, trying Gemini", {
            callId,
            model: claude.model,
            reason,
          }).pipe(Effect.as(null)),
        ),
      );
      if (summary === null) {
        const key = yield* summaryKey(record.threadId);
        // No key and no Claude answer: nothing to ask. The attempt is already
        // spent, exactly as it is for a Gemini error.
        if (key !== undefined) {
          // Parse each model's answer on its own: a primary that answers with
          // something unusable must still leave the fallback model a chance
          // (Astra review, finding 8). Each request passes the gate first, so a
          // chat that turns sensitive during the primary never reaches Google
          // again (Astra re-check R1).
          const askGuarded = (model: string) =>
            Effect.gen(function* () {
              if (yield* exposedNow(record.threadId)) return { exposed: true, text: null } as const;
              return { exposed: false, text: yield* askModel(model, prompt, key) } as const;
            });
          const primary = yield* askGuarded(VOICE_CALL_SUMMARY_MODEL);
          if (primary.exposed) {
            yield* skipSensitive();
            return null;
          }
          const parsed = parseVoiceCallSummary(primary.text);
          if (parsed !== null) {
            summary = { ...parsed, model: VOICE_CALL_SUMMARY_MODEL };
          } else {
            const fallback = yield* askGuarded(VOICE_CALL_SUMMARY_FALLBACK_MODEL);
            if (fallback.exposed) {
              yield* skipSensitive();
              return null;
            }
            const parsedFallback = parseVoiceCallSummary(fallback.text);
            if (parsedFallback !== null) {
              summary = { ...parsedFallback, model: VOICE_CALL_SUMMARY_FALLBACK_MODEL };
            }
          }
        }
      }
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
        model: summary.model ?? "unknown",
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
          const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
          let attempted = 0;
          // The attempt cap is in the query, so a call that is out of attempts
          // can no longer push the older calls out of the window (Astra review,
          // finding 5). What the cap cannot do is move past a row that will
          // never be eligible at all: a sensitive chat, a bot that is not a
          // team lead, a missing bot, or a call with no key yet. Those are
          // skipped, not failed, so they used to sit in the newest five forever
          // and every older call waited behind them (Astra re-check R3).
          //
          // So the sweep walks pages, oldest-last, with a keyset cursor rather
          // than an offset: writing a summary removes its row from the result
          // set, which would shift an offset and skip the row after it. The
          // page count is bounded so a long run of ineligible rows cannot turn
          // one sweep into a table scan; 8 pages of 5 covers a backlog of 40.
          let cursor: VoiceCallSummaryCursor | undefined;
          for (let page = 0; page < VOICE_CALL_SUMMARY_SWEEP_PAGES; page += 1) {
            const rows = yield* calls
              .listNeedingSummary({
                limit: VOICE_CALL_SUMMARY_SWEEP_LIMIT,
                maxAttempts: VOICE_CALL_SUMMARY_MAX_ATTEMPTS,
                ...(cursor === undefined ? {} : { after: cursor }),
              })
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<VoiceCallSummaryCandidate>));
            if (rows.length === 0) break;
            const last = rows[rows.length - 1]!;
            cursor = { startedAt: last.startedAt, rowId: last.rowId };
            for (const row of rows) {
              const lastAttempt = lastAttemptAtMs.get(row.callId);
              // A first attempt runs at once; a retry waits its minute, so the
              // attempts are spread out and then the call is left alone.
              if (lastAttempt !== undefined && nowMs - lastAttempt < VOICE_CALL_SUMMARY_RETRY_MS) {
                continue;
              }
              lastAttemptAtMs.set(row.callId, nowMs);
              attempted += 1;
              const written = yield* summarise(row.callId);
              // A written call is forgotten. One that was only skipped (no key,
              // sensitive chat, not a lead) keeps its place in the map so the
              // wait applies to it too, and its attempt count is untouched.
              if (written !== null) lastAttemptAtMs.delete(row.callId);
            }
            // A short page is the end of the queue: no point asking again.
            if (rows.length < VOICE_CALL_SUMMARY_SWEEP_LIMIT) break;
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
 *
 * The Claude writer is one of those steps: it resolves the provider instance
 * registry, exactly like the nightly memory tidy-up's judge, and the app
 * provides that registry around this whole group.
 */
export const layerLive = layer.pipe(
  Layer.provideMerge(claudeLayer),
  Layer.provideMerge(PersonalBotService.layer),
  Layer.provideMerge(PersonalTaskRepository.layer),
  Layer.provideMerge(PersonalVoiceCallRepository.layer),
  Layer.provideMerge(PersonalSessionAccess.layerLive),
  Layer.provideMerge(VoiceCallGemini.layerLive),
  Layer.provideMerge(PersonalBotRepository.layer),
);
