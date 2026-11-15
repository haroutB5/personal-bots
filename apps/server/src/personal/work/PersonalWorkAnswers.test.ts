// @effect-diagnostics preferSchemaOverJson:off - seeds the projection payloads as stored JSON.
import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { PersonalProjectionRelations } from "../engine/PersonalProjectionRelations.ts";
import { PERSONAL_V2_RELATIONS } from "../engine/PersonalProjectionRelationsV2Live.ts";
import * as PersonalEngine from "../engine/PersonalEngine.ts";
import * as PersonalWorkAnswers from "./PersonalWorkAnswers.ts";

const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const AT = "2026-11-15T09:00:00.000Z";
const THREAD = ThreadId.make("thread-a");
const REPLY = "Delete 9 merged branches?\n\n```choices\nYes, delete\nKeep\n```";

const sends: Array<PersonalEngine.PersonalSendInput> = [];

const layer = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  Layer.succeed(PersonalProjectionRelations, PERSONAL_V2_RELATIONS),
  Layer.mock(PersonalEngine.PersonalEngine)({
    send: (input: PersonalEngine.PersonalSendInput) =>
      Effect.sync(() => {
        sends.push(input);
      }),
  }),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO personal_bots (
      bot_id, name, description, instructions, avatar_shape, avatar_color,
      model_selection_json, enabled, sort_order, created_at, updated_at
    )
    VALUES (${PersonalBotId.make("bot-a")}, 'Builder', '', '', 'blob', '#1A73E8', '{}', 1, 0, ${AT}, ${AT})
  `;
  yield* sql`
    INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
    VALUES (${THREAD}, 'bot-a', ${AT})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    )
    VALUES (${THREAD}, 'project', 'Branch cleanup', 'claude', 'full-access', 'default', ${AT}, ${AT}, '{}')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, role, streaming, created_at, updated_at, payload_json
    )
    VALUES ('m-1', ${THREAD}, 'assistant', 0, ${AT}, ${AT}, json_object('text', ${REPLY}))
  `;
});

const seedNewerOwnerMessage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, role, streaming, created_at, updated_at, payload_json
    )
    VALUES (
      'm-2', ${THREAD}, 'user', 0, '2026-11-15T09:30:00.000Z', '2026-11-15T09:30:00.000Z',
      json_object('text', 'Keep')
    )
  `;
});

const answer = (input: {
  readonly messageId: string;
  readonly choice: string;
  readonly commandId: string;
}) =>
  PersonalWorkAnswers.answer({
    threadId: THREAD,
    messageId: input.messageId as never,
    choice: input.choice,
    commandId: input.commandId,
  });

describe("PersonalWorkAnswers.answer", () => {
  it.effect("sends the chosen option once as a queued owner message", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seed;
      sends.length = 0;

      const result = yield* answer({ messageId: "m-1", choice: "Keep", commandId: "c1" });

      expect(result).toEqual({ status: "sent" });
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        threadId: THREAD,
        messageId: "work-answer:c1",
        text: "Keep",
        attachments: [],
        mode: "queue",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the same command id answers the same way and posts nothing more", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seed;
      sends.length = 0;

      const first = yield* answer({ messageId: "m-1", choice: "Keep", commandId: "c1" });
      const again = yield* answer({ messageId: "m-1", choice: "Keep", commandId: "c1" });

      expect(first).toEqual({ status: "sent" });
      expect(again).toEqual({ status: "sent" });
      expect(sends).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a newer message makes the card stale even with the same command id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seed;
      sends.length = 0;
      yield* seedNewerOwnerMessage;

      const result = yield* answer({ messageId: "m-1", choice: "Keep", commandId: "c1" });

      expect(result).toEqual({ status: "stale" });
      expect(sends).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a choice the reply does not offer is refused", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seed;
      sends.length = 0;

      const result = yield* answer({ messageId: "m-1", choice: "Maybe", commandId: "c1" });

      expect(result).toEqual({ status: "unknownChoice" });
      expect(sends).toEqual([]);
      const again = yield* answer({ messageId: "m-1", choice: "Maybe", commandId: "c1" });
      expect(again).toEqual({ status: "unknownChoice" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a second tap with its own command id sends its own message", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seed;
      sends.length = 0;

      yield* answer({ messageId: "m-1", choice: "Keep", commandId: "c1" });
      yield* answer({ messageId: "m-1", choice: "Yes, delete", commandId: "c2" });

      expect(sends.map((send) => send.messageId)).toEqual(["work-answer:c1", "work-answer:c2"]);
      expect(sends.map((send) => send.text)).toEqual(["Keep", "Yes, delete"]);
    }).pipe(Effect.provide(layer)),
  );
});
