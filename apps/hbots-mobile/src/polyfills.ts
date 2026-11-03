/**
 * The shared chats snapshot measures its UTF-8 byte budget with TextEncoder.
 * Hermes does not guarantee it on every build, and the snapshot only needs the
 * byte length, so this fallback counts code points without allocating.
 */
if (typeof globalThis.TextEncoder === "undefined") {
  class Utf8LengthEncoder {
    encode(input: string): { readonly length: number } {
      let bytes = 0;
      for (const character of input) {
        const point = character.codePointAt(0) ?? 0;
        bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      }
      return { length: bytes };
    }
  }
  Object.defineProperty(globalThis, "TextEncoder", {
    value: Utf8LengthEncoder,
    configurable: true,
    writable: true,
  });
}
