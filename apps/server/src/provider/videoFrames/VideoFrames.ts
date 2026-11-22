// @effect-diagnostics nodeBuiltinImport:off -- ffmpeg and ffprobe are external processes; their pipes are Node streams.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  FrameSelector,
  VIDEO_ANALYSIS_WIDTH,
  VIDEO_FRAME_MAX_EDGE,
  changedPixels,
  frameFileNames,
  meanAbsDiff,
  motionTimeline,
  parseProbe,
  type FrameCandidate,
  type MotionSample,
  type MotionTimeline,
  type VideoProbe,
} from "./videoAnalysis.ts";

/**
 * Writes time-stamped frames, contact sheets and a motion timeline to `<video>.frames/`.
 * ffmpeg runs niced, idle IO class, one video at a time, with a timeout, so the event loop stays free.
 */

const VIDEO_FRAMES_SUFFIX = ".frames";
const MANIFEST = "manifest.json";
const SHEET_COLUMNS = 5;
const SHEET_ROWS = 4;
const SHEET_TILE_WIDTH = 200;
const SHEET_TILE_HEIGHT = 360;
const PROBE_TIMEOUT_MS = 30_000;
const PASS_TIMEOUT_MS = 4 * 60_000;
const STDERR_TAIL = 4096;

export interface VideoFrameEntry {
  readonly file: string;
  readonly t: number;
  readonly n: number;
  readonly kind: FrameCandidate["kind"];
}

export interface VideoSheetEntry {
  readonly file: string;
  readonly from: number;
  readonly to: number;
  readonly frames: number;
}

export type VideoManifest =
  | {
      readonly version: 1;
      readonly status: "ok";
      readonly probe: VideoProbe;
      readonly frames: ReadonlyArray<VideoFrameEntry>;
      readonly sheets: ReadonlyArray<VideoSheetEntry>;
      readonly timeline: MotionTimeline;
      readonly elapsedMs: number;
    }
  | { readonly version: 1; readonly status: "rejected" | "failed"; readonly reason: string };

export function videoFramesDir(videoPath: string): string {
  return `${videoPath}${VIDEO_FRAMES_SUFFIX}`;
}

/** Binaries are resolved once from PATH, with the usual Linux locations as a fallback. */
function binary(name: "ffmpeg" | "ffprobe"): string {
  const override = process.env[`T3CODE_${name.toUpperCase()}_PATH`];
  if (override) return override;
  for (const dir of (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .concat(["/usr/bin", "/usr/local/bin"])) {
    if (!dir) continue;
    const candidate = NodePath.join(dir, name);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return name;
}

/** `nice -n 15 ionice -c 3 <cmd>` where those exist; each execs, so the child pid is ffmpeg's. */
function lowPriority(command: string, args: ReadonlyArray<string>): [string, Array<string>] {
  const ionice = ["/usr/bin/ionice", "/bin/ionice"].find((path) => NodeFS.existsSync(path));
  const nice = ["/usr/bin/nice", "/bin/nice"].find((path) => NodeFS.existsSync(path));
  const chain: string[] = [];
  if (ionice) chain.push(ionice, "-c", "3");
  chain.push(command, ...args);
  return nice ? [nice, ["-n", "15", ...chain]] : [chain[0]!, chain.slice(1)];
}

class VideoProcessError extends Error {}

interface RunOptions {
  readonly timeoutMs: number;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderrLine?: (line: string) => void;
}

function run(command: string, args: ReadonlyArray<string>, options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const [file, argv] = lowPriority(command, args);
    const child = NodeChildProcess.spawn(file, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderrTail = "";
    let partial = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new VideoProcessError(
          `${NodePath.basename(command)} took longer than ${options.timeoutMs / 1000} s`,
        ),
      );
    }, options.timeoutMs);
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdout) options.onStdout(chunk);
      else if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) options.onStderrLine?.(line);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (partial) options.onStderrLine?.(partial);
      if (code === 0) finish(null);
      else
        finish(
          new VideoProcessError(
            `${NodePath.basename(command)} exited ${code}: ${stderrTail.split("\n").slice(-3).join(" ").trim()}`,
          ),
        );
    });
  });
}

/** Swaps width and height for a phone video recorded in portrait with a rotation tag. */
function displaySize(probeJson: string, probe: VideoProbe): { width: number; height: number } {
  try {
    const parsed = JSON.parse(probeJson) as { streams?: Array<Record<string, unknown>> };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const sideData = (video?.side_data_list as Array<Record<string, unknown>> | undefined) ?? [];
    const tags = (video?.tags as Record<string, unknown> | undefined) ?? {};
    const rotation = Number(
      sideData.find((entry) => "rotation" in entry)?.rotation ?? tags.rotate ?? 0,
    );
    if (Math.abs(rotation) % 180 === 90) return { width: probe.height, height: probe.width };
  } catch {
    // Fall through to the coded size.
  }
  return { width: probe.width, height: probe.height };
}

interface AnalysisResult {
  /** pts of the first decoded frame; every time below is relative to it. */
  readonly startPts: number;
  readonly samples: ReadonlyArray<MotionSample>;
  readonly selected: ReadonlyArray<FrameCandidate>;
}

/** One decode at 96 px wide gray: per-frame change, flash reverts and the overview picks. */
async function analyse(videoPath: string, analysisHeight: number): Promise<AnalysisResult> {
  const frameBytes = VIDEO_ANALYSIS_WIDTH * analysisHeight;
  const times: number[] = [];
  const samples: Array<{
    n: number;
    t: number;
    changed: number;
    mean: number;
    revert: number | null;
    revert2: number | null;
  }> = [];
  const recent: Uint8Array[] = [];
  const selector = new FrameSelector();
  let pending: Buffer = Buffer.alloc(0);
  let frames: Uint8Array[] = [];
  let index = 0;

  const drain = () => {
    while (frames.length > 0 && times.length > index) {
      const frame = frames.shift()!;
      const t = times[index]!;
      const previous = recent.at(-1);
      samples.push({
        n: index,
        t,
        changed: previous ? changedPixels(frame, previous) : 0,
        mean: previous ? meanAbsDiff(frame, previous) : 0,
        revert: null,
        revert2: null,
      });
      // This frame against the one two back says whether the frame in between reverted.
      if (recent.length >= 2) samples[index - 1]!.revert = meanAbsDiff(frame, recent.at(-2)!);
      if (recent.length >= 3) samples[index - 2]!.revert2 = meanAbsDiff(frame, recent.at(-3)!);
      recent.push(frame);
      if (recent.length > 3) recent.shift();
      selector.push(index, t, frame);
      index++;
    }
  };

  await run(
    binary("ffmpeg"),
    [
      "-hide_banner",
      "-nostats",
      "-threads",
      "2",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      `showinfo,scale=${VIDEO_ANALYSIS_WIDTH}:${analysisHeight}:flags=area,format=gray`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    {
      timeoutMs: PASS_TIMEOUT_MS,
      onStderrLine: (line) => {
        if (!line.includes("Parsed_showinfo")) return;
        const match = / pts_time:(-?[0-9.]+)/.exec(line);
        if (match) {
          times.push(Number(match[1]));
          drain();
        }
      },
      onStdout: (chunk) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        while (pending.length >= frameBytes) {
          frames.push(new Uint8Array(pending.subarray(0, frameBytes)));
          pending = pending.subarray(frameBytes);
        }
        drain();
      },
    },
  );
  drain();
  frames = [];
  const base = samples[0]?.t ?? 0;
  return {
    startPts: base,
    samples: samples.map((sample) => ({ ...sample, t: sample.t - base })),
    selected: selector.finish().map((candidate) => ({ ...candidate, t: candidate.t - base })),
  };
}

async function extract(
  videoPath: string,
  outDir: string,
  selected: ReadonlyArray<FrameCandidate>,
  startPts: number,
): Promise<{ frames: VideoFrameEntry[]; sheets: VideoSheetEntry[] }> {
  const columns = Math.min(SHEET_COLUMNS, selected.length);
  const rows = Math.min(SHEET_ROWS, Math.ceil(selected.length / columns));
  const perSheet = columns * rows;
  const select = selected.map((candidate) => `eq(n\\,${candidate.n})`).join("+");
  const label =
    "drawtext=text='%{pts\\:hms}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.65:boxborderw=3";
  const times: number[] = [];
  await run(
    binary("ffmpeg"),
    [
      "-hide_banner",
      "-nostats",
      "-threads",
      "2",
      "-i",
      videoPath,
      "-filter_complex",
      `[0:v:0]select='${select}',showinfo,setpts=PTS-${startPts.toFixed(6)}/TB,split=2[f][s];` +
        `[f]scale=${VIDEO_FRAME_MAX_EDGE}:${VIDEO_FRAME_MAX_EDGE}:force_original_aspect_ratio=decrease:force_divisible_by=2[fo];` +
        `[s]scale=${SHEET_TILE_WIDTH}:${SHEET_TILE_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,${label},` +
        `tile=${columns}x${rows}:padding=4:margin=4:color=0x303030[so]`,
      "-map",
      "[fo]",
      "-fps_mode",
      "passthrough",
      "-q:v",
      "4",
      NodePath.join(outDir, "x_%03d.jpg"),
      "-map",
      "[so]",
      "-fps_mode",
      "passthrough",
      "-q:v",
      "4",
      NodePath.join(outDir, "sheet_%d.jpg"),
    ],
    {
      timeoutMs: PASS_TIMEOUT_MS,
      onStderrLine: (line) => {
        if (!line.includes("Parsed_showinfo")) return;
        const match = / pts_time:(-?[0-9.]+)/.exec(line);
        if (match) times.push(Number(match[1]) - startPts);
      },
    },
  );
  const frameTimes = selected.map((candidate, i) => times[i] ?? candidate.t);
  const names = frameFileNames(frameTimes);
  const frames: VideoFrameEntry[] = [];
  for (const [i, candidate] of selected.entries()) {
    const from = NodePath.join(outDir, `x_${String(i + 1).padStart(3, "0")}.jpg`);
    if (!NodeFS.existsSync(from)) continue;
    await NodeFSP.rename(from, NodePath.join(outDir, names[i]!));
    frames.push({
      file: names[i]!,
      t: Math.round(frameTimes[i]! * 1000) / 1000,
      n: candidate.n,
      kind: candidate.kind,
    });
  }
  const sheets: VideoSheetEntry[] = [];
  for (let i = 0; i * perSheet < frames.length; i++) {
    const file = `sheet_${i + 1}.jpg`;
    if (!NodeFS.existsSync(NodePath.join(outDir, file))) continue;
    const covered = frames.slice(i * perSheet, (i + 1) * perSheet);
    sheets.push({ file, from: covered[0]!.t, to: covered.at(-1)!.t, frames: covered.length });
  }
  return { frames, sheets };
}

function motionCsv(samples: ReadonlyArray<MotionSample>): string {
  const rows = samples.map(
    (s) =>
      `${s.n},${s.t.toFixed(4)},${s.changed},${s.mean.toFixed(2)},${s.revert === null ? "" : s.revert.toFixed(2)}`,
  );
  return `frame,pts_seconds,changed_pixels,mean_diff,revert_diff\n${rows.join("\n")}\n`;
}

async function processVideo(videoPath: string): Promise<VideoManifest> {
  const started = Date.now();
  const size = (await NodeFSP.stat(videoPath)).size;
  let probeJson: string;
  try {
    probeJson = await run(
      binary("ffprobe"),
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", videoPath],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
  } catch {
    return {
      version: 1,
      status: "rejected",
      reason: "the file could not be read as a video (corrupt or not a video)",
    };
  }
  const probed = parseProbe(probeJson, size);
  if (!probed.ok) return { version: 1, status: "rejected", reason: probed.reason };
  const display = displaySize(probeJson, probed.probe);
  const probe = { ...probed.probe, ...display };
  const analysisHeight = Math.max(
    2,
    Math.round((VIDEO_ANALYSIS_WIDTH * display.height) / display.width / 2) * 2,
  );

  const workDir = `${videoFramesDir(videoPath)}.${NodeCrypto.randomUUID()}.part`;
  await NodeFSP.mkdir(workDir, { recursive: true });
  try {
    const analysis = await analyse(videoPath, analysisHeight);
    if (analysis.samples.length === 0 || analysis.selected.length === 0) {
      return {
        version: 1,
        status: "rejected",
        reason: "no picture could be decoded (corrupt video)",
      };
    }
    const { frames, sheets } = await extract(
      videoPath,
      workDir,
      analysis.selected,
      analysis.startPts,
    );
    if (frames.length === 0)
      return { version: 1, status: "failed", reason: "no frames could be extracted" };
    const manifest: VideoManifest = {
      version: 1,
      status: "ok",
      probe,
      frames,
      sheets,
      timeline: motionTimeline(analysis.samples),
      elapsedMs: Date.now() - started,
    };
    await NodeFSP.writeFile(NodePath.join(workDir, "motion.csv"), motionCsv(analysis.samples));
    await NodeFSP.writeFile(NodePath.join(workDir, MANIFEST), JSON.stringify(manifest, null, 1));
    await NodeFSP.rename(workDir, videoFramesDir(videoPath)).catch(
      async (error: NodeJS.ErrnoException) => {
        // Another run published first; its result is the same video's.
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      },
    );
    return manifest;
  } finally {
    await NodeFSP.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeOutcome(videoPath: string, manifest: VideoManifest): Promise<void> {
  if (manifest.status === "ok") return;
  const dir = videoFramesDir(videoPath);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dir, MANIFEST), JSON.stringify(manifest, null, 1));
}

export async function readVideoManifest(videoPath: string): Promise<VideoManifest | null> {
  try {
    return JSON.parse(
      await NodeFSP.readFile(NodePath.join(videoFramesDir(videoPath), MANIFEST), "utf8"),
    ) as VideoManifest;
  } catch {
    return null;
  }
}

// One video at a time across the whole server; the same path is never processed twice at once.
let queue: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<VideoManifest>>();
/** A claimed copy whose frames the pending upload is still producing. */
const sources = new Map<string, string>();

export function ensureVideoFrames(videoPath: string): Promise<VideoManifest> {
  const existing = inFlight.get(videoPath);
  if (existing) return existing;
  const work = (async () => {
    const ready = await readVideoManifest(videoPath);
    if (ready) return ready;
    const source = sources.get(videoPath);
    if (source !== undefined) {
      sources.delete(videoPath);
      const copied = await ensureVideoFrames(source).then(
        async (manifest) => ((await copyVideoFrames(source, videoPath)) ? manifest : null),
        () => null,
      );
      if (copied) return copied;
    }
    const result = queue.then(() =>
      processVideo(videoPath).catch((error: unknown): VideoManifest => ({
        version: 1,
        status: "failed",
        reason: error instanceof Error ? error.message : "extraction failed",
      })),
    );
    queue = result.catch(() => undefined);
    const manifest = await result;
    await writeOutcome(videoPath, manifest).catch(() => undefined);
    return manifest;
  })().finally(() => inFlight.delete(videoPath));
  inFlight.set(videoPath, work);
  return work;
}

/** Copies a finished frames folder to a claimed copy of the same video. False when there is none yet. */
async function copyVideoFrames(fromVideo: string, toVideo: string): Promise<boolean> {
  const from = videoFramesDir(fromVideo);
  if (!NodeFS.existsSync(NodePath.join(from, MANIFEST))) return false;
  const staging = `${videoFramesDir(toVideo)}.${NodeCrypto.randomUUID()}.part`;
  try {
    await NodeFSP.cp(from, staging, { recursive: true });
    await NodeFSP.rename(staging, videoFramesDir(toVideo)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
    return true;
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The claim copies a pending upload to the thread's own id. Copy the frames now
 * when they are ready; otherwise the turn waits for the pending run and copies
 * them then, instead of decoding the video a second time.
 */
export async function claimVideoFrames(pendingVideo: string, claimedVideo: string): Promise<void> {
  if (await copyVideoFrames(pendingVideo, claimedVideo).catch(() => false)) return;
  sources.set(claimedVideo, pendingVideo);
}

/** Absolute paths for the images a turn should carry: sheets first, then frames in time order. */
export function videoImagePaths(
  videoPath: string,
  manifest: VideoManifest,
): Array<{ path: string; label: string }> {
  if (manifest.status !== "ok") return [];
  const dir = videoFramesDir(videoPath);
  return [
    ...manifest.sheets.map((sheet) => ({
      path: NodePath.join(dir, sheet.file),
      label: sheet.file,
    })),
    ...manifest.frames.map((frame) => ({
      path: NodePath.join(dir, frame.file),
      label: frame.file,
    })),
  ];
}
