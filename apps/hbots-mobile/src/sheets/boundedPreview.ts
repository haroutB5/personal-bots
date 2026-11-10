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
 * pass the limit, so the app never holds more than about the cap.
 */
export async function readBoundedBody(
  response: BoundedBodyResponse,
  limit: number,
  controller: AbortController,
): Promise<Uint8Array> {
  const declared = declaredBodyLength(response.headers.get("content-length"));
  if (declared !== null && declared > limit) {
    controller.abort();
    throw new PreviewTooLargeError();
  }

  const body = response.body;
  if (body === null) {
    // No stream to bound. Only a declared small body can be read safely.
    if (declared === null) {
      controller.abort();
      throw new PreviewTooLargeError();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (controller.signal.aborted) throw new Error("Preview aborted.");
    if (bytes.byteLength > limit) {
      controller.abort();
      throw new PreviewTooLargeError();
    }
    return bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
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
        controller.abort();
        throw new PreviewTooLargeError();
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
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
