import type { ServerProvider } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import {
  type ConnectionCatalogEntry,
  type PreparedConnection,
  ConnectionTransientError,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { createPersonalClient, type PersonalClient } from "@hbots/personal-client/client";
import { createPersonalBotsClient } from "@hbots/personal-client/bots/personalBots";
import {
  parseSystemSummary,
  SYSTEM_SUMMARY_TIMEOUT_MS,
  SYSTEM_SUMMARY_URL,
  type SystemSummary,
} from "@hbots/personal-client/computer/systemStats";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { backoffMs } from "../connection";
import { classifyFailure } from "../failure";
import { createNativePorts, type NativeBlob } from "../platform/nativePorts";
import { connectNativeSession, environmentIdOf, type NativeSession } from "./nativeSession";
import type { StoredSession } from "../session";

const connectedState = (generation: number): SupervisorConnectionState => ({
  desired: true,
  network: "online",
  phase: "connected",
  stage: null,
  attempt: 0,
  generation,
  lastFailure: null,
  retryAt: null,
});

const connectingState = (generation: number, attempt: number): SupervisorConnectionState => ({
  desired: true,
  network: "online",
  phase: "connecting",
  stage: "opening",
  attempt,
  generation,
  lastFailure: null,
  retryAt: null,
});

const offlineState = (generation: number, attempt: number): SupervisorConnectionState => ({
  desired: true,
  network: "online",
  phase: "offline",
  stage: null,
  attempt,
  generation,
  lastFailure: new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: "Can't reach your laptop.",
  }),
  retryAt: null,
});

function useRefValue<A>(ref: SubscriptionRef.SubscriptionRef<A>): A {
  const [value, setValue] = useState<A>(() => Effect.runSync(SubscriptionRef.get(ref)));
  useEffect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(SubscriptionRef.changes(ref), (next) => Effect.sync(() => setValue(next))),
    );
    return () => {
      void Effect.runPromise(Fiber.interrupt(fiber));
    };
  }, [ref]);
  return value;
}

export type NativePersonalRuntime = EnvironmentRegistry.EnvironmentRegistry;

export interface NativePersonal {
  readonly environmentId: EnvironmentId;
  readonly runtime: Atom.AtomRuntime<NativePersonalRuntime, never>;
  readonly client: PersonalClient<NativePersonalRuntime, never, NativeBlob>;
  readonly bots: ReturnType<typeof createPersonalBotsClient>;
  readonly useProviders: () => ReadonlyArray<ServerProvider>;
  readonly readSystemSummary: () => Promise<SystemSummary | null>;
  readonly useConnectionState: () => SupervisorConnectionState;
  readonly retry: () => void;
  readonly dispose: () => Promise<void>;
}

export interface NativePersonalOptions {
  readonly onAuthDead?: (cause: unknown) => void;
}

export function createNativePersonal(
  stored: StoredSession,
  appVersion: string,
  options: NativePersonalOptions = {},
): NativePersonal {
  const environmentId = environmentIdOf(stored);
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: stored.label,
    httpBaseUrl: stored.httpBaseUrl,
    wsBaseUrl: stored.wsBaseUrl,
  });
  const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
  const ports = createNativePorts();

  const stateRef = Effect.runSync(
    SubscriptionRef.make<SupervisorConnectionState>(connectingState(0, 0)),
  );
  const sessionRef = Effect.runSync(SubscriptionRef.make(Option.none<NativeSession["session"]>()));
  const preparedRef = Effect.runSync(SubscriptionRef.make(Option.none<PreparedConnection>()));
  const entriesRef = Effect.runSync(
    SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[environmentId, entry]]),
    ),
  );
  const networkRef = Effect.runSync(
    SubscriptionRef.make<"unknown" | "offline" | "online">("online"),
  );
  const providersRef = Effect.runSync(SubscriptionRef.make<ReadonlyArray<ServerProvider>>([]));

  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: stateRef,
    session: sessionRef,
    prepared: preparedRef,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });

  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: entriesRef,
    networkStatus: networkRef,
    start: Effect.void,
    register: () => Effect.succeed(false),
    assertKnownAddress: () => Effect.void,
    reconcilePlatform: () => Effect.void,
    remove: () => Effect.void,
    removeRoute: () => Effect.void,
    reorderRoutes: () => Effect.void,
    removeRelayEnvironments: () => Effect.void,
    retryNow: () => Effect.void,
    setEnabled: () => Effect.void,
    setCompatibility: () => Effect.void,
    state: (requested) =>
      requested === environmentId
        ? SubscriptionRef.get(stateRef)
        : Effect.fail(new EnvironmentNotRegisteredError({ environmentId: requested })),
    stateChanges: (requested) =>
      requested === environmentId
        ? SubscriptionRef.changes(stateRef)
        : Stream.fail(new EnvironmentNotRegisteredError({ environmentId: requested })),
    run: (requested, effect) =>
      requested === environmentId
        ? Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        : Effect.fail(new EnvironmentNotRegisteredError({ environmentId: requested })),
    runStream: ((requested, stream) =>
      requested === environmentId
        ? Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        : Stream.fail(
            new EnvironmentNotRegisteredError({ environmentId: requested }),
          )) as EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"],
    followStream: ((requested, stream) =>
      requested === environmentId
        ? Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        : Stream.fail(
            new EnvironmentNotRegisteredError({ environmentId: requested }),
          )) as EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"],
  });

  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry));

  const host = {
    useActiveEnvironmentId: () => environmentId,
    usePrimaryEnvironmentId: () => environmentId,
  };
  const client = createPersonalClient(runtime, ports, host);
  const bots = createPersonalBotsClient(runtime, client);

  let disposed = false;
  let current: NativeSession | null = null;
  let wakeDisposed: (() => void) | null = null;
  const disposedPromise = new Promise<void>((resolve) => {
    wakeDisposed = resolve;
  });
  const newRetrySignal = () => {
    let wake: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    return { promise, wake };
  };
  let retrySignal = newRetrySignal();

  const generation = { value: 0 };
  const setState = (next: SupervisorConnectionState) => {
    Effect.runSync(SubscriptionRef.set(stateRef, next));
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const loop = async () => {
    let attempt = 0;
    for (;;) {
      if (disposed) return;
      generation.value += 1;
      setState(connectingState(generation.value, attempt));
      try {
        const next = await connectNativeSession(stored, appVersion, (providers) => {
          Effect.runSync(SubscriptionRef.set(providersRef, providers));
        });
        if (disposed) {
          await next.dispose();
          return;
        }
        current = next;
        Effect.runSync(SubscriptionRef.set(sessionRef, Option.some(next.session)));
        Effect.runSync(
          SubscriptionRef.set(
            preparedRef,
            Option.some({
              environmentId,
              label: stored.label,
              httpBaseUrl: stored.httpBaseUrl,
              socketUrl: "",
              httpAuthorization: { _tag: "Bearer" as const, token: stored.accessToken },
              target,
            }),
          ),
        );
        attempt = 0;
        void Effect.runPromise(next.session.initialConfig).then(
          (config) => Effect.runSync(SubscriptionRef.set(providersRef, config.providers)),
          () => undefined,
        );
        setState(connectedState(generation.value));
        await Promise.race([Effect.runPromise(next.closed), disposedPromise, retrySignal.promise]);
      } catch (cause) {
        if (
          !disposed &&
          options.onAuthDead !== undefined &&
          classifyFailure(cause).kind === "authDead"
        ) {
          options.onAuthDead(cause);
        }
      }
      if (disposed) return;
      const ended = current;
      current = null;
      if (ended !== null) {
        Effect.runSync(SubscriptionRef.set(sessionRef, Option.none()));
        await ended.dispose();
      }
      retrySignal = newRetrySignal();
      attempt += 1;
      setState(offlineState(generation.value, attempt));
      await Promise.race([sleep(backoffMs(attempt - 1)), disposedPromise, retrySignal.promise]);
    }
  };

  void loop();

  return {
    environmentId,
    runtime,
    client,
    bots,
    useProviders: () => useRefValue(providersRef),
    readSystemSummary: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SYSTEM_SUMMARY_TIMEOUT_MS);
      try {
        const response = await fetch(new URL(SYSTEM_SUMMARY_URL, stored.httpBaseUrl), {
          method: "GET",
          headers: { Authorization: `Bearer ${stored.accessToken}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return parseSystemSummary(await response.json());
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    useConnectionState: () => {
      const [state, setReactState] = useState<SupervisorConnectionState>(() =>
        Effect.runSync(SubscriptionRef.get(stateRef)),
      );
      useEffect(() => {
        const fiber = Effect.runFork(
          Stream.runForEach(SubscriptionRef.changes(stateRef), (next) =>
            Effect.sync(() => setReactState(next)),
          ),
        );
        return () => {
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
      }, []);
      return state;
    },
    retry: () => {
      if (current !== null) {
        const session = current;
        current = null;
        void session.dispose();
      }
      retrySignal.wake();
    },
    dispose: async () => {
      disposed = true;
      wakeDisposed?.();
      const session = current;
      current = null;
      if (session !== null) {
        await session.dispose();
      }
    },
  };
}
