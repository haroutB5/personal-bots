import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import {
  PersonalEngine,
  type PersonalSessionView,
  type PersonalThreadEvent,
  type PersonalThreadStatus,
} from "../engine/PersonalEngine.ts";
import { PersonalBrowserArchiveReactorLive } from "./PersonalBrowserArchiveReactor.ts";
import { PersonalBrowserTurnReactorLive } from "./PersonalBrowserTurnReactor.ts";

const CHAT = ThreadId.make("chat-1");

const session = (status: PersonalThreadStatus): PersonalSessionView => ({
  threadId: CHAT,
  status,
  activeTurnId: null,
  lastError: null,
  providerInstanceId: null,
  providerName: null,
  providerRetry: null,
  updatedAt: "2026-11-05T10:00:00.000Z",
});

const statusChanged = (status: PersonalThreadStatus): PersonalThreadEvent => ({
  _tag: "StatusChanged",
  threadId: CHAT,
  status,
  session: session(status),
});

const harness = (
  reactor: typeof PersonalBrowserTurnReactorLive,
  events: ReadonlyArray<PersonalThreadEvent>,
) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const queue = yield* Queue.unbounded<PersonalThreadEvent>();
    const layer = reactor.pipe(
      Layer.provide(
        Layer.mock(PersonalEngine)({
          events: Stream.fromQueue(queue),
        }),
      ),
      Layer.provide(
        Layer.mock(PersonalBrowser)({
          releaseLease: (threadId: string) =>
            Effect.sync(() => void calls.push(`lease:${threadId}`)),
          releaseThread: (threadId: string) =>
            Effect.sync(() => void calls.push(`thread:${threadId}`)),
        } as never),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        for (const event of events) yield* Queue.offer(queue, event);
        yield* Effect.sleep("20 millis");
      }),
    );
    return calls;
  });

describe("personal browser reactors", () => {
  it.live("the turn reactor gives up the lease only when the session stops being active", () =>
    Effect.gen(function* () {
      const calls = yield* harness(PersonalBrowserTurnReactorLive, [
        statusChanged("starting"),
        statusChanged("running"),
        statusChanged("waiting"),
      ]);
      expect(calls).toEqual(["lease:chat-1"]);
    }),
  );

  it.live("the archive reactor releases an archived chat and ignores other events", () =>
    Effect.gen(function* () {
      const calls = yield* harness(PersonalBrowserArchiveReactorLive, [
        statusChanged("waiting"),
        { _tag: "ThreadDeleted", threadId: CHAT },
        { _tag: "ThreadArchived", threadId: CHAT },
      ]);
      expect(calls).toEqual(["thread:chat-1"]);
    }),
  );
});
