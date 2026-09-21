import { ConnectionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../../persistence/Migrations.ts";
import { SEND_WINDOW_MS } from "./pacing.ts";
import * as SendLog from "./sendLog.ts";

const CONNECTION = ConnectionId.make("connection-1");
const NOW = DateTime.makeUnsafe("2026-09-21T12:00:00.000Z");

const layer = SendLog.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

describe("whatsapp send ledger", () => {
  it.effect(
    "counts only the sends inside the window, so a cap survives a restart but still recovers",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 75 });
        const log = yield* SendLog.WhatsAppSendLog;

        const inside = DateTime.subtract(NOW, { milliseconds: SEND_WINDOW_MS - 60_000 });
        const outside = DateTime.subtract(NOW, { milliseconds: SEND_WINDOW_MS + 60_000 });
        yield* log.record({
          connectionId: CONNECTION,
          recipientNumber: "+447700900001",
          sentAt: inside,
        });
        yield* log.record({
          connectionId: CONNECTION,
          recipientNumber: "+447700900002",
          sentAt: outside,
        });
        yield* log.record({
          connectionId: ConnectionId.make("other-connection"),
          recipientNumber: "+447700900003",
          sentAt: inside,
        });

        const recent = yield* log.recentSends(CONNECTION, NOW);
        expect(recent).toEqual([DateTime.toEpochMillis(inside)]);
      }).pipe(Effect.provide(layer)),
  );
});
