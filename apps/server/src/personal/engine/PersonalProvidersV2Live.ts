/**
 * PersonalProviders on the v2 provider stack. Provider snapshots, refresh and
 * change streams come from ProviderRegistry. Session-level calls have no v2
 * equivalent on this port yet, so they answer empty or unsupported instead of
 * dying; the bot list and startup seeding depend only on `listProviders`.
 *
 * @module personal/engine/PersonalProvidersV2Live
 */
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSmokeCheck,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import {
  PersonalProviders,
  type PersonalGenerateStructured,
  type PersonalProvidersShape,
} from "./PersonalProviders.ts";
import { failureDetail, PersonalProvidersError } from "./errors.ts";

const providersError = (operation: string) => (failure: unknown) =>
  new PersonalProvidersError({ operation, detail: failureDetail(failure) });

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const structuredGenerator: PersonalProvidersShape["structuredGenerator"] = (instanceId) =>
    instances.getInstance(instanceId).pipe(
      Effect.map((instance) => {
        const generate: PersonalGenerateStructured | undefined =
          instance?.textGeneration.generateStructured;
        return generate === undefined ? Option.none() : Option.some(generate);
      }),
    );
  const firstList = yield* Ref.make(true);
  const listProviders = (): Effect.Effect<ReadonlyArray<ServerProvider>, PersonalProvidersError> =>
    Effect.gen(function* () {
      const first = yield* Ref.getAndSet(firstList, false);
      if (!first) return yield* registry.getProviders;
      // The v2 registry probes asynchronously; the first reader (startup
      // seeding) waits for one snapshot so it does not see an empty list.
      return yield* registry.getProviders.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (providers) =>
            providers.some((provider) => provider.installed && provider.status === "ready"),
        }),
        Effect.timeoutOption("20 seconds"),
        Effect.map((providers) =>
          Option.getOrElse(providers, (): ReadonlyArray<ServerProvider> => []),
        ),
      );
    }).pipe(Effect.mapError(providersError("listProviders")));
  const shape: PersonalProvidersShape = {
    listProviders,
    refreshInstance: (instanceId: ProviderInstanceId) =>
      registry.refreshInstance(instanceId).pipe(Effect.mapError(providersError("refreshInstance"))),
    invalidateUsage: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    stopSession: () => Effect.void,
    streamChanges: registry.streamChanges,
    setSmokeCheck: (_instanceId: ProviderInstanceId, _state: ServerProviderSmokeCheck | null) =>
      Effect.void,
    sessionEvents: Stream.empty,
    structuredGenerator,
    smokeTestFor: () => Effect.succeed(Option.none()),
    prewarm: () => Effect.succeed("unsupported" as const),
  };
  return shape;
});

export const PersonalProvidersV2Live = Layer.effect(PersonalProviders, make);
