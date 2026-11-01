import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { type PersonalBotsListResult, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { make as makeManagedRuntime } from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export interface PersonalRpc {
  readonly listBots: () => Promise<{
    readonly result: PersonalBotsListResult;
    readonly ms: number;
  }>;
  readonly dispose: () => Promise<void>;
}

export async function connectPersonalRpc(socketUrl: string): Promise<PersonalRpc> {
  const scope = await Effect.runPromise(Scope.make());
  const socketLayer = Socket.layerWebSocket(socketUrl, {
    openTimeout: "15 seconds",
  }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
    Layer.provideMerge(Layer.succeed(Scope.Scope, scope)),
  );

  const runtime = makeManagedRuntime(protocolLayer);
  const client: WsRpcProtocolClient = await runtime.runPromise(makeWsRpcProtocolClient);

  return {
    listBots: async () => {
      const startedAt = Date.now();
      const result = await runtime.runPromise(client[WS_METHODS.personalBotsList]({}));
      return { result, ms: Date.now() - startedAt };
    },
    dispose: async () => {
      await runtime.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
