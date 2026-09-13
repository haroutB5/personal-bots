import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as BrowserLease from "./BrowserLease.ts";
import * as PersonalBrowserLeaseRepository from "./PersonalBrowserLeaseRepository.ts";

const leaseLayer = BrowserLease.layer.pipe(
  Layer.provideMerge(PersonalBrowserLeaseRepository.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

/**
 * Advances the scheduler until the lease reaches a state. Bounded, and driven
 * by scheduler turns rather than wall-clock sleeps.
 */
const awaitLease = (predicate: (view: BrowserLease.LeaseView) => boolean) =>
  Effect.gen(function* () {
    const lease = yield* BrowserLease.BrowserLease;
    for (let turn = 0; turn < 1_000; turn++) {
      if (predicate(yield* lease.view)) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("lease never reached the expected state"));
  });

const rejectionReason = <A, E>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const error = Cause.squash(exit.cause);
  return error instanceof BrowserLease.BrowserLeaseRejected ? error.reason : "other-failure";
};

describe("BrowserLease", () => {
  it.effect("takeover waits for the in-flight agent op, then bumps the generation", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const inFlight = yield* lease
        .runAgentOp(
          { threadId: "thread-a", operation: "click" },
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("clicked"),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const before = yield* lease.view;
      expect(before).toMatchObject({
        ownerType: "agent",
        ownerId: "thread-a",
        inFlightThreadId: "thread-a",
      });

      const takeover = yield* lease.takeControl("session-1").pipe(Effect.forkChild);
      yield* awaitLease((view) => view.takeoverPending);
      // The human has not landed mid-click: the agent still owns the page.
      expect((yield* lease.view).ownerType).toBe("agent");
      // A new agent op queued now must never run once the human takes over.
      const queued = yield* lease
        .runAgentOp({ threadId: "thread-a", operation: "type" }, Effect.succeed("typed"))
        .pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(inFlight)).toBe("clicked");
      const after = yield* Fiber.join(takeover);
      expect(after).toMatchObject({ ownerType: "human", ownerId: "session-1" });
      expect(after.generation).toBe(before.generation + 1);
      const queuedExit = yield* Fiber.join(queued);
      expect(Exit.isFailure(queuedExit)).toBe(true);
      expect(rejectionReason(queuedExit)).toContain("human-control");
    }).pipe(Effect.provide(leaseLayer)),
  );

  it.effect("takeover stops waiting for a stuck op after 10 seconds", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* lease
        .runAgentOp(
          { threadId: "thread-a", operation: "navigate" },
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const takeover = yield* lease.takeControl("session-1").pipe(Effect.forkChild);
      yield* awaitLease((view) => view.takeoverPending);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(BrowserLease.TAKEOVER_WAIT_MS);
      expect((yield* Fiber.join(takeover)).ownerType).toBe("human");
      yield* Deferred.succeed(release, undefined);
    }).pipe(Effect.provide(leaseLayer)),
  );

  it.effect("an op whose generation went stale before executing is rejected and never runs", () =>
    Effect.gen(function* () {
      const saving = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      // The agent's lease write blocks, so a takeover lands between the
      // agent acquiring its generation and executing: the re-check must win.
      const gatedRepository = Layer.effect(
        PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository,
        Effect.gen(function* () {
          const real = yield* PersonalBrowserLeaseRepository.make;
          let first = true;
          return PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository.of({
            load: real.load,
            save: (row) => {
              if (!first) return real.save(row);
              first = false;
              return Deferred.succeed(saving, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(real.save(row)),
              );
            },
          });
        }),
      );
      yield* Effect.gen(function* () {
        const lease = yield* BrowserLease.BrowserLease;
        const ran = yield* Ref.make(false);
        const op = yield* lease
          .runAgentOp({ threadId: "thread-a", operation: "click" }, Ref.set(ran, true))
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(saving);
        const human = yield* lease.takeControl("session-1");
        expect(human.ownerType).toBe("human");
        yield* Deferred.succeed(gate, undefined);
        const exit = yield* Fiber.join(op);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(rejectionReason(exit)).toContain("stale-generation");
        expect(yield* Ref.get(ran)).toBe(false);
      }).pipe(
        Effect.provide(
          BrowserLease.layer.pipe(
            Layer.provideMerge(gatedRepository),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    }),
  );

  it.effect("returning control makes the next agent action take a fresh snapshot first", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      yield* lease.takeControl("session-1");
      const humanAgent = yield* lease
        .runAgentOp({ threadId: "thread-a", operation: "snapshot" }, Effect.void)
        .pipe(Effect.exit);
      expect(Exit.isFailure(humanAgent)).toBe(true);

      const returned = yield* lease.returnToAgent;
      expect(returned).toMatchObject({ ownerType: "agent", ownerId: null });
      const click = yield* lease
        .runAgentOp({ threadId: "thread-a", operation: "click" }, Effect.void)
        .pipe(Effect.exit);
      expect(rejectionReason(click)).toContain("snapshot-required");
      yield* lease.runAgentOp({ threadId: "thread-a", operation: "snapshot" }, Effect.void);
      yield* lease.runAgentOp({ threadId: "thread-a", operation: "click" }, Effect.void);
      expect((yield* lease.view).agentActive).toBe(true);
    }).pipe(Effect.provide(leaseLayer)),
  );

  it.effect("human control survives a restart until it is explicitly returned", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      const taken = yield* lease.takeControl("session-1");
      // A fresh coordinator over the same table is what a server restart sees.
      const restarted = yield* BrowserLease.make;
      const view = yield* restarted.view;
      expect(view).toMatchObject({ ownerType: "human", ownerId: "session-1" });
      expect(view.generation).toBe(taken.generation);
      expect(yield* restarted.isHumanController("session-1")).toBe(true);
      expect(yield* restarted.isHumanController("session-2")).toBe(false);
    }).pipe(Effect.provide(leaseLayer)),
  );
});
