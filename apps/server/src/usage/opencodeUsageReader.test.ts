// @effect-diagnostics nodeBuiltinImport:off - seeds a real SQLite file the reader opens by path.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { readOpenCodeUsage } from "./opencodeUsageReader.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const SINCE_MS = Date.parse("2026-08-01T00:00:00Z");
const AT_MS = Date.parse("2026-08-10T12:00:00Z");

async function withStore<A>(
  rows: ReadonlyArray<{ id: string; session: string; created: number; data: string }>,
  run: (root: string) => Promise<A>,
): Promise<A> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-reader-test-"));
  try {
    const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencode.db"));
    database.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) insert.run(row.id, row.session, row.created, row.created, row.data);
    database.close();
    return await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

const assistant = (overrides: Record<string, unknown> = {}) =>
  toJson({
    role: "assistant",
    modelID: "gpt-6-astra",
    sessionID: "ses_1",
    id: "msg_a",
    time: { created: AT_MS },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 800, write: 10 } },
    cost: 0.25,
    ...overrides,
  });

describe("readOpenCodeUsage", () => {
  it("reads token counts from message rows without needing the rest of the row", async () => {
    // A message that also carries over a megabyte of tool output still reads.
    const large = "x".repeat(1_500_000);
    const result = await withStore(
      [
        {
          id: "msg_a",
          session: "ses_1",
          created: AT_MS,
          data: assistant({ output: large }),
        },
        { id: "msg_user", session: "ses_1", created: AT_MS, data: toJson({ role: "user" }) },
        {
          id: "msg_old",
          session: "ses_1",
          created: SINCE_MS - 1000,
          data: assistant({ id: "msg_old" }),
        },
      ],
      (root) => readOpenCodeUsage(root, SINCE_MS),
    );
    const records = result.files.flatMap((file) => file.records);
    expect(result.error).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "opencode",
      model: "gpt-6-astra",
      sessionId: "ses_1",
      timestampMs: AT_MS,
      dedupeKey: "opencode:msg_a",
      reportedCostUsd: 0.25,
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 800,
        cacheCreationTokens: 10,
        // Reasoning is counted inside output.
        outputTokens: 25,
        reasoningTokens: 5,
      },
    });
  });

  it("does not read a row over 2 MB (user messages that carry file diffs)", async () => {
    const result = await withStore(
      [
        {
          id: "msg_user_diff",
          session: "ses_1",
          created: AT_MS,
          data: toJson({ role: "user", summary: { diffs: "d".repeat(2_500_000) } }),
        },
        { id: "msg_ok", session: "ses_1", created: AT_MS + 1, data: assistant({ id: "msg_ok" }) },
      ],
      (root) => readOpenCodeUsage(root, SINCE_MS),
    );
    expect(result.error).toBe(false);
    expect(result.files.flatMap((file) => file.records).map((record) => record.dedupeKey)).toEqual([
      "opencode:msg_ok",
    ]);
  });

  it("skips a damaged row and keeps reading the rest of the table", async () => {
    const result = await withStore(
      [
        { id: "msg_bad", session: "ses_1", created: AT_MS, data: "{not json" },
        { id: "msg_ok", session: "ses_2", created: AT_MS + 1, data: assistant({ id: "msg_ok" }) },
      ],
      (root) => readOpenCodeUsage(root, SINCE_MS),
    );
    const records = result.files.flatMap((file) => file.records);
    expect(result.error).toBe(false);
    expect(records.map((record) => record.dedupeKey)).toEqual(["opencode:msg_ok"]);
  });

  it("takes the model from a model object as well as a flat id", async () => {
    const result = await withStore(
      [
        {
          id: "msg_obj",
          session: "ses_3",
          created: AT_MS,
          data: assistant({ id: "msg_obj", modelID: undefined, model: { id: "claude-opus-5-5" } }),
        },
      ],
      (root) => readOpenCodeUsage(root, SINCE_MS),
    );
    expect(result.files.flatMap((file) => file.records)[0]?.model).toBe("claude-opus-5-5");
  });
});
