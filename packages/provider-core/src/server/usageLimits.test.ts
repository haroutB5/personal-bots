import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageLimitsUpdate,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
  seedUsageLimits,
  shortProbeFailureReason,
} from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("keeps full-read proof for an unchanged snapshot, but drops it on a runtime merge", () => {
    const full = makeUsageLimits({ checkedAt, windows: [session, weekly] });
    expect(full.fullReadAt).toBe(checkedAt);
    expect(
      applyUsageLimitsUpdate({ previous: full, checkedAt, update: { windows: [session] } }),
    ).toBe(full);
    const merged = applyUsageLimitsUpdate({
      previous: full,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });
    expect(merged?.fullReadAt).toBeUndefined();
    const failed = { ...full, refreshFailed: { at: checkedAt } };
    expect(
      applyUsageLimitsUpdate({ previous: failed, checkedAt, update: { windows: [session] } })
        ?.fullReadAt,
    ).toBeUndefined();
  });

  it("clears an earlier failed-refresh note once a live reading arrives, even unchanged", () => {
    const noted = { ...published, refreshFailed: { at: "2026-09-03T12:01:00.000Z" } };
    const next = applyUsageLimitsUpdate({
      previous: noted,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...weekly }] },
    });
    expect(next?.refreshFailed).toBeUndefined();
    expect(next?.windows).toEqual(published.windows);
    expect(next?.checkedAt).toBe("2026-09-03T12:00:05.000Z");
  });

  it("returns the published object itself when no window moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toEqual({
      ...sameTime,
      fullReadAt: sameTime.checkedAt,
    });
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: newer })).toEqual({
      ...newer,
      fullReadAt: newer.checkedAt,
    });
  });

  const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
  const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
  const probeAt = "2026-09-03T12:05:00.000Z";

  it("keeps the last good windows through a failed probe and says the refresh failed", () => {
    const kept = resolveUsageLimitsAfterProbe({
      published,
      probed: failed,
      context: { checkedAt: probeAt, message: "Claude Agent CLI is installed but failed to run." },
    });
    expect(kept).toEqual({
      ...published,
      refreshFailed: { at: probeAt, message: "Claude Agent CLI is installed but failed to run" },
    });
    expect(kept?.checkedAt).toBe(published.checkedAt);
    expect(kept?.unavailable).toBeUndefined();
  });

  it("keeps the last good reading when the probe returned nothing", () => {
    expect(
      resolveUsageLimitsAfterProbe({
        published,
        probed: undefined,
        context: { checkedAt: probeAt, installed: true, enabled: true },
      }),
    ).toEqual({
      ...published,
      refreshFailed: { at: probeAt, message: "usage came back empty" },
    });
  });

  it("prefers the probe's own reason and never leaves the note without a time", () => {
    const named = resolveUsageLimitsAfterProbe({
      published,
      probed: { ...failed, unavailable: { reason: "probeFailed", message: "rate limited" } },
      context: { checkedAt: probeAt, message: "ignored" },
    });
    expect(named?.refreshFailed).toEqual({ at: probeAt, message: "rate limited" });
    const bare = resolveUsageLimitsAfterProbe({ published, probed: failed });
    expect(bare?.refreshFailed).toEqual({ at: failed.checkedAt });
  });

  it("keeps the reading when a probe reads no windows", () => {
    const kept = resolveUsageLimitsAfterProbe({
      published,
      probed: { checkedAt: probeAt, windows: [] },
      context: { checkedAt: probeAt },
    });
    expect(kept?.windows).toEqual(published.windows);
    expect(kept?.refreshFailed?.message).toBe("usage came back empty");
  });

  it("a probe that reads usage replaces the reading and its failure note", () => {
    const fresh = { checkedAt: probeAt, windows: [session] };
    const noted = { ...published, refreshFailed: { at: probeAt } };
    expect(resolveUsageLimitsAfterProbe({ published: noted, probed: fresh })).toEqual({
      ...fresh,
      fullReadAt: probeAt,
    });
  });

  const afterResetSession = {
    id: "five_hour",
    kind: "session" as const,
    label: "Session",
    usedPercent: 0,
    windowDurationMins: 300,
    resetsAt: "2026-11-12T12:20:00.000Z",
  };
  const afterResetWeekly = {
    id: "seven_day",
    kind: "weekly" as const,
    label: "Weekly",
    usedPercent: 0,
    windowDurationMins: 10_080,
    resetsAt: "2026-11-15T11:00:00.000Z",
  };
  const afterReset = {
    checkedAt: "2026-11-12T07:28:16.205Z",
    windows: [afterResetSession, afterResetWeekly],
  };

  it("keeps the published windows when a newer read describes an older five-hour window", () => {
    const staleProbe = {
      checkedAt: "2026-11-12T07:28:21.374Z",
      fullReadAt: "2026-11-12T07:28:21.374Z",
      windows: [
        { ...afterResetSession, usedPercent: 9, resetsAt: "2026-11-12T10:40:00.000Z" },
        { ...afterResetWeekly, usedPercent: 100 },
      ],
    };

    expect(resolveUsageLimitsAfterProbe({ published: afterReset, probed: staleProbe })).toEqual({
      ...staleProbe,
      checkedAt: afterReset.checkedAt,
      windows: afterReset.windows,
    });
  });

  it("replaces the published windows when the probe's window ends at the same time or later", () => {
    const sameEndProbe = {
      checkedAt: "2026-11-12T07:28:21.374Z",
      windows: [
        { ...afterResetSession, usedPercent: 9 },
        { ...afterResetWeekly, usedPercent: 100 },
      ],
    };
    expect(resolveUsageLimitsAfterProbe({ published: afterReset, probed: sameEndProbe })).toEqual({
      ...sameEndProbe,
      fullReadAt: sameEndProbe.checkedAt,
    });

    const laterEndProbe = {
      ...sameEndProbe,
      windows: [{ ...afterResetSession, resetsAt: "2026-11-12T17:20:00.000Z" }, afterResetWeekly],
    };
    expect(resolveUsageLimitsAfterProbe({ published: afterReset, probed: laterEndProbe })).toEqual({
      ...laterEndProbe,
      fullReadAt: laterEndProbe.checkedAt,
    });
  });

  it("lets authoritative answers replace the reading", () => {
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(
      resolveUsageLimitsAfterProbe({
        published,
        probed: undefined,
        context: { checkedAt: probeAt, enabled: false },
      }),
    ).toBeUndefined();
    expect(
      resolveUsageLimitsAfterProbe({
        published,
        probed: undefined,
        context: { checkedAt: probeAt, installed: false },
      }),
    ).toBeUndefined();
  });

  it("has nothing to keep when nothing was ever read", () => {
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: undefined })).toBe(
      undefined,
    );
    expect(resolveUsageLimitsAfterProbe({ published: failed, probed: failed })).toBe(failed);
  });
});

describe("shortProbeFailureReason", () => {
  it("keeps the first sentence, trimmed and capped", () => {
    expect(shortProbeFailureReason("Timed out. Try again later.")).toBe("Timed out");
    expect(shortProbeFailureReason("  CLI 2.1.291 failed to start  ")).toBe(
      "CLI 2.1.291 failed to start",
    );
    expect(shortProbeFailureReason("x".repeat(300))?.length).toBe(120);
    expect(shortProbeFailureReason(undefined)).toBeUndefined();
    expect(shortProbeFailureReason("   ")).toBeUndefined();
  });
});

describe("seedUsageLimits", () => {
  it("fills only an empty or failed reading and keeps a good one", () => {
    const seed = { checkedAt, windows: [session] };
    const good = { checkedAt, windows: [weekly] };
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };

    expect(seedUsageLimits({ published: undefined, seed })).toBe(seed);
    expect(seedUsageLimits({ published: failed, seed })).toBe(seed);
    expect(seedUsageLimits({ published: good, seed })).toBe(good);
    expect(seedUsageLimits({ published: undefined, seed: failed })).toBeUndefined();
  });

  it("leaves a failure note from the previous run behind", () => {
    const seed = {
      checkedAt,
      windows: [session],
      refreshFailed: { at: checkedAt, message: "old" },
    };
    expect(seedUsageLimits({ published: undefined, seed })).toEqual({
      checkedAt,
      windows: [session],
    });
  });
});
