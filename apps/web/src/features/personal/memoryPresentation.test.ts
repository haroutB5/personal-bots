import type {
  PersonalMemoryRulesUsage,
  PersonalMemoryRulesUsageRow,
  PersonalMemoryTidyChangeStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  appScopeChip,
  appsLabel,
  memorySourceLabel,
  isNewBotPreference,
  MEMORY_LAST_SEEN_KEY,
  memoryDayLabel,
  memoryDayTimeLabel,
  memoryMetaLine,
  memoryTextLookup,
  newestTidyRunsFirst,
  pendingTidyChanges,
  pendingTidyGroups,
  proposerBotName,
  reclassifyDescription,
  rescopeDescription,
  rulesUsageCardModel,
  readMemoryLastSeen,
  memoryReachTag,
  splitPartTag,
  supersedeKeptText,
  TIDY_CHANGE_STATUS_LABEL,
  TIDY_ACTION_LABEL,
  TIDY_MODE_LABEL,
  tidyActionLabel,
  tidyChangeCountLabel,
  tidyCountsLabel,
  tidyEntryTexts,
  tidyProvenanceLabel,
  tidyRequestHeadline,
  tidyRunGroupLabel,
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
      reclassify: "Reclassified",
      save: "New entry",
      forget: "Forgotten",
      split: "Split",
      rescope: "App scope",
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
      withdrawn: "Withdrawn",
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

describe("reclassify changes", () => {
  it("describes the new kind and reach in words", () => {
    expect(reclassifyDescription({ toKind: "preference" })).toBe("Make it a preference");
    expect(reclassifyDescription({ toScope: "team", toScopeId: "dev" })).toBe("Reach: Dev team");
    expect(reclassifyDescription({ toKind: "note", toScope: "shared", toScopeId: null })).toBe(
      "Make it a note · Reach: All bots",
    );
    expect(reclassifyDescription({ toScope: "team", toScopeId: "finance" })).toBe("Reach: finance");
    expect(reclassifyDescription({ toKind: null, toScope: null })).toBe("");
  });

  it("labels a reclassify as a request while pending", () => {
    expect(tidyActionLabel({ action: "reclassify", status: "pending" })).toBe("Reclassify");
    expect(tidyActionLabel({ action: "reclassify", status: "approved" })).toBe("Reclassified");
    expect(tidyActionLabel({ action: "merge", status: "pending" })).toBe("Merged");
  });
});

describe("pending tidy groups", () => {
  const groupRun = (
    runId: string,
    model: string | null,
    startedAt: string,
    changes: ReadonlyArray<{ changeId: number; status: PersonalMemoryTidyChangeStatus }>,
  ) => ({ runId, model, startedAt: DateTime.makeUnsafe(startedAt), changes });

  it("groups pending changes by run with a header each, dropping empty runs", () => {
    const groups = pendingTidyGroups([
      groupRun("r2", "claude-sonnet", "2026-10-02T02:30:00Z", [
        { changeId: 5, status: "pending" },
        { changeId: 6, status: "applied" },
      ]),
      groupRun("r1", "proposals: Memory review", "2026-10-01T18:00:00Z", [
        { changeId: 1, status: "pending" },
        { changeId: 2, status: "pending" },
        { changeId: 5, status: "pending" },
      ]),
      groupRun("r0", null, "2026-09-30T02:30:00Z", [{ changeId: 9, status: "rejected" }]),
    ]);
    expect(
      groups.map((group) => [group.runId, group.label, group.changes.map((c) => c.changeId)]),
    ).toEqual([
      ["r2", "Nightly tidy-up 2 Oct 03:30", [5]],
      ["r1", "Proposals: Memory review", [1, 2]],
    ]);
  });

  it("names a proposals run with no name plainly", () => {
    expect(
      tidyRunGroupLabel({
        model: "proposals: ",
        startedAt: DateTime.makeUnsafe("2026-10-02T02:30:00Z"),
      }),
    ).toBe("Proposals");
  });
});

describe("bot requests", () => {
  const botName = (botId: string) => (botId === "b1" ? "CTO" : undefined);

  it("labels save and forget, as requests while pending", () => {
    expect(TIDY_ACTION_LABEL.save).toBe("New entry");
    expect(TIDY_ACTION_LABEL.forget).toBe("Forgotten");
    expect(tidyActionLabel({ action: "save", status: "pending" })).toBe("Save");
    expect(tidyActionLabel({ action: "forget", status: "pending" })).toBe("Forget");
    expect(tidyActionLabel({ action: "save", status: "approved" })).toBe("New entry");
  });

  it("says what a bot wants to save or forget", () => {
    expect(
      tidyRequestHeadline(
        {
          action: "save",
          proposedBy: "bot:b1",
          toKind: "preference",
          toScope: "team",
          toScopeId: "dev",
        },
        botName,
      ),
    ).toBe("CTO wants to save a preference for Dev team");
    expect(
      tidyRequestHeadline(
        { action: "save", proposedBy: "bot:gone", toKind: "note", toScope: "shared" },
        botName,
      ),
    ).toBe("A bot wants to save a note for All bots");
    expect(tidyRequestHeadline({ action: "forget", proposedBy: "bot:b1" }, botName)).toBe(
      "CTO asks to forget:",
    );
    expect(tidyRequestHeadline({ action: "merge", proposedBy: "tidy-up" }, botName)).toBe("");
  });

  it("says where a pending change came from", () => {
    expect(tidyProvenanceLabel("tidy-up", botName)).toBe("From the nightly tidy-up");
    expect(tidyProvenanceLabel("bot:b1", botName)).toBe("From CTO");
    expect(tidyProvenanceLabel("bot:gone", botName)).toBe("From a bot");
    expect(tidyProvenanceLabel("file:memory-review.md", botName)).toBe(
      "From the file memory-review.md",
    );
    expect(tidyProvenanceLabel(null, botName)).toBeNull();
    expect(proposerBotName("file:x", botName)).toBe("A bot");
  });

  it("heads a bot-request run as Bot requests", () => {
    expect(
      tidyRunGroupLabel({
        model: "proposals: from bots, 2 Oct",
        startedAt: DateTime.makeUnsafe("2026-10-02T09:00:00Z"),
      }),
    ).toBe("Bot requests 2 Oct");
  });
});

describe("splits and bot-only saves", () => {
  const botName = (botId: string) => (botId === "b2" ? "CFO" : undefined);

  it("labels a split, as a request while pending", () => {
    expect(TIDY_ACTION_LABEL.split).toBe("Split");
    expect(tidyActionLabel({ action: "split", status: "pending" })).toBe("Split");
    expect(tidyActionLabel({ action: "split", status: "applied" })).toBe("Split");
  });

  it("says a bot-only save is for the bot itself", () => {
    expect(
      tidyRequestHeadline(
        { action: "save", proposedBy: "bot:b2", toKind: "preference", toScope: "bot" },
        botName,
      ),
    ).toBe("CFO wants to save a preference for itself");
    expect(reclassifyDescription({ toScope: "bot", toScopeId: "b2" })).toBe("Reach: One bot");
  });

  it("tags each split part with its kind and reach", () => {
    expect(splitPartTag({ content: "x", kind: "preference", scope: "team", scopeId: "dev" })).toBe(
      "Preference · Dev team",
    );
    expect(splitPartTag({ content: "x", kind: "note", scope: "shared", scopeId: null })).toBe(
      "Note · All bots",
    );
    expect(splitPartTag({ content: "x", kind: "note", scope: "team", scopeId: null })).toBe(
      "Note · One team",
    );
  });

  it("finds the newer entry a supersede keeps", () => {
    const texts = new Map([["m-new", "Lives in Leeds"]]);
    expect(supersedeKeptText({ resultMemoryId: "m-new", content: "Lives in York" }, texts)).toBe(
      "Lives in York",
    );
    expect(supersedeKeptText({ resultMemoryId: "m-new", content: null }, texts)).toBe(
      "Lives in Leeds",
    );
    expect(supersedeKeptText({ resultMemoryId: "m-gone", content: null }, texts)).toBe(
      UNLISTED_MEMORY_TEXT,
    );
    // No newer entry: a retirement, nothing kept.
    expect(supersedeKeptText({ resultMemoryId: null, content: null }, texts)).toBeNull();
  });
});

describe("memoryReachTag", () => {
  it("names an entry's kind and reach, bot-only included", () => {
    expect(memoryReachTag({ kind: "preference", scope: "team", scopeId: "Finance" })).toBe(
      "Preference · Finance",
    );
    expect(memoryReachTag({ kind: "note", scope: "shared", scopeId: null })).toBe(
      "Note · All bots",
    );
    expect(memoryReachTag({ kind: "note", scope: "bot", scopeId: "cfo" })).toBe("Note · One bot");
  });
});

describe("1.60.22: a note says where it came from", () => {
  const name = (botId: string) => (botId === "cto" ? "CTO" : undefined);
  const task = () => undefined;
  it("names the bot and the turn it was saved in", () => {
    expect(memorySourceLabel({ source: "bot:cto;from=task" }, name, task)).toBe(
      "Saved by CTO during a task",
    );
    expect(memorySourceLabel({ source: "bot:cto;from=routine+web" }, name, task)).toBe(
      "Saved by CTO during a routine, after reading the web",
    );
    expect(memorySourceLabel({ source: "bot:cto;from=chat" }, name, task)).toBe(
      "Saved by CTO from your message",
    );
  });
  it("keeps the old wording for entries saved before provenance", () => {
    expect(memorySourceLabel({ source: "bot:cto" }, name, task)).toBe(
      "Saved by CTO when you asked",
    );
    expect(memorySourceLabel({ source: "user" }, name, task)).toBe("Saved by you");
  });
});

describe("1.60.40: app scopes in words", () => {
  it("names the apps and chips a scoped rule", () => {
    expect(appsLabel(["matchday"])).toBe("Matchday");
    expect(appsLabel(["matchday", "caltrack"])).toBe("Matchday and CalTrack");
    expect(appsLabel(["matchday", "caltrack", "personal-bots"])).toBe(
      "Matchday, CalTrack and hbots",
    );
    expect(appsLabel(["gizmo-app"])).toBe("gizmo-app");
    expect(appScopeChip({ apps: ["personal-bots"] })).toBe("Only: hbots");
    expect(appScopeChip({ apps: null })).toBe("");
    expect(appScopeChip({})).toBe("");
  });

  it("says what a pending rescope does, and the action's label", () => {
    expect(rescopeDescription({ action: "rescope", toApps: ["matchday"] })).toContain(
      "New app scope: only Matchday",
    );
    expect(rescopeDescription({ action: "rescope", toApps: null })).toContain("all apps (global");
    expect(rescopeDescription({ action: "save", toApps: ["caltrack"] })).toBe(
      "App scope: only CalTrack",
    );
    expect(rescopeDescription({ action: "save", toApps: null })).toBe("");
    expect(rescopeDescription({ action: "merge", toApps: null })).toBe("");
    expect(tidyActionLabel({ action: "rescope", status: "pending" })).toBe("Set app scope");
    expect(TIDY_ACTION_LABEL.rescope).toBe("App scope");
  });
});

describe("1.60.40: the rules limit warning", () => {
  const row = (
    overrides: Partial<PersonalMemoryRulesUsageRow> = {},
  ): PersonalMemoryRulesUsageRow => ({
    botId: "dev",
    botName: "dev (35 bots)",
    entries: 49,
    chars: 12_100,
    globalRules: 19,
    appRules: 30,
    entryShare: 49 / 60,
    charShare: 12_100 / 15_000,
    share: 49 / 60,
    leftOut: [],
    ...overrides,
  });
  const usage = (
    level: PersonalMemoryRulesUsage["level"],
    rows: PersonalMemoryRulesUsageRow[],
    scoping = true,
  ): PersonalMemoryRulesUsage => ({
    maxEntries: 60,
    maxChars: 15_000,
    warnShare: 0.8,
    level,
    scoping,
    rows,
  });

  it("shows nothing while every bot is under 80%", () => {
    expect(rulesUsageCardModel(usage("ok", [row({ share: 0.5 })]))).toBeNull();
    expect(rulesUsageCardModel(usage("near", []))).toBeNull();
  });

  it("warns near the limit with the percentage and what counts", () => {
    const model = rulesUsageCardModel(usage("near", [row()]))!;
    expect(model.tone).toBe("near");
    expect(model.headline).toBe("Rules are 82% of the limit");
    expect(model.detail).toContain("49 of 60 rules at once (12.1k of 15k characters)");
    expect(model.detail).toContain("counting every app");
    expect(model.rows[0]).toMatchObject({
      label: "dev (35 bots)",
      line: "49 of 60 rules · 12.1k of 15k characters",
    });
    expect(model.leftOut).toEqual([]);
  });

  it("names exactly the rules that would not fit when over", () => {
    const model = rulesUsageCardModel(
      usage("over", [
        row({
          entries: 64,
          share: 64 / 60,
          leftOut: [
            { memoryId: "m1" as never, content: "Old Matchday rule." },
            { memoryId: "m2" as never, content: "Older Matchday rule." },
          ],
        }),
      ]),
    )!;
    expect(model.tone).toBe("over");
    expect(model.headline).toBe("2 rules do not fit");
    expect(model.leftOut.map((rule) => rule.content)).toEqual([
      "Old Matchday rule.",
      "Older Matchday rule.",
    ]);
    // The bar never passes its track.
    expect(model.rows[0]!.share).toBe(1);
  });

  it("says when app scoping is switched off", () => {
    const model = rulesUsageCardModel(usage("near", [row()], false))!;
    expect(model.detail).toContain("App scoping is off, so every rule goes to every chat");
    // Only the true sentence: with scoping off, a rule for one app counts everywhere.
    expect(model.detail).not.toContain("only listed in chats about it");
    expect(model.detail).not.toContain("only count in chats about that app");
    const over = rulesUsageCardModel(
      usage(
        "over",
        [
          row({
            entries: 64,
            share: 64 / 60,
            leftOut: [{ memoryId: "m1" as never, content: "R." }],
          }),
        ],
        false,
      ),
    )!;
    expect(over.detail).toContain("App scoping is off");
    expect(over.detail).not.toContain("only count in chats about that app");
    // With scoping on it never says scoping is off.
    expect(rulesUsageCardModel(usage("near", [row()]))!.detail).not.toContain("scoping is off");
  });
});
