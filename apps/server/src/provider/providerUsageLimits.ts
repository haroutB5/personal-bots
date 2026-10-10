import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    fullReadAt: input.checkedAt,
    windows: sortWindows(input.windows),
  };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  // A live reading also settles an earlier failed refresh: rebuild so the
  // "couldn't refresh" note goes with it, even when no number moved.
  if (
    !changed &&
    previous !== undefined &&
    previous.unavailable === undefined &&
    previous.refreshFailed === undefined
  ) {
    return previous;
  }
  return {
    // This snapshot mixes readings from different times. Preserve the UI
    // merge, but never let it certify full allowance recovery. Even a
    // changed event carrying every window is a runtime partial by contract.
    checkedAt: input.checkedAt,
    windows: sortWindows(merged.values()),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/** What the probe that just finished says about itself, for a kept reading's failure note. */
export interface UsageProbeContext {
  readonly checkedAt: string;
  /** The provider's own probe message (CLI missing, timed out, signed out...). */
  readonly message?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly installed?: boolean | undefined;
}

const REASON_MAX_CHARS = 120;

/**
 * One short line for "Couldn't refresh · <reason>": the first sentence of the
 * probe's message, capped. Undefined when there is nothing to say.
 */
export function shortProbeFailureReason(message: string | undefined): string | undefined {
  const text = message?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  const trimmed = sentence.replace(/[.!?]+$/, "");
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= REASON_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, REASON_MAX_CHARS - 1)}…`;
}

/**
 * Choose what to publish after a status probe finishes. A probe that could not
 * read usage this time must not wipe bars a previous probe or a turn already
 * established, so the last good reading stays and says that the newest refresh
 * failed (`refreshFailed`), with its own `checkedAt` so clients can show its
 * age. That covers every way a probe can come back without a reading: a
 * `probeFailed` snapshot, a snapshot that carries no usage at all (the CLI
 * health check timed out or errored before usage was ever asked for: on
 * 7 Oct the boot probe hit a startup stall, returned exactly that, and wiped
 * the reading carried over the restart), and one that read no windows.
 *
 * Authoritative answers still replace it: `unsupported` (an account that
 * cannot have windows), a disabled provider and an uninstalled CLI.
 *
 * A successful probe replaces the published windows outright, including any
 * runtime update that landed while it was running. That is a deliberate
 * trade-off: the Codex and Claude reads take a few seconds at most, the
 * probe is the fresher full read in every case except that window, and the
 * per-window epoch bookkeeping needed to reconcile the two was more code
 * than the sub-second regression it prevented. The next runtime event
 * corrects it.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
  readonly context?: UsageProbeContext | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed, context } = input;
  if (probed?.unavailable?.reason === "unsupported") return probed;
  if (context?.enabled === false || context?.installed === false) return probed;
  const read =
    probed !== undefined && probed.unavailable === undefined && probed.windows.length > 0;
  if (read) {
    // Mark the authoritative probe boundary as well as the normalizers.
    return probed.fullReadAt === probed.checkedAt
      ? probed
      : { ...probed, fullReadAt: probed.checkedAt };
  }
  const lastGood =
    published !== undefined && published.unavailable === undefined && published.windows.length > 0;
  if (!lastGood) return probed;
  const reason =
    shortProbeFailureReason(probed?.unavailable?.message) ??
    shortProbeFailureReason(context?.message) ??
    (probed !== undefined && probed.unavailable === undefined
      ? "usage came back empty"
      : undefined);
  const at = context?.checkedAt ?? probed?.checkedAt ?? published.checkedAt;
  return {
    ...published,
    refreshFailed: { at, ...(reason ? { message: reason } : {}) },
  };
}

/**
 * Offer a provider the last good reading from before a restart. It keeps its
 * own `checkedAt`, so the UI says how old it is. It only fills a gap: a
 * provider with no reading yet, or whose last probe failed, takes it; one
 * that already read its usage (or learned the account has none) keeps its
 * own. After that `resolveUsageLimitsAfterProbe` treats it like any other
 * good reading.
 */
export function seedUsageLimits(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly seed: ServerProviderUsageLimits;
}): ServerProviderUsageLimits | undefined {
  const { published, seed } = input;
  if (seed.unavailable !== undefined || seed.windows.length === 0) {
    return published;
  }
  if (published === undefined || published.unavailable?.reason === "probeFailed") {
    // A failure note belongs to the run that saw it; the next probe decides.
    if (seed.refreshFailed === undefined) return seed;
    const { refreshFailed: _carried, ...reading } = seed;
    return reading;
  }
  return published;
}
