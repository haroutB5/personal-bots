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
import { RpcClientError } from "effect/rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { ConnectionTransientError } from "@t3tools/client-runtime/connection";

import { SESSION_REVOKED_CLOSE_CODE } from "../failure";
import { openSocketUrl } from "../pairing";
import type { StoredSession } from "../session";

export interface NativeSession {
  readonly session: RpcSession;
  readonly closed: Effect.Effect<never, ConnectionTransientError | RpcClientError.RpcClientError>;
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
  signal?: AbortSignal,
): Promise<NativeSession> {
  const socketUrl = await openSocketUrl(stored, appVersion, signal);
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
  const observed: { close: { readonly code: number; readonly reason: string } | null } = {
    close: null,
  };
  const observedConstructor = Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const make = yield* Socket.WebSocketConstructor;
      return (url, options) => {
        const socket = make(url, options);
        socket.addEventListener("close", (event) => {
          observed.close = { code: event.code ?? 1006, reason: event.reason ?? "" };
        });
        return socket;
      };
    }),
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const socketLayer = Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" }).pipe(
    Layer.provide(observedConstructor),
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
  let client: WsRpcProtocolClient;
  try {
    client = await new Promise<WsRpcProtocolClient>((resolve, reject) => {
      const abort = () => reject(new Error("The connection attempt was aborted."));
      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort);
      runtime.runPromise(RpcClient.make(WsRpcGroup)).then(
        (next) => {
          signal?.removeEventListener("abort", abort);
          resolve(next);
        },
        (cause: unknown) => {
          signal?.removeEventListener("abort", abort);
          reject(cause);
        },
      );
    });
  } catch (cause) {
    await runtime.dispose().catch(() => undefined);
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    throw cause;
  }

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
    closed: Deferred.await(disconnected).pipe(
      Effect.mapError((transient): ConnectionTransientError | RpcClientError.RpcClientError =>
        observed.close?.code === SESSION_REVOKED_CLOSE_CODE
          ? new RpcClientError.RpcClientError({
              reason: new Socket.SocketCloseError({
                code: observed.close.code,
                closeReason: observed.close.reason,
              }),
            })
          : transient,
      ),
    ),
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
