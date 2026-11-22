// @effect-diagnostics nodeBuiltinImport:off -- checks whether the zoom helper is installed on this machine.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { describeMoment, formatClock, isVideoFile, type MotionSegment } from "./videoAnalysis.ts";
import {
  ensureVideoFrames,
  videoFramesDir,
  videoImagePaths,
  type VideoManifest,
} from "./VideoFrames.ts";

/** A turn waits this long for frames still being extracted before it goes without them. */
const TURN_WAIT = Duration.minutes(6);
const DEFAULT_ZOOM_TOOL = "/home/harout/Claude/AI/dev-team/tools/video-zoom.sh";

export function isVideoAttachment(attachment: ChatAttachment): boolean {
  return attachment.type === "file" && isVideoFile(attachment);
}

function zoomTool(): string | null {
  const configured = process.env.PERSONAL_VIDEO_ZOOM_TOOL ?? DEFAULT_ZOOM_TOOL;
  return NodeFS.existsSync(configured) ? configured : null;
}

const quote = (path: string) => `"${path.replaceAll('"', '\\"')}"`;

function segmentText(segments: ReadonlyArray<MotionSegment>): string {
  if (segments.length === 0) return "nothing moves";
  const shown = segments
    .slice(0, 12)
    .map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)} s`)
    .join(", ");
  return `moving ${shown}${segments.length > 12 ? ` (+${segments.length - 12} more)` : ""}; still otherwise`;
}

/** The text block a bot reads beside the frames. `attachedImages` is how many images fit the budget. */
export function videoContextText(input: {
  readonly name: string;
  readonly path: string;
  readonly manifest: VideoManifest | null;
  readonly attachedImages?: number | undefined;
}): string {
  const lines = [
    `[Video "${input.name}" for review. Audio not analysed.`,
    `Video file: ${input.path}`,
  ];
  const manifest = input.manifest;
  if (manifest === null) {
    lines.push(
      `Frames are still being extracted; they will appear in ${videoFramesDir(input.path)}/ (manifest.json lists them).`,
    );
  } else if (manifest.status !== "ok") {
    lines.push(`Frames could not be extracted: ${manifest.reason}.`);
  } else {
    const { probe, timeline, frames, sheets } = manifest;
    const dir = videoFramesDir(input.path);
    const total = sheets.length + frames.length;
    lines.push(
      `Duration ${formatClock(probe.durationSeconds)} (${probe.durationSeconds.toFixed(2)} s), ${probe.width}x${probe.height}, ` +
        `${probe.fps === null ? "unknown" : probe.fps} fps nominal${timeline.variableFrameRate ? ", variable frame rate" : ""}, ` +
        `${timeline.frames} frames decoded. Times below are real presentation timestamps from the start of the video.`,
      `Attached as images: ${sheets.map((s) => `contact sheet ${s.file} (${s.from.toFixed(1)}-${s.to.toFixed(1)} s, ${s.frames} frames, timestamps burned in)`).join(", ")}, then ${frames.length} frames in time order.` +
        (input.attachedImages !== undefined && input.attachedImages < total
          ? ` Only the first ${input.attachedImages} of these ${total} images fit this chat's image budget; open the rest from disk.`
          : ""),
      `Frames folder: ${dir}/`,
      `Frames: ${frames.map((f) => `${f.t.toFixed(3)}s ${f.file}`).join(", ")}`,
      `Motion: ${segmentText(timeline.segments)}. Typical gap between changing frames while moving: ${timeline.frameIntervalMs} ms.`,
    );
    if (timeline.moments.length === 0) {
      lines.push(
        "Suspicious moments: none found (no stalls, one- or two-frame flashes or sudden jumps inside motion).",
      );
    } else {
      lines.push("Suspicious moments (zoom in on these to confirm):");
      for (const moment of timeline.moments.slice(0, 20)) lines.push(`- ${describeMoment(moment)}`);
      if (timeline.moments.length > 20)
        lines.push(`- … ${timeline.moments.length - 20} more in motion.csv`);
    }
    lines.push(
      `Per-frame motion data: ${NodePath.join(dir, "motion.csv")} (frame, pts seconds, changed pixels, mean difference, revert difference).`,
    );
  }
  const tool = zoomTool();
  lines.push(
    `For a closer look run \`ffmpeg -ss <t> -i ${quote(input.path)} -frames:v 1 out.jpg\`` +
      (tool === null
        ? "."
        : `, or \`${tool} ${quote(input.path)} <start> <end> [fps] [--crop x,y,w,h]\` for every frame in a window as numbered frames plus a sheet labelled with frame numbers and ms timestamps (use it for animation glitches shorter than the gaps between the frames above).`) +
      "]",
  );
  return lines.join("\n");
}

/** Waits for extraction (bounded) and returns the manifest, or null while it is still running. */
export const awaitVideoManifest = Effect.fn("VideoFrames.awaitManifest")(function* (path: string) {
  const result = yield* Effect.promise(() => ensureVideoFrames(path)).pipe(
    Effect.timeoutOption(TURN_WAIT),
  );
  return Option.getOrNull(result);
});

export interface VideoTurnImage {
  readonly path: string;
  readonly mimeType: "image/jpeg";
}

export function videoTurnImages(
  path: string,
  manifest: VideoManifest | null,
): Array<VideoTurnImage> {
  if (manifest === null) return [];
  return videoImagePaths(path, manifest).map((image) => ({
    path: image.path,
    mimeType: "image/jpeg",
  }));
}
