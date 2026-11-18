import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { TextHit } from "./readerDoc";

interface TextSelectNative {
  textHitAt(surfaceTag: number, pageX: number, pageY: number): Promise<TextHit | null>;
  selectWordAt(
    textTag: number,
    offset: number,
  ): Promise<{ readonly lineTop: number; readonly mode: string } | null>;
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
