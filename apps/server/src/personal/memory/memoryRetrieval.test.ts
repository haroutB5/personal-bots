import { describe, expect, it } from "@effect/vitest";

import { mentionsApp } from "./memoryApps.ts";
import {
  ageWeight,
  capByChars,
  contextualRetrievalEnabled,
  isStatusLike,
  limitSummariesPerTitle,
  memoryQueryTerms,
  RETRIEVAL_ENV,
  rankCandidates,
  selectQueryTerms,
  statedDateMs,
  MAX_FOLLOW_UP_TERMS,
  STATUS_HALF_LIFE_DAYS,
  STATUS_MIN_WEIGHT,
  termsToMatch,
  type RankEntry,
} from "./memoryRetrieval.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");

const entry = (
  id: string,
  content: string,
  overrides: Partial<RankEntry> & { readonly daysOld?: number } = {},
): RankEntry => ({
  memoryId: id,
  kind: "note",
  content,
  source: "bot:cto;from=chat",
  updatedAtMs: NOW - (overrides.daysOld ?? 0) * DAY,
  ...overrides,
});

describe("search words", () => {
  const frequency = new Map<string, number>([
    ["works", 120],
    ["thx", 3],
    ["hbots", 9],
    ["memory", 14],
    ["retrieval", 2],
    ["release", 40],
    ["garmin", 3],
  ]);
  const total = 400;

  it("searches by the chat's topic when the message is a thin follow-up", () => {
    const picked = selectQueryTerms(
      {
        current: "This works thx",
        title: "hbots memory",
        appWords: ["hbots personal-bots"],
        recent: ["I changed the memory retrieval so it reads the title"],
      },
      frequency,
      total,
    );
    expect(picked.followUp).toBe(true);
    // "works" is in 30% of entries: it says nothing.
    expect(picked.terms).not.toContain("works");
    expect(picked.terms).toContain("hbots");
    expect(picked.terms).toContain("memory");
    expect(picked.terms).toContain("retrieval");
    expect(picked.terms).not.toContain("garmin");
  });

  it("keeps a rich message in charge and adds only a few context words", () => {
    const picked = selectRules("hbots memory retrieval release", {
      title: "hbots memory",
      recent: ["garmin"],
    });
    expect(picked.followUp).toBe(false);
    expect(picked.terms.slice(0, 4).toSorted()).toEqual(
      ["hbots", "memory", "release", "retrieval"].toSorted(),
    );
    expect(picked.terms.length).toBeLessThanOrEqual(16);

    function selectRules(current: string, rest: { title: string; recent: Array<string> }) {
      return selectQueryTerms({ current, ...rest }, frequency, total);
    }
  });

  it("finds nothing to search by when no word is in memory", () => {
    const picked = selectQueryTerms({ current: "zzz qqq" }, frequency, total);
    expect(picked.terms).toEqual([]);
    expect(termsToMatch(picked.terms)).toBeNull();
  });

  it("does not drop common words from a tiny memory", () => {
    const picked = selectQueryTerms({ current: "works" }, new Map([["works", 3]]), 10);
    expect(picked.terms).toEqual(["works"]);
  });

  it("quotes terms so FTS syntax is inert", () => {
    expect(memoryQueryTerms("the AND of NEAR(x")).toEqual(["near"]);
    expect(termsToMatch(["tea", "coffee"])).toBe('"tea" OR "coffee"*');
  });

  it("reads the kill switch", () => {
    expect(contextualRetrievalEnabled({})).toBe(true);
    expect(contextualRetrievalEnabled({ [RETRIEVAL_ENV]: "legacy" })).toBe(false);
  });
});

describe("ageing of status entries", () => {
  it("spots a status entry, not a durable fact", () => {
    expect(isStatusLike(entry("a", "2026-10-04: pending 1.60.37 waiter 67416 stopped."))).toBe(
      true,
    );
    expect(isStatusLike(entry("b", "Backend 1.60.38 live since 16:21, QA SHIP."))).toBe(true);
    expect(
      isStatusLike(entry("c", "hbots 1.60.38 is the rollback.", { source: "bot:x;from=task" })),
    ).toBe(true);
    expect(isStatusLike(entry("d", "Harout's favourite drink is green tea."))).toBe(false);
    // A version alone is not a status, and a status word alone only where a version or an app wrote it.
    expect(
      isStatusLike(
        entry("n", "Node 22.1.0 is required to build hbots.", { source: "bot:x;from=task" }),
      ),
    ).toBe(false);
    expect(
      isStatusLike(entry("u", "Harout decided every fix is QA tested before it is shipped.")),
    ).toBe(false);
    expect(
      isStatusLike(entry("w", "The waiter restarts the server.", { source: "bot:x;from=task" })),
    ).toBe(true);
    expect(isStatusLike(entry("v", "hbots 1.60.30 armed and live."))).toBe(true);
    expect(isStatusLike(entry("e", "Harout lives in London."))).toBe(false);
    expect(isStatusLike(entry("f", "Task summary.", { kind: "task_summary" }))).toBe(true);
    expect(isStatusLike(entry("g", "Always release on Fridays.", { kind: "preference" }))).toBe(
      false,
    );
  });

  it("halves a status entry's weight per half-life, with a floor", () => {
    const status = entry("a", "Release 1.60.37 armed.", { daysOld: 0 });
    expect(ageWeight(status, NOW)).toBe(1);
    expect(
      ageWeight({ ...status, updatedAtMs: NOW - STATUS_HALF_LIFE_DAYS * DAY }, NOW),
    ).toBeCloseTo(0.5, 5);
    expect(ageWeight({ ...status, updatedAtMs: NOW - 400 * DAY }, NOW)).toBe(STATUS_MIN_WEIGHT);
    // Durable facts never age.
    expect(ageWeight(entry("d", "Likes green tea.", { daysOld: 400 }), NOW)).toBe(1);
  });

  it("ranks last week's armed note below a durable fact of the same relevance", () => {
    const durable = entry("fact", "hbots keeps task chats archived for 48 hours.", { daysOld: 30 });
    const status = entry("status", "hbots 1.60.30 armed and live.", { daysOld: 28 });
    const { picked } = rankCandidates(
      [
        { entry: status, bm25: -5 },
        { entry: durable, bm25: -5 },
      ],
      { nowMs: NOW, floor: 0.2, limit: 6 },
    );
    expect(picked.map((row) => row.entry.memoryId)).toEqual(["fact", "status"]);
    expect(picked[1]!.why[0]).toContain("older status entry");
  });

  it("lets a much more relevant old status entry still win: ranked lower, never lost", () => {
    const status = entry("status", "hbots 1.60.30 armed and live.", { daysOld: 40 });
    const weak = entry("weak", "hbots is an app.", { daysOld: 1 });
    const { picked } = rankCandidates(
      [
        { entry: weak, bm25: -2 },
        { entry: status, bm25: -30 },
      ],
      { nowMs: NOW, floor: 0.2, limit: 6 },
    );
    expect(picked[0]!.entry.memoryId).toBe("status");
  });

  it("legacy mode ranks by bm25 alone", () => {
    const status = entry("status", "hbots 1.60.30 armed.", { daysOld: 100 });
    const fact = entry("fact", "hbots keeps archives.", { daysOld: 100 });
    const { picked } = rankCandidates(
      [
        { entry: fact, bm25: -4 },
        { entry: status, bm25: -5 },
      ],
      { nowMs: NOW, floor: 0.2, limit: 6, ageing: false },
    );
    expect(picked.map((row) => row.entry.memoryId)).toEqual(["status", "fact"]);
  });
});

describe("ranking and caps", () => {
  const options = {
    nowMs: NOW,
    floor: 0.2,
    limit: 6,
    mentionsApp,
    knownApps: ["matchday", "caltrack", "personal-bots"],
  };

  it("boosts an active app's entries and cuts another app's", () => {
    const mine = entry("mine", "hbots queue notes.");
    const other = entry("other", "Matchday standings notes.");
    const { picked } = rankCandidates(
      [
        { entry: other, bm25: -5 },
        { entry: mine, bm25: -5 },
      ],
      { ...options, activeApps: new Set(["personal-bots"]) },
    );
    expect(picked.map((row) => row.entry.memoryId)).toEqual(["mine", "other"]);
    expect(picked[0]!.why).toContain("names an app this chat is about");
    expect(picked[1]!.why).toContain("about another app");
  });

  it("drops matches far weaker than the best, and reports the cut", () => {
    const { picked, leftOut } = rankCandidates(
      [
        { entry: entry("a", "strong"), bm25: -10 },
        { entry: entry("b", "weak"), bm25: -1 },
      ],
      { ...options },
    );
    expect(picked.map((row) => row.entry.memoryId)).toEqual(["a"]);
    expect(leftOut.map((row) => row.entry.memoryId)).toEqual(["b"]);
  });

  it("stops at the limit", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      entry: entry(`n${i}`, `note ${i}`),
      bm25: -10 + i * 0.1,
    }));
    const { picked, leftOut } = rankCandidates(rows, options);
    expect(picked).toHaveLength(6);
    expect(leftOut).toHaveLength(3);
  });

  it("demotes entries the owner marked outdated", () => {
    const { picked } = rankCandidates(
      [
        { entry: entry("old", "outdated"), bm25: -10 },
        { entry: entry("fresh", "fresh"), bm25: -6 },
      ],
      { ...options, demoted: new Set(["old"]) },
    );
    expect(picked.map((row) => row.entry.memoryId)).toEqual(["fresh"]);
  });

  it("caps the picked entries by characters, lowest ranked first to go", () => {
    const ranked = ["a", "b", "c", "d"].map((id) => ({ entry: entry(id, id.repeat(100)) }));
    const capped = capByChars(ranked, () => 1_500, 4_000);
    expect(capped.kept.map((row) => row.entry.memoryId)).toEqual(["a", "b"]);
    expect(capped.leftOut.map((row) => row.entry.memoryId)).toEqual(["c", "d"]);
  });
});

describe("1.60.40 refinements", () => {
  it("reads the date an entry states, and ages by it when a later edit made it look newer", () => {
    expect(statedDateMs("2026-09-25: hbots 1.43.0 live")).toBe(Date.UTC(2026, 8, 25));
    expect(statedDateMs("(2026-10-02) Backend runs Opus.")).toBe(Date.UTC(2026, 9, 2));
    expect(
      statedDateMs(`${"Backend runs Opus and many other things. ".repeat(3)}Since 2026-10-02.`),
    ).toBeNull();
    expect(statedDateMs("No date here.")).toBeNull();
    // Written 2 days ago, but about a release armed 20 days ago.
    const edited = entry("a", "2026-09-14: hbots 1.40.0 armed and live.", { daysOld: 2 });
    const plain = entry("b", "hbots 1.40.0 armed and live.", { daysOld: 2 });
    expect(ageWeight(edited, NOW)).toBeLessThan(ageWeight(plain, NOW));
    expect(ageWeight(edited, NOW)).toBeCloseTo(0.5 ** (20.5 / STATUS_HALF_LIFE_DAYS), 1);
  });

  it("keeps at most two task summaries of one title, in rank order, and passes notes through", () => {
    const summary = (title: string, n: number) => ({
      kind: "task_summary",
      content: `Task "${title}": run ${n}.`,
    });
    const kept = limitSummariesPerTitle([
      summary("Hourly monitor", 1),
      summary("Hourly monitor", 2),
      { kind: "note", content: "A note." },
      summary("Hourly monitor", 3),
      summary("Other task", 1),
      summary("Hourly monitor", 4),
    ]);
    expect(kept.map((row) => row.content)).toEqual([
      'Task "Hourly monitor": run 1.',
      'Task "Hourly monitor": run 2.',
      "A note.",
      'Task "Other task": run 1.',
    ]);
  });

  it("uses fewer words on a follow-up", () => {
    const frequency = new Map(Array.from({ length: 30 }, (_, i) => [`topic${i}`, 3] as const));
    const picked = selectQueryTerms(
      {
        current: "ok",
        title: "topic0 topic1 topic2 topic3 topic4 topic5 topic6",
        recent: ["topic7 topic8 topic9 topic10 topic11 topic12 topic13"],
      },
      frequency,
      400,
    );
    expect(picked.followUp).toBe(true);
    expect(picked.terms.length).toBeLessThanOrEqual(MAX_FOLLOW_UP_TERMS);
  });
});
