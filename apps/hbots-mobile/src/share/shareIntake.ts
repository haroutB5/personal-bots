import { requireOptionalNativeModule } from "expo";

import type { RawShare } from "./pickerModel";
import { parseRawShare } from "./rawShare";

interface ShareModule {
  read(id: string): string | null;
  discard(id: string): void;
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
