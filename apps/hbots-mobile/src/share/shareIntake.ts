import { requireOptionalNativeModule } from "expo";

import type { RawShare } from "./pickerModel";
import { parseRawShare } from "./rawShare";

interface ShareModule {
  read(id: string): string | null;
  discard(id: string): void;
  discardAllExcept(keep: string | null): void;
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
