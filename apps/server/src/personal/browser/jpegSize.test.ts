import { describe, expect, it } from "@effect/vitest";

import { jpegSize } from "./jpegSize.ts";

const startOfFrame = (marker: number, width: number, height: number) => [
  0xff,
  marker,
  0x00,
  0x11,
  0x08,
  height >> 8,
  height & 0xff,
  width >> 8,
  width & 0xff,
  0x03,
  0x01,
  0x11,
  0x00,
  0x02,
  0x11,
  0x00,
  0x03,
  0x11,
  0x00,
];

describe("jpegSize", () => {
  it("reads the size from a baseline start of frame", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, ...startOfFrame(0xc0, 1_560, 3_040), 0xff, 0xd9]);
    expect(jpegSize(jpeg)).toEqual({ width: 1_560, height: 3_040 });
  });

  it("steps over segments before the frame, like a quantisation table", () => {
    const table = [0xff, 0xdb, 0x00, 0x05, 0x01, 0x02, 0x03];
    const app = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
    const jpeg = Uint8Array.from([0xff, 0xd8, ...app, ...table, ...startOfFrame(0xc2, 780, 1_520)]);
    expect(jpegSize(jpeg)).toEqual({ width: 780, height: 1_520 });
  });

  it("does not take a Huffman table (0xc4) for a frame", () => {
    const huffman = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
    const jpeg = Uint8Array.from([0xff, 0xd8, ...huffman, ...startOfFrame(0xc0, 16, 16)]);
    expect(jpegSize(jpeg)).toEqual({ width: 16, height: 16 });
  });

  it("is null for bytes that are not a JPEG or stop before the frame", () => {
    expect(jpegSize(Uint8Array.from([]))).toBeNull();
    expect(jpegSize(Uint8Array.from([0x78, 0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x05, 0x01]))).toBeNull();
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]))).toBeNull();
  });
});
