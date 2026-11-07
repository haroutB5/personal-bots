/**
 * The v2 provider port. C5 fills in structured generation; the rest dies with
 * the same marker until C9 supplies the managed-provider port.
 *
 * @module personal/engine/PersonalProvidersV2Live
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import {
  PersonalProviders,
  type PersonalGenerateStructured,
  type PersonalProvidersShape,
} from "./PersonalProviders.ts";

const pending = (method: string) => Effect.die(`v2-port pending: PersonalProviders.${method}`);

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const structuredGenerator: PersonalProvidersShape["structuredGenerator"] = (instanceId) =>
    registry.getInstance(instanceId).pipe(
      Effect.map((instance) => {
        const generate: PersonalGenerateStructured | undefined =
          instance?.textGeneration.generateStructured;
        return generate === undefined ? Option.none() : Option.some(generate);
      }),
    );
  const shape: PersonalProvidersShape = {
    listProviders: () => pending("listProviders"),
    refreshInstance: () => pending("refreshInstance"),
    invalidateUsage: () => pending("invalidateUsage"),
    listSessions: () => pending("listSessions"),
    stopSession: () => pending("stopSession"),
    streamChanges: Stream.die("v2-port pending: PersonalProviders.streamChanges"),
    setSmokeCheck: () => pending("setSmokeCheck"),
    sessionEvents: Stream.die("v2-port pending: PersonalProviders.sessionEvents"),
    structuredGenerator,
    smokeTestFor: () => pending("smokeTestFor"),
    prewarm: () => pending("prewarm"),
  };
  return shape;
});

export const PersonalProvidersV2Live = Layer.effect(PersonalProviders, make);
