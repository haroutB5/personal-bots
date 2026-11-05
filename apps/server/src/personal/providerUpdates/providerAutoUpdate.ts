/**
 * Provider auto-update policy.
 *
 * One record per provider instance decides the once-a-day clock and the last
 * result. The projection turns that record into the small `autoUpdate` state
 * the phone's Settings row reads.
 *
 * @module personal/providerUpdates/providerAutoUpdate
 */
import type { ServerProvider, ServerProviderAutoUpdate } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

export const autoUpdateMetaKey = (instanceId: string) => `provider-auto-update:${instanceId}`;

/**
 * The durable part of an attempt. `attemptedAt` is written before the update
 * command runs, so a crash mid-update still counts against the daily clock.
 */
export const PersistedAutoUpdate = Schema.Struct({
  status: Schema.Literals(["updating", "updated", "rolled_back", "failed", "waiting_for_limit"]),
  fromVersion: Schema.NullOr(Schema.String),
  toVersion: Schema.String,
  message: Schema.NullOr(Schema.String),
  attemptedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type PersistedAutoUpdate = typeof PersistedAutoUpdate.Type;

export const decodePersistedAutoUpdate = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedAutoUpdate),
);
export const encodePersistedAutoUpdate = Schema.encodeSync(
  Schema.fromJsonString(PersistedAutoUpdate),
);

const compatibilityBlocks = (provider: ServerProvider): boolean => {
  const status = provider.compatibilityAdvisory?.latestVersionStatus;
  return status === "broken" || status === "unsupported";
};

const currentSmokeBlocks = (provider: ServerProvider): boolean => {
  const smoke = provider.smokeCheck;
  return (
    smoke?.version === provider.version &&
    (smoke.status === "failed" || smoke.status === "waiting_for_limit")
  );
};

export function canManageAutoUpdate(provider: ServerProvider): boolean {
  const advisory = provider.versionAdvisory;
  return (
    provider.enabled &&
    provider.installed &&
    provider.version !== null &&
    advisory !== undefined &&
    advisory.canUpdate === true &&
    advisory.canInstallVersion === true &&
    provider.auth.status !== "unauthenticated" &&
    !compatibilityBlocks(provider) &&
    !currentSmokeBlocks(provider)
  );
}

/**
 * Why this behind provider cannot update itself, or null when it can (or is
 * already current). The sentence is shown verbatim in Settings.
 */
export function autoUpdateBlockReason(provider: ServerProvider): string | null {
  if (!provider.enabled || !provider.installed || provider.version === null) return null;
  const advisory = provider.versionAdvisory;
  if (advisory?.status !== "behind_latest") return null;
  if (currentSmokeBlocks(provider)) {
    const smoke = provider.smokeCheck;
    return smoke?.status === "waiting_for_limit"
      ? "The test is waiting for the usage limit. Updates can run after it."
      : "The current version failed its test. Fix it before updates can run.";
  }
  if (compatibilityBlocks(provider)) {
    return "The latest version isn't compatible with this app.";
  }
  if (advisory.canUpdate !== true) {
    return "This provider updates outside the app. Update it on your computer.";
  }
  if (advisory.canInstallVersion !== true) {
    return "This updater can't go back to an older version, so updates stay manual.";
  }
  if (provider.auth.status === "unauthenticated") {
    return "Sign in before updates can run.";
  }
  if (advisory.latestVersion === null) {
    return "The latest version isn't known yet.";
  }
  return null;
}

/** When the daily clock lets the next attempt start, or null if never tried. */
export function autoUpdateRetryAtMs(record: PersistedAutoUpdate): number | null {
  const attemptedAt = DateTime.make(record.attemptedAt);
  return Option.isSome(attemptedAt)
    ? DateTime.toEpochMillis(attemptedAt.value) + AUTO_UPDATE_INTERVAL_MS
    : null;
}

const isoOrNull = (ms: number | null): string | null =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));

const managedState = (): ServerProviderAutoUpdate => ({
  status: "managed",
  message: null,
  fromVersion: null,
  toVersion: null,
  finishedAt: null,
  nextAttemptAt: null,
});

/**
 * What Settings reads for one provider. A record only describes the version
 * it was about; once the provider moves past it, the row falls back to
 * "managed" instead of showing a stale result from another release.
 */
export function autoUpdateProjection(input: {
  readonly provider: ServerProvider;
  readonly record: PersistedAutoUpdate | null;
  readonly blockReason: string | null;
  readonly retryAtMs: number | null;
}): ServerProviderAutoUpdate | undefined {
  const { provider, record, blockReason, retryAtMs } = input;
  const behind = provider.versionAdvisory?.status === "behind_latest";
  if (blockReason !== null) {
    return behind
      ? {
          status: "blocked",
          message: blockReason,
          fromVersion: null,
          toVersion: null,
          finishedAt: null,
          nextAttemptAt: null,
        }
      : undefined;
  }
  if (!canManageAutoUpdate(provider)) return undefined;
  if (record === null) return managedState();
  const relevant =
    record.status === "updating" ||
    record.toVersion === provider.version ||
    record.fromVersion === provider.version;
  if (!relevant) return managedState();
  return {
    status: record.status,
    message: record.message,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion,
    finishedAt: record.finishedAt,
    nextAttemptAt: isoOrNull(retryAtMs),
  };
}
