import { requireOptionalNativeModule } from "expo";

import type { ShrunkPhoto } from "../chat/photoDrafts";
import type { RawShare } from "./pickerModel";
import { parseRawShare } from "./rawShare";

interface ShareModule {
  read(id: string): string | null;
  discard(id: string): void;
  discardAllExcept(keep: string | null): void;
  discardDraft(uri: string): void;
  shrinkPhoto(uri: string, mimeType: string): Promise<ShrunkPhoto | null>;
  photoMeanLuma(uri: string): Promise<number | null>;
}

const native = requireOptionalNativeModule<ShareModule>("HbotsShare");

export function readShare(id: string): RawShare | null {
  const json = native?.read(id) ?? null;
  return json === null ? null : parseRawShare(json);
}

/** Deletes the copied files once they are queued or the picker closes. */
export function discardShare(id: string): void {
  native?.discard(id);
}

/**
 * App start: removes every intake an earlier run left behind (a refusal, a
 * cancel, a force stop), keeping only the share this launch opened. Intakes
 * younger than a minute are left alone, a copy may still be running.
 */
export function discardStaleShares(keep: string | null): void {
  native?.discardAllExcept(keep);
}

/** A camera draft's cache copy goes once its message is sent or the draft lets go of it. */
export function discardCameraDraft(uri: string): void {
  native?.discardDraft(uri);
}

/** The photo at 2576 px on its long edge, upright and without metadata, or null to keep it. */
export async function shrinkPhoto(uri: string, mimeType: string): Promise<ShrunkPhoto | null> {
  return (await native?.shrinkPhoto(uri, mimeType)) ?? null;
}

/**
 * The photo's mean luma from 0 (black) to 1 (white), or null when the module or the file cannot
 * read it. The in-app shutter uses it to refuse a capture the camera saved as a black frame.
 */
export async function photoMeanLuma(uri: string): Promise<number | null> {
  return (await native?.photoMeanLuma(uri)) ?? null;
}
