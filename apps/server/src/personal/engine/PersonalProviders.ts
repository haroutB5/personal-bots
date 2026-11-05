/**
 * The provider calls personal code makes, behind one port.
 *
 * v1 wraps ProviderInstanceRegistry, ProviderRegistry, ProviderService and
 * ProviderCommandReactor. v2 wraps the same capabilities in provider-core and
 * ProviderTurnStartService. Callers never see either.
 *
 * @module personal/engine/PersonalProviders
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderSession,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import type { PersonalProvidersError } from "./errors.ts";

export type PersonalPrewarmOutcome =
  | "started"
  | "live"
  | "missing"
  | "archived"
  | "busy"
  | "unsupported"
  | "failed";

export interface PersonalProvidersShape {
  readonly getInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstance | undefined, PersonalProvidersError>;
  readonly listProviders: () => Effect.Effect<
    ReadonlyArray<ServerProvider>,
    PersonalProvidersError
  >;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
    options?: { readonly refreshLatestVersion?: boolean },
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, PersonalProvidersError>;
  readonly invalidateUsage: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, PersonalProvidersError>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<ProviderSession>,
    PersonalProvidersError
  >;
  readonly stopSession: (input: {
    readonly threadId: ThreadId;
    readonly terminateProcesses?: boolean;
  }) => Effect.Effect<void, PersonalProvidersError>;
  readonly prewarm: (input: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<PersonalPrewarmOutcome, PersonalProvidersError>;
}

export class PersonalProviders extends Context.Service<PersonalProviders, PersonalProvidersShape>()(
  "t3/personal/engine/PersonalProviders",
) {}
