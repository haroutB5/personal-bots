/**
 * Width and height of a JPEG in pixels, read from its start-of-frame marker without decoding it.
 * Null when the bytes are not a JPEG or end before the marker.
 */
export function jpegSize(
  jpeg: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= jpeg.length) {
    if (jpeg[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = jpeg[at + 1]!;
    // Padding between segments, and markers that carry no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // Start of frame (baseline, extended, progressive, ...), not the three that are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > jpeg.length) return null;
      return {
        height: (jpeg[at + 5]! << 8) | jpeg[at + 6]!,
        width: (jpeg[at + 7]! << 8) | jpeg[at + 8]!,
      };
    }
    at += 2 + ((jpeg[at + 2]! << 8) | jpeg[at + 3]!);
  }
  return null;
}
