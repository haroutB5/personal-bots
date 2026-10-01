import type { PersonalMemoryTidyChangeStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isNewBotPreference,
  MEMORY_LAST_SEEN_KEY,
  memoryDayLabel,
  memoryDayTimeLabel,
  memoryMetaLine,
  memoryTextLookup,
  newestTidyRunsFirst,
  pendingTidyChanges,
  readMemoryLastSeen,
  TIDY_CHANGE_STATUS_LABEL,
  TIDY_ACTION_LABEL,
  TIDY_MODE_LABEL,
  tidyChangeCountLabel,
  tidyCountsLabel,
  tidyEntryTexts,
  tidyRunKindLabel,
  tidyStatusLabel,
  tidySummaryLine,
  UNLISTED_MEMORY_TEXT,
  writeMemoryLastSeen,
} from "./memoryPresentation";

const now = new Date("2026-10-01T15:00:00Z"); // 16:00 BST

describe("memoryDayLabel", () => {
  it("gives the London calendar day as YYYY-MM-DD", () => {
    expect(memoryDayLabel(new Date("2026-10-01T12:00:00Z"))).toBe("2026-10-01");
    // 23:30 UTC on 30 Sep is 00:30 BST on 1 Oct.
    expect(memoryDayLabel(new Date("2026-09-30T23:30:00Z"))).toBe("2026-10-01");
    expect(memoryDayLabel(Date.parse("2026-01-05T09:00:00Z"))).toBe("2026-01-05");
  });

  it("honours another time zone", () => {
    expect(memoryDayLabel(new Date("2026-10-01T02:00:00Z"), "America/New_York")).toBe("2026-09-30");
  });

  it("adds a 24-hour time for run stamps", () => {
    expect(memoryDayTimeLabel(new Date("2026-10-01T02:30:00Z"))).toBe("2026-10-01 03:30");
  });
});

describe("memoryMetaLine", () => {
  it("joins source, day and the relative time", () => {
    expect(
      memoryMetaLine("Saved by CTO when you asked", new Date("2026-10-01T12:00:00Z"), now),
    ).toBe("Saved by CTO when you asked · 2026-10-01 · 3h");
  });

  it("keeps the relative label for older entries", () => {
    expect(memoryMetaLine("Saved by you", new Date("2026-09-20T12:00:00Z"), now)).toBe(
      "Saved by you · 2026-09-20 · 20 Sep",
    );
  });
});

describe("tidy labels", () => {
  it("names actions, modes, statuses and run kinds in words", () => {
    expect(TIDY_ACTION_LABEL).toEqual({
      merge: "Merged",
      supersede: "Replaced",
      leave: "Left alone",
    });
    expect(TIDY_MODE_LABEL).toEqual({ off: "Off", preview: "Preview only", on: "Make changes" });
    expect(tidyStatusLabel("failed")).toBe("Failed");
    expect(tidyRunKindLabel({ dryRun: true })).toBe("Preview");
    expect(tidyRunKindLabel({ dryRun: false })).toBe("Changes made");
    expect(tidyChangeCountLabel(1)).toBe("1 change");
    expect(tidyChangeCountLabel(4)).toBe("4 changes");
  });

  it("summarises counts and leaves zeros out", () => {
    expect(tidyCountsLabel({ merged: 2, superseded: 3, leftAlone: 1 })).toBe(
      "2 merged, 3 replaced, 1 left alone",
    );
    expect(tidyCountsLabel({ merged: 0, superseded: 1, leftAlone: 0 })).toBe("1 replaced");
    expect(tidyCountsLabel({ merged: 0, superseded: 0, leftAlone: 0 })).toBe("Nothing to tidy");
  });
});

const run = (
  startedAt: string,
  extra: Partial<{ status: "running" | "done" | "failed" }> = {},
) => ({
  startedAt: DateTime.makeUnsafe(startedAt),
  status: extra.status ?? ("done" as const),
  merged: 1,
  superseded: 2,
  leftAlone: 0,
});

describe("tidy runs", () => {
  it("sorts newest first without mutating the input", () => {
    const runs = [run("2026-09-29T02:30:00Z"), run("2026-10-01T02:30:00Z")];
    const sorted = newestTidyRunsFirst(runs);
    expect(sorted.map((item) => DateTime.formatIso(item.startedAt))).toEqual([
      "2026-10-01T02:30:00.000Z",
      "2026-09-29T02:30:00.000Z",
    ]);
    expect(DateTime.formatIso(runs[0]!.startedAt)).toBe("2026-09-29T02:30:00.000Z");
  });

  it("writes the one-line status from the mode and newest run", () => {
    expect(tidySummaryLine("preview", null)).toBe("Preview only · not run yet");
    expect(tidySummaryLine("on", run("2026-10-01T02:30:00Z"))).toBe(
      "Make changes · last run 2026-10-01 03:30: 1 merged, 2 replaced",
    );
    expect(tidySummaryLine("off", run("2026-10-01T02:30:00Z", { status: "failed" }))).toBe(
      "Off · last run 2026-10-01 03:30: Failed",
    );
  });
});

describe("memory text lookup", () => {
  const texts = memoryTextLookup(
    [{ memoryId: "a", content: "Current A" }],
    [
      { memoryId: "a", content: "Old A" },
      { memoryId: "b", content: "Replaced B" },
    ],
    null,
  );

  it("prefers the current list and covers replaced entries", () => {
    expect(texts.get("a")).toBe("Current A");
    expect(texts.get("b")).toBe("Replaced B");
  });

  it("falls back for ids neither list has", () => {
    expect(tidyEntryTexts(["b", "gone"], texts)).toEqual(["Replaced B", UNLISTED_MEMORY_TEXT]);
    expect(UNLISTED_MEMORY_TEXT).toBe("an entry no longer listed");
  });
});

describe("pending tidy changes", () => {
  it("gathers pending changes across runs once each, in order", () => {
    const runs: ReadonlyArray<{
      changes: ReadonlyArray<{ changeId: number; status: PersonalMemoryTidyChangeStatus }>;
    }> = [
      {
        changes: [
          { changeId: 3, status: "pending" as const },
          { changeId: 4, status: "applied" as const },
        ],
      },
      {
        changes: [
          { changeId: 1, status: "pending" as const },
          { changeId: 3, status: "pending" as const },
          { changeId: 2, status: "rejected" as const },
        ],
      },
    ];
    expect(pendingTidyChanges(runs).map((change) => change.changeId)).toEqual([3, 1]);
    expect(pendingTidyChanges([])).toEqual([]);
  });

  it("labels change statuses and counts waiting changes in the status line", () => {
    expect(TIDY_CHANGE_STATUS_LABEL).toEqual({
      applied: "Done",
      preview: "Preview",
      pending: "Waiting for you",
      approved: "Approved",
      rejected: "Rejected",
      left: "Left alone",
    });
    expect(tidySummaryLine("on", run("2026-10-01T02:30:00Z"), 2)).toBe(
      "Make changes · last run 2026-10-01 03:30: 1 merged, 2 replaced · 2 waiting for your OK",
    );
  });
});

describe("New badge", () => {
  const lastSeen = Date.parse("2026-10-01T10:00:00Z");
  const entry = (
    kind: "note" | "preference" | "task_summary",
    source: string,
    createdAt: string,
  ) => ({
    kind,
    source,
    createdAt: DateTime.makeUnsafe(createdAt),
  });

  it("marks bot-saved preferences newer than the last visit", () => {
    expect(
      isNewBotPreference(entry("preference", "bot:b1", "2026-10-01T11:00:00Z"), lastSeen),
    ).toBe(true);
  });

  it("leaves everything else unmarked", () => {
    expect(
      isNewBotPreference(entry("preference", "bot:b1", "2026-10-01T09:00:00Z"), lastSeen),
    ).toBe(false);
    expect(isNewBotPreference(entry("preference", "user", "2026-10-01T11:00:00Z"), lastSeen)).toBe(
      false,
    );
    expect(isNewBotPreference(entry("note", "bot:b1", "2026-10-01T11:00:00Z"), lastSeen)).toBe(
      false,
    );
    // First visit on this device: nothing is New.
    expect(isNewBotPreference(entry("preference", "bot:b1", "2026-10-01T11:00:00Z"), null)).toBe(
      false,
    );
  });

  it("reads and writes the last visit, tolerating missing or bad storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
    try {
      expect(readMemoryLastSeen()).toBeNull();
      writeMemoryLastSeen(lastSeen);
      expect(store.get(MEMORY_LAST_SEEN_KEY)).toBe(String(lastSeen));
      expect(readMemoryLastSeen()).toBe(lastSeen);
      store.set(MEMORY_LAST_SEEN_KEY, "garbage");
      expect(readMemoryLastSeen()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
