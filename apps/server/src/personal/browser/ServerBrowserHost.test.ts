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
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
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
import { performSelect } from "./pageOperations.ts";
import { PersonalBrowser } from "./PersonalBrowser.ts";
import * as ServerBrowserHost from "./ServerBrowserHost.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { mcpThreadScope } from "../../personal/testing/mcpThreadScope.ts";

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(7));

const environmentId = EnvironmentId.make("environment-test");

const descriptor = {
  environmentId,
  label: "Test environment",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

const scope = mcpThreadScope({
  environmentId,
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});

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
    Layer.provideMerge(Layer.succeed(SecureRandom.SecureRandom, testCrypto)),
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

it.effect(
  "answers a stalled operation itself, before the broker gives up, and stays registered",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connects = { count: 0 };
        const clickReceived = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          hostLayer(
            (request) =>
              request.operation === "click"
                ? Deferred.succeed(clickReceived, undefined).pipe(
                    // A page parked in a dialog or a runaway script: never answers.
                    Effect.andThen(Effect.never),
                  )
                : Effect.succeed({ available: true }),
            connects,
          ),
        );
        const broker = yield* Effect.service(PreviewAutomationBroker.PreviewAutomationBroker).pipe(
          Effect.provide(context),
        );
        yield* awaitHostReady(broker);

        const click = yield* broker
          .invoke<BrowserStatus>({ scope, operation: "click", input: { locator: "#b" } })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(clickReceived);
        yield* TestClock.adjust(15_000 - ServerBrowserHost.BROKER_DEADLINE_MARGIN_MS);
        const error = yield* Fiber.join(click);
        expect(error).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
        // The host's own words are what the bot reads.
        expect(error.message).toContain("still available");

        // No eviction, no reconnect gap: the very next call is served at once.
        const status = yield* broker.invoke<BrowserStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(status).toMatchObject({ available: true });
        expect(connects.count).toBe(1);
      }),
    ),
);

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
                  // Uninterruptible: a host so wedged it cannot even answer
                  // with its own timeout, which is what the broker evicts.
                  Effect.andThen(Effect.uninterruptible(Deferred.await(stall))),
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
      yield* TestClock.adjust("16 seconds");
      expect(yield* Fiber.join(timedOut)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });

      // Before the fix every later call failed with NoAvailableHost until the
      // whole server was restarted.
      expect(yield* awaitHostReady(broker)).toMatchObject({ available: true });
      expect(connects.count).toBe(2);
      yield* Deferred.succeed(stall, undefined);
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
                  // Uninterruptible: a host so wedged it cannot even answer
                  // with its own timeout, which is what the broker evicts.
                  Effect.andThen(Effect.uninterruptible(Deferred.await(stall))),
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
      yield* TestClock.adjust("16 seconds");
      yield* Fiber.join(timedOut);
      const afterDisconnect = connects.count;
      // The wedged op finishing lets the scope close; it must not reconnect.
      yield* Deferred.succeed(stall, undefined);

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

it("advertises the 1.66.6 operations and still leaves recording to the desktop app", () => {
  for (const operation of ["click", "hover", "drag", "history", "closeTab", "select"] as const) {
    expect(ServerBrowserHost.SERVER_BROWSER_OPERATIONS).toContain(operation);
  }
  for (const operation of ["upload", "dialog", "recordingStart", "recordingStop"] as const) {
    expect(ServerBrowserHost.SERVER_BROWSER_OPERATIONS).not.toContain(operation);
  }
  // Every operation the host serves is one the broker knows. The contract set
  // is wider: desktop hosts also answer dialog, upload, select and the V1 close.
  const known = new Set<string>(PREVIEW_AUTOMATION_SERVER_OPERATIONS);
  for (const operation of ServerBrowserHost.SERVER_BROWSER_OPERATIONS) {
    expect(known).toContain(operation);
  }
});

it.effect(
  "serves select, and refuses upload, dialog and recording as unsupported with no retry advice",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connects = { count: 0 };
        const seen: string[] = [];
        const context = yield* Layer.build(
          hostLayer((request) => {
            seen.push(request.operation);
            return Effect.succeed(
              request.operation === "select" ? { selected: ["two"] } : { available: true },
            );
          }, connects),
        );
        const broker = yield* Effect.service(PreviewAutomationBroker.PreviewAutomationBroker).pipe(
          Effect.provide(context),
        );
        yield* awaitHostReady(broker);

        const selected = yield* broker.invoke<{ selected: string[] }>({
          scope,
          operation: "select",
          input: { selector: "#s", values: ["two"] },
        });
        expect(selected).toEqual({ selected: ["two"] });

        for (const operation of ["upload", "dialog", "recordingStart", "recordingStop"] as const) {
          const error = yield* broker.invoke({ scope, operation, input: {} }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
          expect(error.message).toContain("not supported on the shared browser");
          // A permanent refusal: nothing here may send the bot back to retry.
          expect(error.message).not.toMatch(
            /retry|reconnect|starting|preview_open|preview_status/i,
          );
        }
        // Refused by the broker itself: the host never saw them, and stayed registered.
        expect(seen.filter((operation) => operation !== "status")).toEqual(["select"]);
        expect(connects.count).toBe(1);
      }),
    ),
);

it.effect(
  "tells the bot in plain words when select meets a non-dropdown or a dropdown that never becomes usable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connects = { count: 0 };
        // Playwright's texts for the two cases, in the shape real Chromium returns them.
        const playwrightTexts: Record<string, string> = {
          "#div":
            "locator.selectOption: Error: Element is not a <select> element\nCall log:\n  - waiting for locator('#div')\n",
          "#disabled":
            "locator.selectOption: Timeout 13500ms exceeded.\nCall log:\n  - waiting for locator('#disabled')\n  - element is not enabled\n",
        };
        const page = {
          selectOption: (locator: string) =>
            Promise.reject(new Error(playwrightTexts[locator] ?? "unexpected locator")),
        };
        const context = yield* Layer.build(
          hostLayer(
            (request) =>
              request.operation === "select"
                ? Effect.promise(() => performSelect(page as never, request.input as never, 1000))
                : Effect.succeed({ available: true }),
            connects,
          ),
        );
        const broker = yield* Effect.service(PreviewAutomationBroker.PreviewAutomationBroker).pipe(
          Effect.provide(context),
        );
        yield* awaitHostReady(broker);

        // The words must survive the trip host -> broker -> bot. An error type whose
        // contract class rebuilds its message from fields would drop them.
        const notDropdown = yield* broker
          .invoke({ scope, operation: "select", input: { selector: "#div", values: ["a"] } })
          .pipe(Effect.flip);
        expect(notDropdown.message).toContain("not a dropdown");
        expect(notDropdown.message).toContain("preview_act click");

        const neverUsable = yield* broker
          .invoke({ scope, operation: "select", input: { selector: "#disabled", values: ["a"] } })
          .pipe(Effect.flip);
        expect(neverUsable.message).toContain("could not be used in time");
        expect(neverUsable.message).not.toMatch(/Call log|locator\.selectOption|Timeout \d+ms/);
      }),
    ),
);
