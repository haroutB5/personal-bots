import { decodeFilePreviewText } from "@t3tools/shared/filePreview";

/**
 * A response body read that stops at a byte cap. A server that honours Range
 * sends at most the cap. One that ignores it can send the whole file, so the
 * reader aborts the request as soon as the declared or streamed size passes the
 * cap and never keeps an over-cap chunk.
 */

/** The most a text preview may read, matching the shared decoder's cap. */
export const PREVIEW_BODY_MAX_BYTES = 1024 * 1024;

/** The body is larger than the phone will hold; the request is already aborted. */
export class PreviewTooLargeError extends Error {
  constructor() {
    super("The file is larger than the phone preview cap.");
    this.name = "PreviewTooLargeError";
  }
}

/** The first bytes of a body that was cut at the cap. */
export interface BoundedHead {
  readonly bytes: Uint8Array;
  /** True when the body held more than the cap, so `bytes` is only its head. */
  readonly truncated: boolean;
}

export interface BoundedReadOptions {
  /**
   * `head` keeps the first `limit` bytes of a larger body and aborts, instead
   * of refusing the file. A text preview uses it. Without it a body over the
   * cap throws, which is what a binary preview wants.
   */
  readonly mode: "head";
}

export interface BoundedBodyResponse {
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A declared body size, or null when the header is missing or unusable. */
export function declaredBodyLength(contentLength: string | null): number | null {
  if (contentLength === null || contentLength.trim() === "") return null;
  const length = Number(contentLength);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/**
 * Reads at most `limit` bytes and returns them. A larger declared body aborts
 * before the first read. A chunked body aborts the moment the next chunk would
 * pass the limit, so the app never holds more than about the cap. With
 * `{ mode: "head" }` a larger body is cut at the limit and returned as its head.
 */
export async function readBoundedBody(
  response: BoundedBodyResponse,
  limit: number,
  controller: AbortController,
): Promise<Uint8Array>;
export async function readBoundedBody(
  response: BoundedBodyResponse,
  limit: number,
  controller: AbortController,
  options: BoundedReadOptions,
): Promise<BoundedHead>;
export async function readBoundedBody(
  response: BoundedBodyResponse,
  limit: number,
  controller: AbortController,
  options?: BoundedReadOptions,
): Promise<Uint8Array | BoundedHead> {
  const head = options?.mode === "head";
  const declared = declaredBodyLength(response.headers.get("content-length"));
  // A head read goes on to stream a larger body; only a refusal stops at the header.
  if (declared !== null && declared > limit && !head) {
    controller.abort();
    throw new PreviewTooLargeError();
  }

  const body = response.body;
  if (body === null) {
    // No stream to bound. Only a declared small body can be read safely.
    if (declared === null || declared > limit) {
      controller.abort();
      throw new PreviewTooLargeError();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (controller.signal.aborted) throw new Error("Preview aborted.");
    if (bytes.byteLength > limit) {
      controller.abort();
      throw new PreviewTooLargeError();
    }
    return head ? { bytes, truncated: false } : bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cut = false;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (controller.signal.aborted) throw new Error("Preview aborted.");
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.byteLength > limit) {
        if (!head) {
          controller.abort();
          throw new PreviewTooLargeError();
        }
        const room = limit - length;
        if (room > 0) {
          chunks.push(next.value.subarray(0, room));
          length += room;
        }
        cut = true;
        break;
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    controller.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
  // A cancel while a read was pending resolves it as done, not as an error.
  if (controller.signal.aborted) throw new Error("Preview aborted.");
  // The head is complete, so the rest of the download is no longer wanted.
  if (cut) controller.abort();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return head ? { bytes, truncated: cut } : bytes;
}

/** The full size in a `Content-Range: bytes 0-99/1000` header, or null when unknown. */
export function contentRangeTotal(contentRange: string | null): number | null {
  if (contentRange === null) return null;
  const match = /^\s*bytes\s+(?:\d+-\d+|\*)\/(\d+)\s*$/iu.exec(contentRange);
  if (match === null) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Reads a text file's head. A file larger than the cap yields its first `limit`
 * bytes with `truncated` set, whether the server cut it by Range (`Content-Range`
 * names the full size) or ignored the Range and sent it all.
 */
export async function readTextHead(
  response: BoundedBodyResponse,
  limit: number,
  controller: AbortController,
): Promise<BoundedHead> {
  const head = await readBoundedBody(response, limit, controller, { mode: "head" });
  const total = contentRangeTotal(response.headers.get("content-range"));
  return {
    bytes: head.bytes,
    truncated: head.truncated || (total !== null && total > head.bytes.byteLength),
  };
}

/** Decodes a text head. Throws for binary content or bytes that are not UTF-8. */
export function decodeTextHead(head: BoundedHead): { text: string; truncated: boolean } {
  return decodeFilePreviewText(head.bytes, head.truncated);
}
