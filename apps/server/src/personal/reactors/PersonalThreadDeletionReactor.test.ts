import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import { PersonalEngine, type PersonalThreadEvent } from "../engine/PersonalEngine.ts";
import * as PersonalVoiceCallRepository from "../voiceCalls/PersonalVoiceCallRepository.ts";
import { PersonalThreadDeletionReactorLive } from "./PersonalThreadDeletionReactor.ts";

const CHAT = ThreadId.make("chat-1");
const OTHER = ThreadId.make("chat-2");

describe("personal thread deletion reactor", () => {
  it.live("releases the browser and removes voice cards only for the deleted chat", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const queue = yield* Queue.unbounded<PersonalThreadEvent>();
      const layer = PersonalThreadDeletionReactorLive.pipe(
        Layer.provide(
          Layer.mock(PersonalEngine)({
            events: Stream.fromQueue(queue),
          }),
        ),
        Layer.provide(
          Layer.mock(PersonalBrowser)({
            releaseThread: (threadId: string) =>
              Effect.sync(() => void calls.push(`browser:${threadId}`)),
          } as never),
        ),
        Layer.provide(
          Layer.mock(PersonalVoiceCallRepository.PersonalVoiceCallRepository)({
            deleteByThread: (threadId: ThreadId) =>
              Effect.sync(() => {
                calls.push(`cards:${threadId}`);
                return 1;
              }),
            deleteLeasesByThread: (threadId: ThreadId) =>
              Effect.sync(() => {
                calls.push(`leases:${threadId}`);
                return 1;
              }),
          } as never),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          yield* Queue.offer(queue, { _tag: "ThreadArchived", threadId: CHAT });
          yield* Queue.offer(queue, { _tag: "ThreadDeleted", threadId: OTHER });
          yield* Effect.sleep("20 millis");
        }),
      );

      expect(calls).toEqual(["browser:chat-2", "cards:chat-2", "leases:chat-2"]);
    }),
  );
});
