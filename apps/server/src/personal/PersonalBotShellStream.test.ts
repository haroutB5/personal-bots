import {
  type OrchestrationThreadShell,
  type PersonalBotThreadShellStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import { PersonalBotShellStream, layer as shellStreamLayer } from "./PersonalBotShellStream.ts";
import * as PersonalEngine from "./engine/PersonalEngine.ts";

const thread = (id: string, title: string) =>
  ({ id: ThreadId.make(id), title }) as unknown as OrchestrationThreadShell;

const appEvent = (threadId: string, sequence: number) =>
  ({ sequence, event: { threadId: ThreadId.make(threadId) } }) as never;

interface Harness {
  /** Open bot chats the first snapshot reads. */
  readonly snapshotOpen: ReadonlySet<string>;
  /** Open bot chats a live batch's re-check reads. */
  readonly checkOpen: ReadonlySet<string>;
  readonly shells: ReadonlyMap<string, OrchestrationThreadShell>;
  readonly events: ReadonlyArray<unknown>;
  readonly linkChanges: ReadonlyArray<ThreadId>;
}

const harnessLayer = (harness: Harness) =>
  shellStreamLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(PersonalEngine.PersonalEngine, {
          threadShells: (threadIds: ReadonlyArray<ThreadId>) =>
            Effect.succeed(
              threadIds.flatMap((threadId) => {
                const shell = harness.shells.get(threadId as string);
                return shell === undefined ? [] : [shell];
              }),
            ),
        } as never),
        Layer.succeed(PersonalBotRepository.PersonalBotRepository, {
          listOpenThreadIds: () =>
            Effect.succeed([...harness.snapshotOpen].map((threadId) => ThreadId.make(threadId))),
          openThreadIds: (threadIds: ReadonlyArray<ThreadId>) =>
            Effect.succeed(
              new Set(threadIds.filter((threadId) => harness.checkOpen.has(threadId as string))),
            ),
        } as never),
        Layer.succeed(PersonalBotService.PersonalBotService, {
          subscribeLinkChanges: Effect.succeed(
            Stream.fromIterable(harness.linkChanges.map((threadId) => ({ threadId }))),
          ),
        } as never),
        Layer.succeed(OrchestrationEventStore, {
          latestApplicationSequence: Effect.succeed(0),
          streamProjectedApplicationEvents: (input: { project: (event: never) => unknown }) =>
            Stream.fromIterable(harness.events.map((event) => input.project(event as never))),
        } as never),
      ),
    ),
  );

const collect = (harness: Harness) =>
  Effect.gen(function* () {
    const service = yield* PersonalBotShellStream;
    return yield* service.subscribe.pipe(Stream.runCollect);
  }).pipe(Effect.provide(harnessLayer(harness)));

it.effect("a snapshot opens the stream, then one coalesced upsert for a bot chat", () => {
  const harness: Harness = {
    snapshotOpen: new Set(["bot-thread"]),
    checkOpen: new Set(["bot-thread"]),
    shells: new Map([
      ["bot-thread", thread("bot-thread", "Researcher")],
      ["other-thread", thread("other-thread", "Not a bot chat")],
    ]),
    events: [appEvent("bot-thread", 1), appEvent("bot-thread", 2), appEvent("other-thread", 3)],
    linkChanges: [],
  };
  return Effect.gen(function* () {
    const items = Array.from(yield* collect(harness));
    expect(items).toEqual([
      { type: "snapshot", threads: [thread("bot-thread", "Researcher")] },
      { type: "upsert", threads: [thread("bot-thread", "Researcher")] },
    ] satisfies ReadonlyArray<PersonalBotThreadShellStreamItem>);
  });
});

it.effect("an archived bot chat leaves the map as removed", () => {
  const harness: Harness = {
    snapshotOpen: new Set(["bot-thread"]),
    checkOpen: new Set(),
    shells: new Map([["bot-thread", thread("bot-thread", "Researcher")]]),
    events: [],
    linkChanges: [ThreadId.make("bot-thread")],
  };
  return Effect.gen(function* () {
    const items = Array.from(yield* collect(harness));
    expect(items).toEqual([
      { type: "snapshot", threads: [thread("bot-thread", "Researcher")] },
      { type: "removed", threadIds: [ThreadId.make("bot-thread")] },
    ] satisfies ReadonlyArray<PersonalBotThreadShellStreamItem>);
  });
});

it.effect("a new subscriber gets a fresh snapshot, not the previous map", () => {
  const first: Harness = {
    snapshotOpen: new Set(["bot-thread"]),
    checkOpen: new Set(["bot-thread"]),
    shells: new Map([["bot-thread", thread("bot-thread", "Old title")]]),
    events: [],
    linkChanges: [],
  };
  const second: Harness = {
    snapshotOpen: new Set(["bot-thread"]),
    checkOpen: new Set(["bot-thread"]),
    shells: new Map([["bot-thread", thread("bot-thread", "New title")]]),
    events: [],
    linkChanges: [],
  };
  return Effect.gen(function* () {
    const firstItems = Array.from(yield* collect(first));
    const secondItems = Array.from(yield* collect(second));
    expect(firstItems[0]).toEqual({
      type: "snapshot",
      threads: [thread("bot-thread", "Old title")],
    });
    expect(secondItems[0]).toEqual({
      type: "snapshot",
      threads: [thread("bot-thread", "New title")],
    });
  });
});
