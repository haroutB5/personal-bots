import { memoryLine } from "./memoryBlock.ts";
// Tests for the pure policies extracted from PersonalMemoryService in 1.66.2: who sees and replaces an entry, where a
// note came from and which Undo it gets, which apps a chat carries and when the rules list is resent, how memory ages.
import { describe, expect, it } from "@effect/vitest";
import {
  PersonalMemoryId,
  type PersonalBotId,
  type PersonalMemoryEntry,
  type PersonalMemoryKind,
  type PersonalMemoryScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ActiveApp } from "./memoryApps.ts";
import {
  ageWeight,
  isStatusLike,
  STATUS_HALF_LIFE_DAYS,
  STATUS_MIN_WEIGHT,
  TRACE_PRUNE_EVERY_MS,
  tracePruneDue,
} from "./memoryAgeingPolicy.ts";
import { carryActiveApps, preferenceSend, sessionHoldsRules } from "./memoryContextPolicy.ts";
import type { SentPreferences } from "./memoryCore.ts";
import {
  isOwnerMessageId,
  originOfMessage,
  undoRoute,
  usedWebTool,
  WEB_TOOL_NEEDLES,
  WEB_TOOL_PATTERN,
} from "./memoryProvenancePolicy.ts";
import {
  capPreferences,
  dedupeKey,
  replaceRefusal,
  SCOPE_REACH,
  visibleTo,
} from "./memoryScopePolicy.ts";
import {
  PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
  PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
  RULE_FORGOTTEN_REASON,
} from "./memoryShared.ts";

const entry = (
  over: Partial<{
    id: string;
    scope: PersonalMemoryScope;
    scopeId: string | null;
    kind: PersonalMemoryKind;
    content: string;
  }> = {},
): PersonalMemoryEntry =>
  ({
    memoryId: PersonalMemoryId.make(over.id ?? "m-1"),
    scope: over.scope ?? "shared",
    scopeId: over.scopeId ?? null,
    kind: over.kind ?? "note",
    content: over.content ?? "A fact.",
    source: "user",
    sensitivity: "normal",
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    version: 1,
    supersededAt: null,
    supersededBy: null,
    supersededReason: null,
    apps: null,
    demoted: null,
  }) as unknown as PersonalMemoryEntry;

const bot = (id: string) => id as PersonalBotId;

describe("memoryScopePolicy", () => {
  it("shared entries are visible to every bot, bot entries to their bot, team entries to that team (any case)", () => {
    expect(visibleTo(entry({ scope: "shared" }), bot("a"), null)).toBe(true);
    expect(visibleTo(entry({ scope: "bot", scopeId: "a" }), bot("a"), null)).toBe(true);
    expect(visibleTo(entry({ scope: "bot", scopeId: "a" }), bot("b"), "Dev")).toBe(false);
    expect(visibleTo(entry({ scope: "team", scopeId: "dev" }), bot("a"), "Dev")).toBe(true);
    expect(visibleTo(entry({ scope: "team", scopeId: "dev" }), bot("a"), "Ops")).toBe(false);
    // A bot with no team sees no team entry; a project entry is never visible this way.
    expect(visibleTo(entry({ scope: "team", scopeId: "dev" }), bot("a"), null)).toBe(false);
    expect(visibleTo(entry({ scope: "team", scopeId: null }), bot("a"), "Dev")).toBe(false);
    expect(visibleTo(entry({ scope: "project", scopeId: "p" }), bot("a"), "Dev")).toBe(false);
  });

  it("a save may not replace an entry that reaches more bots, nor a task summary", () => {
    expect(SCOPE_REACH.shared).toBeGreaterThan(SCOPE_REACH.team);
    expect(SCOPE_REACH.team).toBeGreaterThan(SCOPE_REACH.bot);
    expect(replaceRefusal(entry({ scope: "shared" }), "bot")).toContain(
      "reaches fewer bots than the shared entry",
    );
    expect(replaceRefusal(entry({ scope: "team" }), "bot")).toContain("Save it as team instead");
    expect(replaceRefusal(entry({ scope: "bot" }), "shared")).toBeNull();
    expect(replaceRefusal(entry({ scope: "shared" }), "shared")).toBeNull();
    expect(replaceRefusal(entry({ scope: "bot" }), "project")).toBeNull();
    expect(replaceRefusal(entry({ kind: "task_summary", scope: "bot" }), "shared")).toBe(
      "Task summaries cannot be replaced, so nothing was saved.",
    );
  });

  it("dedupeKey ignores case and spacing", () => {
    expect(dedupeKey("  Use   TABS\nplease ")).toBe(dedupeKey("use tabs please"));
    expect(dedupeKey("use tabs")).not.toBe(dedupeKey("use spaces"));
  });

  it("capPreferences keeps the newest within the entry cap, drops from the first that does not fit, returns oldest first", () => {
    const newestFirst = Array.from({ length: PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES + 5 }, (_, i) =>
      entry({ id: `r-${i}`, kind: "preference", content: `rule number ${i}` }),
    );
    const capped = capPreferences(newestFirst);
    expect(capped.kept.length).toBe(PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES);
    expect(capped.dropped).toBe(5);
    // Oldest of the kept first: the newest rule is last.
    expect(capped.kept.at(-1)?.memoryId).toBe("r-0");
    expect(capped.kept[0]?.memoryId).toBe(`r-${PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES - 1}`);
  });

  it("counts the complete rendered rule line against the character cap", () => {
    const rule = entry({
      id: "near-cap",
      kind: "preference",
      content: "x".repeat(PERSONAL_MEMORY_PREFERENCE_MAX_CHARS - 5),
    });
    expect(memoryLine(rule).length).toBeGreaterThan(PERSONAL_MEMORY_PREFERENCE_MAX_CHARS);
    expect(capPreferences([rule]).kept).toEqual([]);
  });

  it("capPreferences never lets a shorter older rule jump the queue past one that did not fit, and counts duplicates once", () => {
    const big = "x".repeat(PERSONAL_MEMORY_PREFERENCE_MAX_CHARS - 10);
    const capped = capPreferences([
      entry({ id: "new", kind: "preference", content: "short new rule" }),
      entry({ id: "big", kind: "preference", content: big }),
      entry({ id: "old", kind: "preference", content: "short old rule" }),
      entry({ id: "dupe", kind: "preference", content: "Short  NEW rule" }),
    ]);
    expect(capped.kept.map((e) => e.memoryId)).toEqual(["new"]);
    expect(capped.dropped).toBe(2);
  });
});

describe("memoryProvenancePolicy", () => {
  it("a message not written by the app is the owner's", () => {
    expect(isOwnerMessageId("0b1f-user-message")).toBe(true);
    expect(isOwnerMessageId("personal-task-abc")).toBe(false);
  });

  it("the origin of a turn comes from the id of the message that started it", () => {
    expect(originOfMessage("0b1f", null)).toBe("chat");
    expect(originOfMessage("personal-task-1", "user")).toBe("task");
    expect(originOfMessage("personal-task-1", "delegation")).toBe("task");
    expect(originOfMessage("personal-task-1", "routine")).toBe("routine");
    expect(originOfMessage("personal-relay-1", null)).toBe("bot");
    expect(originOfMessage("personal-group-1", null)).toBe("bot");
    expect(originOfMessage("personal-lead-answer-1", null)).toBe("bot");
    expect(originOfMessage("personal-notice-1", null)).toBe("app");
  });

  it("web tools are found by item type or by tool name, in any case", () => {
    expect(usedWebTool([])).toBe(false);
    expect(usedWebTool([{ itemType: "web_search", text: "Searched" }])).toBe(true);
    expect(
      usedWebTool([{ itemType: "mcp_tool_call", text: "mcp__t3__read_pages https://x" }]),
    ).toBe(true);
    expect(usedWebTool([{ itemType: null, text: "WebFetch https://example.com" }])).toBe(true);
    expect(usedWebTool([{ itemType: "command", text: "ran git status" }])).toBe(false);
  });

  it("the SQL needles and the pattern name the same tools", () => {
    for (const needle of WEB_TOOL_NEEDLES) {
      expect(WEB_TOOL_PATTERN.test(`${needle}x`)).toBe(true);
    }
  });

  it("a rule a bot saved at the owner's word gets the rule Undo; a forgotten rule comes back whatever its source", () => {
    const rule = (source: string, supersededReason: string | null) => ({
      kind: "preference" as const,
      source,
      supersededReason,
    });
    expect(undoRoute(rule("bot:b1;rule", null), "archive")).toBe("rule");
    expect(undoRoute(rule("bot:b1;rule", null), undefined)).toBe("rule");
    // Saved before `;rule` existed: archiving it from the chat is refused...
    expect(undoRoute(rule("bot:b1", null), "archive")).toBe("refuse");
    expect(undoRoute(rule("user", null), "archive")).toBe("refuse");
    // ...but a rule forgotten at the owner's word is restorable whatever its source.
    expect(undoRoute(rule("bot:b1", RULE_FORGOTTEN_REASON), "restore")).toBe("rule");
    expect(undoRoute(rule("bot:b1", "Replaced by a newer save."), "restore")).toBe("refuse");
    expect(undoRoute(rule("user", RULE_FORGOTTEN_REASON), "archive")).toBe("refuse");
  });

  it("a note gets the note Undo; a task summary gets none", () => {
    const base = { source: "bot:b1;from=chat", supersededReason: null };
    expect(undoRoute({ kind: "note", ...base }, "archive")).toBe("note");
    expect(undoRoute({ kind: "note", ...base }, "restore")).toBe("note");
    expect(undoRoute({ kind: "task_summary", ...base }, "archive")).toBe("refuse");
  });
});

describe("memoryContextPolicy", () => {
  const app = (slug: string, via: ActiveApp["via"][number] = "message"): ActiveApp => ({
    slug,
    via: [via],
  });

  it("a session keeps the apps it has been about, after the ones detected now, capped", () => {
    const sticky = { sessionKey: "s1", slugs: new Set(["caltrack", "matchday"]) };
    const carried = carryActiveApps({
      detected: [app("matchday")],
      session: { key: "s1", fresh: false },
      sticky,
      max: 8,
    });
    expect(carried.map((a) => [a.slug, a.via[0]])).toEqual([
      ["matchday", "message"],
      ["caltrack", "earlier"],
    ]);
    expect(
      carryActiveApps({
        detected: [app("matchday")],
        session: { key: "s1", fresh: false },
        sticky,
        max: 1,
      }).map((a) => a.slug),
    ).toEqual(["matchday"]);
  });

  it("nothing is carried into a new session key, a fresh session or a turn with no session", () => {
    const sticky = { sessionKey: "s1", slugs: new Set(["caltrack"]) };
    const detected = [app("matchday")];
    const only = (session: { key: string; fresh: boolean } | undefined) =>
      carryActiveApps({ detected, session, sticky, max: 8 }).map((a) => a.slug);
    expect(only({ key: "s2", fresh: false })).toEqual(["matchday"]);
    expect(only({ key: "s1", fresh: true })).toEqual(["matchday"]);
    expect(only(undefined)).toEqual(["matchday"]);
    expect(
      carryActiveApps({
        detected,
        session: { key: "s1", fresh: false },
        sticky: undefined,
        max: 8,
      }).map((a) => a.slug),
    ).toEqual(["matchday"]);
  });

  const previous = (over: Partial<SentPreferences> = {}): SentPreferences => ({
    sessionKey: "s1",
    setKey: "a:1,b:1",
    ids: new Map([
      ["a", 1],
      ["b", 1],
    ]),
    sentAt: "2026-10-07T10:00:00.000Z",
    turns: 2,
    ...over,
  });

  it("the session holds the rules sent earlier only for the same session, not fresh, with rules, and before the resend turn", () => {
    const base = {
      session: { key: "s1", fresh: false },
      listedCount: 2,
      previous: previous(),
      resendEvery: 12,
    };
    expect(sessionHoldsRules(base)).toBe(true);
    expect(sessionHoldsRules({ ...base, session: undefined })).toBe(false);
    expect(sessionHoldsRules({ ...base, session: { key: "s1", fresh: true } })).toBe(false);
    expect(sessionHoldsRules({ ...base, session: { key: "s2", fresh: false } })).toBe(false);
    expect(sessionHoldsRules({ ...base, listedCount: 0 })).toBe(false);
    expect(sessionHoldsRules({ ...base, previous: undefined })).toBe(false);
    // turns + 1 < resendEvery: turn 11 of 12 is the last reminder, the 12th resends in full.
    expect(sessionHoldsRules({ ...base, previous: previous({ turns: 10 }) })).toBe(true);
    expect(sessionHoldsRules({ ...base, previous: previous({ turns: 11 }) })).toBe(false);
  });

  const rule = (id: string, apps: ReadonlyArray<string> | null = null) => ({ memoryId: id, apps });

  it("an unchanged set is a one-line repeat", () => {
    const listed = [rule("a"), rule("b")];
    const send = preferenceSend({
      reusable: true,
      previous: previous(),
      setKey: "a:1,b:1",
      currentIds: new Map([
        ["a", 1],
        ["b", 1],
      ]),
      listed,
      scoping: true,
    });
    expect(send).toEqual({ repeat: true, addedRules: [], delta: false });
  });

  it("with app scoping, rules added for an app are sent alone on top of the earlier list", () => {
    const listed = [rule("a"), rule("b"), rule("c", ["matchday"])];
    const input = {
      reusable: true,
      previous: previous(),
      setKey: "a:1,b:1,c:1",
      currentIds: new Map([
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ]),
      listed,
      scoping: true,
    };
    const send = preferenceSend(input);
    expect(send.repeat).toBe(false);
    expect(send.addedRules.map((r) => r.memoryId)).toEqual(["c"]);
    expect(send.delta).toBe(true);
    // Without app scoping, or when an added rule is global, the full list goes again (no delta).
    expect(preferenceSend({ ...input, scoping: false }).delta).toBe(false);
    expect(preferenceSend({ ...input, listed: [rule("a"), rule("b"), rule("c")] }).delta).toBe(
      false,
    );
  });

  it("a changed rule (new version) or a removed rule sends the full list again", () => {
    const listed = [rule("a"), rule("b", ["matchday"])];
    const changed = preferenceSend({
      reusable: true,
      previous: previous(),
      setKey: "a:2,b:1",
      currentIds: new Map([
        ["a", 2],
        ["b", 1],
      ]),
      listed,
      scoping: true,
    });
    expect(changed).toEqual({ repeat: false, addedRules: [], delta: false });
    const notReusable = preferenceSend({
      reusable: false,
      previous: previous(),
      setKey: "a:1,b:1",
      currentIds: new Map([
        ["a", 1],
        ["b", 1],
      ]),
      listed,
      scoping: true,
    });
    expect(notReusable).toEqual({ repeat: false, addedRules: [], delta: false });
  });
});

describe("memoryAgeingPolicy", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 9, 7);

  it("traces are cleared when never cleared before, then at most once an hour", () => {
    expect(TRACE_PRUNE_EVERY_MS).toBe(3_600_000);
    expect(tracePruneDue(now, Number.NEGATIVE_INFINITY)).toBe(true);
    expect(tracePruneDue(now, now - 30 * 60_000)).toBe(false);
    expect(tracePruneDue(now, now - TRACE_PRUNE_EVERY_MS)).toBe(false);
    expect(tracePruneDue(now, now - TRACE_PRUNE_EVERY_MS - 1)).toBe(true);
  });

  it("a durable note keeps its weight whatever its age; a status note halves every half-life down to a floor", () => {
    const durable = {
      kind: "note" as const,
      content: "Harout prefers green tea.",
      source: "user",
      updatedAtMs: now - 400 * DAY,
    };
    const status = {
      kind: "note" as const,
      content: "hbots 1.66.1 is live since this morning.",
      source: "bot:b1;from=task",
      updatedAtMs: now,
    };
    expect(isStatusLike(durable)).toBe(false);
    expect(ageWeight(durable, now)).toBe(1);
    expect(isStatusLike(status)).toBe(true);
    expect(ageWeight(status, now)).toBe(1);
    expect(
      ageWeight({ ...status, updatedAtMs: now - STATUS_HALF_LIFE_DAYS * DAY }, now),
    ).toBeCloseTo(0.5, 5);
    expect(
      ageWeight({ ...status, updatedAtMs: now - 2 * STATUS_HALF_LIFE_DAYS * DAY }, now),
    ).toBeCloseTo(0.25, 5);
    // Ranked lower, never lost.
    expect(ageWeight({ ...status, updatedAtMs: now - 500 * DAY }, now)).toBe(STATUS_MIN_WEIGHT);
  });

  it("task summaries age like status; the date a note states counts, not a later edit", () => {
    const summary = {
      kind: "task_summary" as const,
      content: 'Task "Release check": done.',
      source: "task:1",
      updatedAtMs: now - STATUS_HALF_LIFE_DAYS * DAY,
    };
    expect(isStatusLike(summary)).toBe(true);
    expect(ageWeight(summary, now)).toBeCloseTo(0.5, 5);
    const dated = {
      kind: "note" as const,
      content: "2026-09-09: hbots 1.60.0 deployed.",
      source: "bot:b1;from=app",
      updatedAtMs: now,
    };
    expect(ageWeight(dated, now)).toBeLessThan(0.5);
  });
});
