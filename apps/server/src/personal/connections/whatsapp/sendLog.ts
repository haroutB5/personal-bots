import * as NodeCrypto from "node:crypto";

import { type ConnectionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../../../persistence/Errors.ts";
import { SEND_WINDOW_MS } from "./pacing.ts";

/**
 * Every WhatsApp message this app actually sent, one row each.
 *
 * It is persisted rather than counted in memory for the obvious reason: a cap
 * that resets when the server restarts is not a cap, and a restart loop is
 * exactly when a run would be retrying. A row is written only after a send is
 * confirmed on the page, so the ledger is what left, not what was attempted.
 */

export type WhatsAppSendLogError = PersistenceSqlError | PersistenceDecodeError;

const SentAtRow = Schema.Struct({ sentAt: Schema.DateTimeUtcFromString });
const decodeRow = Schema.decodeUnknownEffect(SentAtRow);

export class WhatsAppSendLog extends Context.Service<
  WhatsAppSendLog,
  {
    /** Epoch milliseconds of the sends inside the pacing window, newest last. */
    readonly recentSends: (
      connectionId: ConnectionId,
      now: DateTime.Utc,
    ) => Effect.Effect<ReadonlyArray<number>, WhatsAppSendLogError>;
    readonly record: (input: {
      readonly connectionId: ConnectionId;
      readonly recipientNumber: string;
      readonly sentAt: DateTime.Utc;
    }) => Effect.Effect<void, WhatsAppSendLogError>;
  }
>()("t3/personal/connections/whatsapp/sendLog/WhatsAppSendLog") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: `WhatsAppSendLog.${operation}`, cause }),
      ),
    );

  const recentSends: WhatsAppSendLog["Service"]["recentSends"] = (connectionId, now) => {
    const windowStart = DateTime.formatIso(
      DateTime.subtract(now, { milliseconds: SEND_WINDOW_MS }),
    );
    return query(
      "recentSends",
      sql`
        SELECT sent_at AS "sentAt" FROM personal_whatsapp_sends
        WHERE connection_id = ${connectionId} AND sent_at > ${windowStart}
        ORDER BY sent_at ASC
      `,
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeRow(row).pipe(
            Effect.map((decoded) => DateTime.toEpochMillis(decoded.sentAt)),
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError("WhatsAppSendLog.recentSends", cause),
            ),
          ),
        ),
      ),
    );
  };

  const record: WhatsAppSendLog["Service"]["record"] = (input) =>
    query(
      "record",
      sql`
        INSERT INTO personal_whatsapp_sends (send_id, connection_id, recipient_number, sent_at)
        VALUES (
          ${NodeCrypto.randomUUID()}, ${input.connectionId}, ${input.recipientNumber},
          ${DateTime.formatIso(input.sentAt)}
        )
      `,
    ).pipe(Effect.asVoid);

  return WhatsAppSendLog.of({ recentSends, record });
});

export const layer = Layer.effect(WhatsAppSendLog, make);
