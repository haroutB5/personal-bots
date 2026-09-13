import { describe, expect, it } from "vite-plus/test";

import {
  decodePersonalBrowserFrame,
  encodePersonalBrowserFrame,
  PERSONAL_BROWSER_FRAME_HEADER_BYTES,
} from "./personalBrowser.ts";

describe("personal browser viewport frames", () => {
  it("round-trips the viewport size and device scale with the JPEG bytes", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const frame = encodePersonalBrowserFrame(jpeg, {
      width: 390,
      height: 844,
      deviceScaleFactor: 2.625,
    });
    expect(frame.length).toBe(PERSONAL_BROWSER_FRAME_HEADER_BYTES + jpeg.length);
    const decoded = decodePersonalBrowserFrame(frame);
    expect(decoded?.meta).toEqual({ width: 390, height: 844, deviceScaleFactor: 2.63 });
    expect([...(decoded?.jpeg ?? [])]).toEqual([...jpeg]);
  });

  it("decodes a frame that sits at an offset inside a larger buffer", () => {
    const frame = encodePersonalBrowserFrame(new Uint8Array([9, 9]), {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
    });
    const padded = new Uint8Array(frame.length + 3);
    padded.set(frame, 3);
    expect(decodePersonalBrowserFrame(padded.subarray(3))?.meta.width).toBe(1280);
  });

  it("rejects truncated, zero-sized and unknown-version frames", () => {
    expect(
      decodePersonalBrowserFrame(new Uint8Array(PERSONAL_BROWSER_FRAME_HEADER_BYTES)),
    ).toBeNull();
    const zero = encodePersonalBrowserFrame(new Uint8Array([1]), {
      width: 0,
      height: 10,
      deviceScaleFactor: 1,
    });
    expect(decodePersonalBrowserFrame(zero)).toBeNull();
    const future = encodePersonalBrowserFrame(new Uint8Array([1]), {
      width: 10,
      height: 10,
      deviceScaleFactor: 1,
    });
    new DataView(future.buffer).setUint16(6, 2);
    expect(decodePersonalBrowserFrame(future)).toBeNull();
  });
});
