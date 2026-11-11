import { describe, expect, it } from "vite-plus/test";

import {
  contentRangeTotal,
  declaredBodyLength,
  decodeTextHead,
  PreviewTooLargeError,
  readBoundedBody,
  readTextHead,
  type BoundedBodyResponse,
} from "./boundedPreview.ts";

const MIB = 1024 * 1024;

function response(
  body: ReadableStream<Uint8Array> | null,
  contentLength?: string,
  contentRange?: string,
): BoundedBodyResponse {
  return {
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === "content-length") return contentLength ?? null;
        if (key === "content-range") return contentRange ?? null;
        return null;
      },
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

const encoder = new TextEncoder();

describe("readBoundedBody head mode", () => {
  it("keeps the first cap bytes of a stream over the cap and aborts", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const controller = new AbortController();
    const head = await readBoundedBody(
      response(chunked(Array.from({ length: 64 }, () => chunk))),
      MIB - 10,
      controller,
      { mode: "head" },
    );
    expect(head.truncated).toBe(true);
    expect(head.bytes.byteLength).toBe(MIB - 10);
    expect(controller.signal.aborted).toBe(true);
  });

  it("streams past a declared length over the cap instead of refusing", async () => {
    const controller = new AbortController();
    const head = await readBoundedBody(
      response(chunked([new Uint8Array(100), new Uint8Array(100)]), String(MIB * 3)),
      150,
      controller,
      { mode: "head" },
    );
    expect(head.truncated).toBe(true);
    expect(head.bytes.byteLength).toBe(150);
  });

  it("is not truncated when the body fits, and leaves the request alone", async () => {
    const controller = new AbortController();
    const head = await readBoundedBody(
      response(chunked([new Uint8Array([1, 2, 3])])),
      8,
      controller,
      { mode: "head" },
    );
    expect(head).toEqual({ bytes: new Uint8Array([1, 2, 3]), truncated: false });
    expect(controller.signal.aborted).toBe(false);
  });

  it("still refuses a body with no stream and no usable length", async () => {
    const controller = new AbortController();
    await expect(
      readBoundedBody(response(null), MIB, controller, { mode: "head" }),
    ).rejects.toThrow(PreviewTooLargeError);
  });

  it("without head mode a stream over the cap still throws", async () => {
    const controller = new AbortController();
    await expect(
      readBoundedBody(response(chunked([new Uint8Array(MIB), new Uint8Array(1)])), MIB, controller),
    ).rejects.toThrow(PreviewTooLargeError);
  });
});

describe("contentRangeTotal", () => {
  it("reads the full size and ignores anything else", () => {
    expect(contentRangeTotal("bytes 0-1048575/3145728")).toBe(3145728);
    expect(contentRangeTotal("bytes */42")).toBe(42);
    expect(contentRangeTotal("bytes 0-9/*")).toBeNull();
    expect(contentRangeTotal(null)).toBeNull();
    expect(contentRangeTotal("nonsense")).toBeNull();
  });
});

describe("readTextHead", () => {
  it("returns the head of a text stream over 1 MiB with no Content-Range as truncated", async () => {
    const line = encoder.encode("a log line that repeats\n");
    const chunks: Uint8Array[] = [];
    for (let size = 0; size < 3 * MIB; size += line.byteLength) chunks.push(line);
    const controller = new AbortController();
    const head = await readTextHead(response(chunked(chunks)), MIB, controller);
    expect(head.truncated).toBe(true);
    expect(head.bytes.byteLength).toBe(MIB);
    const decoded = decodeTextHead(head);
    expect(decoded.truncated).toBe(true);
    expect(decoded.text.startsWith("a log line that repeats\n")).toBe(true);
  });

  it("marks a Range answer truncated when Content-Range names a larger file", async () => {
    const controller = new AbortController();
    const head = await readTextHead(
      response(chunked([new Uint8Array(MIB).fill(97)]), String(MIB), `bytes 0-${MIB - 1}/3145728`),
      MIB,
      controller,
    );
    expect(head.truncated).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not mark a file that fits as truncated", async () => {
    const controller = new AbortController();
    const head = await readTextHead(
      response(chunked([encoder.encode("small")]), "5", "bytes 0-4/5"),
      MIB,
      controller,
    );
    expect(head.truncated).toBe(false);
    expect(decodeTextHead(head)).toEqual({ text: "small", truncated: false });
  });

  it("keeps a multi-byte character cut at the cap from failing the decode", () => {
    const bytes = encoder.encode("ab😀");
    const head = { bytes: bytes.subarray(0, bytes.byteLength - 2), truncated: true };
    expect(decodeTextHead(head).text).toBe("ab");
  });

  it("still throws for binary content in the head", async () => {
    const body = new Uint8Array(MIB + 5);
    body[10] = 0;
    body.fill(65, 11);
    const controller = new AbortController();
    const head = await readTextHead(response(chunked([body])), MIB, controller);
    expect(head.truncated).toBe(true);
    expect(() => decodeTextHead(head)).toThrow();
  });
});
