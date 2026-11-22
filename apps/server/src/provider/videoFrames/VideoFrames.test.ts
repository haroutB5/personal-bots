// @effect-diagnostics nodeBuiltinImport:off -- the fixture clip is made by the ffmpeg binary under test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  ensureVideoFrames,
  readVideoManifest,
  videoFramesDir,
  videoImagePaths,
} from "./VideoFrames.ts";

const hasFfmpeg =
  NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0 &&
  NodeChildProcess.spawnSync("ffprobe", ["-version"]).status === 0;

function scratch(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "video-frames-"));
}

/**
 * 6 s at 60 fps: a box swinging left and right, a one-frame white flash at
 * 2.500 s and a 200 ms freeze from 3.000 s. Frames 181-191 are dropped, the
 * way an Android recorder skips frames that did not change.
 */
function makeClip(dir: string): string {
  const out = NodePath.join(dir, "clip.mp4");
  const time = "if(lt(t\\,3)\\,t\\,if(lt(t\\,3.2)\\,3\\,t-0.2))";
  const result = NodeChildProcess.spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x202020:s=360x780:r=60:d=6",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=60x60:r=60:d=6",
    "-filter_complex",
    `[0][1]overlay=x='150+120*sin(PI*${time})':y=300,` +
      "drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill:enable='eq(n\\,150)'," +
      "select='not(between(n\\,181\\,191))'",
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return out;
}

describe.skipIf(!hasFfmpeg)("VideoFrames (needs ffmpeg and ffprobe on PATH)", () => {
  it("extracts named frames, a contact sheet and flags the flash and the freeze", async () => {
    const dir = scratch();
    try {
      const clip = makeClip(dir);
      const manifest = await ensureVideoFrames(clip);
      expect(manifest.status).toBe("ok");
      if (manifest.status !== "ok") return;
      expect(manifest.probe).toMatchObject({ width: 360, height: 780, hasAudio: false });
      expect(manifest.frames[0]).toMatchObject({ file: "f_00m00.0s.jpg", t: 0, kind: "first" });
      expect(manifest.sheets.map((sheet) => sheet.file)).toEqual(["sheet_1.jpg"]);
      for (const image of videoImagePaths(clip, manifest)) {
        expect(NodeFS.statSync(image.path).size).toBeGreaterThan(0);
      }
      expect(NodeFS.existsSync(NodePath.join(videoFramesDir(clip), "motion.csv"))).toBe(true);
      expect(manifest.timeline.moments).toEqual([
        { kind: "flash", t: 2.5, frames: 1, n: 150 },
        expect.objectContaining({ kind: "stall", t: 3, durationMs: 217 }),
      ]);
      // A second call reads the stored manifest.
      expect(await readVideoManifest(clip)).toEqual(manifest);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt file and a file that is not a video", async () => {
    const dir = scratch();
    try {
      const corrupt = NodePath.join(dir, "broken.mp4");
      NodeFS.writeFileSync(corrupt, Buffer.from("\u0000\u0000\u0000\u0018ftypmp42 truncated"));
      const text = NodePath.join(dir, "notes.mp4");
      NodeFS.writeFileSync(text, "just some words\n".repeat(100));
      for (const path of [corrupt, text]) {
        const manifest = await ensureVideoFrames(path);
        expect(manifest).toMatchObject({ status: "rejected" });
        expect(await readVideoManifest(path)).toEqual(manifest);
      }
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
