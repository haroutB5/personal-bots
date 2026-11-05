/**
 * PersonalProviders on the v1 provider stack. No caller moves yet.
 *
 * @module personal/engine/PersonalProvidersV1Live
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderSession,
  ServerProvider,
  ServerProviderSmokeCheck,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderCommandReactor } from "../../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import {
  PersonalProviders,
  type PersonalGenerateStructured,
  type PersonalPrewarmOutcome,
  type PersonalSessionEvent,
  type PersonalSmokeTest,
} from "./PersonalProviders.ts";
import { failureDetail, PersonalProvidersError } from "./errors.ts";

const providersError = (operation: string) => (failure: unknown) =>
  new PersonalProvidersError({ operation, detail: failureDetail(failure) });

export const PersonalProvidersV1Live = Layer.effect(
  PersonalProviders,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry;
    const registry = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const reactor = yield* ProviderCommandReactor;

    const getInstance = (
      instanceId: ProviderInstanceId,
    ): Effect.Effect<ProviderInstance | undefined, PersonalProvidersError> =>
      instances.getInstance(instanceId).pipe(Effect.mapError(providersError("getInstance")));

    const listProviders = (): Effect.Effect<
      ReadonlyArray<ServerProvider>,
      PersonalProvidersError
    > => registry.getProviders.pipe(Effect.mapError(providersError("listProviders")));

    const refreshInstance = (
      instanceId: ProviderInstanceId,
      options?: { readonly refreshLatestVersion?: boolean },
    ): Effect.Effect<ReadonlyArray<ServerProvider>, PersonalProvidersError> =>
      registry
        .refreshInstance(instanceId, options)
        .pipe(Effect.mapError(providersError("refreshInstance")));

    const invalidateUsage = (
      instanceId: ProviderInstanceId,
    ): Effect.Effect<void, PersonalProvidersError> =>
      registry.invalidateUsage(instanceId).pipe(Effect.mapError(providersError("invalidateUsage")));

    const listSessions = (): Effect.Effect<
      ReadonlyArray<ProviderSession>,
      PersonalProvidersError
    > => providerService.listSessions().pipe(Effect.mapError(providersError("listSessions")));

    const stopSession = (input: {
      readonly threadId: ThreadId;
      readonly terminateProcesses?: boolean;
    }): Effect.Effect<void, PersonalProvidersError> =>
      providerService
        .stopSession({
          threadId: input.threadId,
          ...(input.terminateProcesses === undefined
            ? {}
            : { terminateProcesses: input.terminateProcesses }),
        })
        .pipe(Effect.mapError(providersError("stopSession")));

    const prewarm = (input: {
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
    }): Effect.Effect<PersonalPrewarmOutcome, PersonalProvidersError> =>
      reactor.prewarmSession(input).pipe(Effect.mapError(providersError("prewarm")));

    const streamChanges = registry.streamChanges;

    const setSmokeCheck = (
      instanceId: ProviderInstanceId,
      state: ServerProviderSmokeCheck | null,
    ): Effect.Effect<void, PersonalProvidersError> =>
      registry
        .setProviderMaintenanceActionState({ instanceId, action: "smokeCheck", state })
        .pipe(Effect.asVoid, Effect.mapError(providersError("setSmokeCheck")));

    const sessionEvents: Stream.Stream<PersonalSessionEvent> = providerService.streamEvents.pipe(
      Stream.flatMap((event): Stream.Stream<PersonalSessionEvent> => {
        switch (event.type) {
          case "session.started":
            return Stream.succeed({
              _tag: "SessionStarted",
              threadId: event.threadId,
              instanceId: event.providerInstanceId ?? null,
            });
          case "session.exited":
            return Stream.succeed({ _tag: "SessionExited", threadId: event.threadId });
          case "turn.completed":
          case "turn.aborted":
            return Stream.succeed({ _tag: "TurnSettled", threadId: event.threadId });
          default:
            return Stream.empty;
        }
      }),
    );

    const structuredGenerator = (
      instanceId: ProviderInstanceId,
    ): Effect.Effect<Option.Option<PersonalGenerateStructured>, PersonalProvidersError> =>
      getInstance(instanceId).pipe(
        Effect.map((instance) =>
          Option.fromNullishOr(instance?.textGeneration.generateStructured).pipe(
            // The instance method keeps its own `this`-free closure shape.
            Option.map(
              (generate): PersonalGenerateStructured =>
                (input) =>
                  generate(input),
            ),
          ),
        ),
      );

    const smokeTestFor = (
      instanceId: ProviderInstanceId,
    ): Effect.Effect<Option.Option<PersonalSmokeTest>, PersonalProvidersError> =>
      getInstance(instanceId).pipe(
        Effect.map((instance) =>
          Option.fromNullishOr(instance?.smokeTest).pipe(
            Option.map(
              (smokeTest): PersonalSmokeTest =>
                (input) =>
                  smokeTest(input).pipe(
                    Effect.mapError(
                      (error) =>
                        new PersonalProvidersError({
                          operation: "smokeTest",
                          detail: error.detail,
                        }),
                    ),
                  ),
            ),
          ),
        ),
      );

    return PersonalProviders.of({
      getInstance,
      listProviders,
      refreshInstance,
      invalidateUsage,
      listSessions,
      stopSession,
      streamChanges,
      setSmokeCheck,
      sessionEvents,
      structuredGenerator,
      smokeTestFor,
      prewarm,
    });
  }),
);
