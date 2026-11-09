// 1.60.42 rebuild: the trace sink appends without holding the event loop (QA saw synchronous
// server.trace.ndjson writes of 1 to 9 s stall every request behind them).
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { makeTraceSink, type TraceRecord } from "./observability.ts";

const record = (name: string): TraceRecord =>
  ({
    type: "effect-span",
    name,
    traceId: "t",
    spanId: name,
    sampled: true,
    kind: "internal",
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    durationMs: 0,
    attributes: {},
    events: [],
    links: [],
    exit: { _tag: "Success" },
  }) as unknown as TraceRecord;

const names = (path: string) =>
  NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { name: string }).name);

describe("the trace sink does not hold the event loop for a slow disk", () => {
  it.live("a threshold flush returns at once while the append is slow, and nothing is lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-async-" });
        const file = path.join(dir, "shared.trace.ndjson");
        const real = NodeFS.promises.appendFile.bind(NodeFS.promises);
        const gate = { open: null as (() => void) | null };
        const spy = vi
          .spyOn(NodeFS.promises, "appendFile")
          .mockImplementation(async (target, data, options) => {
            // The first append waits until the test lets it go: a stalled disk.
            if (gate.open === null) {
              await new Promise<void>((resolve) => {
                gate.open = resolve;
              });
            }
            return real(target, data, options as never);
          });
        try {
          const sink = yield* makeTraceSink({
            filePath: file,
            maxBytes: 4 * 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 60_000,
          });
          const before = performance.now();
          // 256 records reach the buffer threshold, which submits the write.
          for (let index = 0; index < 300; index += 1) sink.push(record(`r${index}`));
          const blockedMs = performance.now() - before;
          // The loop was free while the disk "stalled": a timer fires, the file is still empty.
          yield* Effect.sleep("30 millis");
          assert.isBelow(blockedMs, 250);
          assert.equal(NodeFS.existsSync(file) ? NodeFS.statSync(file).size : 0, 0);
          gate.open?.();
          yield* sink.flush;
          const written = names(file);
          assert.equal(written.length, 300);
          // Order is kept across the batches.
          assert.deepEqual(
            written,
            Array.from({ length: 300 }, (_, index) => `r${index}`),
          );
        } finally {
          spy.mockRestore();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("close waits for writes in flight, and a failed append is tried again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-async-" });
        const file = path.join(dir, "shared.trace.ndjson");
        const real = NodeFS.promises.appendFile.bind(NodeFS.promises);
        let calls = 0;
        const spy = vi
          .spyOn(NodeFS.promises, "appendFile")
          .mockImplementation(async (target, data, options) => {
            calls += 1;
            if (calls === 1) throw new Error("EBUSY");
            return real(target, data, options as never);
          });
        try {
          const sink = yield* makeTraceSink({
            filePath: file,
            maxBytes: 4 * 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 60_000,
          });
          sink.push(record("first"));
          yield* sink.flush;
          // The failed batch went back to the buffer; the next flush writes it.
          sink.push(record("second"));
          yield* sink.close();
          assert.deepEqual(names(file), ["first", "second"]);
        } finally {
          spy.mockRestore();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
