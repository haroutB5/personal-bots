import { describe, expect, it } from "vite-plus/test";

import {
  attachmentLimitMessage,
  formatDuration,
  formatSize,
  nextChunk,
  rangeStep,
  UPLOAD_CHUNK_BYTES,
  usesRangedUpload,
} from "./videoDrafts";

const MB = 1024 * 1024;

describe("attachmentLimitMessage", () => {
  it("allows videos up to 200 MB and 5 minutes, other files up to 25 MB", () => {
    const video = { name: "rec.mp4", mimeType: "video/mp4" };
    expect(
      attachmentLimitMessage({ ...video, sizeBytes: 200 * MB, durationMs: 300_000 }),
    ).toBeNull();
    expect(attachmentLimitMessage({ ...video, sizeBytes: 230 * MB, durationMs: 60_000 })).toBe(
      '"rec.mp4" is 230 MB. Videos can be up to 200 MB.',
    );
    expect(attachmentLimitMessage({ ...video, sizeBytes: 50 * MB, durationMs: 372_000 })).toBe(
      '"rec.mp4" is 6:12 long. Videos can be up to 5 minutes.',
    );
    expect(
      attachmentLimitMessage({ name: "a.pdf", mimeType: "application/pdf", sizeBytes: 30 * MB }),
    ).toBe('"a.pdf" is 30 MB. Files can be up to 25 MB (videos up to 200 MB).');
    expect(
      attachmentLimitMessage({ name: "a.pdf", mimeType: "application/pdf", sizeBytes: 3 * MB }),
    ).toBeNull();
  });
});

describe("formatting", () => {
  it("shows durations and sizes the way the chip does", () => {
    expect(formatDuration(23_400)).toBe("0:23");
    expect(formatDuration(299_600)).toBe("5:00");
    expect(formatSize(48.4 * MB)).toBe("48 MB");
    expect(formatSize(3.26 * MB)).toBe("3.3 MB");
    expect(formatSize(900)).toBe("1 KB");
  });
});

describe("ranged upload", () => {
  it("splits a file into pieces under the tunnel limit", () => {
    expect(usesRangedUpload({ mimeType: "video/mp4", sizeBytes: 1 })).toBe(true);
    expect(usesRangedUpload({ mimeType: "application/zip", sizeBytes: 20 * MB })).toBe(true);
    expect(usesRangedUpload({ mimeType: "application/zip", sizeBytes: 2 * MB })).toBe(false);
    const size = 2 * UPLOAD_CHUNK_BYTES + 5;
    expect(nextChunk(0, size)).toEqual({ offset: 0, length: UPLOAD_CHUNK_BYTES });
    expect(nextChunk(2 * UPLOAD_CHUNK_BYTES, size)).toEqual({
      offset: 2 * UPLOAD_CHUNK_BYTES,
      length: 5,
    });
    expect(nextChunk(size, size)).toBeNull();
  });

  it("resumes from the server's count and tells refusals from gateways", () => {
    const sent = { offset: 0, length: 10 };
    expect(rangeStep({ status: 202, endpoint: true, received: 10 }, sent)).toEqual({
      kind: "next",
      offset: 10,
    });
    expect(rangeStep({ status: 204, endpoint: true }, sent)).toEqual({ kind: "done" });
    expect(rangeStep({ status: 409, endpoint: true, received: 4 }, sent)).toEqual({
      kind: "next",
      offset: 4,
    });
    expect(rangeStep({ status: 400, endpoint: true }, sent)).toEqual({
      kind: "refused",
      status: 400,
    });
    expect(rangeStep({ status: 413, endpoint: false }, sent)).toEqual({
      kind: "unreached",
      status: 413,
    });
    expect(rangeStep({ status: 0, endpoint: false, cancelled: true }, sent)).toEqual({
      kind: "cancelled",
    });
  });
});
