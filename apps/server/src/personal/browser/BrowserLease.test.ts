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

  it.effect(
    "a persisted human lease is cleared at boot: its session id died with the restart",
    () =>
      Effect.gen(function* () {
        const lease = yield* BrowserLease.BrowserLease;
        const taken = yield* lease.takeControl("session-1");
        // A fresh coordinator over the same table is what a server restart sees.
        const restarted = yield* BrowserLease.make;
        const view = yield* restarted.view;
        expect(view).toMatchObject({ ownerType: "agent", ownerId: null });
        expect(view.generation).toBe(taken.generation + 1);
        expect(yield* restarted.isHumanController("session-1")).toBe(false);
        // The clearing was persisted, not just in memory.
        const reread = yield* BrowserLease.make;
        expect(yield* reread.view).toMatchObject({ ownerType: "agent", ownerId: null });
        // And agents are no longer told a (dead) user is holding the browser.
        yield* restarted.runAgentOp({ threadId: "thread-a", operation: "snapshot" }, Effect.void);
        expect((yield* restarted.view).agentActive).toBe(true);
      }).pipe(Effect.provide(leaseLayer)),
  );

  it.effect("a persisted agent lease is extended at boot and keeps its page", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      yield* lease.runAgentOp({ threadId: "thread-a", operation: "navigate" }, Effect.void);
      yield* lease.recordPageUrl("https://example.com/");
      const before = yield* lease.view;
      // A fresh coordinator over the same table is what a server restart sees:
      // the TTL the previous process was counting down is renewed from boot,
      // without a generation bump (ownership never changed hands).
      const restarted = yield* BrowserLease.make;
      const view = yield* restarted.view;
      expect(view).toMatchObject({
        ownerType: "agent",
        ownerId: "thread-a",
        lastUrl: "https://example.com/",
        agentActive: true,
      });
      expect(view.generation).toBe(before.generation);
      const reread = yield* BrowserLease.make;
      expect(yield* reread.view).toMatchObject({ lastUrl: "https://example.com/" });
    }).pipe(Effect.provide(leaseLayer)),
  );

  it.effect("recordPageUrl only sticks while an agent holds the lease", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      // Released: nothing to attach a page to.
      yield* lease.recordPageUrl("https://example.com/");
      expect((yield* lease.view).lastUrl).toBeNull();
      // Human control: the human's browsing is not the agent's restore page.
      yield* lease.takeControl("session-1");
      yield* lease.recordPageUrl("https://example.org/");
      expect((yield* lease.view).lastUrl).toBeNull();
      yield* lease.returnToAgent;
      // Agent op: sticks, and repeats of the same URL are idempotent.
      yield* lease.runAgentOp({ threadId: "thread-a", operation: "navigate" }, Effect.void);
      yield* lease.recordPageUrl("https://example.com/");
      yield* lease.recordPageUrl("https://example.com/");
      expect((yield* lease.view).lastUrl).toBe("https://example.com/");
    }).pipe(Effect.provide(leaseLayer)),
  );

  describe("decideBrowserRestore", () => {
    const row = (
      ownerType: "agent" | "human",
      ownerId: string | null,
      lastUrl: string | null,
    ): PersonalBrowserLeaseRepository.BrowserLeaseRow => ({
      profileId: BrowserLease.PERSONAL_BROWSER_PROFILE_ID,
      ownerType,
      ownerId,
      generation: 4,
      heartbeatAt: null,
      expiresAt: null,
      lastUrl,
    });

    it.effect("restores an agent lease with its normalized page", () =>
      Effect.gen(function* () {
        expect(BrowserLease.decideBrowserRestore(row("agent", "thread-a", "example.com"))).toEqual({
          _tag: "RestoreAgent",
          threadId: "thread-a",
          url: "https://example.com/",
        });
      }),
    );

    it.effect("restores an agent lease without a page when there is nothing usable", () =>
      Effect.gen(function* () {
        expect(BrowserLease.decideBrowserRestore(row("agent", "thread-a", null))).toEqual({
          _tag: "RestoreAgent",
          threadId: "thread-a",
          url: null,
        });
        // A saved URL that fails the navigation policy restores the lease but
        // never navigates, rather than blocking the restore.
        expect(
          BrowserLease.decideBrowserRestore(row("agent", "thread-a", "javascript:alert(1)")),
        ).toEqual({ _tag: "RestoreAgent", threadId: "thread-a", url: null });
      }),
    );

    it.effect("clears a human lease and leaves a released lease alone", () =>
      Effect.gen(function* () {
        expect(BrowserLease.decideBrowserRestore(row("human", "session-1", null))).toEqual({
          _tag: "ClearHuman",
        });
        expect(BrowserLease.decideBrowserRestore(row("agent", null, null))).toEqual({
          _tag: "Noop",
        });
        expect(BrowserLease.decideBrowserRestore(row("human", null, null))).toEqual({
          _tag: "Noop",
        });
      }),
    );
  });
});
