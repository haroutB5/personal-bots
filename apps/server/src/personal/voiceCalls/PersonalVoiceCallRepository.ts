import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import {
  PersonalBotId,
  ThreadId,
  VoiceCallEndReason,
  VoiceCallSpeaker,
  VoiceCallSummary,
  type VoiceCallRecord,
  type VoiceCallTranscriptEntry,
} from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type PersonalVoiceCallRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** The stored transcript, as JSON. A row that does not decode reads as empty. */
const StoredTranscript = Schema.Array(
  Schema.Struct({
    speaker: VoiceCallSpeaker,
    text: Schema.String,
    at: Schema.DateTimeUtcFromString,
  }),
);

export const PersonalVoiceCallDbRow = Schema.Struct({
  callId: Schema.String,
  threadId: ThreadId,
  botId: PersonalBotId,
  startedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.DateTimeUtcFromString,
  durationSeconds: Schema.Number,
  endReason: VoiceCallEndReason,
  messageCount: Schema.Number,
  voiceName: Schema.String,
  model: Schema.String,
  detail: Schema.String,
  transcript: Schema.String,
  /** The stored `VoiceCallSummary` as JSON, or `''` when there is none. */
  summaryJson: Schema.String,
});

const decodeRow = Schema.decodeUnknownEffect(PersonalVoiceCallDbRow);

/** Never fatal: a hand-edited transcript reads as "no transcript" rather than losing the card. */
const parseTranscript = (json: string): ReadonlyArray<VoiceCallTranscriptEntry> => {
  try {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(StoredTranscript))(json);
    return Option.isSome(decoded) ? decoded.value : [];
  } catch {
    return [];
  }
};

const encodeTranscript = (entries: ReadonlyArray<VoiceCallTranscriptEntry>): string =>
  JSON.stringify(
    entries.map((entry) => ({
      speaker: entry.speaker,
      text: entry.text,
      at: DateTime.formatIso(entry.at),
    })),
  );

/**
 * The stored summary. Empty, malformed, or a hand-edited shape reads as "no
 * summary": a card must still render from its transcript, never fail to load
 * because the one convenience line on it is unreadable.
 */
export const parseStoredSummary = (json: string): VoiceCallSummary | null => {
  if (json.trim() === "") return null;
  try {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceCallSummary))(json);
    return Option.isSome(decoded) ? decoded.value : null;
  } catch {
    return null;
  }
};

/** Encodes a summary for storage. Never called with null: none is `''`. */
export const encodeStoredSummary = (summary: VoiceCallSummary): string =>
  JSON.stringify({
    summary: summary.summary,
    points: [...summary.points],
    decision: summary.decision,
    open: summary.open,
  });

const CALL_COLUMNS = `
  call_id AS "callId",
  thread_id AS "threadId",
  bot_id AS "botId",
  started_at AS "startedAt",
  ended_at AS "endedAt",
  duration_seconds AS "durationSeconds",
  end_reason AS "endReason",
  message_count AS "messageCount",
  voice_name AS "voiceName",
  model AS "model",
  detail AS "detail",
  transcript_json AS "transcript",
  summary_json AS "summaryJson"
`;

/** The same row, with the transcript replaced by an empty one: the list never
 * reads `transcript_json`, so a chat's whole call history costs one small
 * query rather than every transcript of up to fifty calls.
 */
const CALL_COLUMNS_WITHOUT_TRANSCRIPT = CALL_COLUMNS.replace(
  'transcript_json AS "transcript"',
  `'[]' AS "transcript"`,
);

/**
 * An error's own tag and nothing else. A decode error carries the row it
 * rejected, and that row holds the call summary, so the payload must never
 * reach a log line (Astra review, finding 7).
 */
const errorTagOf = (error: unknown): string => {
  const tag = (error as { readonly _tag?: unknown } | null)?._tag;
  return typeof tag === "string" ? tag : "unknown";
};

/**
 * The call cards. Deliberately their own table and never a chat message:
 * nothing here is ever handed to a bot's model context, which is exactly what
 * the owner's transcript needs. `call_id` is the primary key, so storing a
 * call twice writes nothing the second time (idempotent `finish`).
 */
export class PersonalVoiceCallRepository extends Context.Service<
  PersonalVoiceCallRepository,
  {
    /** Writes the card unless this call already has one. Returns whether it was written. */
    readonly insert: (input: {
      readonly record: VoiceCallRecord;
      readonly createdAt: DateTime.Utc;
    }) => Effect.Effect<boolean, PersonalVoiceCallRepositoryError>;
    readonly get: (
      callId: string,
    ) => Effect.Effect<Option.Option<VoiceCallRecord>, PersonalVoiceCallRepositoryError>;
    /**
     * Newest call first, **without** reading any stored transcript: `transcript`
     * on every row is empty. A chat with fifty calls still costs one small
     * query, and the client asks for one card's transcript with `getTranscript`
     * when the owner expands it.
     */
    readonly listByThread: (
      threadId: ThreadId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<VoiceCallRecord>, PersonalVoiceCallRepositoryError>;
    /** One call's stored transcript, or none when the call is unknown. */
    readonly getTranscript: (
      callId: string,
    ) => Effect.Effect<
      Option.Option<ReadonlyArray<VoiceCallTranscriptEntry>>,
      PersonalVoiceCallRepositoryError
    >;
    /**
     * Writes a call's summary, once. Returns whether it was written: a call
     * that already carries a summary (or has since been deleted) is left alone,
     * so an out-of-order retry can never overwrite a good summary with a later
     * one, and `finish` staying idempotent stays true for the summary too.
     */
    readonly setSummary: (input: {
      readonly callId: string;
      readonly summary: VoiceCallSummary;
    }) => Effect.Effect<boolean, PersonalVoiceCallRepositoryError>;
    /**
     * The calls that still need a summary: a stored transcript that is not
     * empty, no summary yet, and fewer than `maxAttempts` model attempts
     * already spent. Ids only, and it never reads a transcript, so the boot
     * scan and the lazy check on opening a chat are both cheap.
     *
     * The attempt cap is part of the query, not a filter after it: five calls
     * that have each failed three times would otherwise be the only five rows a
     * sweep ever sees, starving every older call for good (Astra review,
     * finding 5).
     *
     * `threadId` narrows it to one chat.
     */
    readonly listNeedingSummary: (input: {
      readonly threadId?: ThreadId | undefined;
      readonly limit: number;
      readonly maxAttempts: number;
    }) => Effect.Effect<ReadonlyArray<string>, PersonalVoiceCallRepositoryError>;
    /** One more model attempt spent on this call, recorded before the request. */
    readonly recordSummaryAttempt: (
      callId: string,
    ) => Effect.Effect<void, PersonalVoiceCallRepositoryError>;
    /**
     * The summaries a bot's next turn should be given, newest first: calls that
     * carry a summary the bot has never been shown. Capped small; an empty list
     * is the normal case.
     */
    readonly summariesForTurn: (input: {
      readonly threadId: ThreadId;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<VoiceCallRecord>, PersonalVoiceCallRepositoryError>;
    /**
     * These summaries have now been put into a turn's context, so the bot has
     * been shown them and no later turn needs them again. Written when the turn
     * request is built, which is the only moment that answers "did the bot see
     * it" without guessing (Astra review, finding 3).
     */
    readonly markSummariesDelivered: (input: {
      readonly callIds: ReadonlyArray<string>;
      readonly at: DateTime.Utc;
    }) => Effect.Effect<void, PersonalVoiceCallRepositoryError>;
    /**
     * Removes every call card of one chat and reports how many went. Called
     * when the chat is deleted: the transcript is the owner's own words and
     * must not outlive the chat it belongs to.
     */
    readonly deleteByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<number, PersonalVoiceCallRepositoryError>;
    /**
     * Marks one call open. The row is the only thing a restart gate can see
     * from outside this process, so it is written when a call is minted and
     * never carries a word said on the call. Writing the same call twice
     * refreshes it rather than failing.
     */
    readonly openLease: (input: {
      readonly callId: string;
      readonly threadId: ThreadId;
      readonly botId: PersonalBotId;
      readonly openedAt: DateTime.Utc;
      readonly expiresAt: DateTime.Utc;
    }) => Effect.Effect<void, PersonalVoiceCallRepositoryError>;
    /** The call is over (or was never open): the row goes. Idempotent. */
    readonly closeLease: (callId: string) => Effect.Effect<void, PersonalVoiceCallRepositoryError>;
    /** Drops rows whose expiry has passed, so a dead phone's row cannot linger. */
    readonly pruneLeases: (
      at: DateTime.Utc,
    ) => Effect.Effect<number, PersonalVoiceCallRepositoryError>;
    /** Every open-call row goes: a restart ends every call, so boot clears them. */
    readonly clearLeases: () => Effect.Effect<number, PersonalVoiceCallRepositoryError>;
    /** A deleted chat has no call: its lease goes with its cards. */
    readonly deleteLeasesByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<number, PersonalVoiceCallRepositoryError>;
  }
>()("t3/personal/voiceCalls/PersonalVoiceCallRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: `PersonalVoiceCallRepository.${operation}`,
            cause,
          }),
      ),
    );

  const toRecord = (row: typeof PersonalVoiceCallDbRow.Type): VoiceCallRecord => {
    const summary = parseStoredSummary(row.summaryJson);
    return {
      callId: row.callId,
      threadId: row.threadId,
      botId: row.botId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSeconds: Math.max(0, Math.trunc(row.durationSeconds)),
      endReason: row.endReason,
      messageCount: Math.max(0, Math.trunc(row.messageCount)),
      voiceName: row.voiceName,
      model: row.model,
      detail: row.detail,
      transcript: parseTranscript(row.transcript),
      ...(summary === null ? {} : { summary }),
    };
  };

  const insert: PersonalVoiceCallRepository["Service"]["insert"] = (input) =>
    query(
      "insert",
      sql`
        INSERT INTO personal_voice_calls (
          call_id, thread_id, bot_id, started_at, ended_at, duration_seconds,
          end_reason, message_count, voice_name, model, detail, transcript_json, created_at
        )
        VALUES (
          ${input.record.callId}, ${input.record.threadId}, ${input.record.botId},
          ${DateTime.formatIso(input.record.startedAt)}, ${DateTime.formatIso(input.record.endedAt)},
          ${input.record.durationSeconds}, ${input.record.endReason}, ${input.record.messageCount},
          ${input.record.voiceName}, ${input.record.model}, ${input.record.detail},
          ${encodeTranscript(input.record.transcript)}, ${DateTime.formatIso(input.createdAt)}
        )
        ON CONFLICT(call_id) DO NOTHING
        RETURNING call_id AS "callId"
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  /** A row that does not decode is a real failure, reported as a decode error, never dropped. */
  const decodeCallRow = (operation: string, row: unknown) =>
    decodeRow(row).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError(`PersonalVoiceCallRepository.${operation}`, cause),
      ),
    );

  const get: PersonalVoiceCallRepository["Service"]["get"] = (callId) =>
    query(
      "get",
      sql`
        SELECT ${sql.literal(CALL_COLUMNS)}
        FROM personal_voice_calls
        WHERE call_id = ${callId}
      `,
    ).pipe(
      Effect.flatMap((rows) =>
        Option.match(Option.fromNullishOr(rows[0]), {
          onNone: () => Effect.succeed(Option.none<VoiceCallRecord>()),
          onSome: (row) =>
            decodeCallRow("get", row).pipe(Effect.map((decoded) => Option.some(toRecord(decoded)))),
        }),
      ),
    );

  const listByThread: PersonalVoiceCallRepository["Service"]["listByThread"] = (threadId, limit) =>
    query(
      "listByThread",
      sql`
        SELECT ${sql.literal(CALL_COLUMNS_WITHOUT_TRANSCRIPT)}
        FROM personal_voice_calls
        WHERE thread_id = ${threadId}
        ORDER BY started_at DESC, rowid DESC
        LIMIT ${Math.max(1, Math.trunc(limit))}
      `,
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeCallRow("list", row).pipe(Effect.map(toRecord))),
      ),
    );

  const getTranscript: PersonalVoiceCallRepository["Service"]["getTranscript"] = (callId) =>
    query(
      "getTranscript",
      sql<{ readonly transcript: string }>`
        SELECT transcript_json AS "transcript"
        FROM personal_voice_calls
        WHERE call_id = ${callId}
      `,
    ).pipe(
      Effect.map((rows) =>
        Option.match(Option.fromNullishOr(rows[0]), {
          onNone: () => Option.none<ReadonlyArray<VoiceCallTranscriptEntry>>(),
          onSome: (row) => Option.some(parseTranscript(row.transcript)),
        }),
      ),
    );

  const setSummary: PersonalVoiceCallRepository["Service"]["setSummary"] = (input) =>
    query(
      "setSummary",
      sql`
        UPDATE personal_voice_calls
        SET summary_json = ${encodeStoredSummary(input.summary)}
        WHERE call_id = ${input.callId}
          AND summary_json = ''
        RETURNING call_id AS "callId"
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const listNeedingSummary: PersonalVoiceCallRepository["Service"]["listNeedingSummary"] = (
    input,
  ) =>
    query(
      "listNeedingSummary",
      sql<{ readonly callId: string }>`
        SELECT call_id AS "callId"
        FROM personal_voice_calls
        WHERE summary_json = ''
          AND transcript_json NOT IN ('', '[]')
          AND summary_attempts < ${Math.max(1, Math.trunc(input.maxAttempts))}
          ${input.threadId === undefined ? sql`` : sql`AND thread_id = ${input.threadId}`}
        ORDER BY started_at DESC, rowid DESC
        LIMIT ${Math.max(1, Math.trunc(input.limit))}
      `,
    ).pipe(Effect.map((rows) => rows.map((row) => row.callId)));

  /**
   * Counted in the row before the request goes out, so a crash or a restart
   * cannot hand the same call unlimited attempts. A call with no transcript and
   * a call that is already written are never touched.
   */
  const recordSummaryAttempt: PersonalVoiceCallRepository["Service"]["recordSummaryAttempt"] = (
    callId,
  ) =>
    query(
      "recordSummaryAttempt",
      sql`
        UPDATE personal_voice_calls
        SET summary_attempts = summary_attempts + 1
        WHERE call_id = ${callId}
          AND summary_json = ''
      `,
    ).pipe(Effect.asVoid);

  /**
   * A summary belongs to the bot's first turn after it was written and to
   * nothing after it: the marker is written when the block goes into a turn's
   * context, so a reply that lands before the summary exists can no longer
   * retire a summary the bot never saw (Astra review, finding 3).
   */
  const summariesForTurn: PersonalVoiceCallRepository["Service"]["summariesForTurn"] = (input) =>
    query(
      "summariesForTurn",
      sql`
        SELECT ${sql.literal(CALL_COLUMNS_WITHOUT_TRANSCRIPT)}
        FROM personal_voice_calls
        WHERE thread_id = ${input.threadId}
          AND summary_json <> ''
          AND summary_delivered_at = ''
        ORDER BY ended_at DESC, rowid DESC
        LIMIT ${Math.max(1, Math.trunc(input.limit))}
      `,
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeCallRow("summariesForTurn", row).pipe(Effect.map(toRecord)),
        ),
      ),
      // The projection table is another module's; a query that cannot run is
      // the same as no summary at all, never a failed turn. Only the error's
      // class is logged: a decode error carries the row it rejected, and that
      // row holds the summary text (Astra review, finding 7).
      Effect.catch((cause) =>
        Effect.logWarning("personal voice call summaries for a turn could not be read", {
          threadId: input.threadId,
          errorTag: errorTagOf(cause),
        }).pipe(Effect.as([] as ReadonlyArray<VoiceCallRecord>)),
      ),
    );

  const markSummariesDelivered: PersonalVoiceCallRepository["Service"]["markSummariesDelivered"] = (
    input,
  ) =>
    input.callIds.length === 0
      ? Effect.void
      : query(
          "markSummariesDelivered",
          sql`
              UPDATE personal_voice_calls
              SET summary_delivered_at = ${DateTime.formatIso(input.at)}
              WHERE ${sql.in("call_id", input.callIds)}
                AND summary_delivered_at = ''
            `,
        ).pipe(Effect.asVoid);

  const deleteByThread: PersonalVoiceCallRepository["Service"]["deleteByThread"] = (threadId) =>
    query(
      "deleteByThread",
      sql`
        DELETE FROM personal_voice_calls
        WHERE thread_id = ${threadId}
        RETURNING call_id AS "callId"
      `,
    ).pipe(Effect.map((rows) => rows.length));

  const openLease: PersonalVoiceCallRepository["Service"]["openLease"] = (input) =>
    query(
      "openLease",
      sql`
        INSERT INTO personal_voice_call_leases (call_id, thread_id, bot_id, opened_at, expires_at)
        VALUES (
          ${input.callId}, ${input.threadId}, ${input.botId},
          ${DateTime.formatIso(input.openedAt)}, ${DateTime.formatIso(input.expiresAt)}
        )
        ON CONFLICT(call_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          bot_id = excluded.bot_id,
          opened_at = excluded.opened_at,
          expires_at = excluded.expires_at
      `,
    ).pipe(Effect.asVoid);

  const closeLease: PersonalVoiceCallRepository["Service"]["closeLease"] = (callId) =>
    query(
      "closeLease",
      sql`
        DELETE FROM personal_voice_call_leases
        WHERE call_id = ${callId}
      `,
    ).pipe(Effect.asVoid);

  const pruneLeases: PersonalVoiceCallRepository["Service"]["pruneLeases"] = (at) =>
    query(
      "pruneLeases",
      sql`
        DELETE FROM personal_voice_call_leases
        WHERE expires_at <= ${DateTime.formatIso(at)}
        RETURNING call_id AS "callId"
      `,
    ).pipe(Effect.map((rows) => rows.length));

  const clearLeases: PersonalVoiceCallRepository["Service"]["clearLeases"] = () =>
    query(
      "clearLeases",
      sql`
        DELETE FROM personal_voice_call_leases
        RETURNING call_id AS "callId"
      `,
    ).pipe(Effect.map((rows) => rows.length));

  const deleteLeasesByThread: PersonalVoiceCallRepository["Service"]["deleteLeasesByThread"] = (
    threadId,
  ) =>
    query(
      "deleteLeasesByThread",
      sql`
        DELETE FROM personal_voice_call_leases
        WHERE thread_id = ${threadId}
        RETURNING call_id AS "callId"
      `,
    ).pipe(Effect.map((rows) => rows.length));

  return {
    insert,
    get,
    listByThread,
    getTranscript,
    setSummary,
    listNeedingSummary,
    recordSummaryAttempt,
    summariesForTurn,
    markSummariesDelivered,
    deleteByThread,
    openLease,
    closeLease,
    pruneLeases,
    clearLeases,
    deleteLeasesByThread,
  } satisfies PersonalVoiceCallRepository["Service"];
});

export const layer = Layer.effect(PersonalVoiceCallRepository, make);
