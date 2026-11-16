import {
  MessageId,
  PersonalTasksError,
  splitChoices,
  type PersonalWorkAnswerInput,
  type PersonalWorkAnswerResult as AnswerResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersonalProjectionRelations } from "../engine/PersonalProjectionRelations.ts";
import * as PersonalEngine from "../engine/PersonalEngine.ts";

const ACTION = "work-answer";

const NewestMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
});

const StatusRow = Schema.Struct({
  body: Schema.NullOr(Schema.String),
  action: Schema.String,
  notificationId: Schema.String,
});

const failure = (cause: unknown) =>
  new PersonalTasksError({ message: "Could not send the answer.", cause });

const statusOf = (body: string): AnswerResult => {
  if (body === "sent" || body === "stale" || body === "unknownChoice") return { status: body };
  return { status: "stale" };
};

const claimedStatus = (status: AnswerResult): number => (status.status === "sent" ? 200 : 409);

/**
 * Sends one choices option as the owner's message. The tap's command id claims
 * a row first, so a retry of the same tap returns the first result, and the
 * queued message id is derived from it, so a repeat can never post twice. A
 * claim left by a crash answers `stale`, which makes the phone refetch instead
 * of answering a question the bot may no longer be asking.
 */
export const answer = (
  input: PersonalWorkAnswerInput,
): Effect.Effect<
  AnswerResult,
  PersonalTasksError,
  SqlClient.SqlClient | PersonalEngine.PersonalEngine | PersonalProjectionRelations
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* PersonalEngine.PersonalEngine;
    const rel = yield* PersonalProjectionRelations;
    const threadId = input.threadId;
    const nowIso = DateTime.formatIso(yield* DateTime.now);

    const claimed = yield* sql<{ readonly commandId: string }>`
      INSERT INTO personal_phone_commands (
        command_id, subject, action, notification_id, status, body, created_at
      )
      VALUES (
        ${input.commandId}, ${threadId}, ${ACTION}, ${input.messageId}, NULL, NULL, ${nowIso}
      )
      ON CONFLICT (command_id, subject) DO NOTHING
      RETURNING command_id AS "commandId"
    `.pipe(Effect.mapError(failure));

    if (claimed.length === 0) {
      const rows = yield* sql<Readonly<Record<string, unknown>>>`
        SELECT body AS "body", action AS "action", notification_id AS "notificationId"
        FROM personal_phone_commands
        WHERE command_id = ${input.commandId} AND subject = ${threadId}
        LIMIT 1
      `.pipe(Effect.mapError(failure));
      const stored = yield* Schema.decodeUnknownEffect(StatusRow)(rows[0]).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (
        stored === null ||
        stored.action !== ACTION ||
        stored.notificationId !== input.messageId ||
        stored.body === null
      ) {
        return { status: "stale" } as const;
      }
      return statusOf(stored.body);
    }

    const release = sql`
      DELETE FROM personal_phone_commands
      WHERE command_id = ${input.commandId} AND subject = ${threadId}
    `;

    const outcome = yield* Effect.gen(function* () {
      const newest = yield* sql<Readonly<Record<string, unknown>>>`
        SELECT m.message_id AS "messageId", m.text AS "text"
        FROM ${sql.unsafe(rel.messages)} m
        WHERE m.thread_id = ${threadId} AND m.role IN ('user', 'assistant')
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT 1
      `.pipe(Effect.mapError(failure));
      const current = yield* Schema.decodeUnknownEffect(NewestMessage)(newest[0]).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (current === null || current.messageId !== input.messageId) {
        return { status: "stale" } as const;
      }
      const options = splitChoices(current.text).options;
      if (options === null || !options.includes(input.choice)) {
        return { status: "unknownChoice" } as const;
      }
      yield* engine
        .send({
          threadId,
          messageId: MessageId.make(`work-answer:${input.commandId}`),
          text: input.choice,
          attachments: [],
          mode: "queue",
        })
        .pipe(
          Effect.mapError(failure),
          Effect.onError(() => release.pipe(Effect.ignore)),
        );
      return { status: "sent" } as const;
    });

    yield* sql`
      UPDATE personal_phone_commands
      SET status = ${claimedStatus(outcome)}, body = ${outcome.status}
      WHERE command_id = ${input.commandId} AND subject = ${threadId}
    `.pipe(Effect.mapError(failure));
    return outcome;
  });
