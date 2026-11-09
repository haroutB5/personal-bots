/**
 * PersonalProviders on the v2 provider stack. Provider snapshots, refresh and
 * change streams come from ProviderRegistry. Session list, stop and events
 * come from PersonalProviderSessions, prewarm from PersonalPrewarmSession. A
 * host without them answers empty or unsupported instead of dying; the bot list
 * and startup seeding depend only on `listProviders`.
 *
 * @module personal/engine/PersonalProvidersV2Live
 */
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderAutoUpdate,
  ServerProviderSmokeCheck,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import {
  PersonalProviders,
  type PersonalGenerateStructured,
  type PersonalProvidersShape,
  type PersonalServerProvider,
  type PersonalSmokeTest,
} from "./PersonalProviders.ts";
import { PersonalPrewarmSession } from "./PersonalPrewarmSession.ts";
import { PersonalProviderSessions } from "./PersonalProviderSessions.ts";
import { failureDetail, PersonalProvidersError } from "./errors.ts";

const SmokeAnswer = Schema.Struct({ ok: Schema.Boolean });

const providersError = (operation: string) => (failure: unknown) =>
  new PersonalProvidersError({ operation, detail: failureDetail(failure) });

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const prewarmSession = yield* Effect.serviceOption(PersonalPrewarmSession);
  const providerSessions = yield* Effect.serviceOption(PersonalProviderSessions);
  const structuredGenerator: PersonalProvidersShape["structuredGenerator"] = (instanceId) =>
    instances.getInstance(instanceId).pipe(
      Effect.map((instance) => {
        const generate: PersonalGenerateStructured | undefined =
          instance?.textGeneration.generateStructured;
        return generate === undefined ? Option.none() : Option.some(generate);
      }),
    );
  const smokeTestFor: PersonalProvidersShape["smokeTestFor"] = (instanceId) =>
    structuredGenerator(instanceId).pipe(
      Effect.map(
        Option.map(
          (generate): PersonalSmokeTest =>
            (input) =>
              generate({
                prompt: 'Reply with the JSON object {"ok": true} and nothing else.',
                outputSchema: SmokeAnswer,
                modelSelection: { instanceId, model: input.model },
              }).pipe(Effect.asVoid, Effect.mapError(providersError("smokeTest"))),
        ),
      ),
    );
  const firstList = yield* Ref.make(true);
  const listProviders = (): Effect.Effect<
    ReadonlyArray<PersonalServerProvider>,
    PersonalProvidersError
  > =>
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
    invalidateUsage: (instanceId: ProviderInstanceId) =>
      instances.getInstance(instanceId).pipe(
        Effect.flatMap((instance) => instance?.snapshot.refreshUsage ?? Effect.void),
        Effect.mapError(providersError("invalidateUsage")),
      ),
    listSessions: () =>
      Option.isSome(providerSessions) ? providerSessions.value.listSessions() : Effect.succeed([]),
    stopSession: (input) =>
      Option.isSome(providerSessions) ? providerSessions.value.stopSession(input) : Effect.void,
    streamChanges: registry.streamChanges,
    setSmokeCheck: (instanceId: ProviderInstanceId, state: ServerProviderSmokeCheck | null) =>
      registry
        .setProviderMaintenanceActionState({ instanceId, action: "smokeCheck", state })
        .pipe(Effect.andThen(registry.getProviders), Effect.asVoid),
    setAutoUpdate: (instanceId: ProviderInstanceId, state: ServerProviderAutoUpdate | null) =>
      registry
        .setProviderMaintenanceActionState({ instanceId, action: "autoUpdate", state })
        .pipe(Effect.andThen(registry.getProviders), Effect.asVoid),
    sessionEvents: Option.isSome(providerSessions)
      ? providerSessions.value.sessionEvents
      : Stream.empty,
    structuredGenerator,
    smokeTestFor,
    prewarm: (input) =>
      Option.isSome(prewarmSession)
        ? prewarmSession.value.prewarm(input)
        : Effect.succeed("unsupported" as const),
  };
  return shape;
});

export const PersonalProvidersV2Live = Layer.effect(PersonalProviders, make);
