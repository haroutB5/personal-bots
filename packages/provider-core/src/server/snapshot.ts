import type {
  ProviderUsageLimitsUpdate,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerSettingsError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "./maintenance.ts";

/** authLabel names the plan, for drivers whose usage report carries it. */
export type ProviderUsageLimitsReport = ProviderUsageLimitsUpdate & {
  readonly checkedAt: string;
  readonly authLabel?: string;
  /** A full reading replaces sparse windows and clears a previous probe failure. */
  readonly complete?: boolean;
};

export interface ManagedServerProvider {
  /** Cached; pass { fresh: true } before executing updates. */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /** True while getSnapshot still returns the placeholder from before the first completed check. */
  readonly isAwaitingFirstCheck?: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<ServerProvider>;
  /** The settings card's manual refresh: asks for the uncached registry lookup. */
  readonly refreshLatest?: Effect.Effect<ServerProvider>;
  /** Takes the usage reading persisted before a restart when the provider has none. */
  readonly seedUsageLimits?: (limits: ServerProviderUsageLimits) => Effect.Effect<void>;
  /** Drops the published reading when the provider's account changed, without probing. */
  readonly clearUsageLimits?: Effect.Effect<void>;
  readonly refreshUsage?: Effect.Effect<void, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Merge windows by ID and set any authLabel; an update with no window leaves the snapshot untouched. */
  readonly applyUsageLimits: (update: ProviderUsageLimitsReport) => Effect.Effect<void>;
}
