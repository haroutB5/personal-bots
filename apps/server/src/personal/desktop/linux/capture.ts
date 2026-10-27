// @effect-diagnostics nodeBuiltinImport:off - grim writes a temp file that is read back and unlinked.
// @effect-diagnostics globalTimers:off - capture timing is a plain millisecond clock.
// @effect-diagnostics globalDate:off - capture timing is a plain millisecond clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { jpegSize } from "../../browser/jpegSize.ts";
import { DesktopHelperError } from "../DesktopHelper.ts";
import { runCommand, type LinuxSession, sessionEnv } from "./session.ts";

export interface CaptureRequest {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Desired image width; the capture is scaled down to it, never up. */
  readonly outWidth?: number;
  readonly outHeight?: number;
  readonly quality?: number;
  /** Close the banner while this pixel capture is taken (evidence shots). */
  readonly hideOverlay?: boolean;
}

export interface CaptureResult {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly captureMs: number;
}

/**
 * One grim capture. `grim -c` includes the pointer, so the screenshot needs no
 * cursor composite; `-s` is relative to the logical size (SPEC.md 5.3).
 */
export class LinuxScreenCapture {
  private readonly session: LinuxSession;
  private readonly tempDir: string;

  constructor(session: LinuxSession, tempDir: string) {
    this.session = session;
    this.tempDir = tempDir;
    NodeFS.mkdirSync(tempDir, { recursive: true });
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const started = Date.now();
    const width = Math.max(1, Math.round(request.width));
    const height = Math.max(1, Math.round(request.height));
    const wantedWidth = request.outWidth === undefined ? width : Math.max(1, request.outWidth);
    const scale = Math.min(1, wantedWidth / width);
    const file = NodePath.join(this.tempDir, `shot-${NodeCrypto.randomUUID()}.jpg`);
    const quality = Math.max(1, Math.min(100, Math.round(request.quality ?? 80)));
    const args = [
      "-g",
      `${Math.round(request.x)},${Math.round(request.y)} ${width}x${height}`,
      "-s",
      scale.toFixed(5),
      "-t",
      "jpeg",
      "-q",
      String(quality),
      "-c",
      file,
    ];
    try {
      const result = await runCommand("grim", args, {
        env: sessionEnv(this.session),
        timeoutMs: 15_000,
      });
      if (result.code !== 0) {
        throw new DesktopHelperError(
          "unavailable",
          `The screen could not be captured: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
        );
      }
      let buffer = NodeFS.readFileSync(file);
      let size = jpegSize(buffer);
      if (size === null) {
        throw new DesktopHelperError("unavailable", "The screen capture was not a JPEG image.");
      }
      if (
        request.outWidth !== undefined &&
        request.outHeight !== undefined &&
        (size.width !== request.outWidth || size.height !== request.outHeight)
      ) {
        // A scale factor rounds to whole pixels; the click frame is built from
        // the requested size, so make the image match it exactly.
        const resized = await runCommand(
          "magick",
          [file, "-resize", `${request.outWidth}x${request.outHeight}!`, file],
          { env: sessionEnv(this.session), timeoutMs: 15_000 },
        );
        if (resized.code === 0) {
          buffer = NodeFS.readFileSync(file);
          size = jpegSize(buffer) ?? size;
        }
      }
      return {
        data: buffer.toString("base64"),
        width: size.width,
        height: size.height,
        captureMs: Date.now() - started,
      };
    } finally {
      NodeFS.unlink(file, () => undefined);
    }
  }
}
