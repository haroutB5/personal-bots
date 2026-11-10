import { describe, expect, it } from "vite-plus/test";

import {
  declaredBodyLength,
  PreviewTooLargeError,
  readBoundedBody,
  type BoundedBodyResponse,
} from "./boundedPreview.ts";

const MIB = 1024 * 1024;

function response(
  body: ReadableStream<Uint8Array> | null,
  contentLength?: string,
): BoundedBodyResponse {
  return {
    headers: {
      get: (name) => (name.toLowerCase() === "content-length" ? (contentLength ?? null) : null),
    },
    body,
    arrayBuffer: async () => new Uint8Array(0).buffer,
  };
}

function chunked(chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

describe("declaredBodyLength", () => {
  it("reads a whole non-negative number and ignores everything else", () => {
    expect(declaredBodyLength("1048576")).toBe(MIB);
    expect(declaredBodyLength("0")).toBe(0);
    expect(declaredBodyLength(null)).toBeNull();
    expect(declaredBodyLength("")).toBeNull();
    expect(declaredBodyLength("12.5")).toBeNull();
    expect(declaredBodyLength("-1")).toBeNull();
    expect(declaredBodyLength("lots")).toBeNull();
  });
});

describe("readBoundedBody", () => {
  it("returns a chunked body that fits under the cap", async () => {
    const controller = new AbortController();
    const bytes = await readBoundedBody(
      response(chunked([new Uint8Array([1, 2]), new Uint8Array([3])])),
      8,
      controller,
    );
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts before reading when the declared body is over the cap", async () => {
    const inner = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1));
      },
    });
    let readers = 0;
    const body = {
      getReader: () => {
        readers += 1;
        return inner.getReader();
      },
    } as unknown as ReadableStream<Uint8Array>;
    const controller = new AbortController();
    await expect(readBoundedBody(response(body, String(MIB + 1)), MIB, controller)).rejects.toThrow(
      PreviewTooLargeError,
    );
    expect(readers).toBe(0);
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts a chunked body as soon as a chunk would pass the cap", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const bodies = Array.from({ length: 64 }, () => chunk);
    const controller = new AbortController();
    await expect(readBoundedBody(response(chunked(bodies)), MIB, controller)).rejects.toThrow(
      PreviewTooLargeError,
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns a body exactly at the cap", async () => {
    const controller = new AbortController();
    const bytes = await readBoundedBody(response(chunked([new Uint8Array(MIB)])), MIB, controller);
    expect(bytes.byteLength).toBe(MIB);
  });

  it("cancels the reader when the sheet closes mid-read", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull: () => new Promise(() => {}),
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const read = readBoundedBody(response(body), MIB, controller);
    await Promise.resolve();
    controller.abort();
    await expect(read).rejects.toThrow("Preview aborted.");
    expect(cancelled).toBe(true);
  });
});
