import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const MOBILE_ROOT = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const KOTLIN_ROOT = NodePath.join(
  MOBILE_ROOT,
  "modules/hbots-liveview/android/src/main/java/expo/modules/hbotsliveview",
);
const COMPUTER_ROOT = NodePath.join(MOBILE_ROOT, "src/computer");

function kotlinFiles(): ReadonlyArray<{ readonly name: string; readonly text: string }> {
  return NodeFS.readdirSync(KOTLIN_ROOT)
    .filter((name) => name.endsWith(".kt"))
    .map((name) => ({ name, text: NodeFS.readFileSync(NodePath.join(KOTLIN_ROOT, name), "utf8") }));
}

function source(name: string): string {
  return NodeFS.readFileSync(NodePath.join(COMPUTER_ROOT, name), "utf8");
}

const PERSISTENCE_IN_KOTLIN = [
  "FileOutputStream",
  "FileInputStream",
  "openFileOutput",
  "openFileInput",
  "getSharedPreferences",
  "SharedPreferences",
  "cacheDir",
  "filesDir",
  "MediaStore",
  "ContentResolver",
  "Bitmap.compress",
  "ByteArrayOutputStream",
  "createTempFile",
  "SQLiteDatabase",
  "Room.",
  "java.io.File",
];

const PERSISTENCE_IN_TYPESCRIPT = [
  "expo-file-system",
  "FileSystem.",
  "writeAsString",
  "readAsString",
  "base64",
  "arrayBuffer",
  "Uint8Array",
  "Buffer.from",
  "localStorage",
];

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("frames never reach storage", () => {
  it("has no disk, cache or preferences write in the Kotlin module", () => {
    for (const file of kotlinFiles()) {
      for (const token of PERSISTENCE_IN_KOTLIN) {
        expect(file.text, `${file.name} must not use ${token}`).not.toContain(token);
      }
    }
  });

  it("has no file or byte-buffer path in the TypeScript live view", () => {
    for (const name of [
      "liveView.ts",
      "ComputerLiveView.tsx",
      "ComputerScreen.tsx",
      "ComputerActivitySheet.tsx",
      "ComputerCards.tsx",
      "computerScreenModel.ts",
      "liveViewAccess.ts",
    ]) {
      const text = source(name);
      for (const token of PERSISTENCE_IN_TYPESCRIPT) {
        expect(text, `${name} must not use ${token}`).not.toContain(token);
      }
    }
  });

  it("holds exactly one bitmap and recycles the one it replaces", () => {
    const view = kotlinFiles().find((file) => file.name === "HbotsLiveView.kt");
    expect(view).toBeDefined();
    const text = view?.text ?? "";

    expect(text.match(/private var bitmap: Bitmap\? = null/g)).toHaveLength(1);

    const setFrame = between(text, "fun setFrame", "fun clear");
    expect(setFrame).toContain("val previous = bitmap");
    expect(setFrame).toContain("bitmap = next");
    expect(setFrame).toContain("previous?.recycle()");

    const clear = between(text, "fun clear", "override fun onSizeChanged");
    expect(clear).toContain("bitmap = null");
    expect(clear).toContain("previous?.recycle()");
  });

  it("decodes a frame straight into the view and never copies it for JavaScript", () => {
    const view = kotlinFiles().find((file) => file.name === "HbotsLiveView.kt");
    const text = view?.text ?? "";

    expect(text.match(/BitmapFactory\.decodeByteArray/g)).toHaveLength(1);

    const onBinary = between(
      text,
      "override fun onMessage(webSocket: WebSocket, bytes: ByteString)",
      "override fun onMessage(webSocket: WebSocket, text: String)",
    );
    expect(onBinary).toContain("frameView.setFrame(bitmap, meta)");
    expect(onBinary).toContain('"width" to meta.width');
    expect(onBinary).toContain('"height" to meta.height');
    expect(onBinary).toContain('"scale" to meta.deviceScaleFactor');
    expect(onBinary).not.toContain("base64");
  });

  it("sends only the frame size to JavaScript, never the bytes", () => {
    const view = source("liveView.ts");
    const frameEvent = between(view, "export interface LiveFrameEvent {", "}");
    expect(frameEvent).toContain("width: number");
    expect(frameEvent).toContain("height: number");
    expect(frameEvent).toContain("scale: number");
    expect(frameEvent).not.toContain("bytes");
    expect(frameEvent).not.toContain("data");
    expect(frameEvent).not.toContain("image");

    const screen = source("ComputerLiveView.tsx");
    const handler = between(screen, "const frame = (event", "const closed = (event");
    expect(handler).toContain("metaRef.current = { width: next.width, height: next.height }");
    expect(handler).not.toContain("base64");
    expect(handler).not.toContain("arrayBuffer");
  });
});
