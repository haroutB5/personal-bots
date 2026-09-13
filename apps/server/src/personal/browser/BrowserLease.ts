/**
 * Who may drive the shared browser. Agents hold a short, self-refreshing lease
 * per thread; a human holds control until they explicitly return it (a closed
 * phone keeps control). Every control change bumps `generation`, and each agent
 * op re-checks the generation immediately before it executes, so an op queued
 * or captured before a takeover can never act on the page afterwards.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  type BrowserLeaseRow,
  PersonalBrowserLeaseRepository,
} from "./PersonalBrowserLeaseRepository.ts";

export const PERSONAL_BROWSER_PROFILE_ID = "default";
/** An agent lease lapses after this long without an op; the next op re-acquires. */
export const AGENT_LEASE_TTL_MS = 90_000;
/** Take control waits this long for an in-flight agent op before taking over anyway. */
export const TAKEOVER_WAIT_MS = 10_000;

/** After a human hands back control these act on page state the agent has not seen. */
const ACTIONS_NEEDING_FRESH_SNAPSHOT: ReadonlySet<string> = new Set([
  "click",
  "type",
  "press",
  "scroll",
]);

export type BrowserLeaseRejectionReason =
  | "human-control"
  | "stale-generation"
  | "snapshot-required";

export class BrowserLeaseRejected extends Data.TaggedError("BrowserLeaseRejected")<{
  readonly reason: BrowserLeaseRejectionReason;
  readonly message: string;
}> {}

export interface LeaseView {
  readonly ownerType: "agent" | "human";
  readonly ownerId: string | null;
  readonly generation: number;
  /** An agent owns the lease and it has not lapsed. */
  readonly agentActive: boolean;
  readonly inFlightThreadId: string | null;
  readonly takeoverPending: boolean;
}

interface InFlight {
  readonly threadId: string;
  readonly done: Deferred.Deferred<void>;
}

interface LeaseState {
  readonly row: BrowserLeaseRow;
  readonly inFlight: InFlight | null;
  readonly takeoverPending: boolean;
  readonly freshSnapshotRequired: boolean;
}

export class BrowserLease extends Context.Service<
  BrowserLease,
  {
    readonly runAgentOp: <A, E, R>(
      input: { readonly threadId: string; readonly operation: string },
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | BrowserLeaseRejected, R>;
    readonly takeControl: (sessionId: string) => Effect.Effect<LeaseView>;
    readonly returnToAgent: Effect.Effect<LeaseView>;
    readonly isHumanController: (sessionId: string) => Effect.Effect<boolean>;
    readonly view: Effect.Effect<LeaseView>;
    readonly changes: Stream.Stream<LeaseView>;
  }
>()("t3/personal/browser/BrowserLease") {}

const releasedRow = (generation: number): BrowserLeaseRow => ({
  profileId: PERSONAL_BROWSER_PROFILE_ID,
  ownerType: "agent",
  ownerId: null,
  generation,
  heartbeatAt: null,
  expiresAt: null,
});

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const agentLeaseLive = (row: BrowserLeaseRow, now: number) =>
  row.ownerType === "agent" &&
  row.ownerId !== null &&
  row.expiresAt !== null &&
  Date.parse(row.expiresAt) > now;

const humanControlMessage =
  "The user has taken control of the shared browser. Wait until they return control, then take a fresh snapshot.";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalBrowserLeaseRepository;
  const loaded = yield* repository.load(PERSONAL_BROWSER_PROFILE_ID).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Personal browser lease could not be loaded; starting released.", {
        cause,
      }).pipe(Effect.as(Option.none<BrowserLeaseRow>())),
    ),
  );
  const state = yield* Ref.make<LeaseState>({
    row: Option.getOrElse(loaded, () => releasedRow(0)),
    inFlight: null,
    takeoverPending: false,
    freshSnapshotRequired: false,
  });
  // One agent op at a time: the page is shared, and takeover waits on it.
  const opLock = yield* Semaphore.make(1);
  const takeoverLock = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<LeaseView>();

  const toView = (current: LeaseState, now: number): LeaseView => ({
    ownerType: current.row.ownerType,
    ownerId: current.row.ownerId,
    generation: current.row.generation,
    agentActive: agentLeaseLive(current.row, now),
    inFlightThreadId: current.inFlight?.threadId ?? null,
    takeoverPending: current.takeoverPending,
  });

  const view = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return toView(yield* Ref.get(state), now);
  });

  const publish = Effect.flatMap(view, (next) => PubSub.publish(changesPubSub, next));

  // The in-memory state is authoritative for this process; the row only
  // carries control across restarts, so a failed write must not block control.
  const persist = (row: BrowserLeaseRow) =>
    repository
      .save(row)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Personal browser lease could not be persisted.", { cause }),
        ),
      );

  const runAgentOp: BrowserLease["Service"]["runAgentOp"] = (input, effect) =>
    opLock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const acquired = yield* Ref.modify(
          state,
          (
            current,
          ): readonly [
            (
              | { readonly _tag: "rejected"; readonly reason: BrowserLeaseRejectionReason }
              | {
                  readonly _tag: "acquired";
                  readonly row: BrowserLeaseRow;
                  readonly changed: boolean;
                }
            ),
            LeaseState,
          ] => {
            if (current.takeoverPending || current.row.ownerType === "human") {
              return [{ _tag: "rejected", reason: "human-control" }, current];
            }
            let freshSnapshotRequired = current.freshSnapshotRequired;
            if (freshSnapshotRequired && ACTIONS_NEEDING_FRESH_SNAPSHOT.has(input.operation)) {
              // Reported once; the agent is told to snapshot before acting.
              return [
                { _tag: "rejected", reason: "snapshot-required" },
                { ...current, freshSnapshotRequired: false },
              ];
            }
            if (input.operation === "snapshot") freshSnapshotRequired = false;
            const sameOwner =
              current.row.ownerId === input.threadId && agentLeaseLive(current.row, now);
            const row: BrowserLeaseRow = {
              ...current.row,
              ownerType: "agent",
              ownerId: input.threadId,
              generation: sameOwner ? current.row.generation : current.row.generation + 1,
              heartbeatAt: iso(now),
              expiresAt: iso(now + AGENT_LEASE_TTL_MS),
            };
            return [
              { _tag: "acquired", row, changed: !sameOwner },
              { ...current, row, freshSnapshotRequired },
            ];
          },
        );
        if (acquired._tag === "rejected") {
          return yield* new BrowserLeaseRejected({
            reason: acquired.reason,
            message:
              acquired.reason === "snapshot-required"
                ? "The user just returned control of the shared browser and the page may have changed. Take a snapshot before acting."
                : humanControlMessage,
          });
        }
        yield* persist(acquired.row);
        if (acquired.changed) yield* publish;
        const generation = acquired.row.generation;
        const done = yield* Deferred.make<void>();
        // Re-check immediately before executing: a takeover that landed while
        // the lease row was being written wins over this op.
        const admitted = yield* Ref.modify(state, (current) =>
          current.takeoverPending ||
          current.row.ownerType === "human" ||
          current.row.generation !== generation
            ? ([false, current] as const)
            : ([true, { ...current, inFlight: { threadId: input.threadId, done } }] as const),
        );
        if (!admitted) {
          return yield* new BrowserLeaseRejected({
            reason: "stale-generation",
            message: humanControlMessage,
          });
        }
        return yield* effect.pipe(
          Effect.ensuring(
            Ref.update(state, (current) =>
              current.inFlight?.done === done ? { ...current, inFlight: null } : current,
            ).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
          ),
        );
      }),
    );

  const takeControl: BrowserLease["Service"]["takeControl"] = (sessionId) =>
    takeoverLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.row.ownerType === "human" && current.row.ownerId === sessionId) {
          return yield* view;
        }
        // Block new agent ops first, then give the in-flight one a bounded
        // chance to finish so the human never lands mid-click.
        const inFlight = yield* Ref.modify(
          state,
          (latest) => [latest.inFlight, { ...latest, takeoverPending: true }] as const,
        );
        yield* publish;
        if (inFlight !== null) {
          yield* Deferred.await(inFlight.done).pipe(Effect.timeoutOption(TAKEOVER_WAIT_MS));
        }
        const now = yield* Clock.currentTimeMillis;
        const row = yield* Ref.modify(state, (latest) => {
          const next: BrowserLeaseRow = {
            ...latest.row,
            ownerType: "human",
            ownerId: sessionId,
            generation: latest.row.generation + 1,
            heartbeatAt: iso(now),
            expiresAt: null,
          };
          return [next, { ...latest, row: next, takeoverPending: false }] as const;
        });
        yield* persist(row);
        yield* publish;
        return yield* view;
      }).pipe(
        Effect.onInterrupt(() =>
          Ref.update(state, (latest) => ({ ...latest, takeoverPending: false })),
        ),
      ),
    );

  const returnToAgent: BrowserLease["Service"]["returnToAgent"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const row = yield* Ref.modify(state, (latest) => {
      if (latest.row.ownerType !== "human") return [null, latest] as const;
      const next: BrowserLeaseRow = {
        ...releasedRow(latest.row.generation + 1),
        heartbeatAt: iso(now),
      };
      return [next, { ...latest, row: next, freshSnapshotRequired: true }] as const;
    });
    if (row !== null) {
      yield* persist(row);
      yield* publish;
    }
    return yield* view;
  });

  const isHumanController: BrowserLease["Service"]["isHumanController"] = (sessionId) =>
    Ref.get(state).pipe(
      Effect.map(
        (current) => current.row.ownerType === "human" && current.row.ownerId === sessionId,
      ),
    );

  return BrowserLease.of({
    runAgentOp,
    takeControl,
    returnToAgent,
    isHumanController,
    view,
    changes: Stream.fromPubSub(changesPubSub),
  });
});

export const layer = Layer.effect(BrowserLease, make);
