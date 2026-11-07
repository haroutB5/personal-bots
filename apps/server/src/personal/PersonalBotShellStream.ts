/**
 * The phone's live bot-chat shells.
 *
 * A subscriber gets one snapshot from a by-id read, then upserts and removals
 * from U's application events plus the personal link changes that have no
 * orchestration event (archive, unarchive, create and delete). No resume
 * cursor: a reconnect starts a new stream and its first item is a fresh
 * snapshot.
 *
 * @module personal/PersonalBotShellStream
 */
import {
  PersonalBotsError,
  type PersonalBotThreadShellStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  type ShellApplicationEvent,
  toShellApplicationEvent,
} from "../orchestration-v2/ShellStream.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import * as PersonalEngine from "./engine/PersonalEngine.ts";

/** U's shell stream groups at 50 ms; the phone list can wait longer per batch. */
const COALESCE_WINDOW = Duration.millis(250);
const COALESCE_MAX_EVENTS = 256;

interface ShellSignal {
  readonly threadId: ThreadId;
  readonly fromLink: boolean;
}

const streamError = (cause: unknown): PersonalBotsError =>
  cause instanceof PersonalBotsError
    ? cause
    : new PersonalBotsError({
        message: "Could not stream the bot's chats.",
        cause,
      });

export class PersonalBotShellStream extends Context.Service<
  PersonalBotShellStream,
  {
    readonly subscribe: Stream.Stream<PersonalBotThreadShellStreamItem, PersonalBotsError>;
  }
>()("t3/personal/PersonalBotShellStream") {}

const make = Effect.gen(function* () {
  const engine = yield* PersonalEngine.PersonalEngine;
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const applicationEvents = yield* OrchestrationEventStore;

  const isThreadShellEvent = (
    event: ShellApplicationEvent,
  ): event is Extract<ShellApplicationEvent, { readonly event: unknown }> =>
    !("aggregateKind" in event);

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      // Take the link subscription before the snapshot so an archive in the
      // read window is re-checked instead of lost. It is a stream, so this
      // effect runs once per subscriber.
      const linkChanges = yield* bots.subscribeLinkChanges;
      const sequence = yield* applicationEvents.latestApplicationSequence;
      const openIds = yield* repository.listOpenThreadIds();
      const snapshot = yield* engine.threadShells(openIds);

      /** Open membership, and whether a chat was ever sent to this subscriber. */
      const membership = new Map<string, boolean>(
        openIds.map((threadId) => [threadId as string, true]),
      );
      const known = new Set<string>(openIds.map((threadId) => threadId as string));

      const projectBatch = (batch: ReadonlyArray<ShellSignal>) =>
        Effect.gen(function* () {
          const latest = new Map<string, ShellSignal>();
          for (const signal of batch) latest.set(signal.threadId as string, signal);

          const linkChanged = new Set(
            [...latest.values()]
              .filter((signal) => signal.fromLink)
              .map((signal) => signal.threadId as string),
          );
          const toCheck = [...latest.keys()].filter(
            (threadId) => linkChanged.has(threadId) || !membership.has(threadId),
          );
          if (toCheck.length > 0) {
            const open = yield* repository.openThreadIds(
              toCheck.map((threadId) => ThreadId.make(threadId)),
            );
            for (const threadId of toCheck) {
              membership.set(threadId, open.has(ThreadId.make(threadId)));
            }
          }

          const changedOpenIds = [...latest.keys()].filter(
            (threadId) => membership.get(threadId) === true,
          );
          const shells =
            changedOpenIds.length === 0
              ? []
              : yield* engine.threadShells(
                  changedOpenIds.map((threadId) => ThreadId.make(threadId)),
                );
          const shellIds = new Set(shells.map((shell) => shell.id as string));

          const removed: ThreadId[] = [];
          for (const threadId of latest.keys()) {
            if (membership.get(threadId) !== true && known.has(threadId)) {
              removed.push(ThreadId.make(threadId));
            }
          }
          for (const threadId of changedOpenIds) {
            if (!shellIds.has(threadId) && known.has(threadId)) {
              removed.push(ThreadId.make(threadId));
            }
          }

          for (const threadId of shellIds) known.add(threadId);
          for (const threadId of removed) known.delete(threadId as string);

          const items: Array<PersonalBotThreadShellStreamItem> = [];
          if (removed.length > 0) items.push({ type: "removed", threadIds: removed });
          if (shells.length > 0) items.push({ type: "upsert", threads: shells });
          return items;
        });

      const applicationChanges = applicationEvents
        .streamProjectedApplicationEvents({
          afterSequence: sequence,
          project: toShellApplicationEvent,
        })
        .pipe(
          Stream.filter(isThreadShellEvent),
          Stream.map((event) => ({ threadId: event.event.threadId, fromLink: false })),
        );
      const linkSignals = linkChanges.pipe(
        Stream.map((change) => ({ threadId: change.threadId, fromLink: true })),
      );

      const live = Stream.merge(applicationChanges, linkSignals).pipe(
        Stream.groupedWithin(COALESCE_MAX_EVENTS, COALESCE_WINDOW),
        Stream.mapEffect((batch) => projectBatch(Array.from(batch))),
        Stream.flatMap(Stream.fromIterable),
      );

      return Stream.concat(
        Stream.make({ type: "snapshot" as const, threads: [...snapshot] }),
        live,
      );
    }),
  ).pipe(Stream.mapError(streamError));

  return { subscribe };
});

export const layer = Layer.effect(PersonalBotShellStream, make);
