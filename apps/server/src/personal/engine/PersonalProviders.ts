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
  ServerProviderAutoUpdate,
  ServerProviderSmokeCheck,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { PersonalProvidersError } from "./errors.ts";

/** U dropped `smokeCheck` from ServerProvider; the port overlays it from `setSmokeCheck`. */
export type PersonalServerProvider = ServerProvider & {
  readonly smokeCheck?: ServerProviderSmokeCheck;
};

export type PersonalPrewarmOutcome =
  | "started"
  | "live"
  | "missing"
  | "archived"
  | "busy"
  | "unsupported"
  | "failed";

/** The three provider session facts personal code reacts to. */
export type PersonalSessionEvent =
  | {
      readonly _tag: "SessionStarted";
      readonly threadId: ThreadId;
      readonly instanceId: ProviderInstanceId | null;
    }
  | { readonly _tag: "SessionExited"; readonly threadId: ThreadId }
  | { readonly _tag: "TurnSettled"; readonly threadId: ThreadId };

/** A prompt answered as JSON matching `outputSchema`, through a provider's tool-less one-shot call. */
export type PersonalGenerateStructured = <S extends Schema.Top>(input: {
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
}) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** One minimal isolated turn through the same executable a bot session uses. */
export type PersonalSmokeTest = (input: {
  readonly model: string;
}) => Effect.Effect<void, PersonalProvidersError>;

export interface PersonalProvidersShape {
  readonly listProviders: () => Effect.Effect<
    ReadonlyArray<PersonalServerProvider>,
    PersonalProvidersError
  >;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
    options?: { readonly refreshLatestVersion?: boolean },
  ) => Effect.Effect<ReadonlyArray<PersonalServerProvider>, PersonalProvidersError>;
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
  /** Every provider snapshot change, as the full current list. */
  readonly streamChanges: Stream.Stream<ReadonlyArray<PersonalServerProvider>>;
  /** Writes (or clears, with null) the smoke check result a provider card shows. */
  readonly setSmokeCheck: (
    instanceId: ProviderInstanceId,
    state: ServerProviderSmokeCheck | null,
  ) => Effect.Effect<void, PersonalProvidersError>;
  /** Writes (or clears, with null) the background updater state a provider card shows. */
  readonly setAutoUpdate: (
    instanceId: ProviderInstanceId,
    state: ServerProviderAutoUpdate | null,
  ) => Effect.Effect<void, PersonalProvidersError>;
  readonly sessionEvents: Stream.Stream<PersonalSessionEvent>;
  /** None when the instance is missing or has no structured generation. */
  readonly structuredGenerator: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<Option.Option<PersonalGenerateStructured>, PersonalProvidersError>;
  /** None when the instance is missing or has no smoke test. */
  readonly smokeTestFor: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<Option.Option<PersonalSmokeTest>, PersonalProvidersError>;
  readonly prewarm: (input: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<PersonalPrewarmOutcome, PersonalProvidersError>;
}

export class PersonalProviders extends Context.Service<PersonalProviders, PersonalProvidersShape>()(
  "t3/personal/engine/PersonalProviders",
) {}
