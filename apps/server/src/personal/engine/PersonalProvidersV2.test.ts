import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { PersonalProviders } from "./PersonalProviders.ts";
import { PersonalProvidersV2Live } from "./PersonalProvidersV2Live.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const outputSchema = Schema.Struct({ verdict: Schema.String });

const instanceWith = (
  generateStructured: (input: unknown) => Effect.Effect<unknown, TextGenerationError>,
) =>
  ({
    instanceId,
    textGeneration: { generateStructured },
  }) as never;

const withProviders = <A, E>(
  getInstance: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]["getInstance"],
  body: (providers: PersonalProviders["Service"]) => Effect.Effect<A, E>,
) => {
  const registry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({ getInstance });
  const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({});
  return Effect.gen(function* () {
    const providers = yield* PersonalProviders;
    return yield* body(providers);
  }).pipe(
    Effect.provide(
      PersonalProvidersV2Live.pipe(Layer.provide(Layer.merge(registry, providerRegistry))),
    ),
  );
};

describe("PersonalProvidersV2 structured generation", () => {
  it.effect("returns the instance's generator and answers through it", () => {
    const asked: Array<unknown> = [];
    return withProviders(
      () =>
        Effect.succeed(
          instanceWith((input) => {
            asked.push(input);
            return Effect.succeed({ verdict: "keep" });
          }),
        ),
      (providers) =>
        Effect.gen(function* () {
          const generator = yield* providers.structuredGenerator(instanceId);
          expect(Option.isSome(generator)).toBe(true);
          const answer = yield* Option.getOrThrow(generator)({
            prompt: "decide this entry",
            outputSchema,
            modelSelection: { instanceId, model: "claude-sonnet-5-5" },
          });
          expect(answer).toEqual({ verdict: "keep" });
          expect(asked).toHaveLength(1);
        }),
    );
  });

  it.effect("returns none when the instance is missing", () =>
    withProviders(
      () => Effect.succeed(undefined),
      (providers) =>
        Effect.gen(function* () {
          const generator = yield* providers.structuredGenerator(instanceId);
          expect(Option.isNone(generator)).toBe(true);
        }),
    ),
  );

  it.effect("returns none when the instance has no structured generator", () =>
    withProviders(
      () => Effect.succeed({ instanceId, textGeneration: {} } as never),
      (providers) =>
        Effect.gen(function* () {
          const generator = yield* providers.structuredGenerator(instanceId);
          expect(Option.isNone(generator)).toBe(true);
        }),
    ),
  );
});

const withRegistries = <A, E>(
  instance: unknown,
  providerList: ReadonlyArray<unknown>,
  body: (providers: PersonalProviders["Service"]) => Effect.Effect<A, E>,
) => {
  const registry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: () => Effect.succeed(instance as never),
  });
  const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed(providerList as never),
  });
  return Effect.gen(function* () {
    return yield* body(yield* PersonalProviders);
  }).pipe(
    Effect.provide(
      PersonalProvidersV2Live.pipe(Layer.provide(Layer.merge(registry, providerRegistry))),
    ),
  );
};

describe("PersonalProvidersV2 smoke test and usage", () => {
  const provider = { instanceId, installed: true, status: "ready" };

  it.effect("runs the smoke test as one structured call on the requested model", () => {
    const asked: Array<Record<string, unknown>> = [];
    return withRegistries(
      instanceWith((input) => {
        asked.push(input as Record<string, unknown>);
        return Effect.succeed({ ok: true });
      }),
      [provider],
      (providers) =>
        Effect.gen(function* () {
          const test = yield* providers.smokeTestFor(instanceId);
          yield* Option.getOrThrow(test)({ model: "claude-haiku-5-5" });
          expect(asked).toHaveLength(1);
          expect(asked[0]?.modelSelection).toEqual({ instanceId, model: "claude-haiku-5-5" });
        }),
    );
  });

  it.effect("fails the smoke test when the provider call fails", () =>
    withRegistries(
      instanceWith(() => Effect.fail(new TextGenerationError({ operation: "smoke", detail: "x" }))),
      [provider],
      (providers) =>
        Effect.gen(function* () {
          const test = yield* providers.smokeTestFor(instanceId);
          const outcome = yield* Effect.exit(Option.getOrThrow(test)({ model: "m" }));
          expect(outcome._tag).toBe("Failure");
        }),
    ),
  );

  it.effect("returns no smoke test for a missing instance", () =>
    withRegistries(undefined, [provider], (providers) =>
      Effect.gen(function* () {
        expect(Option.isNone(yield* providers.smokeTestFor(instanceId))).toBe(true);
      }),
    ),
  );

  it.effect("shows a stored smoke check on the listed provider until it is cleared", () =>
    withRegistries(undefined, [provider], (providers) =>
      Effect.gen(function* () {
        const check = { status: "passed", version: "1.0.0", checkedAt: null, message: null };
        yield* providers.setSmokeCheck(instanceId, check as never);
        expect((yield* providers.listProviders())[0]?.smokeCheck).toEqual(check);
        yield* providers.setSmokeCheck(instanceId, null);
        expect((yield* providers.listProviders())[0]?.smokeCheck).toBeUndefined();
      }),
    ),
  );

  it.effect("invalidating usage refreshes the instance's usage snapshot", () => {
    let refreshed = 0;
    return withRegistries(
      { instanceId, snapshot: { refreshUsage: Effect.sync(() => void refreshed++) } },
      [provider],
      (providers) =>
        Effect.gen(function* () {
          yield* providers.invalidateUsage(instanceId);
          expect(refreshed).toBe(1);
        }),
    );
  });
});
