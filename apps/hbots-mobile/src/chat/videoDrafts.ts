/**
 * Videos in the composer: bots review them as frames the laptop extracts, so a
 * video may be bigger than other files (200 MB, 5 minutes), and it goes up in
 * pieces because the tunnel in front of the laptop refuses bodies over 100 MB.
 */

export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const VIDEO_MAX_DURATION_MS = 5 * 60 * 1000;
/** Other files keep the old cap. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Each upload request carries at most this much, well under the tunnel's 100 MB. */
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

export interface VideoMeta {
  readonly durationMs: number | null;
  readonly thumbnailUri: string | null;
}

export function isVideoMime(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith("video/");
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Why this attachment cannot go, in words for the composer notice; null when it fits. */
export function attachmentLimitMessage(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly durationMs?: number | null;
}): string | null {
  if (!isVideoMime(input.mimeType)) {
    return input.sizeBytes > FILE_MAX_BYTES
      ? `"${input.name}" is ${formatSize(input.sizeBytes)}. Files can be up to 25 MB (videos up to 200 MB).`
      : null;
  }
  if (input.sizeBytes > VIDEO_MAX_BYTES) {
    return `"${input.name}" is ${formatSize(input.sizeBytes)}. Videos can be up to 200 MB.`;
  }
  // A second of slack: phones round a 5:00 recording up.
  if (input.durationMs != null && input.durationMs > VIDEO_MAX_DURATION_MS + 1000) {
    return `"${input.name}" is ${formatDuration(input.durationMs)} long. Videos can be up to 5 minutes.`;
  }
  return null;
}

/** Ranged uploads for videos (progress and cancel) and for any file a single request could not carry. */
export function usesRangedUpload(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  return isVideoMime(input.mimeType) || input.sizeBytes > UPLOAD_CHUNK_BYTES;
}

export function nextChunk(
  offset: number,
  sizeBytes: number,
): { offset: number; length: number } | null {
  if (offset >= sizeBytes) return null;
  return { offset, length: Math.min(UPLOAD_CHUNK_BYTES, sizeBytes - offset) };
}

export interface RangeAnswer {
  readonly status: number;
  readonly endpoint: boolean;
  readonly received?: number | null;
  readonly cancelled?: boolean;
}

/**
 * What to do after one piece. 202 means the piece landed and more are due,
 * 204 that the file is complete, 409 with a count that the server holds a
 * different amount, so the upload resumes from there.
 */
export function rangeStep(
  answer: RangeAnswer,
  sent: { readonly offset: number; readonly length: number },
):
  | { readonly kind: "next"; readonly offset: number }
  | { readonly kind: "done" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "unreached"; readonly status: number } {
  if (answer.cancelled === true) return { kind: "cancelled" };
  if (answer.status === 204) return { kind: "done" };
  if (answer.status === 202)
    return { kind: "next", offset: answer.received ?? sent.offset + sent.length };
  if (answer.endpoint && answer.status === 409 && typeof answer.received === "number") {
    return { kind: "next", offset: answer.received };
  }
  if (answer.endpoint && answer.status >= 400) return { kind: "refused", status: answer.status };
  return { kind: "unreached", status: answer.status };
}
