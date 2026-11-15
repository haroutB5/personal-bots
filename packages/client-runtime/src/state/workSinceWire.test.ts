import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";

import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { makeWsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const ENVIRONMENT_ID = EnvironmentId.make("since-environment");
const SINCE = "2026-11-15T16:12:26.000Z";
const AS_OF = "2026-11-15T16:20:00.000Z";

const target = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Since environment",
  httpBaseUrl: "https://since.example.test",
  wsBaseUrl: "wss://since.example.test",
});

const connected = {
  desired: true,
  network: "online",
  phase: "connected",
  stage: null,
  lastFailure: null,
  retryAt: null,
  attempt: 1,
  generation: 1,
} as unknown as SupervisorConnectionState;

describe("the Work digest query", () => {
  it.effect("sends personalWork.since with the seen marker and reads the answer", () =>
    Effect.gen(function* () {
      const sent: Array<{ readonly tag: string; readonly payload: unknown }> = [];
      const protocol = yield* RpcClient.Protocol.make((writeResponse) =>
        Effect.succeed({
          send: (clientId, request) => {
            if (request._tag !== "Request") return Effect.void;
            sent.push({ tag: request.tag, payload: request.payload });
            return writeResponse(clientId, {
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Success", value: { events: [], omitted: 0, asOf: AS_OF } },
            });
          },
          supportsAck: false,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor,
        }),
      );
      const client = yield* makeWsRpcProtocolClient.pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      const session = { client } as unknown as RpcSession.RpcSession;

      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(connected),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
        _environmentId,
        effect,
      ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        _environmentId,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const registries = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        followStream,
        stateChanges: () => SubscriptionRef.changes(supervisor.state),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registries),
      );

      const workSince = createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "personal-work:since",
        tag: WS_METHODS.personalWorkSince,
      });
      const atom = workSince({ environmentId: ENVIRONMENT_ID, input: { since: SINCE } });

      const registry = AtomRegistry.make();
      const unmount = registry.mount(atom);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unmount();
          registry.dispose();
        }),
      );
      const result = yield* AtomRegistry.getResult(registry, atom, {
        suspendOnWaiting: true,
      }).pipe(Effect.exit);

      if (result._tag === "Failure") {
        throw new Error(`personalWork.since did not succeed: ${Cause.pretty(result.cause)}`);
      }
      expect(sent).toEqual([{ tag: WS_METHODS.personalWorkSince, payload: { since: SINCE } }]);
      const value = registry.get(atom);
      expect(AsyncResult.isSuccess(value) && DateTime.formatIso(value.value.asOf)).toBe(AS_OF);
    }),
  );
});
