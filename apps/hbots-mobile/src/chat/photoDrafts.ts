import type { DraftAttachment } from "./outboxNative";

export interface ShrunkPhoto {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Native: the photo shrunk to a 2576 px long edge, or null when it goes as it is. */
export type ShrinkPhoto = (uri: string, mimeType: string) => Promise<ShrunkPhoto | null>;

function jpegName(name: string): string {
  if (/\.jpe?g$/i.test(name)) return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}

/**
 * Every attachment a draft takes in passes here, from every source. Each image is shrunk
 * natively; a file, or an image the native side keeps (small and clean, or unreadable), goes
 * through unchanged. A failed shrink keeps the original rather than losing the photo.
 */
export async function shrinkDrafts(
  drafts: ReadonlyArray<DraftAttachment>,
  shrink: ShrinkPhoto,
): Promise<ReadonlyArray<DraftAttachment>> {
  const out: DraftAttachment[] = [];
  for (const draft of drafts) {
    if (draft.kind !== "image") {
      out.push(draft);
      continue;
    }
    const shrunk = await shrink(draft.uri, draft.mimeType).catch(() => null);
    out.push(
      shrunk === null
        ? draft
        : {
            ...draft,
            name: jpegName(draft.name),
            mimeType: "image/jpeg",
            sizeBytes: shrunk.bytes,
            uri: shrunk.uri,
          },
    );
  }
  return out;
}
