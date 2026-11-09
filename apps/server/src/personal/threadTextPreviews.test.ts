import { MessageId, ThreadId, type PersonalThreadFullTextInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PersonalEngine from "./engine/PersonalEngine.ts";
import { readThreadFullText } from "./threadTextPreviews.ts";

const engineLayer = Layer.succeed(PersonalEngine.PersonalEngine, {
  messagesByIds: (input: { messageIds: ReadonlyArray<MessageId> }) =>
    Effect.succeed(
      input.messageIds.map((messageId) => ({
        id: messageId,
        role: "reasoning" as const,
        text: `full text of ${messageId}`,
        turnId: null,
        streaming: false,
        createdAt: "2026-11-06T12:00:00.000Z",
        updatedAt: "2026-11-06T12:00:00.000Z",
      })),
    ),
  activitiesByIds: (input: { ids: ReadonlyArray<string> }) =>
    Effect.succeed(
      input.ids.map((id) => ({
        id,
        kind: "command_execution",
        payload: { id, type: "command_execution", input: `full command ${id}` },
      })),
    ),
} as never);

const input: PersonalThreadFullTextInput = {
  threadId: ThreadId.make("thread-1"),
  messageIds: [MessageId.make("m-1"), MessageId.make("m-2")],
  activityIds: ["a-1"],
};

it.effect("reads the whole text of the named messages and activities", () =>
  Effect.gen(function* () {
    const result = yield* readThreadFullText(input);
    expect(result.messages).toEqual([
      { messageId: "m-1", text: "full text of m-1" },
      { messageId: "m-2", text: "full text of m-2" },
    ]);
    expect(result.activities).toEqual([
      {
        activityId: "a-1",
        payload: { id: "a-1", type: "command_execution", input: "full command a-1" },
      },
    ]);
  }).pipe(Effect.provide(engineLayer)),
);

it.effect("asks for nothing when the input names nothing", () =>
  Effect.gen(function* () {
    const result = yield* readThreadFullText({ threadId: ThreadId.make("thread-1") });
    expect(result).toEqual({ messages: [], activities: [] });
  }).pipe(Effect.provide(engineLayer)),
);
