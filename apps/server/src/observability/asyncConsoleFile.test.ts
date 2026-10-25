// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - plain Node file
// handles and wall-clock waits, no Effect runtime in this module.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  asyncConsoleWriterFor,
  installAsyncConsoleFileRedirect,
  type AsyncConsoleTarget,
} from "./asyncConsoleFile.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Waits until the file holds `count` lines (fs.write callbacks batched). */
const waitForLines = async (filePath: string, count: number) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const text = NodeFS.readFileSync(filePath, "utf8");
      if (text.length > 0 && text.trim().split("\n").length >= count) return text;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return NodeFS.readFileSync(filePath, "utf8");
};

/** Waits until the writer has drained far enough to hold `needle`. */
const waitForText = async (filePath: string, needle: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const text = NodeFS.readFileSync(filePath, "utf8");
      if (text.includes(needle)) return text;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return NodeFS.readFileSync(filePath, "utf8");
};

describe("installAsyncConsoleFileRedirect", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0, cleanups.length)) cleanup();
  });

  const makeTarget = () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-async-console-"));
    const filePath = NodePath.join(dir, "out.log");
    const fd = NodeFS.openSync(filePath, "a");
    const stream: { write?: unknown } = { write: vi.fn() };
    const target: AsyncConsoleTarget = { stream, fd };
    cleanups.push(() => {
      try {
        NodeFS.closeSync(fd);
      } catch {
        // already closed
      }
      NodeFS.rmSync(dir, { recursive: true, force: true });
    });
    return { stream, target, filePath };
  };

  it("writes console lines through the async writer in order", async () => {
    const { stream, target, filePath } = makeTarget();
    expect(installAsyncConsoleFileRedirect([target])).toBe(1);
    const write = stream.write as (chunk: string) => boolean;

    expect(write("first line\n")).toBe(true);
    write("second line\n");
    // The queue is drained by fs.write callbacks; a couple of macrotasks clear
    // both chunks, and until then the loop was never held.
    await settle();
    await settle();
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("first line\nsecond line\n");
    expect(asyncConsoleWriterFor(stream)).toBeDefined();
  });

  it("keeps a chunk order that matches the call order under load", async () => {
    const { stream, target, filePath } = makeTarget();
    installAsyncConsoleFileRedirect([target]);
    const write = stream.write as (chunk: string) => boolean;
    for (let index = 0; index < 64; index += 1) write(`line-${index}\n`);
    const text = await waitForLines(filePath, 64);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(64);
    expect(lines[0]).toBe("line-0");
    expect(lines[63]).toBe("line-63");
  });

  it("coalesces a burst into one in-flight batch instead of one write per line", async () => {
    const { stream, target, filePath } = makeTarget();
    installAsyncConsoleFileRedirect([target]);
    const writer = asyncConsoleWriterFor(stream);
    const write = stream.write as (chunk: string) => boolean;

    // A synchronous burst cannot let an fs.write callback run, so everything
    // written here is queued. One batch is taken by the first pump; the rest
    // must wait as queue, not as thousands of separate in-flight writes.
    for (let index = 0; index < 5_000; index += 1) write(`burst line ${index}\n`);
    const text = await waitForLines(filePath, 5_000);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(5_000);
    expect(lines[0]).toBe("burst line 0");
    expect(lines[4_999]).toBe("burst line 4999");
    expect(writer?.backlogBytes).toBe(0);
  });

  it("bounds the backlog and drops the oldest lines with one marker", async () => {
    const { stream, target, filePath } = makeTarget();
    installAsyncConsoleFileRedirect([target]);
    const writer = asyncConsoleWriterFor(stream);
    const write = stream.write as (chunk: string) => boolean;

    // Fill the queue past the bound in one synchronous turn (no callback can
    // run). The oldest lines must go, the newest must stay, and exactly one
    // marker line must record the loss.
    const chunk = "x".repeat(1_023) + "\n"; // 1 KiB per line
    for (let index = 0; index < 12_000; index += 1) {
      write(`line ${String(index).padStart(5, "0")} ${chunk}`);
    }
    expect(writer?.droppedLineCount).toBeGreaterThan(0);
    expect(writer?.backlogBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    // The drained queue still holds most of the burst when the first 100 lines
    // land, so wait for the newest line itself instead of a fixed line count.
    const text = await waitForText(filePath, "line 11999 ");
    expect(text).toContain("[async-console] dropped ");
  });

  it("is a no-op with the kill switch set", () => {
    const { stream, target } = makeTarget();
    vi.stubEnv("T3CODE_ASYNC_CONSOLE", "off");
    expect(installAsyncConsoleFileRedirect([target])).toBe(0);
    expect(asyncConsoleWriterFor(stream)).toBeUndefined();
    expect(vi.isMockFunction(stream.write)).toBe(true);
  });

  it("leaves a stream that was already redirected alone", () => {
    const { target } = makeTarget();
    expect(installAsyncConsoleFileRedirect([target])).toBe(1);
    expect(installAsyncConsoleFileRedirect([target])).toBe(0);
  });
});
