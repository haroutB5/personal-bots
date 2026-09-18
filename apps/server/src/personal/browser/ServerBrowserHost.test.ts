/**
 * The server browser is registered with the preview broker once per connection.
 * A request the host never answers makes the broker time out and shut the
 * connection's queue down, which ends the host's request stream: without a
 * reconnect loop, one slow operation removes the browser from every bot until
 * the server process restarts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { PersonalBrowser } from "./PersonalBrowser.ts";
import * as ServerBrowserHost from "./ServerBrowserHost.ts";

const environmentId = EnvironmentId.make("environment-test");

const descriptor = {
  environmentId,
  label: "Test environment",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

const scope = {
  environmentId,
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

/** Counts every registration attempt the host makes against the real broker. */
const countingBrokerLayer = (connects: { count: number }) =>
  Layer.effect(
    PreviewAutomationBroker.PreviewAutomationBroker,
    Effect.map(PreviewAutomationBroker.make, (broker) =>
      PreviewAutomationBroker.PreviewAutomationBroker.of({
        ...broker,
        connect: (host: PreviewAutomationHost) =>
          Effect.suspend(() => {
            connects.count += 1;
            return broker.connect(host);
          }),
      }),
    ),
  ).pipe(Layer.provide(NodeServices.layer));

const hostLayer = (
  handle: (request: PreviewAutomationRequest) => Effect.Effect<unknown>,
  connects: { count: number },
) =>
  ServerBrowserHost.layer.pipe(
    Layer.provide(Layer.mock(PersonalBrowser)({ handleAutomationRequest: handle })),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
    Layer.provideMerge(countingBrokerLayer(connects)),
  );

type BrowserStatus = { readonly available: boolean };

type Broker = PreviewAutomationBroker.PreviewAutomationBroker["Service"];

/**
 * The host registers on a forked fiber, and after a disconnect it registers
 * again behind a backoff sleep, so readiness is polled on the test clock.
 */
const awaitHostReady = (broker: Broker) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 200; turn++) {
      const exit = yield* Effect.exit(
        broker.invoke<BrowserStatus>({
          scope,
          operation: "status",
          input: {},
        }),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
    }
    return yield* Effect.die(new Error("The server browser never re-registered with the broker."));
  });

it.effect("re-registers after an unanswered request disconnects it from the broker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const connects = { count: 0 };
      const stall = yield* Deferred.make<void>();
      const openReceived = yield* Deferred.make<void>();
      const context = yield* Layer.build(
        hostLayer(
          (request) =>
            request.operation === "open"
              ? Deferred.succeed(openReceived, undefined).pipe(
                  Effect.andThen(Deferred.await(stall)),
                  Effect.as({ available: true }),
                )
              : Effect.succeed({ available: true }),
          connects,
        ),
      );
      const broker = yield* Effect.service(PreviewAutomationBroker.PreviewAutomationBroker).pipe(
        Effect.provide(context),
      );

      expect(yield* awaitHostReady(broker)).toMatchObject({ available: true });
      expect(connects.count).toBe(1);

      // The live failure: Chrome took longer than the preview timeout to start.
      const timedOut = yield* broker
        .invoke<BrowserStatus>({ scope, operation: "open", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(openReceived);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Fiber.join(timedOut)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });

      // Before the fix every later call failed with NoAvailableHost until the
      // whole server was restarted.
      expect(yield* awaitHostReady(broker)).toMatchObject({ available: true });
      expect(connects.count).toBe(2);
    }),
  ),
);

it.effect("stops reconnecting once the layer scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const connects = { count: 0 };
      const stall = yield* Deferred.make<void>();
      const openReceived = yield* Deferred.make<void>();
      const layerScope = yield* Scope.make();
      const context = yield* Layer.build(
        hostLayer(
          (request) =>
            request.operation === "open"
              ? Deferred.succeed(openReceived, undefined).pipe(
                  Effect.andThen(Deferred.await(stall)),
                  Effect.as({ available: true }),
                )
              : Effect.succeed({ available: true }),
          connects,
        ),
      ).pipe(Scope.provide(layerScope));
      const broker = yield* Effect.service(PreviewAutomationBroker.PreviewAutomationBroker).pipe(
        Effect.provide(context),
      );

      yield* awaitHostReady(broker);
      const timedOut = yield* broker
        .invoke<BrowserStatus>({ scope, operation: "open", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(openReceived);
      // Leaves the host inside its reconnect backoff, the moment a leaked fiber
      // would survive shutdown.
      yield* TestClock.adjust("15 seconds");
      yield* Fiber.join(timedOut);
      const afterDisconnect = connects.count;

      yield* Scope.close(layerScope, Exit.void);
      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 minute");

      expect(connects.count).toBe(afterDisconnect);
      expect(
        yield* broker
          .invoke<BrowserStatus>({ scope, operation: "status", input: {} })
          .pipe(Effect.flip),
      ).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
    }),
  ),
);
