/**
 * Pure video-review logic (limits, frame selection, names, motion timeline), tested without ffmpeg.
 * Android recordings are variable frame rate: a freeze is a gap between pts values, not repeated
 * frames, so every time here is a real pts in seconds.
 */

const VIDEO_MAX_DURATION_SECONDS = 5 * 60;
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const VIDEO_MAX_FRAMES = 40;
export const VIDEO_FRAME_MAX_EDGE = 1280;
const VIDEO_BASELINE_INTERVAL_SECONDS = 2;
/** Width of the grayscale frames the analysis pass compares. */
export const VIDEO_ANALYSIS_WIDTH = 96;

/** Mean absolute difference (0-255) from the last kept frame that makes a new overview frame. */
const SCENE_CHANGE_MEAN = 0.06 * 255;
/** A baseline frame this close to the last kept frame is a duplicate and is dropped... */
const DUPLICATE_MEAN = 1.0;
/** ...unless this many pixels visibly moved: a small toggle or spinner still counts as new. */
const DUPLICATE_MAX_CHANGED_PIXELS = 12;
/** A pixel counts as changed when its gray level moved by more than this. */
const CHANGED_PIXEL_DELTA = 10;
/** Fewer changed pixels than this between two frames is encoder noise: no visible change. */
const CHANGE_MIN_PIXELS = 3;

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "3gp", "3g2", "avi", "ts"]);

export function isVideoFile(input: { readonly mimeType: string; readonly name: string }): boolean {
  const mime = input.mimeType.toLowerCase().split(";", 1)[0]!.trim();
  if (mime.startsWith("video/")) return true;
  const extension = input.name.split(".").at(-1)?.toLowerCase();
  return mime === "application/octet-stream" && extension !== undefined
    ? VIDEO_EXTENSIONS.has(extension)
    : false;
}

export interface VideoProbe {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  /** Nominal rate from the container (r_frame_rate); a VFR file reports its ceiling. */
  readonly fps: number | null;
  readonly codec: string;
  readonly hasAudio: boolean;
}

export type ProbeResult =
  | { readonly ok: true; readonly probe: VideoProbe }
  | { readonly ok: false; readonly reason: string };

function parseRate(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const [num, den] = raw.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num) || num <= 0) return null;
  const rate = den === undefined ? num : den > 0 ? num / den : NaN;
  return Number.isFinite(rate) && rate > 0 && rate < 1000 ? Math.round(rate * 100) / 100 : null;
}

/** Reads `ffprobe -print_format json -show_streams -show_format` output. */
export function parseProbe(json: string, sizeBytes: number): ProbeResult {
  let parsed: {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return { ok: false, reason: "the file could not be read as a video" };
  }
  const video = parsed.streams?.find(
    (stream) =>
      stream.codec_type === "video" &&
      // Cover art in an audio file is a one-frame "video" stream.
      (stream.disposition as Record<string, unknown> | undefined)?.attached_pic !== 1,
  );
  if (!video) return { ok: false, reason: "the file has no video track" };
  const width = Number(video.width);
  const height = Number(video.height);
  if (!(width > 0 && height > 0)) return { ok: false, reason: "the video has no picture size" };
  const duration = Number(video.duration ?? parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, reason: "the video has no readable duration (corrupt or incomplete file)" };
  }
  const limit = limitError({ durationSeconds: duration, sizeBytes });
  if (limit) return { ok: false, reason: limit };
  return {
    ok: true,
    probe: {
      durationSeconds: duration,
      width,
      height,
      fps: parseRate(video.r_frame_rate) ?? parseRate(video.avg_frame_rate),
      codec: typeof video.codec_name === "string" ? video.codec_name : "unknown",
      hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false,
    },
  };
}

/** The phone shows the same words before upload. */
export function limitError(input: {
  readonly durationSeconds?: number | null;
  readonly sizeBytes?: number | null;
}): string | null {
  if (input.sizeBytes != null && input.sizeBytes > VIDEO_MAX_BYTES) {
    return `the video is ${Math.round(input.sizeBytes / (1024 * 1024))} MB; the limit is 200 MB`;
  }
  // Half a second of slack: recorders round a 5:00 clip up.
  if (input.durationSeconds != null && input.durationSeconds > VIDEO_MAX_DURATION_SECONDS + 0.5) {
    return `the video is ${formatClock(input.durationSeconds)} long; the limit is 5:00`;
  }
  return null;
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** `f_00m12.4s.jpg`: minutes and tenths, so names sort in time order. */
export function frameFileName(seconds: number): string {
  const tenths = Math.max(0, Math.floor(seconds * 10 + 1e-6));
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  const secondsPart = `${String(Math.floor(rest / 10)).padStart(2, "0")}.${rest % 10}`;
  return `f_${String(minutes).padStart(2, "0")}m${secondsPart}s.jpg`;
}

/** Unique names in time order; two frames in the same tenth get `.1`, `.2` hundredths-style suffixes. */
export function frameFileNames(times: ReadonlyArray<number>): Array<string> {
  const seen = new Map<string, number>();
  return times.map((time) => {
    const base = frameFileName(time);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : base.replace(/s\.jpg$/, `s_${count + 1}.jpg`);
  });
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let total = 0;
  for (let i = 0; i < length; i++) total += Math.abs(a[i]! - b[i]!);
  return total / length;
}

export function changedPixels(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < length; i++) if (Math.abs(a[i]! - b[i]!) > CHANGED_PIXEL_DELTA) count++;
  return count;
}

export interface FrameCandidate {
  /** Decode index, for ffmpeg `select=eq(n,…)`. */
  readonly n: number;
  readonly t: number;
  readonly kind: "first" | "scene" | "baseline" | "last";
  /** Visual change from the previously kept frame; ranks candidates when capping. */
  readonly score: number;
}

/**
 * Picks overview frames while the analysis pass streams: a frame becomes a
 * candidate when it differs enough from the last kept one (a scene change, or
 * the accumulated change of a scroll), plus one every two seconds as an even
 * baseline. A baseline frame that looks like the last kept one is a duplicate.
 */
function differs(frame: Uint8Array, kept: Uint8Array, change: number): boolean {
  return change >= DUPLICATE_MEAN || changedPixels(frame, kept) >= DUPLICATE_MAX_CHANGED_PIXELS;
}

export class FrameSelector {
  private lastKept: Uint8Array | null = null;
  private nextBaseline = VIDEO_BASELINE_INTERVAL_SECONDS;
  private last: { n: number; t: number; frame: Uint8Array } | null = null;
  readonly candidates: Array<FrameCandidate> = [];

  push(n: number, t: number, frame: Uint8Array): void {
    this.last = { n, t, frame };
    if (this.lastKept === null) {
      this.keep({ n, t, kind: "first", score: Number.POSITIVE_INFINITY }, frame);
      return;
    }
    const change = meanAbsDiff(frame, this.lastKept);
    const baselineDue = t + 1e-6 >= this.nextBaseline;
    if (baselineDue) {
      while (this.nextBaseline <= t + 1e-6) this.nextBaseline += VIDEO_BASELINE_INTERVAL_SECONDS;
    }
    if (change >= SCENE_CHANGE_MEAN) {
      this.keep({ n, t, kind: "scene", score: change }, frame);
    } else if (baselineDue && differs(frame, this.lastKept, change)) {
      this.keep({ n, t, kind: "baseline", score: change }, frame);
    }
  }

  /** Closes the pass: the final frame is kept when it shows something new. */
  finish(): Array<FrameCandidate> {
    const last = this.last;
    const previous = this.candidates.at(-1);
    if (last && previous && previous.n === last.n && previous.kind !== "first") {
      // The end state matters most; pin it against the cap.
      this.candidates[this.candidates.length - 1] = { ...previous, kind: "last" };
    } else if (last && this.lastKept && previous && previous.n !== last.n) {
      const change = meanAbsDiff(last.frame, this.lastKept);
      if (differs(last.frame, this.lastKept, change)) {
        this.candidates.push({
          n: last.n,
          t: last.t,
          kind: "last",
          score: change + SCENE_CHANGE_MEAN,
        });
      }
    }
    return capFrames(this.candidates, VIDEO_MAX_FRAMES);
  }

  private keep(candidate: FrameCandidate, frame: Uint8Array): void {
    this.candidates.push(candidate);
    this.lastKept = frame;
  }
}

/**
 * At most `cap` frames, in time order. The first and last always stay; the
 * rest are ranked by how much they changed, scene changes ahead of baseline
 * frames of the same size, so a long still stretch gives up its baselines
 * before a busy stretch gives up its changes.
 */
export function capFrames(
  candidates: ReadonlyArray<FrameCandidate>,
  cap: number,
): Array<FrameCandidate> {
  const sorted = [...candidates].toSorted((a, b) => a.t - b.t || a.n - b.n);
  const unique = sorted.filter(
    (candidate, index) => index === 0 || sorted[index - 1]!.n !== candidate.n,
  );
  if (unique.length <= cap) return unique;
  const pinned = unique.filter((c) => c.kind === "first" || c.kind === "last");
  const rest = unique
    .filter((c) => c.kind !== "first" && c.kind !== "last")
    .toSorted(
      (a, b) =>
        (b.kind === "scene" ? 1 : 0) - (a.kind === "scene" ? 1 : 0) ||
        b.score - a.score ||
        a.t - b.t,
    )
    .slice(0, Math.max(0, cap - pinned.length));
  return [...pinned, ...rest].slice(0, cap).toSorted((a, b) => a.t - b.t || a.n - b.n);
}

/** One analysed frame: change from the previous frame, and whether it undid that change. */
export interface MotionSample {
  readonly n: number;
  readonly t: number;
  /** Pixels that changed from the previous frame (analysis resolution). */
  readonly changed: number;
  /** Mean absolute gray difference from the previous frame. */
  readonly mean: number;
  /**
   * Mean difference between the next frame and the previous one: near zero
   * when this frame was a one-frame flash. Null for the first and last frames.
   */
  readonly revert: number | null;
  /** Same, two frames on: the frame after next against the previous one. */
  readonly revert2: number | null;
}

export type SuspiciousMoment =
  | {
      readonly kind: "stall";
      readonly t: number;
      readonly durationMs: number;
      readonly expectedMs: number;
      readonly repeatedFrames: number;
    }
  | { readonly kind: "flash"; readonly t: number; readonly frames: 1 | 2; readonly n: number }
  | { readonly kind: "jump"; readonly t: number; readonly n: number; readonly ratio: number };

export interface MotionSegment {
  readonly start: number;
  readonly end: number;
  readonly changes: number;
}

export interface MotionTimeline {
  /** Typical gap between consecutive changes while something moves. */
  readonly frameIntervalMs: number;
  readonly segments: ReadonlyArray<MotionSegment>;
  readonly moments: ReadonlyArray<SuspiciousMoment>;
  readonly frames: number;
  readonly variableFrameRate: boolean;
}

/** A pause between changes longer than this is the motion stopping, not a hitch. */
const SEGMENT_GAP_SECONDS = 0.5;
/** Flash: the change it brought is at least this big … */
const FLASH_MIN_MEAN = 3;
/** … and the frame after it is at most this fraction as far from the frame before. */
const FLASH_REVERT_RATIO = 0.25;
const JUMP_RATIO = 4;
const JUMP_MIN_MEAN = 4;

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Gaps between visible changes catch freezes on both CFR and VFR recorders. stall: a gap of 3+
 * intervals (50 ms+) inside motion that is not slowing; flash: 1-2 frames that change a lot then
 * revert; jump: one change far bigger than its neighbours inside steady motion.
 */
export function motionTimeline(samples: ReadonlyArray<MotionSample>): MotionTimeline {
  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i++) deltas.push(samples[i]!.t - samples[i - 1]!.t);
  const changes = samples.filter(
    (sample, index) => index > 0 && sample.changed >= CHANGE_MIN_PIXELS,
  );
  const changeGaps: number[] = [];
  for (let i = 1; i < changes.length; i++) changeGaps.push(changes[i]!.t - changes[i - 1]!.t);
  const sourceInterval = median(deltas.filter((delta) => delta > 0));
  const motionInterval = median(changeGaps.filter((gap) => gap < SEGMENT_GAP_SECONDS));
  const interval = Math.max(
    1 / 240,
    Math.min(sourceInterval || motionInterval, motionInterval || sourceInterval) || 1 / 30,
  );
  const variableFrameRate =
    deltas.length > 2 &&
    deltas.filter((delta) => Math.abs(delta - sourceInterval) > sourceInterval * 0.5).length >
      deltas.length * 0.05;

  const segments: MotionSegment[] = [];
  for (const change of changes) {
    const current = segments.at(-1);
    const start = change.t - interval;
    if (current && start - current.end <= SEGMENT_GAP_SECONDS) {
      segments[segments.length - 1] = {
        start: current.start,
        end: change.t,
        changes: current.changes + 1,
      };
    } else {
      segments.push({ start: Math.max(0, start), end: change.t, changes: 1 });
    }
  }

  const moments: SuspiciousMoment[] = [];
  const steady = (gap: number | undefined) => gap !== undefined && gap <= interval * 1.6;
  for (let k = 2; k < changes.length - 2; k++) {
    const gap = changes[k]!.t - changes[k - 1]!.t;
    if (gap < Math.max(interval * 3, 0.05) || gap > SEGMENT_GAP_SECONDS) continue;
    const before = [changeGaps[k - 3], changeGaps[k - 2]];
    const after = [changeGaps[k], changeGaps[k + 1]];
    if (!before.every(steady) || !after.every(steady)) continue;
    // A finger slowing down to a stop shrinks the changes before the pause.
    const lead = changes[k - 1]!.changed;
    const peak = Math.max(...changes.slice(Math.max(0, k - 6), k).map((c) => c.changed));
    if (lead < peak * 0.5) continue;
    const startT = changes[k - 1]!.t;
    const repeated = samples.filter((s) => s.t > startT && s.t < changes[k]!.t).length;
    moments.push({
      kind: "stall",
      t: startT,
      durationMs: Math.round(gap * 1000),
      expectedMs: Math.round(interval * 1000),
      repeatedFrames: repeated,
    });
  }

  for (let i = 1; i < samples.length - 1; i++) {
    const sample = samples[i]!;
    const next = samples[i + 1]!;
    if (sample.mean >= FLASH_MIN_MEAN && sample.revert !== null) {
      if (
        next.mean >= FLASH_MIN_MEAN &&
        sample.revert <= Math.min(sample.mean, next.mean) * FLASH_REVERT_RATIO
      ) {
        moments.push({ kind: "flash", t: sample.t, frames: 1, n: sample.n });
        continue;
      }
      const after = samples[i + 2];
      if (
        sample.revert2 !== null &&
        after !== undefined &&
        after.mean >= FLASH_MIN_MEAN &&
        next.mean < sample.mean &&
        sample.revert2 <= Math.min(sample.mean, after.mean) * FLASH_REVERT_RATIO
      ) {
        moments.push({ kind: "flash", t: sample.t, frames: 2, n: sample.n });
      }
    }
  }

  const flashFrames = new Set(
    moments.flatMap((m) => (m.kind === "flash" ? [m.n, m.n + 1, m.n + m.frames] : [])),
  );
  for (let k = 2; k < changes.length - 2; k++) {
    const change = changes[k]!;
    if (change.mean < JUMP_MIN_MEAN || flashFrames.has(change.n)) continue;
    const gapsAround = [changeGaps[k - 2], changeGaps[k - 1], changeGaps[k], changeGaps[k + 1]];
    if (!gapsAround.every((gap) => gap !== undefined && gap <= Math.max(interval * 4, 0.1)))
      continue;
    const neighbours = changes
      .slice(Math.max(0, k - 5), k + 6)
      .filter((c) => c.n !== change.n && !flashFrames.has(c.n))
      .map((c) => c.mean);
    const typical = median(neighbours);
    if (typical > 0 && change.mean >= typical * JUMP_RATIO) {
      moments.push({
        kind: "jump",
        t: change.t,
        n: change.n,
        ratio: Math.round((change.mean / typical) * 10) / 10,
      });
    }
  }

  return {
    frameIntervalMs: Math.round(interval * 10000) / 10,
    segments,
    moments: moments.toSorted((a, b) => a.t - b.t),
    frames: samples.length,
    variableFrameRate,
  };
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(3)}s`;
}

export function describeMoment(moment: SuspiciousMoment): string {
  switch (moment.kind) {
    case "stall":
      return `${formatSeconds(moment.t)} stall: no new picture for ${moment.durationMs} ms in the middle of motion (normal ${moment.expectedMs} ms${moment.repeatedFrames > 0 ? `, ${moment.repeatedFrames} repeated frames` : ", no frames recorded"}): stutter or dropped frames`;
    case "flash":
      return `${formatSeconds(moment.t)} ${moment.frames === 1 ? "one-frame" : "two-frame"} flash: the picture changes for ${moment.frames} frame${moment.frames === 1 ? "" : "s"} and then reverts (frame #${moment.n})`;
    case "jump":
      return `${formatSeconds(moment.t)} sudden jump: one change ${moment.ratio}x bigger than the motion around it (frame #${moment.n})`;
  }
}
