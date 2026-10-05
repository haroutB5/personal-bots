import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PersonalMemoryService, layer as memoryLayer } from "./PersonalMemoryService.ts";

const TestLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

/** Adds an entry straight into the table with the time given, so a test can lay out a long history. */
const insert = (input: {
  readonly id: string;
  readonly kind: "note" | "preference" | "task_summary";
  readonly content: string;
  readonly updatedAt: string;
  readonly supersededAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_memory (
        memory_id, scope, scope_id, kind, content, source, sensitivity,
        created_at, updated_at, deleted_at, version, superseded_at
      )
      VALUES (
        ${input.id}, 'shared', NULL, ${input.kind}, ${input.content},
        ${input.kind === "task_summary" ? `task:${input.id}` : "user"}, 'normal',
        ${input.updatedAt}, ${input.updatedAt}, NULL, 1, ${input.supersededAt ?? null}
      )
    `;
  });

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();

/** Old rules and notes, then a long run of newer task summaries (the shape of the live data). */
const longHistory = Effect.gen(function* () {
  for (let i = 0; i < 3; i += 1) {
    yield* insert({
      id: `rule-${i}`,
      kind: "preference",
      content: `Rule number ${i}: keep replies short`,
      updatedAt: day(i),
    });
  }
  for (let i = 0; i < 4; i += 1) {
    yield* insert({
      id: `note-${i}`,
      kind: "note",
      content: `Note ${i} about the garden`,
      updatedAt: day(10 + i),
    });
  }
  for (let i = 0; i < 620; i += 1) {
    yield* insert({
      id: `sum-${i}`,
      kind: "task_summary",
      content: `Task summary ${i}`,
      updatedAt: day(100 + i),
    });
  }
});

describe("memory list paging and search", () => {
  it.effect("a long run of newer task summaries no longer hides the older rules", () =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      yield* longHistory;
      // The old behaviour, for the record: the default list is the 500 newest and misses the rules.
      const everything = yield* memory.list({});
      expect(everything).toHaveLength(500);
      expect(everything.some((entry) => entry.kind === "preference")).toBe(false);
      // Asking for the rules returns every one of them, whatever else was saved after.
      const rules = yield* memory.listPage({ kind: "preference", limit: 2000 });
      expect(rules.total).toBe(3);
      expect(rules.entries.map((entry) => entry.memoryId).toSorted()).toEqual([
        "rule-0",
        "rule-1",
        "rule-2",
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pages a kind newest first and says how many there are in all", () =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      yield* longHistory;
      const first = yield* memory.listPage({ kind: "task_summary", limit: 30 });
      expect(first.total).toBe(620);
      expect(first.entries).toHaveLength(30);
      expect(first.entries[0]?.memoryId).toBe("sum-619");
      // A bigger limit is a longer prefix of the same order ("Show more").
      const more = yield* memory.listPage({ kind: "task_summary", limit: 130 });
      expect(more.entries).toHaveLength(130);
      expect(more.entries.slice(0, 30).map((e) => e.memoryId)).toEqual(
        first.entries.map((e) => e.memoryId),
      );
      const notes = yield* memory.listPage({ kind: "note" });
      expect(notes.total).toBe(4);
      expect(notes.entries).toHaveLength(4);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the search covers every entry, not only the page that is loaded", () =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      yield* longHistory;
      // "Rule number 1" is older than 600 newer summaries: only a server-side search finds it.
      const found = yield* memory.listPage({ query: "RULE NUMBER 1", limit: 30 });
      expect(found.entries.map((entry) => entry.memoryId)).toEqual(["rule-1"]);
      expect(found.total).toBe(1);
      const summaries = yield* memory.listPage({
        kind: "task_summary",
        query: "summary 60",
        limit: 5,
      });
      // 60, 600 to 609 (and 600 to 609 each match "summary 60"): 11 in all, 5 shown.
      expect(summaries.total).toBe(11);
      expect(summaries.entries).toHaveLength(5);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("% and _ in a search are plain characters, not wildcards", () =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      yield* insert({ id: "a", kind: "note", content: "Save 50% on shoes", updatedAt: day(1) });
      yield* insert({ id: "b", kind: "note", content: "Save 500 on shoes", updatedAt: day(2) });
      yield* insert({ id: "c", kind: "note", content: "snake_case name", updatedAt: day(3) });
      yield* insert({ id: "d", kind: "note", content: "snakeXcase name", updatedAt: day(4) });
      expect((yield* memory.listPage({ query: "50%" })).entries.map((e) => e.memoryId)).toEqual([
        "a",
      ]);
      expect((yield* memory.listPage({ query: "e_c" })).entries.map((e) => e.memoryId)).toEqual([
        "c",
      ]);
      expect((yield* memory.listPage({ query: "  " })).total).toBe(4);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the replaced list pages and searches the same way", () =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      for (let i = 0; i < 60; i += 1) {
        yield* insert({
          id: `old-${i}`,
          kind: "note",
          content: `Old fact ${i}`,
          updatedAt: day(i),
          supersededAt: day(1000 + i),
        });
      }
      yield* insert({ id: "live", kind: "note", content: "Current fact", updatedAt: day(2000) });
      const page = yield* memory.listPage({ status: "superseded", limit: 50 });
      expect(page.total).toBe(60);
      expect(page.entries).toHaveLength(50);
      expect(page.entries.some((entry) => entry.memoryId === "live")).toBe(false);
      const one = yield* memory.listPage({ status: "superseded", query: "fact 7" });
      expect(one.entries.map((entry) => entry.memoryId)).toEqual(["old-7"]);
      expect((yield* memory.listPage({})).entries.map((entry) => entry.memoryId)).toEqual(["live"]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
