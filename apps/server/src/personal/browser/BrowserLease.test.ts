import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
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

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const rejectionReason = <A, E>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const error = Cause.squash(exit.cause);
  return error instanceof BrowserLease.BrowserLeaseRejected ? error.reason : "other-failure";
};

describe("BrowserLease", () => {
  // Audit #6: a close that only takes the launch lock can tear the context
  // down underneath an operation that is already past launch.
  it.effect("runExclusive waits for the in-flight agent op", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: string[] = [];
      const inFlight = yield* lease
        .runAgentOp(
          { threadId: "thread-a", operation: "click" },
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => order.push("op"))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);

      const exclusive = yield* lease
        .runExclusive(Effect.sync(() => order.push("exclusive")))
        .pipe(Effect.forkChild);
      // Given a chance to run, it still has not: the op holds the lock.
      yield* Effect.yieldNow;
      expect(order).toEqual([]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(inFlight);
      yield* Fiber.join(exclusive);
      expect(order).toEqual(["op", "exclusive"]);
    }).pipe(Effect.provide(leaseLayer)),
  );

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

  it.effect("deleting the owning thread releases the lease and forgets its page", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      yield* lease.runAgentOp({ threadId: "thread-a", operation: "navigate" }, Effect.void);
      yield* lease.recordPageUrl("https://example.com/");

      // Another thread's deletion must not take the browser off this bot.
      yield* lease.releaseThread("thread-b");
      expect(yield* lease.view).toMatchObject({
        ownerId: "thread-a",
        lastUrl: "https://example.com/",
      });

      yield* lease.releaseThread("thread-a");
      // The page goes with the owner: a deleted chat's URL must never be
      // reopened by a later boot restore.
      expect(yield* lease.view).toMatchObject({ ownerId: null, lastUrl: null });
    }).pipe(Effect.provide(leaseLayer)),
  );

  it.effect("remembers the last agent chat past its lease, until the session ends", () =>
    Effect.gen(function* () {
      const lease = yield* BrowserLease.BrowserLease;
      expect((yield* lease.view).lastAgentThreadId).toBeNull();

      yield* lease.runAgentOp({ threadId: "thread-a", operation: "navigate" }, Effect.void);
      expect(yield* lease.view).toMatchObject({
        agentActive: true,
        lastAgentThreadId: "thread-a",
      });

      // The lease lapses long before Chrome's ten idle minutes are up. The
      // controller goes quiet; the chat to go back to must not.
      yield* TestClock.adjust(BrowserLease.AGENT_LEASE_TTL_MS + 1_000);
      expect(yield* lease.view).toMatchObject({
        agentActive: false,
        lastAgentThreadId: "thread-a",
      });

      // Taking control overwrites `ownerId` with the auth session id, so the
      // remembered chat is the only thing left pointing at the bot.
      yield* lease.takeControl("session-1");
      expect(yield* lease.view).toMatchObject({
        ownerId: "session-1",
        lastAgentThreadId: "thread-a",
      });
      yield* lease.returnToAgent;
      expect((yield* lease.view).lastAgentThreadId).toBe("thread-a");

      // Another chat's deletion leaves it alone; its own deletion clears it.
      yield* lease.releaseThread("thread-b");
      expect((yield* lease.view).lastAgentThreadId).toBe("thread-a");
      yield* lease.releaseThread("thread-a");
      expect((yield* lease.view).lastAgentThreadId).toBeNull();

      // Closing the browser ends the session and the target with it.
      yield* lease.runAgentOp({ threadId: "thread-c", operation: "navigate" }, Effect.void);
      expect((yield* lease.view).lastAgentThreadId).toBe("thread-c");
      yield* lease.releaseAll;
      expect((yield* lease.view).lastAgentThreadId).toBeNull();
    }).pipe(Effect.provide(leaseLayer)),
  );

  it.effect("boot releases a lapsed agent lease instead of keeping its page", () =>
    Effect.gen(function* () {
      const saved: PersonalBrowserLeaseRepository.BrowserLeaseRow[] = [];
      // The test clock boots at the epoch, so a heartbeat a day earlier is a
      // day stale from boot's point of view.
      const heartbeatMs = -24 * 60 * 60 * 1_000;
      const stale: PersonalBrowserLeaseRepository.BrowserLeaseRow = {
        profileId: BrowserLease.PERSONAL_BROWSER_PROFILE_ID,
        ownerType: "agent",
        ownerId: "thread-a",
        generation: 4,
        heartbeatAt: iso(heartbeatMs),
        expiresAt: iso(heartbeatMs + BrowserLease.AGENT_LEASE_TTL_MS),
        lastUrl: "https://example.com/",
      };
      const repository = Layer.succeed(
        PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository,
        PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository.of({
          load: () => Effect.succeed(Option.some(stale)),
          save: (next) =>
            Effect.sync(() => {
              saved.push(next);
            }),
        }),
      );

      yield* Effect.gen(function* () {
        const lease = yield* BrowserLease.BrowserLease;
        expect(yield* lease.view).toMatchObject({ ownerId: null, lastUrl: null });
        // Normalized on disk too, so the stale owner and URL stop accumulating.
        expect(saved.at(-1)).toMatchObject({ ownerId: null, lastUrl: null });
      }).pipe(Effect.provide(BrowserLease.layer.pipe(Layer.provide(repository))));
    }),
  );

  describe("decideBrowserRestore", () => {
    const BOOT_MS = Date.parse("2026-01-02T00:00:00.000Z");
    /** When the agent last touched the browser, N seconds before the restart. */
    const heartbeat = (secondsBeforeBoot: number) => BOOT_MS - secondsBeforeBoot * 1_000;

    const row = (
      ownerType: "agent" | "human",
      ownerId: string | null,
      lastUrl: string | null,
      // Live by default: an agent lease heartbeaten 30s before the restart.
      heartbeatAt: number | null = heartbeat(30),
    ): PersonalBrowserLeaseRepository.BrowserLeaseRow => ({
      profileId: BrowserLease.PERSONAL_BROWSER_PROFILE_ID,
      ownerType,
      ownerId,
      generation: 4,
      heartbeatAt: heartbeatAt === null ? null : iso(heartbeatAt),
      // Always past: a restart outlasts the 90s idle TTL, which is exactly why
      // the restore decision is made on the heartbeat instead.
      expiresAt: heartbeatAt === null ? null : iso(heartbeatAt + BrowserLease.AGENT_LEASE_TTL_MS),
      lastUrl,
    });

    it.effect("restores an agent lease with its normalized page", () =>
      Effect.gen(function* () {
        expect(
          BrowserLease.decideBrowserRestore(row("agent", "thread-a", "example.com"), BOOT_MS),
        ).toEqual({
          _tag: "RestoreAgent",
          threadId: "thread-a",
          url: "https://example.com/",
        });
      }),
    );

    it.effect("restores an agent lease without a page when there is nothing usable", () =>
      Effect.gen(function* () {
        expect(BrowserLease.decideBrowserRestore(row("agent", "thread-a", null), BOOT_MS)).toEqual({
          _tag: "RestoreAgent",
          threadId: "thread-a",
          url: null,
        });
        // A saved URL that fails the navigation policy restores the lease but
        // never navigates, rather than blocking the restore.
        expect(
          BrowserLease.decideBrowserRestore(
            row("agent", "thread-a", "javascript:alert(1)"),
            BOOT_MS,
          ),
        ).toEqual({ _tag: "RestoreAgent", threadId: "thread-a", url: null });
      }),
    );

    it.effect("clears a human lease and leaves a released lease alone", () =>
      Effect.gen(function* () {
        expect(BrowserLease.decideBrowserRestore(row("human", "session-1", null), BOOT_MS)).toEqual(
          {
            _tag: "ClearHuman",
          },
        );
        expect(BrowserLease.decideBrowserRestore(row("agent", null, null), BOOT_MS)).toEqual({
          _tag: "Noop",
        });
        expect(BrowserLease.decideBrowserRestore(row("human", null, null), BOOT_MS)).toEqual({
          _tag: "Noop",
        });
      }),
    );

    it.effect("refuses to restore an agent lease that lapsed before the restart window", () =>
      Effect.gen(function* () {
        // A day-old lease. Without this bound every later restart relaunches
        // Chrome on yesterday's page and reports the bot as working.
        const stale = row("agent", "thread-a", "https://example.com/", heartbeat(24 * 60 * 60));
        expect(BrowserLease.decideBrowserRestore(stale, BOOT_MS)).toEqual({ _tag: "Noop" });
        expect(BrowserLease.isLapsedAgentLease(stale, BOOT_MS)).toBe(true);

        // A row that never recorded a heartbeat proves nothing about liveness.
        const unheard = row("agent", "thread-a", "https://example.com/", null);
        expect(BrowserLease.decideBrowserRestore(unheard, BOOT_MS)).toEqual({ _tag: "Noop" });
        expect(BrowserLease.isLapsedAgentLease(unheard, BOOT_MS)).toBe(true);

        // The window's own edge still restores, and a live lease is not lapsed.
        const edge = row(
          "agent",
          "thread-a",
          null,
          heartbeat(BrowserLease.RESTART_GRACE_MS / 1000),
        );
        expect(BrowserLease.decideBrowserRestore(edge, BOOT_MS)).toMatchObject({
          _tag: "RestoreAgent",
        });
        expect(BrowserLease.isLapsedAgentLease(row("agent", "thread-a", null), BOOT_MS)).toBe(
          false,
        );
      }),
    );
  });
});
