import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { nextUsageResetAt, usageResetSinceReading } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderHost from "./ProviderHost.ts";
import { probeBackoffInterval, usageAwareWait } from "./probeBackoff.ts";
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
  seedUsageLimits,
} from "./usageLimits.ts";
import type { ManagedServerProvider } from "./snapshot.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ManagedServerProvider["resolveMaintenance"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly checkUsageLimits?: Effect.Effect<ServerProvider["usageLimits"]>;
  readonly invalidateUsageCache?: Effect.Effect<void>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean | ((snapshot: ServerProvider) => boolean);
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ManagedServerProvider,
  ServerSettingsError,
  Scope.Scope | ProviderHost.ProviderHost
> {
  const host = yield* ProviderHost.ProviderHost;
  const refreshSemaphore = yield* Semaphore.make(1);
  const usageRefreshQueued = yield* Ref.make<symbol | null>(null);
  const probeFailureStreak = yield* Ref.make(0);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment must not revert usage updates newer than its input snapshot.
      const merged = withUsageLimits(nextSnapshot, state.snapshot.usageLimits);
      if (Equal.equals(state.snapshot, merged)) {
        return [null, state] as const;
      }
      return [merged, { ...state, snapshot: merged }] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot || !snapshot.enabled) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      const state = yield* Ref.get(snapshotStateRef);
      const nextGeneration = state.enrichmentGeneration + 1;
      yield* Ref.set(snapshotStateRef, {
        ...state,
        enrichmentGeneration: nextGeneration,
      });
      yield* Ref.set(settingsRef, nextSettings);
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, nextGeneration);
      return state.snapshot;
    }

    const probedSnapshot = yield* input.checkProvider.pipe(
      Effect.tap(() => Ref.set(probeFailureStreak, 0)),
      Effect.tapError(() => Ref.update(probeFailureStreak, (streak) => streak + 1)),
    );
    const { snapshot: nextSnapshot, generation: nextGeneration } = yield* Ref.modify(
      snapshotStateRef,
      (state) => {
        const generation = input.enrichSnapshot
          ? state.enrichmentGeneration + 1
          : state.enrichmentGeneration;
        // Failed reads retain limits only for the same account and original workspace.
        const previous = state.snapshot.auth;
        const differs = (a: string | undefined, b: string | undefined) =>
          a !== undefined && b !== undefined && a !== b;
        const switchedAccount =
          differs(probedSnapshot.auth.email?.toLowerCase(), previous.email?.toLowerCase()) ||
          (probedSnapshot.auth.workspaceId !== undefined &&
            probedSnapshot.auth.workspaceId !== previous.workspaceId);
        const accountUnverified =
          probedSnapshot.auth.status === "unknown" && previous.status !== "unknown";
        const usageLimits =
          switchedAccount || accountUnverified
            ? probedSnapshot.usageLimits
            : resolveUsageLimitsAfterProbe({
                published: state.snapshot.usageLimits,
                probed: probedSnapshot.usageLimits,
                context: {
                  checkedAt: probedSnapshot.checkedAt,
                  message: probedSnapshot.message,
                  enabled: probedSnapshot.enabled,
                  installed: probedSnapshot.installed,
                },
              });
        const workspaceId =
          usageLimits === probedSnapshot.usageLimits ? undefined : state.snapshot.auth.workspaceId;
        const snapshot = withUsageLimits(
          workspaceId && !probedSnapshot.auth.workspaceId
            ? { ...probedSnapshot, auth: { ...probedSnapshot.auth, workspaceId } }
            : probedSnapshot,
          usageLimits,
        );
        return [
          { snapshot, generation },
          { snapshot, enrichmentGeneration: generation },
        ] as const;
      },
    );
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  // Providers call this on every token-usage tick, usually without changing the snapshot.
  const applyUsageLimits: ManagedServerProvider["applyUsageLimits"] = Effect.fnUntraced(
    function* (update) {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const usageLimits = applyUsageLimitsUpdate({
          previous: state.snapshot.usageLimits,
          update,
          checkedAt: update.checkedAt,
        });
        if (usageLimits === state.snapshot.usageLimits) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(state.snapshot, usageLimits);
        return [snapshot, { ...state, snapshot }] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }
    },
  );

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const refreshUsage = Effect.fn("ManagedServerProvider.refreshUsage")(function* () {
    const { snapshot } = yield* Ref.get(snapshotStateRef);
    if (
      !snapshot.enabled ||
      !snapshot.usageLimits ||
      snapshot.usageLimits.unavailable?.reason === "unsupported"
    )
      return;
    // An in-flight refresh may have read cached usage, so one refresh waits behind it.
    const claim = Symbol();
    const release = Ref.update(usageRefreshQueued, (queued) => (queued === claim ? null : queued));
    yield* Effect.uninterruptibleMask((restore) =>
      Ref.modify(usageRefreshQueued, (queued) => [queued !== null, queued ?? claim]).pipe(
        Effect.flatMap((held) =>
          held
            ? Effect.void
            : restore(
                refreshSemaphore.withPermits(1)(
                  release.pipe(
                    Effect.andThen(input.invalidateUsageCache ?? Effect.void),
                    Effect.andThen(input.getSettings),
                    Effect.flatMap((settings) =>
                      applySnapshotBase(settings, { forceRefresh: true }),
                    ),
                  ),
                ),
              ).pipe(Effect.onInterrupt(() => release)),
        ),
      ),
    );
  });

  const needsUsageRecovery = (snapshot: ServerProvider) =>
    input.checkUsageLimits !== undefined &&
    snapshot.installed &&
    snapshot.status === "ready" &&
    snapshot.auth.status === "authenticated" &&
    snapshot.usageLimits?.unavailable?.reason === "probeFailed";

  const needsProviderRefresh = (snapshot: ServerProvider) =>
    input.refreshOnInterval !== false &&
    (typeof input.refreshOnInterval !== "function" || input.refreshOnInterval(snapshot));

  const refreshOnInterval = Effect.fn("ManagedServerProvider.refreshOnInterval")(function* () {
    const { snapshot } = yield* Ref.get(snapshotStateRef);
    if (!snapshot.enabled) return;
    if (!needsUsageRecovery(snapshot) || !input.checkUsageLimits) {
      if (needsProviderRefresh(snapshot)) {
        yield* applySnapshotBase(yield* input.getSettings, { forceRefresh: true });
      }
      return;
    }
    const probed = yield* input.checkUsageLimits.pipe(
      Effect.tap(() => Ref.set(probeFailureStreak, 0)),
      Effect.tapError(() => Ref.update(probeFailureStreak, (streak) => streak + 1)),
    );
    const next = yield* Ref.modify(snapshotStateRef, (state) => {
      const usageLimits = resolveUsageLimitsAfterProbe({
        published: state.snapshot.usageLimits,
        probed,
      });
      const snapshot = withUsageLimits(state.snapshot, usageLimits);
      return [snapshot, { ...state, snapshot }] as const;
    });
    yield* PubSub.publish(changesPubSub, next);
  });

  const shouldRefreshOnInterval = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    // A disabled instance has nothing to probe; a periodic check would only
    // republish a snapshot that differs in checkedAt.
    if (
      !state.snapshot.enabled ||
      (!needsUsageRecovery(state.snapshot) && !needsProviderRefresh(state.snapshot))
    ) {
      return false;
    }
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      host.shouldRunBackgroundWork({ type: "provider-status" }),
      host.shouldRunBackgroundWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : host.settings.get.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* host.settings.subscribe;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  // A reading that moves a usage reset changes when the loop should wake, so
  // the loop re-plans its sleep without probing when the reset time changes.
  const plannedResetRef = yield* Ref.make<number | null>(null);
  const resetSubscription = yield* PubSub.subscribe(changesPubSub);
  yield* Stream.fromSubscription(resetSubscription).pipe(
    Stream.runForEach((snapshot) =>
      Effect.gen(function* () {
        const next = nextUsageResetAt(snapshot.usageLimits, yield* Clock.currentTimeMillis);
        if (next === (yield* Ref.get(plannedResetRef))) return;
        yield* Ref.set(plannedResetRef, next);
        yield* Queue.offer(refreshIntervalChanges, undefined);
      }),
    ),
    Effect.forkScoped,
  );

  // A failed check must not end this subscription: the next settings change
  // retries, like the periodic and initial checks below.
  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    getRefreshInterval.pipe(
      Effect.flatMap((configured) =>
        Effect.gen(function* () {
          // Read per iteration so a settings change and the current failure
          // streak both take effect on the very next wait.
          const refreshInterval = probeBackoffInterval(
            configured,
            yield* Ref.get(probeFailureStreak),
          );
          const enabled = Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0;
          const planned = (yield* Ref.get(snapshotStateRef)).snapshot;
          yield* Ref.set(
            plannedResetRef,
            nextUsageResetAt(planned.usageLimits, yield* Clock.currentTimeMillis),
          );
          const wait = usageAwareWait(
            enabled ? refreshInterval : Duration.seconds(60),
            planned.usageLimits,
            yield* Clock.currentTimeMillis,
          );
          // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races the interval against a settings-change signal, not a timeout
          const intervalElapsed = yield* Effect.raceFirst(
            Effect.sleep(wait).pipe(Effect.as(true)),
            Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
          );
          if (!enabled || !intervalElapsed) return;
          // A reading older than a reset is wrong for everyone who opens the
          // app next, so it is read again even without a viewer.
          const resetSinceReading = usageResetSinceReading(
            (yield* Ref.get(snapshotStateRef)).snapshot.usageLimits,
            yield* Clock.currentTimeMillis,
          );
          if (resetSinceReading || (yield* shouldRefreshOnInterval)) {
            yield* refreshSemaphore.withPermits(1)(refreshOnInterval());
          }
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  const applyUsageLimitsSeed: NonNullable<ManagedServerProvider["seedUsageLimits"]> = Effect.fn(
    "ManagedServerProvider.seedUsageLimits",
  )(function* (seed) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      const usageLimits = seedUsageLimits({ published: state.snapshot.usageLimits, seed });
      if (usageLimits === state.snapshot.usageLimits) {
        return [null, state] as const;
      }
      const snapshot = withUsageLimits(state.snapshot, usageLimits);
      return [snapshot, { ...state, snapshot }] as const;
    });
    if (snapshotToPublish !== null) {
      yield* PubSub.publish(changesPubSub, snapshotToPublish);
    }
  });

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: input
      .resolveMaintenance({ fresh: true })
      .pipe(Effect.andThen(refreshSnapshot), Effect.tapError(Effect.logError), Effect.orDie),
    // The settings card's manual Refresh is the same uncached lookup.
    get refreshLatest() {
      return input
        .resolveMaintenance({ fresh: true })
        .pipe(Effect.andThen(refreshSnapshot), Effect.tapError(Effect.logError), Effect.orDie);
    },
    applyUsageLimits,
    seedUsageLimits: applyUsageLimitsSeed,
    refreshUsage: refreshUsage(),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ManagedServerProvider;
});
