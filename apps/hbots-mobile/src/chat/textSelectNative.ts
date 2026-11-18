import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { TextHit } from "./readerDoc";

interface TextSelectNative {
  textHitAt(surfaceTag: number, pageX: number, pageY: number): Promise<TextHit | null>;
  selectWordAt(
    textTag: number,
    offset: number,
  ): Promise<{ readonly lineTop: number; readonly mode: string } | null>;
  watchSelection(textTag: number): Promise<boolean>;
  clearSelection(textTag: number): Promise<boolean>;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<TextSelectNative>("HbotsTextSelect")
    : null;

/** The word under a window point inside a chat surface, or null off Android and on any miss. */
export async function textHitAt(
  surfaceTag: number,
  pageX: number,
  pageY: number,
): Promise<TextHit | null> {
  if (native === null) return null;
  try {
    return await native.textHitAt(surfaceTag, pageX, pageY);
  } catch {
    return null;
  }
}

/** Selects the word at `offset` in the reader text and returns its line top in dp, or null on any miss. */
export async function selectWordAt(
  textTag: number,
  offset: number,
): Promise<{ readonly lineTop: number; readonly mode: string } | null> {
  if (native === null) return null;
  try {
    return await native.selectWordAt(textTag, offset);
  } catch {
    return null;
  }
}

/** Clears the reader's selection and its handles. True when there was one, so Back can stop there. */
export async function clearSelection(textTag: number): Promise<boolean> {
  if (native === null) return false;
  try {
    return await native.clearSelection(textTag);
  } catch {
    return false;
  }
}

/** Starts noting when the reader's selection collapses, so Back can tell a toolbar that just closed. */
export async function watchSelection(textTag: number): Promise<boolean> {
  if (native === null) return false;
  try {
    return await native.watchSelection(textTag);
  } catch {
    return false;
  }
}
