import type { ServerProvider } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { Persistence } from "@t3tools/client-runtime/platform";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import * as ExpoCrypto from "expo-crypto";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { KnownSessionGrants } from "@t3tools/client-runtime/state/runtime";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import { createEnvironmentShellAtoms } from "@t3tools/client-runtime/state/shell";
import { createPersonalClient, type PersonalClient } from "@hbots/personal-client/client";
import { deleteOutboxBlobs } from "@hbots/personal-client/composer/outboxBlobs";
import { createPersonalAutomationClient } from "@hbots/personal-client/automation/automationClient";
import { createPersonalBotsClient } from "@hbots/personal-client/bots/personalBots";
import { createPersonalGroupsClient } from "@hbots/personal-client/groups/personalGroups";
import { createPersonalMemoryClient } from "@hbots/personal-client/memory/personalMemory";
import { createPersonalLoginsClient } from "@hbots/personal-client/logins/personalLogins";
import { createPersonalSecretsClient } from "@hbots/personal-client/secrets/personalSecrets";
import { createPersonalConnectionsClient } from "@hbots/personal-client/connections/personalConnections";
import { createPersonalSettingsClient } from "@hbots/personal-client/settings/personalSettings";
import { createProviderSetupClient } from "@hbots/personal-client/settings/providerSetup";
import { createPersonalComputerClient } from "@hbots/personal-client/computer/personalComputer";
import { createVoiceCallApi } from "@hbots/personal-client/conversation/voice/voiceCallApi";
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

import { authorizedFetch } from "../authorizedRequest";
import { wipeOutgoingThread } from "../chat/composerSendModel";
import { liveViewURLs, type LiveViewURLs } from "../computer/liveViewAccess";
import { backoffMs } from "../connection";
import { classifyFailure } from "../failure";
import { createNativePorts, type NativeBlob } from "../platform/nativePorts";
import { createNativeEnvironmentCache } from "./nativeCache";
import { connectWithDeadline } from "./connectDeadline";
import { threadSnapshotLoader } from "./threadSnapshotLoader";
import { phoneHasInternet, resetNetworkClient } from "./networkReset";
import { shouldResetNetworkClient } from "./reconnectPolicy";
import { connectNativeSession, environmentIdOf, type NativeSession } from "./nativeSession";
import type { StoredSession } from "../session";
import { canManageDevices, grantedScopes } from "../sessionScopes";
import { authMethodOf } from "../sessionAuth";

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

const offlineState = (
  generation: number,
  attempt: number,
  detail = "Can't reach your laptop.",
): SupervisorConnectionState => ({
  desired: true,
  network: "online",
  phase: "offline",
  stage: null,
  attempt,
  generation,
  lastFailure: new ConnectionTransientError({
    reason: "remote-unavailable",
    detail,
  }),
  retryAt: null,
});

/**
 * The shell snapshot is large and changes with every streamed message, so it
 * is not written to SecureStore. A1's cold paint comes from the capped chats
 * snapshot; activity lands with the socket a moment later. Threads settle into
 * `nativeCache.ts`, which is what makes a chat reopen paint at once.
 */
function makeShellCache(onThreadRemoved?: (environmentId: string, threadId: string) => void) {
  return createNativeEnvironmentCache(onThreadRemoved);
}

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

export type NativePersonalRuntime =
  | EnvironmentRegistry.EnvironmentRegistry
  | Persistence.EnvironmentCacheStore
  | ShellSnapshotLoader.ShellSnapshotLoader
  | ThreadSnapshotLoader
  | KnownSessionGrants
  | SecureRandom.SecureRandom;

export interface NativePersonal {
  readonly environmentId: EnvironmentId;
  /** The label this phone gave at pairing; Settings > This phone shows it. */
  readonly deviceLabel: string;
  /** Both access scopes were granted, so Settings > Devices can list and revoke. */
  readonly canManageDevices: boolean;
  readonly httpBaseUrl: string;
  readonly runtime: Atom.AtomRuntime<NativePersonalRuntime, never>;
  readonly client: PersonalClient<NativePersonalRuntime, never, NativeBlob>;
  readonly bots: ReturnType<typeof createPersonalBotsClient>;
  readonly automation: ReturnType<typeof createPersonalAutomationClient>;
  readonly groups: ReturnType<typeof createPersonalGroupsClient>;
  readonly settings: ReturnType<typeof createPersonalSettingsClient>;
  readonly providers: ReturnType<typeof createProviderSetupClient>;
  readonly memory: ReturnType<typeof createPersonalMemoryClient>;
  readonly logins: ReturnType<typeof createPersonalLoginsClient>;
  readonly secrets: ReturnType<typeof createPersonalSecretsClient>;
  readonly connections: ReturnType<typeof createPersonalConnectionsClient>;
  readonly computer: ReturnType<typeof createPersonalComputerClient>;
  readonly voice: ReturnType<typeof createVoiceCallApi>;
  readonly shell: ReturnType<typeof createEnvironmentShellAtoms>;
  readonly useProviders: () => ReadonlyArray<ServerProvider>;
  readonly readSystemSummary: () => Promise<SystemSummary | null>;
  /** Freshly ticketed browser and desktop live-view sockets. */
  readonly liveViews: () => Promise<LiveViewURLs>;
  readonly useConnectionState: () => SupervisorConnectionState;
  /**
   * The connection as it is right now, read from the session loop itself. A
   * send that fails must ask this, not the last render's phase, or a socket
   * that has already gone still looks connected for a frame.
   */
  readonly readConnection: () => { readonly connected: boolean; readonly generation: number };
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

  const cache = makeShellCache((environmentId, threadId) => {
    for (const messageId of wipeOutgoingThread(ports.kv, environmentId, threadId)) {
      void deleteOutboxBlobs(messageId);
    }
  });
  const loader = threadSnapshotLoader(stored);

  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
      Layer.succeed(ShellSnapshotLoader.ShellSnapshotLoader, {
        load: () => Effect.succeed(Option.none()),
      }),
      Layer.succeed(ThreadSnapshotLoader, loader),
      Layer.succeed(KnownSessionGrants, {
        authenticated: true,
        scopes: grantedScopes(stored.scope),
      }),
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => ExpoCrypto.getRandomBytes(size)),
      ),
    ),
  );

  const host = {
    useActiveEnvironmentId: () => environmentId,
    usePrimaryEnvironmentId: () => environmentId,
  };
  const client = createPersonalClient(runtime, ports, host);
  const bots = createPersonalBotsClient(runtime, client);
  const automation = createPersonalAutomationClient(runtime);
  const groups = createPersonalGroupsClient(runtime, client, {
    refreshBots: (registry, environmentId) => {
      registry.refresh(
        bots.personalBotsList({ environmentId, input: bots.personalBotsListInput() }),
      );
    },
  });
  const settings = createPersonalSettingsClient(runtime, client);
  const providers = createProviderSetupClient(runtime, client);
  const memory = createPersonalMemoryClient(runtime, client);
  const logins = createPersonalLoginsClient(runtime, client);
  const secrets = createPersonalSecretsClient(runtime, client);
  const connections = createPersonalConnectionsClient(runtime, client);
  const computer = createPersonalComputerClient(runtime, client);
  const voice = createVoiceCallApi(runtime);
  const shell = createEnvironmentShellAtoms(runtime);

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
  /**
   * Retry pacing is there so a laptop that is off does not get hammered. A
   * network that comes back is a new fact, so the pending wait is void, and
   * the next attempt starts at once. The flag carries a wake that arrived
   * while an attempt was in flight, when nothing was listening yet.
   */
  let retryImmediately = false;
  const wakeRetry = () => {
    retryImmediately = true;
    retrySignal.wake();
  };
  let unstable = 0;
  /**
   * The phone's own network coming back is the one fact the retry loop cannot
   * see, so a light watcher wakes it at once instead of waiting out the
   * backoff. It only ever wakes the loop: recovery happens in place, with no
   * app restart, because a restart loses the open chat for no gain.
   */
  let networkTimer: ReturnType<typeof setInterval> | null = null;
  const stopNetworkWatch = () => {
    if (networkTimer === null) return;
    clearInterval(networkTimer);
    networkTimer = null;
  };
  const startNetworkWatch = () => {
    if (networkTimer !== null || disposed) return;
    let checking = false;
    let wasOnline = true;
    networkTimer = setInterval(() => {
      if (disposed || checking || current !== null) return;
      checking = true;
      void phoneHasInternet().then((online) => {
        checking = false;
        if (disposed || current !== null) return;
        if (!online) {
          wasOnline = false;
          return;
        }
        if (!wasOnline) {
          wasOnline = true;
          wakeRetry();
        }
      });
    }, 1_000);
  };

  const generation = { value: 0 };
  let socketAlive = false;
  const setState = (next: SupervisorConnectionState) => {
    Effect.runSync(SubscriptionRef.set(stateRef, next));
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const loop = async () => {
    let attempt = 0;
    let lastDetail = "Can't reach your laptop.";
    for (;;) {
      if (disposed) return;
      try {
        generation.value += 1;
        setState(connectingState(generation.value, attempt));
        const next = await connectWithDeadline((signal) =>
          connectNativeSession(
            stored,
            appVersion,
            (providers) => {
              Effect.runSync(SubscriptionRef.set(providersRef, providers));
            },
            signal,
          ),
        );
        if (disposed) {
          socketAlive = false;
          await next.dispose();
          return;
        }
        const connectedAt = Date.now();
        current = next;
        socketAlive = true;
        Effect.runSync(SubscriptionRef.set(sessionRef, Option.some(next.session)));
        Effect.runSync(
          SubscriptionRef.set(
            preparedRef,
            Option.some({
              environmentId,
              label: stored.label,
              httpBaseUrl: stored.httpBaseUrl,
              socketUrl: "",
              httpAuthorization:
                authMethodOf(stored) === "dpop"
                  ? {
                      _tag: "Dpop" as const,
                      accessToken: stored.accessToken,
                      expiresAtEpochMs: stored.expiresAt,
                    }
                  : { _tag: "Bearer" as const, token: stored.accessToken },
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
        let stopWatchdog: () => void = () => undefined;
        const liveness = new Promise<void>((resolve) => {
          let stopped = false;
          let timer: ReturnType<typeof setTimeout>;
          const tick = async () => {
            if (stopped || disposed) return;
            try {
              await Promise.race([
                Effect.runPromise(next.session.probe),
                sleep(4_000).then(() => {
                  throw new Error("probe timeout");
                }),
              ]);
            } catch {
              resolve();
              return;
            }
            if (!stopped) {
              timer = setTimeout(tick, 5_000);
            }
          };
          timer = setTimeout(tick, 4_000);
          stopWatchdog = () => {
            stopped = true;
            clearTimeout(timer);
          };
        });
        await Promise.race([
          Effect.runPromise(next.closed),
          disposedPromise,
          retrySignal.promise,
          liveness,
        ]);
        socketAlive = false;
        stopWatchdog();
        // A session that drops within ten seconds is part of the same outage.
        if (Date.now() - connectedAt >= 10_000) {
          unstable = 0;
        } else {
          unstable += 1;
          startNetworkWatch();
        }
      } catch (cause) {
        socketAlive = false;
        unstable += 1;
        lastDetail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        startNetworkWatch();
        if (
          !disposed &&
          options.onAuthDead !== undefined &&
          classifyFailure(cause).kind === "authDead"
        ) {
          options.onAuthDead(cause);
        }
      }
      try {
        if (shouldResetNetworkClient(unstable)) await resetNetworkClient();
        if (disposed) return;
        const ended = current;
        current = null;
        if (ended !== null) {
          Effect.runSync(SubscriptionRef.set(sessionRef, Option.none()));
          await Promise.race([ended.dispose(), sleep(3_000)]);
        }
        retrySignal = newRetrySignal();
        attempt += 1;
        setState(offlineState(generation.value, attempt, lastDetail));
        const waitMs = retryImmediately ? 0 : backoffMs(attempt - 1);
        retryImmediately = false;
        await Promise.race([sleep(waitMs), disposedPromise, retrySignal.promise]);
      } catch (cause) {
        // The loop's whole job is to keep trying, so one failed iteration is
        // followed by another. Tearing down a dead socket can throw, and that
        // must not leave the app offline with nothing left to reconnect it.
        console.error("[hbots] reconnect iteration failed", cause);
        await Promise.race([sleep(1_000), disposedPromise]);
      }
    }
  };

  startNetworkWatch();
  void loop();

  return {
    environmentId,
    deviceLabel: stored.deviceLabel ?? stored.label,
    canManageDevices: canManageDevices(stored.scope),
    httpBaseUrl: stored.httpBaseUrl,
    runtime,
    client,
    bots,
    automation,
    groups,
    settings,
    providers,
    memory,
    logins,
    secrets,
    connections,
    computer,
    voice,
    shell,
    useProviders: () => useRefValue(providersRef),
    readSystemSummary: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SYSTEM_SUMMARY_TIMEOUT_MS);
      try {
        const response = await authorizedFetch(
          stored,
          new URL(SYSTEM_SUMMARY_URL, stored.httpBaseUrl),
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) return null;
        return parseSystemSummary(await response.json());
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    liveViews: () => liveViewURLs(stored),
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
    readConnection: () => ({ connected: socketAlive, generation: generation.value }),
    retry: () => {
      if (current !== null) {
        const session = current;
        current = null;
        void session.dispose();
      }
      wakeRetry();
    },
    dispose: async () => {
      disposed = true;
      stopNetworkWatch();
      wakeDisposed?.();
      const session = current;
      current = null;
      if (session !== null) {
        await session.dispose();
      }
    },
  };
}
