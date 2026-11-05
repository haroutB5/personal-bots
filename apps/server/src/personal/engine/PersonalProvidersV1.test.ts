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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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

const runtimeEvent = (type: string, threadId: string, providerInstanceId?: string) =>
  ({
    type,
    threadId,
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
  }) as never;

const makeHarness = (options?: { stopFails?: boolean; smokeFails?: boolean }) => {
  const calls: {
    refresh: Array<[ProviderInstanceId, { refreshLatestVersion?: boolean } | undefined]>;
    invalidated: Array<ProviderInstanceId>;
    stopped: Array<{ threadId: string; terminateProcesses?: boolean }>;
    prewarmed: Array<{ threadId: string; modelSelection: ModelSelection }>;
    smokeStates: Array<{ instanceId: ProviderInstanceId; action: string; state: unknown }>;
    smokeModels: Array<string>;
  } = {
    refresh: [],
    invalidated: [],
    stopped: [],
    prewarmed: [],
    smokeStates: [],
    smokeModels: [],
  };

  const fullInstance = {
    ...instance,
    textGeneration: {
      generateStructured: (input: { prompt: string }) => Effect.succeed(input.prompt),
    },
    smokeTest: (input: { model: string }) =>
      options?.smokeFails === true
        ? Effect.fail(new FakeStopError({ detail: "smoke refused" }))
        : Effect.sync(() => {
            calls.smokeModels.push(input.model);
          }),
  } as unknown as ProviderInstance;
  const bareInstance = { ...instance, textGeneration: {} } as unknown as ProviderInstance;
  const instances = {
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed(
        instanceId === INSTANCE_ID
          ? fullInstance
          : (instanceId as string) === "bare"
            ? bareInstance
            : undefined,
      ),
  };
  const registry = {
    getProviders: Effect.succeed([serverProvider]),
    streamChanges: Stream.make([serverProvider]),
    setProviderMaintenanceActionState: (input: {
      instanceId: ProviderInstanceId;
      action: string;
      state: unknown;
    }) =>
      Effect.sync(() => {
        calls.smokeStates.push(input);
        return [serverProvider];
      }),
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
    streamEvents: Stream.fromIterable([
      runtimeEvent("session.started", "t1", "claudeAgent"),
      runtimeEvent("session.started", "t2"),
      runtimeEvent("content.delta", "t1"),
      runtimeEvent("turn.completed", "t1"),
      runtimeEvent("turn.aborted", "t2"),
      runtimeEvent("session.exited", "t1"),
    ]),
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
      expect(found).toBeDefined();

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

  it.effect("streamChanges emits the registry snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const changes = yield* withProviders(harness, (providers) =>
        Stream.runCollect(providers.streamChanges),
      );
      expect(Array.from(changes)).toEqual([[serverProvider]]);
    });
  });

  it.effect("setSmokeCheck writes the smokeCheck maintenance state", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* withProviders(harness, (providers) => providers.setSmokeCheck(INSTANCE_ID, null));
      expect(harness.calls.smokeStates).toEqual([
        { instanceId: INSTANCE_ID, action: "smokeCheck", state: null },
      ]);
    });
  });

  it.effect("sessionEvents keeps only started, exited and settled facts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const events = yield* withProviders(harness, (providers) =>
        Stream.runCollect(providers.sessionEvents),
      );
      expect(Array.from(events)).toEqual([
        { _tag: "SessionStarted", threadId: "t1", instanceId: "claudeAgent" },
        { _tag: "SessionStarted", threadId: "t2", instanceId: null },
        { _tag: "TurnSettled", threadId: "t1" },
        { _tag: "TurnSettled", threadId: "t2" },
        { _tag: "SessionExited", threadId: "t1" },
      ]);
    });
  });

  it.effect("structuredGenerator is none without the instance or the capability", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const found = yield* withProviders(harness, (providers) =>
        providers.structuredGenerator(INSTANCE_ID),
      );
      expect(Option.isSome(found)).toBe(true);
      const bare = yield* withProviders(harness, (providers) =>
        providers.structuredGenerator("bare" as ProviderInstanceId),
      );
      expect(Option.isNone(bare)).toBe(true);
      const missing = yield* withProviders(harness, (providers) =>
        providers.structuredGenerator("other" as ProviderInstanceId),
      );
      expect(Option.isNone(missing)).toBe(true);
    });
  });

  it.effect("smokeTestFor runs the instance smoke test and maps its failure", () => {
    const harness = makeHarness();
    const failing = makeHarness({ smokeFails: true });
    return Effect.gen(function* () {
      const smoke = yield* withProviders(harness, (providers) =>
        providers.smokeTestFor(INSTANCE_ID),
      );
      expect(Option.isSome(smoke)).toBe(true);
      if (Option.isSome(smoke)) yield* smoke.value({ model: "m1" });
      expect(harness.calls.smokeModels).toEqual(["m1"]);

      const failingSmoke = yield* withProviders(failing, (providers) =>
        providers.smokeTestFor(INSTANCE_ID),
      );
      const error = Option.isSome(failingSmoke)
        ? yield* failingSmoke.value({ model: "m1" }).pipe(Effect.flip)
        : undefined;
      expect(error).toBeInstanceOf(PersonalProvidersError);
      expect(error?.detail).toBe("smoke refused");
      const none = yield* withProviders(harness, (providers) =>
        providers.smokeTestFor("bare" as ProviderInstanceId),
      );
      expect(Option.isNone(none)).toBe(true);
    });
  });
});
