import { EnvironmentId, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { make as makeManagedRuntime } from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { ConnectionTransientError } from "@t3tools/client-runtime/connection";

import { openSocketUrl } from "../pairing";
import type { StoredSession } from "../session";

export interface NativeSession {
  readonly session: RpcSession;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
  readonly dispose: () => Promise<void>;
}

/**
 * One authenticated WebSocket session. The socket URL is minted per attempt,
 * so a reconnect always carries a fresh wsTicket.
 */
export async function connectNativeSession(
  stored: StoredSession,
  appVersion: string,
  onProviders?: (providers: ReadonlyArray<ServerProvider>) => void,
): Promise<NativeSession> {
  const socketUrl = await openSocketUrl(stored, appVersion);
  const disconnected = await Effect.runPromise(Deferred.make<never, ConnectionTransientError>());
  const hooks = RpcClient.ConnectionHooks.of({
    onConnect: Effect.void,
    onDisconnect: Deferred.fail(
      disconnected,
      new ConnectionTransientError({
        reason: "transport",
        detail: `${stored.label} disconnected.`,
      }),
    ).pipe(Effect.asVoid),
  });
  const scope = await Effect.runPromise(Scope.make());
  const socketLayer = Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        socketLayer,
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks, hooks),
      ),
    ),
    Layer.provideMerge(Layer.succeed(Scope.Scope, scope)),
  );
  const runtime = makeManagedRuntime(protocolLayer);
  const client: WsRpcProtocolClient = await runtime.runPromise(RpcClient.make(WsRpcGroup));

  const configFiber =
    onProviders === undefined
      ? null
      : runtime.runFork(
          client[WS_METHODS.subscribeServerConfig]({
            usageLimitsCommand: true,
            usageLimitSources: true,
            workspaceSnapshotsOnDemand: true,
          }).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "snapshot") onProviders(event.config.providers);
                else if (event.type === "providerStatuses") onProviders(event.payload.providers);
              }),
            ),
            Effect.catchEager(() => Effect.void),
          ),
        );

  const session: RpcSession = {
    client,
    initialConfig: client[WS_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(
        (cause) =>
          new ConnectionTransientError({ reason: "remote-unavailable", detail: String(cause) }),
      ),
    ),
    subscribeServerConfig: (input) => client[WS_METHODS.subscribeServerConfig](input ?? {}),
    ready: Effect.void,
    probe: client[WS_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(
        (cause) =>
          new ConnectionTransientError({ reason: "remote-unavailable", detail: String(cause) }),
      ),
      Effect.asVoid,
    ),
    inboundFrames: Effect.succeed(0),
    closed: Deferred.await(disconnected),
  };

  return {
    session,
    closed: Deferred.await(disconnected),
    dispose: async () => {
      if (configFiber !== null) await Effect.runPromise(Fiber.interrupt(configFiber));
      await runtime.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

export function environmentIdOf(stored: StoredSession): EnvironmentId {
  return EnvironmentId.make(stored.environmentId);
}
