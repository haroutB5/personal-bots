import { describe, expect, it } from "vite-plus/test";

import {
  FrameSelector,
  VIDEO_MAX_FRAMES,
  capFrames,
  frameFileName,
  frameFileNames,
  isVideoFile,
  limitError,
  motionTimeline,
  parseProbe,
  type FrameCandidate,
  type MotionSample,
} from "./videoAnalysis.ts";

const probeJson = (stream: Record<string, unknown>, format: Record<string, unknown> = {}) =>
  JSON.stringify({ streams: [stream], format });

const h264 = {
  codec_type: "video",
  codec_name: "h264",
  width: 1080,
  height: 2400,
  r_frame_rate: "60/1",
};

describe("parseProbe", () => {
  it("reads duration, size and rate", () => {
    expect(parseProbe(probeJson({ ...h264, duration: "23.4" }), 5_000_000)).toEqual({
      ok: true,
      probe: {
        durationSeconds: 23.4,
        width: 1080,
        height: 2400,
        fps: 60,
        codec: "h264",
        hasAudio: false,
      },
    });
  });

  it("rejects non-video and corrupt input", () => {
    expect(parseProbe("not json", 10)).toMatchObject({ ok: false });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: "audio" }] }), 10)).toEqual({
      ok: false,
      reason: "the file has no video track",
    });
    // An mp3 with cover art has a one-picture video stream.
    expect(
      parseProbe(probeJson({ ...h264, duration: "3", disposition: { attached_pic: 1 } }), 10),
    ).toMatchObject({ ok: false, reason: "the file has no video track" });
    expect(parseProbe(probeJson({ ...h264 }), 10)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no readable duration"),
    });
  });

  it("applies the 5 minute and 200 MB limits", () => {
    expect(parseProbe(probeJson({ ...h264, duration: "300.4" }), 10).ok).toBe(true);
    expect(parseProbe(probeJson({ ...h264, duration: "301" }), 10)).toEqual({
      ok: false,
      reason: "the video is 5:01 long; the limit is 5:00",
    });
    expect(limitError({ sizeBytes: 200 * 1024 * 1024 })).toBeNull();
    expect(limitError({ sizeBytes: 200 * 1024 * 1024 + 1 })).toBe(
      "the video is 200 MB; the limit is 200 MB",
    );
    expect(limitError({ sizeBytes: 250 * 1024 * 1024 })).toBe(
      "the video is 250 MB; the limit is 200 MB",
    );
  });
});

describe("isVideoFile", () => {
  it("goes by mime type, and by extension only for an unknown type", () => {
    expect(isVideoFile({ mimeType: "video/mp4", name: "a.bin" })).toBe(true);
    expect(isVideoFile({ mimeType: "application/octet-stream", name: "rec.MOV" })).toBe(true);
    expect(isVideoFile({ mimeType: "application/pdf", name: "rec.mp4" })).toBe(false);
    expect(isVideoFile({ mimeType: "image/gif", name: "a.gif" })).toBe(false);
  });
});

describe("frame names", () => {
  it("names a frame by minutes and tenths so names sort in time order", () => {
    expect(frameFileName(12.44)).toBe("f_00m12.4s.jpg");
    expect(frameFileName(0)).toBe("f_00m00.0s.jpg");
    expect(frameFileName(61.05)).toBe("f_01m01.0s.jpg");
    expect(frameFileName(299.99)).toBe("f_04m59.9s.jpg");
    // Float noise must not round 0.3 down to 0.2.
    expect(frameFileName(0.1 + 0.2)).toBe("f_00m00.3s.jpg");
  });

  it("keeps names unique when two frames share a tenth", () => {
    expect(frameFileNames([1.0, 1.04, 1.08, 2])).toEqual([
      "f_00m01.0s.jpg",
      "f_00m01.0s_2.jpg",
      "f_00m01.0s_3.jpg",
      "f_00m02.0s.jpg",
    ]);
  });
});

const frame = (value: number, size = 64) => new Uint8Array(size).fill(value);

describe("FrameSelector", () => {
  it("keeps scene changes, adds a baseline every 2 s and drops still duplicates", () => {
    const selector = new FrameSelector();
    // 10 s at 10 fps: still until 3 s, a cut to a new screen, still again.
    for (let n = 0; n < 100; n++) selector.push(n, n / 10, frame(n < 30 ? 20 : 120));
    const picked = selector.finish();
    expect(picked.map((c) => [c.n, c.kind])).toEqual([
      [0, "first"],
      [30, "scene"],
    ]);
  });

  it("samples a slow change through baselines and keeps a changed last frame", () => {
    const selector = new FrameSelector();
    // Brightness creeps up 0.1 a frame: never a scene change, always a new picture by the next baseline.
    for (let n = 0; n <= 70; n++) selector.push(n, n / 10, frame(Math.floor(n / 10) * 1.2 + 10));
    const picked = selector.finish();
    expect(picked.map((c) => c.kind)).toEqual([
      "first",
      "baseline",
      "baseline",
      "baseline",
      "last",
    ]);
    expect(picked.map((c) => c.t)).toEqual([0, 2, 4, 6, 7]);
  });

  it("keeps baselines while only a small element moves", () => {
    const selector = new FrameSelector();
    // A 4x4 box crossing an otherwise still 96x200 screen: a tiny mean change, but visible pixels.
    for (let n = 0; n <= 60; n++) {
      const picture = frame(20, 96 * 200);
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) picture[y * 96 + ((n + x) % 96)] = 220;
      selector.push(n, n / 10, picture);
    }
    expect(selector.finish().map((c) => c.t)).toEqual([0, 2, 4, 6]);
  });

  it("caps a busy video at 40 frames in time order", () => {
    const selector = new FrameSelector();
    for (let n = 0; n < 600; n++) selector.push(n, n / 10, frame(n % 2 === 0 ? 0 : 200));
    const picked = selector.finish();
    expect(picked).toHaveLength(VIDEO_MAX_FRAMES);
    expect(picked[0]!.n).toBe(0);
    expect(picked.at(-1)!.kind).toBe("last");
    expect(picked.map((c) => c.t)).toEqual(picked.map((c) => c.t).toSorted((a, b) => a - b));
  });
});

describe("capFrames", () => {
  const candidate = (n: number, kind: FrameCandidate["kind"], score: number): FrameCandidate => ({
    n,
    t: n,
    kind,
    score,
  });

  it("keeps first and last, then scene changes before baselines, biggest first", () => {
    const picked = capFrames(
      [
        candidate(0, "first", Infinity),
        candidate(1, "baseline", 50),
        candidate(2, "scene", 20),
        candidate(3, "scene", 40),
        candidate(4, "scene", 30),
        candidate(9, "last", 25),
      ],
      4,
    );
    expect(picked.map((c) => c.n)).toEqual([0, 3, 4, 9]);
  });

  it("returns short lists unchanged and drops duplicate indexes", () => {
    expect(capFrames([candidate(0, "first", 1), candidate(0, "scene", 1)], 40)).toHaveLength(1);
  });
});

/** Steady motion at 60 fps with the given overrides by frame index. */
function samples(
  count: number,
  overrides: Record<number, Partial<MotionSample>> = {},
  dropped: ReadonlySet<number> = new Set(),
): Array<MotionSample> {
  const out: MotionSample[] = [];
  for (let n = 0; n < count; n++) {
    if (dropped.has(n)) continue;
    out.push({ n, t: n / 60, changed: 40, mean: 1.5, revert: 3, revert2: 4.5, ...overrides[n] });
  }
  return out;
}

describe("motionTimeline", () => {
  it("flags nothing on steady motion", () => {
    const timeline = motionTimeline(samples(300));
    expect(timeline.moments).toEqual([]);
    expect(timeline.segments).toHaveLength(1);
    expect(timeline.frameIntervalMs).toBe(16.7);
  });

  it("flags a 200 ms freeze recorded as repeated frames (constant frame rate)", () => {
    const frozen: Record<number, Partial<MotionSample>> = {};
    for (let n = 121; n <= 132; n++) frozen[n] = { changed: 0, mean: 0 };
    const timeline = motionTimeline(samples(300, frozen));
    expect(timeline.moments).toEqual([
      { kind: "stall", t: 2, durationMs: 217, expectedMs: 17, repeatedFrames: 12 },
    ]);
  });

  it("flags the same freeze recorded as a pts gap (Android variable frame rate)", () => {
    const dropped = new Set(Array.from({ length: 12 }, (_, i) => 121 + i));
    const timeline = motionTimeline(samples(300, {}, dropped));
    expect(timeline.moments).toEqual([
      { kind: "stall", t: 2, durationMs: 217, expectedMs: 17, repeatedFrames: 0 },
    ]);
  });

  it("does not call a finger slowing to a stop a stall", () => {
    const overrides: Record<number, Partial<MotionSample>> = {};
    // Decelerate over 6 frames, hold for 200 ms, then move again.
    for (let i = 0; i < 6; i++) overrides[114 + i] = { changed: 40 - i * 6, mean: 1.5 - i * 0.2 };
    for (let n = 120; n <= 131; n++) overrides[n] = { changed: 0, mean: 0 };
    expect(motionTimeline(samples(300, overrides)).moments).toEqual([]);
  });

  it("does not flag a pause between two separate animations", () => {
    const still: Record<number, Partial<MotionSample>> = {};
    for (let n = 100; n < 160; n++) still[n] = { changed: 0, mean: 0 };
    expect(motionTimeline(samples(300, still)).moments).toEqual([]);
  });

  it("flags one- and two-frame flashes but not the change back from them", () => {
    const timeline = motionTimeline(
      samples(300, {
        60: { mean: 90, changed: 5000, revert: 1.2 },
        61: { mean: 90, changed: 5000, revert: 95 },
        200: { mean: 80, changed: 5000, revert: 82, revert2: 2 },
        201: { mean: 2, changed: 30, revert: 81 },
        202: { mean: 80, changed: 5000, revert: 4 },
      }),
    );
    expect(timeline.moments).toEqual([
      { kind: "flash", t: 1, frames: 1, n: 60 },
      { kind: "flash", t: 200 / 60, frames: 2, n: 200 },
    ]);
  });

  it("flags a sudden jump inside motion", () => {
    const timeline = motionTimeline(samples(300, { 150: { mean: 12, changed: 900, revert: 13 } }));
    expect(timeline.moments).toEqual([{ kind: "jump", t: 2.5, n: 150, ratio: 8 }]);
  });
});
