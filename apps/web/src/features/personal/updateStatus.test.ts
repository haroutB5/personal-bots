import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  NO_UPDATE,
  RESTART_EXPECTED_WINDOW_MS,
  fetchUpdateStatus,
  parseUpdateStatusAnswer,
  updateLineFor,
  versionFromLabel,
  visibleUpdateLine,
  type UpdateStatusAnswer,
} from "./updateStatus";

const NOW = Date.parse("2026-10-12T21:00:00.000Z");

const answer = (overrides: Partial<UpdateStatusAnswer> = {}): UpdateStatusAnswer => ({
  phase: "backing_up",
  version: "1.66.34",
  previousVersion: "1.66.33",
  updatedAt: "2026-10-12T20:59:00.000Z",
  ...overrides,
});

const textFor = (phase: string, extra: Partial<UpdateStatusAnswer> = {}) =>
  updateLineFor(answer({ phase, ...extra }), "1.66.33")?.text ?? null;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the server's answer may be", () => {
  it("keeps the four fields, and refuses anything that is not them", () => {
    expect(parseUpdateStatusAnswer(answer())).toEqual(answer());
    expect(parseUpdateStatusAnswer({ ...answer(), extra: 1 })).toEqual(answer());
    expect(
      parseUpdateStatusAnswer({
        phase: null,
        version: null,
        previousVersion: null,
        updatedAt: null,
      }),
    ).toEqual(NO_UPDATE);
    expect(parseUpdateStatusAnswer({ phase: "Backing Up", version: "1.66.34" })).toEqual({
      phase: null,
      version: "1.66.34",
      previousVersion: null,
      updatedAt: null,
    });
    expect(parseUpdateStatusAnswer({ phase: "backing_up", version: "1.66.34\n" })).toEqual({
      phase: "backing_up",
      version: null,
      previousVersion: null,
      updatedAt: null,
    });
    expect(parseUpdateStatusAnswer([])).toBeNull();
    expect(parseUpdateStatusAnswer("backing_up")).toBeNull();
    expect(parseUpdateStatusAnswer(null)).toBeNull();
  });

  it("asks with the session credential and never a cache", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchUpdateStatus()).resolves.toEqual(answer());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("/api/personal/update/status");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
  });

  it("reads no answer, a refusal and a malformed body as no answer / nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchUpdateStatus()).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 403 })),
    );
    await expect(fetchUpdateStatus()).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    await expect(fetchUpdateStatus()).resolves.toEqual(NO_UPDATE);
  });
});

describe("how each phase reads", () => {
  it("prepares, waits for idle, backs up, restarts, checks and lands", () => {
    for (const phase of ["starting", "guards", "notes_check", "evidence_check", "preflight"]) {
      expect(textFor(phase)).toBe("Preparing update 1.66.34");
    }
    expect(textFor("waiting_for_idle")).toBe(
      "Update 1.66.34 ready, installs when the bots are idle",
    );
    expect(textFor("backing_up")).toBe("Backing up before update");
    expect(textFor("activating")).toBe("Restarting for update");
    expect(textFor("smoking")).toBe("Checking update 1.66.34");
    expect(textFor("live_verified")).toBe("Updated to 1.66.34");
  });

  it("says what is still live after a failed landing", () => {
    expect(textFor("rolled_back")).toBe("Update failed, still on 1.66.33");
    expect(textFor("rollback_failed")).toBe("Update problem, the team is on it");
    expect(textFor("failed")).toBe("Update problem, the team is on it");
    expect(textFor("rolling_back")).toBe("Update problem, the team is on it");
  });

  it("falls back to the version the page already shows, and copes without a version", () => {
    expect(textFor("rolled_back", { previousVersion: null })).toBe(
      "Update failed, still on 1.66.33",
    );
    expect(
      updateLineFor(answer({ phase: "rolled_back", previousVersion: null }), "1.66.29")?.text,
    ).toBe("Update failed, still on 1.66.29");
    expect(updateLineFor(answer({ phase: "rolled_back", previousVersion: null }), null)?.text).toBe(
      "Update failed, rolled back to the previous version",
    );
    expect(textFor("waiting_for_idle", { version: null })).toBe(
      "Update ready, installs when the bots are idle",
    );
    expect(textFor("smoking", { version: null })).toBe("Checking update");
    expect(textFor("live_verified", { version: null })).toBe("Updated");
  });

  it("tones the line: plain while moving, amber while waiting, red when it failed", () => {
    expect(updateLineFor(answer({ phase: "backing_up" }))?.tone).toBe("plain");
    expect(updateLineFor(answer({ phase: "waiting_for_idle" }))?.tone).toBe("notice");
    expect(updateLineFor(answer({ phase: "failed" }))?.tone).toBe("problem");
    expect(updateLineFor(answer({ phase: "live_verified" }))?.tone).toBe("plain");
  });

  it("shows nothing for a superseded waiter or a phase this build does not know", () => {
    expect(updateLineFor(answer({ phase: "superseded_before_activation" }))).toBeNull();
    expect(updateLineFor(answer({ phase: "a-future-phase" }))).toBeNull();
    expect(updateLineFor(answer({ phase: null }))).toBeNull();
  });

  it("lets a tap put away a finished line, and only a finished one", () => {
    for (const phase of [
      "live_verified",
      "live_verified_doc_update_failed",
      "rolled_back",
      "rollback_failed",
      "failed",
    ]) {
      expect(updateLineFor(answer({ phase }))?.dismissible).toBe(true);
    }
    for (const phase of ["waiting_for_idle", "backing_up", "activating", "smoking"]) {
      expect(updateLineFor(answer({ phase }))?.dismissible).toBe(false);
    }
  });
});

describe("what the page shows right now", () => {
  const visible = (input: Partial<Parameters<typeof visibleUpdateLine>[0]>) =>
    visibleUpdateLine({
      answer: answer(),
      offline: false,
      lastSeen: null,
      dismissed: null,
      fallbackVersion: null,
      nowMs: NOW,
      ...input,
    });

  it("shows the phase while the server answers, and nothing when there is no update", () => {
    expect(visible({})?.text).toBe("Backing up before update");
    expect(visible({ answer: NO_UPDATE })).toBeNull();
    expect(visible({ answer: null })).toBeNull();
  });

  it("calls the outage a restart when one was on its way", () => {
    for (const phase of ["waiting_for_idle", "backing_up", "activating", "rolling_back"]) {
      expect(
        visible({ offline: true, lastSeen: { phase, version: "1.66.34", atMs: NOW - 60_000 } })
          ?.text,
      ).toBe("Restarting for update");
    }
  });

  it("does not call every outage a restart", () => {
    // A finished phase: the server being away is not that update restarting.
    expect(
      visible({
        offline: true,
        lastSeen: { phase: "live_verified", version: "1.66.34", atMs: NOW },
      }),
    ).toBeNull();
    // Too long ago: waiting for idle for hours with the server down is not a
    // restart arriving, it is a problem - the offline banner says so.
    expect(
      visible({
        offline: true,
        lastSeen: {
          phase: "waiting_for_idle",
          version: "1.66.34",
          atMs: NOW - RESTART_EXPECTED_WINDOW_MS - 1,
        },
      }),
    ).toBeNull();
    // Nothing was ever seen: a plain outage is the banner's story.
    expect(visible({ offline: true, lastSeen: null })).toBeNull();
  });

  it("hides a dismissed line while it is the same one, and brings a new one back", () => {
    const dismissed = { phase: "live_verified", version: "1.66.34", atMs: NOW - 60_000 };
    expect(visible({ answer: answer({ phase: "live_verified" }), dismissed })).toBeNull();
    // The line has moved on: the dismissal was for the old one.
    expect(visible({ answer: answer({ phase: "rolled_back" }), dismissed })?.text).toBe(
      "Update failed, still on 1.66.33",
    );
    // A previous leave does not hide a later update of the same kind forever.
    expect(
      visible({
        answer: answer({ phase: "live_verified" }),
        dismissed: { ...dismissed, atMs: NOW - 25 * 60 * 60_000 },
      })?.text,
    ).toBe("Updated to 1.66.34");
    // Another version's line is another line.
    expect(
      visible({ answer: answer({ phase: "live_verified", version: "1.66.35" }), dismissed })?.text,
    ).toBe("Updated to 1.66.35");
  });
});

describe("the page's own version stamp", () => {
  it("reads v1.66.33 as 1.66.33, and anything else as nothing", () => {
    expect(versionFromLabel("v1.66.33")).toBe("1.66.33");
    expect(versionFromLabel("1.66.33")).toBe("1.66.33");
    expect(versionFromLabel("970a968")).toBeNull();
    expect(versionFromLabel(null)).toBeNull();
  });
});
