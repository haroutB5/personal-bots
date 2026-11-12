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
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
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
  if (!changed && previous !== undefined && previous.refreshFailed === undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined ? { reason: "probeFailed" as const } : previous.unavailable;
  return {
    checkedAt: input.checkedAt,
    windows: sortWindows(merged.values()),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
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

/**
 * Offer a provider the last good reading from before a restart. It only fills
 * a gap: a provider with no reading, or whose last probe failed, takes it.
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
    if (seed.refreshFailed === undefined) return seed;
    const { refreshFailed: _carried, ...reading } = seed;
    return reading;
  }
  return published;
}

export interface UsageProbeContext {
  readonly checkedAt: string;
  readonly message?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly installed?: boolean | undefined;
}

const REASON_MAX_CHARS = 120;

/** The first sentence of a probe message, capped, for "Couldn't refresh · <reason>". */
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
 * A probe can arrive after a newer reading and still describe the window that
 * a reset replaced. Its window ends earlier while the published one is still
 * open, so the probe is stale whatever its timestamp says.
 */
function probeDescribesOlderWindow(
  published: ServerProviderUsageLimits,
  probed: ServerProviderUsageLimits,
): boolean {
  const readAtMs = Date.parse(probed.checkedAt);
  if (!Number.isFinite(readAtMs)) return false;
  const publishedById = new Map(published.windows.map((window) => [window.id, window] as const));
  return probed.windows.some((window) => {
    const publishedWindow = publishedById.get(window.id);
    if (publishedWindow?.resetsAt === undefined || window.resetsAt === undefined) return false;
    const publishedEndMs = Date.parse(publishedWindow.resetsAt);
    const probedEndMs = Date.parse(window.resetsAt);
    return (
      Number.isFinite(publishedEndMs) &&
      Number.isFinite(probedEndMs) &&
      publishedEndMs > readAtMs &&
      probedEndMs < publishedEndMs
    );
  });
}

/**
 * A probe that read no usage keeps the last good windows and marks them
 * `refreshFailed`; a read replaces them. `unsupported`, a disabled provider and
 * an uninstalled CLI are authoritative and replace the reading.
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
    if (published !== undefined && published.unavailable === undefined) {
      const olderRead =
        Date.parse(published.checkedAt) > Date.parse(probed.checkedAt) ||
        probeDescribesOlderWindow(published, probed);
      if (olderRead) {
        return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
      }
    }
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
    (probed?.unavailable === undefined ? "usage came back empty" : undefined);
  const at = context?.checkedAt ?? probed?.checkedAt;
  if (at === undefined) return published;
  return {
    ...published,
    refreshFailed: { at, ...(reason ? { message: reason } : {}) },
  };
}
