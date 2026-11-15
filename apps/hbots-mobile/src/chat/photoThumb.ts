/**
 * The sent photo bubble's box. The composer decodes each waiting photo at this size before Send,
 * so the bubble's first frame is the photo instead of an empty box while it decodes.
 */
export const PHOTO_THUMB = { width: 200, height: 160 } as const;

export interface WarmPhoto {
  readonly id: string;
  readonly uri: string;
}

/** The image files in the draft to keep decoded at the bubble size while Send waits. */
export function photosToWarm(
  attachments: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly uri: string;
  }>,
): ReadonlyArray<WarmPhoto> {
  return attachments
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({ id: attachment.id, uri: attachment.uri }));
}
