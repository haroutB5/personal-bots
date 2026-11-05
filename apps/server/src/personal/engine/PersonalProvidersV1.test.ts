import {
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderSession,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderCommandReactor } from "../../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { PersonalProviders } from "./PersonalProviders.ts";
import { PersonalProvidersV1Live } from "./PersonalProvidersV1Live.ts";
import { PersonalProvidersError } from "./errors.ts";

class FakeStopError extends Schema.TaggedError<FakeStopError>()("FakeStopError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const INSTANCE_ID = "claudeAgent" as ProviderInstanceId;
const MODEL: ModelSelection = { instanceId: INSTANCE_ID, model: "claude-test" };

const serverProvider = {
  instanceId: INSTANCE_ID,
  driver: "claudeAgent",
} as unknown as ServerProvider;
const providerSession = {
  provider: "claudeAgent",
  status: "ready",
  runtimeMode: "full-access",
  threadId: "thread-1",
} as unknown as ProviderSession;
const instance = {
  instanceId: INSTANCE_ID,
  driverKind: "claudeAgent",
} as unknown as ProviderInstance;

const makeHarness = (options?: { stopFails?: boolean }) => {
  const calls: {
    refresh: Array<[ProviderInstanceId, { refreshLatestVersion?: boolean } | undefined]>;
    invalidated: Array<ProviderInstanceId>;
    stopped: Array<{ threadId: string; terminateProcesses?: boolean }>;
    prewarmed: Array<{ threadId: string; modelSelection: ModelSelection }>;
  } = { refresh: [], invalidated: [], stopped: [], prewarmed: [] };

  const instances = {
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed(instanceId === INSTANCE_ID ? instance : undefined),
  };
  const registry = {
    getProviders: Effect.succeed([serverProvider]),
    refreshInstance: (
      instanceId: ProviderInstanceId,
      refreshOptions?: { refreshLatestVersion?: boolean },
    ) =>
      Effect.sync(() => {
        calls.refresh.push([instanceId, refreshOptions]);
        return [serverProvider];
      }),
    invalidateUsage: (instanceId: ProviderInstanceId) =>
      Effect.sync(() => {
        calls.invalidated.push(instanceId);
      }),
  };
  const providerService = {
    listSessions: () => Effect.succeed([providerSession]),
    stopSession: (input: { threadId: string; terminateProcesses?: boolean }) =>
      options?.stopFails === true
        ? Effect.fail(new FakeStopError({ detail: "provider refused to stop" }))
        : Effect.sync(() => {
            calls.stopped.push(input);
          }),
  };
  const reactor = {
    prewarmSession: (input: { threadId: string; modelSelection: ModelSelection }) =>
      Effect.sync(() => {
        calls.prewarmed.push(input);
        return calls.prewarmed.length === 1 ? "started" : "failed";
      }),
  };

  const layer = PersonalProvidersV1Live.pipe(
    Layer.provide(Layer.succeed(ProviderInstanceRegistry, instances as never)),
    Layer.provide(Layer.succeed(ProviderRegistry, registry as never)),
    Layer.provide(Layer.succeed(ProviderService, providerService as never)),
    Layer.provide(Layer.succeed(ProviderCommandReactor, reactor as never)),
  );

  return { layer, calls };
};

const withProviders = <A, E>(
  harness: ReturnType<typeof makeHarness>,
  program: (providers: PersonalProviders["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const providers = yield* PersonalProviders;
    return yield* program(providers);
  }).pipe(Effect.provide(harness.layer));

describe("PersonalProvidersV1", () => {
  it.effect("getInstance returns the live instance or undefined", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const found = yield* withProviders(harness, (providers) =>
        providers.getInstance(INSTANCE_ID),
      );
      expect(found).toBe(instance);

      const missing = yield* withProviders(harness, (providers) =>
        providers.getInstance("other" as ProviderInstanceId),
      );
      expect(missing).toBeUndefined();
    });
  });

  it.effect("listProviders returns the registry snapshot", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const providers = yield* withProviders(harness, (catalog) => catalog.listProviders());
      expect(providers).toEqual([serverProvider]);
    });
  });

  it.effect("refreshInstance forwards the instance and options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const refreshed = yield* withProviders(harness, (providers) =>
        providers.refreshInstance(INSTANCE_ID, { refreshLatestVersion: true }),
      );
      expect(refreshed).toEqual([serverProvider]);
      expect(harness.calls.refresh).toEqual([[INSTANCE_ID, { refreshLatestVersion: true }]]);
    });
  });

  it.effect("invalidateUsage forwards the instance", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* withProviders(harness, (providers) => providers.invalidateUsage(INSTANCE_ID));
      expect(harness.calls.invalidated).toEqual([INSTANCE_ID]);
    });
  });

  it.effect("listSessions returns the provider sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sessions = yield* withProviders(harness, (providers) => providers.listSessions());
      expect(sessions).toEqual([providerSession]);
    });
  });

  it.effect("stopSession forwards terminateProcesses", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* withProviders(harness, (providers) =>
        providers.stopSession({ threadId: ThreadId.make("thread-1"), terminateProcesses: true }),
      );
      expect(harness.calls.stopped).toEqual([{ threadId: "thread-1", terminateProcesses: true }]);
    });
  });

  it.effect("stopSession failure becomes a PersonalProvidersError", () => {
    const harness = makeHarness({ stopFails: true });
    return Effect.gen(function* () {
      const error = yield* withProviders(harness, (providers) =>
        providers.stopSession({ threadId: ThreadId.make("thread-1") }).pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(PersonalProvidersError);
      expect(error.operation).toBe("stopSession");
      expect(error.detail).toBe("provider refused to stop");
    });
  });

  it.effect("prewarm forwards the next model and returns the outcome", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const first = yield* withProviders(harness, (providers) =>
        providers.prewarm({ threadId: ThreadId.make("thread-1"), modelSelection: MODEL }),
      );
      const second = yield* withProviders(harness, (providers) =>
        providers.prewarm({ threadId: ThreadId.make("thread-1"), modelSelection: MODEL }),
      );

      expect(first).toBe("started");
      expect(second).toBe("failed");
      expect(harness.calls.prewarmed).toEqual([
        { threadId: "thread-1", modelSelection: MODEL },
        { threadId: "thread-1", modelSelection: MODEL },
      ]);
    });
  });
});
