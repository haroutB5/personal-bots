/**
 * Replaces inline base64 media in a tool result with a small placeholder.
 *
 * When a bot `Read`s an image or calls `preview_snapshot`, the Claude tool
 * result carries the whole picture as `{type:"image", source:{type:"base64",
 * media_type, data}}`. `item.completed` persisted that verbatim into both the
 * event store and `projection_thread_activities` (216 results, ~83 MB of one
 * 250 MB database), and every thread-detail open decoded it from JSON only for
 * `projectActivityPayload` to drop it before the wire. No reader uses the
 * bytes: the provider's own transcript keeps the image for the model, and the
 * clients show the viewed image from `data.imagePath` (the file on disk).
 *
 * The placeholder keeps the media type and the decoded byte size so the row
 * still says what was there. Everything else in the payload is untouched, and
 * the input value is returned as-is (same reference) when it holds no media,
 * so the common case allocates nothing.
 *
 * Shapes handled:
 * - Anthropic content block source: `{type:"base64", media_type, data}`
 *   (Claude `Read` of an image, MCP image results relayed by the Claude SDK).
 * - MCP / ACP content block: `{type:"image"|"audio", data, mimeType}`.
 */

const MEDIA_BLOCK_TYPES = new Set(["image", "audio"]);
const MAX_DEPTH = 12;
// A cheap sniff on the head of the string; a real base64 payload is long and
// uniform, and this keeps a URL or a short label in `data` from being replaced.
const BASE64_HEAD = /^[A-Za-z0-9+/_-]{16,}={0,2}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeBase64(value: string): boolean {
  const head = value.length > 64 ? value.slice(0, 64) : value;
  return BASE64_HEAD.test(head);
}

/** Decoded size of a base64 string, without decoding it. */
export function base64DecodedBytes(value: string): number {
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function isMediaCarrier(record: Record<string, unknown>): boolean {
  const data = record.data;
  if (typeof data !== "string" || !looksLikeBase64(data)) return false;
  return (
    record.type === "base64" ||
    (typeof record.type === "string" && MEDIA_BLOCK_TYPES.has(record.type))
  );
}

function placeholderFor(record: Record<string, unknown>): Record<string, unknown> {
  const { data, ...rest } = record;
  return { ...rest, omittedBytes: base64DecodedBytes(data as string) };
}

function strip(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    let next: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const stripped = strip(entry, depth + 1);
      if (stripped !== entry) {
        next ??= value.slice();
        next[index] = stripped;
      }
    }
    return next ?? value;
  }

  const record = value as Record<string, unknown>;
  if (isMediaCarrier(record)) return placeholderFor(record);

  let next: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (entry === null || typeof entry !== "object") continue;
    const stripped = strip(entry, depth + 1);
    if (stripped !== entry) {
      next ??= { ...record };
      next[key] = stripped;
    }
  }
  return next ?? record;
}

export function stripToolResultMedia<T>(value: T): T {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  return strip(value, 0) as T;
}
