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
