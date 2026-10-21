// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { makeAntigravityUsageCache, readAntigravityUsage } from "./antigravityUsageReader.ts";

function encodeVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= 128n) {
    bytes.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeField(
  number: number,
  wireType: number,
  value: number | bigint | string | Buffer,
): Buffer {
  const tag = encodeVarint((number << 3) | wireType);
  if (wireType === 0) {
    return Buffer.concat([tag, encodeVarint(value as number | bigint)]);
  } else if (wireType === 2) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    return Buffer.concat([tag, encodeVarint(buf.length), buf]);
  }
  throw new Error("unsupported wireType");
}

function makeUsage(
  uncached: number,
  cached: number,
  output: number,
  reasoning = 0,
  cacheCreation = 0,
  responseId?: string,
): Buffer {
  return Buffer.concat([
    encodeField(2, 0, uncached),
    encodeField(5, 0, cached),
    encodeField(4, 0, cacheCreation),
    encodeField(3, 0, output),
    encodeField(9, 0, reasoning),
    ...(responseId === undefined ? [] : [encodeField(11, 2, Buffer.from(responseId, "utf8"))]),
  ]);
}

function makeStepMetadata(
  model: string,
  timestampMs: number,
  uncached: number,
  cached: number,
  output: number,
  reasoning = 0,
): Buffer {
  const usageBuf = makeUsage(uncached, cached, output, reasoning);
  const sec = Math.floor(timestampMs / 1000);
  const nano = (timestampMs % 1000) * 1_000_000;
  const timeBuf = Buffer.concat([encodeField(1, 0, sec), encodeField(2, 0, nano)]);
  const modelBuf = Buffer.concat([encodeField(12, 2, Buffer.from(model, "utf8"))]);
  return Buffer.concat([
    encodeField(24, 2, modelBuf),
    encodeField(9, 2, usageBuf),
    encodeField(8, 2, timeBuf),
  ]);
}

function makeGenerationMetadata(
  model: string,
  timestampMs: number,
  usage: Buffer,
  retry?: Buffer,
): Buffer {
  const sec = Math.floor(timestampMs / 1000);
  const nano = (timestampMs % 1000) * 1_000_000;
  const timeBuf = Buffer.concat([encodeField(1, 0, sec), encodeField(2, 0, nano)]);
  return Buffer.concat([
    encodeField(
      1,
      2,
      Buffer.concat([
        encodeField(4, 2, usage),
        encodeField(19, 2, Buffer.from(model, "utf8")),
        encodeField(9, 2, Buffer.concat([encodeField(4, 2, timeBuf)])),
        ...(retry === undefined ? [] : [encodeField(17, 2, encodeField(2, 2, retry))]),
      ]),
    ),
  ]);
}

describe("antigravityUsageReader", () => {
  it("reads and parses step metadata from conversation sqlite databases", async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-reader-test-"));
    try {
      const sessionId = "11111111-2222-3333-4444-555555555555";
      const dbPath = NodePath.join(tmp, `${sessionId}.db`);
      const db = new NodeSqlite.DatabaseSync(dbPath);
      db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");
      const stmt = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
      const ts = Date.parse("2026-10-21T10:00:00Z");
      stmt.run(1, makeStepMetadata("gemini-3.8-flash-high", ts, 1200, 5000, 300, 100));
      stmt.run(2, makeStepMetadata("gemini-4-argon", ts + 1000, 2000, 10000, 500, 200));
      db.close();

      const cache = makeAntigravityUsageCache();
      const result = await readAntigravityUsage([tmp], 0, cache);
      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(1);
      const file = result.files[0]!;
      expect(file.records).toHaveLength(2);

      const [r1, r2] = file.records;
      expect(r1).toMatchObject({
        provider: "antigravity",
        sessionId,
        model: "gemini-3.8-flash-high",
        rateModel: "gemini-3.8-flash",
        totals: {
          uncachedInputTokens: 1200,
          cachedInputTokens: 5000,
          cacheCreationTokens: 0,
          outputTokens: 300,
          reasoningTokens: 100,
        },
      });
      expect(r2).toMatchObject({
        provider: "antigravity",
        sessionId,
        model: "gemini-4-argon",
        rateModel: "gemini-4-argon",
        totals: {
          uncachedInputTokens: 2000,
          cachedInputTokens: 10000,
          cacheCreationTokens: 0,
          outputTokens: 500,
          reasoningTokens: 200,
        },
      });

      // Second read hits the cache
      const cachedResult = await readAntigravityUsage([tmp], 0, cache);
      expect(cachedResult.files[0]!.records).toHaveLength(2);
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  });

  it("filters records by sinceMs timestamp", async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-since-test-"));
    try {
      const sessionId = "22222222-3333-4444-5555-666666666666";
      const dbPath = NodePath.join(tmp, `${sessionId}.db`);
      const db = new NodeSqlite.DatabaseSync(dbPath);
      db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");
      const stmt = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
      const oldTime = Date.parse("2026-08-01T10:00:00Z");
      const newTime = Date.parse("2026-10-21T10:00:00Z");
      stmt.run(1, makeStepMetadata("gemini-3.8-flash-n", oldTime, 100, 200, 10));
      stmt.run(2, makeStepMetadata("gemini-3.8-flash-high", newTime, 300, 400, 20));
      db.close();

      const result = await readAntigravityUsage([tmp], Date.parse("2026-10-01T00:00:00Z"));
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.records).toHaveLength(1);
      expect(result.files[0]!.records[0]!.totals.uncachedInputTokens).toBe(300);
      expect(result.files[0]!.records[0]!.rateModel).toBe("gemini-3.8-flash");
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  });

  it("counts one Antigravity call once when its step, generation and retry repeat the same totals", async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-dedupe-test-"));
    try {
      const sessionId = "33333333-4444-5555-6666-777777777777";
      const dbPath = NodePath.join(tmp, `${sessionId}.db`);
      const db = new NodeSqlite.DatabaseSync(dbPath);
      const ts = Date.parse("2026-10-21T10:00:00Z");
      const usage = makeUsage(1200, 5000, 300, 100);
      const step = Buffer.concat([
        encodeField(9, 2, usage),
        encodeField(8, 2, encodeField(1, 0, ts / 1000)),
      ]);
      try {
        db.exec(
          "CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);",
        );
        // The row indexes do not line up: the step at idx 1 belongs to the
        // generation at idx 3, which is why the totals are what match them.
        db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)").run(1, step);
        db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(
          3,
          makeGenerationMetadata("Gemini 3 Pro", ts, usage, usage),
        );
      } finally {
        db.close();
      }

      const deduped = await readAntigravityUsage([tmp], 0);
      expect(deduped.errors).toEqual([]);
      expect(deduped.files[0]!.records).toHaveLength(1);
      expect(deduped.files[0]!.records[0]).toMatchObject({
        sessionId,
        model: "gemini-3-pro",
        timestampMs: ts,
        totals: {
          uncachedInputTokens: 1200,
          cachedInputTokens: 5000,
          cacheCreationTokens: 0,
          outputTokens: 300,
          reasoningTokens: 100,
        },
      });

      // The kill switch restores release-1.66.79, which counted all three.
      const legacy = await readAntigravityUsage([tmp], 0, undefined, { dedupe: false });
      expect(legacy.files[0]!.records).toHaveLength(3);
      expect(
        legacy.files[0]!.records.reduce(
          (sum, record) => sum + record.totals.uncachedInputTokens,
          0,
        ),
      ).toBe(3600);
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps two Antigravity generations in one session apart when their totals coincide", async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-same-totals-test-"));
    try {
      const dbPath = NodePath.join(tmp, "44444444-5555-6666-7777-888888888888.db");
      const db = new NodeSqlite.DatabaseSync(dbPath);
      const usage = makeUsage(10, 0, 5);
      try {
        db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
        const insert = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
        insert.run(
          0,
          makeGenerationMetadata("Gemini 3 Pro", Date.parse("2026-10-21T10:00:00Z"), usage),
        );
        insert.run(
          1,
          makeGenerationMetadata("Gemini 3 Pro", Date.parse("2026-10-21T10:00:20Z"), usage),
        );
      } finally {
        db.close();
      }
      const result = await readAntigravityUsage([tmp], 0);
      expect(result.errors).toEqual([]);
      expect(result.files[0]!.records.map((record) => record.timestampMs)).toEqual([
        Date.parse("2026-10-21T10:00:00Z"),
        Date.parse("2026-10-21T10:00:20Z"),
      ]);
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps repeated Antigravity step totals apart when no generation matches them", async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-steps-only-test-"));
    try {
      const dbPath = NodePath.join(tmp, "55555555-6666-7777-8888-999999999999.db");
      const db = new NodeSqlite.DatabaseSync(dbPath);
      try {
        db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)");
        const insert = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
        const ts = Date.parse("2026-10-21T10:00:00Z");
        insert.run(0, makeStepMetadata("gemini-3.8-flash-high", ts, 10, 0, 5));
        insert.run(1, makeStepMetadata("gemini-3.8-flash-high", ts + 20_000, 10, 0, 5));
      } finally {
        db.close();
      }
      const result = await readAntigravityUsage([tmp], 0);
      expect(result.errors).toEqual([]);
      expect(result.files[0]!.records).toHaveLength(2);
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  });

  it("ignores corrupted databases without crashing", async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-err-test-"));
    try {
      await NodeFSP.writeFile(NodePath.join(tmp, "corrupt.db"), "not an sqlite database");
      const result = await readAntigravityUsage([tmp], 0);
      expect(result.errors).toHaveLength(1);
      expect(result.files).toHaveLength(0);
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  });
});
