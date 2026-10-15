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
  transcript_json AS "transcript"
`;

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
    /** Newest call first. */
    readonly listByThread: (
      threadId: ThreadId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<VoiceCallRecord>, PersonalVoiceCallRepositoryError>;
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

  const toRecord = (row: typeof PersonalVoiceCallDbRow.Type): VoiceCallRecord => ({
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
  });

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
        SELECT ${sql.literal(CALL_COLUMNS)}
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

  return { insert, get, listByThread } satisfies PersonalVoiceCallRepository["Service"];
});

export const layer = Layer.effect(PersonalVoiceCallRepository, make);
