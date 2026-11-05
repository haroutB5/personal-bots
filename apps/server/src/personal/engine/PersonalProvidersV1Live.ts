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
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderCommandReactor } from "../../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { PersonalProviders, type PersonalPrewarmOutcome } from "./PersonalProviders.ts";
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

    return PersonalProviders.of({
      getInstance,
      listProviders,
      refreshInstance,
      invalidateUsage,
      listSessions,
      stopSession,
      prewarm,
    });
  }),
);
