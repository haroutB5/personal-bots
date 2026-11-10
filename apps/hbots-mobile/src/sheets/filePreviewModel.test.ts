import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";
import { describe, expect, it } from "vite-plus/test";

import {
  FILE_PREVIEW_TOO_LARGE_TEXT,
  TEXT_PREVIEW_MAX_ROW_CHARS,
  filePreviewErrorText,
  filePreviewRoute,
  filePreviewState,
  imageSizeVerdict,
  textPreviewRows,
  type FilePreviewSource,
  type FileTextRead,
  type ImageSizeRead,
} from "./filePreviewModel.ts";

const success = (url: string): AssetUrlState => ({
  _tag: "Success",
  url,
  expiresAt: 4_000_000_000_000,
});

const textSource = (asset: AssetUrlState, read: FileTextRead): FilePreviewSource => ({
  _tag: "Text",
  asset,
  read,
});

const imageSource = (
  asset: AssetUrlState,
  size: ImageSizeRead = { _tag: "Ready" },
): FilePreviewSource => ({ _tag: "Image", asset, size });

const state = (path: string | null, source: FilePreviewSource) =>
  filePreviewState({ path, source });

describe("filePreviewRoute", () => {
  it("sends text, markdown and source files to the text route", () => {
    expect(filePreviewRoute("NOTES.md")).toBe("text");
    expect(filePreviewRoute("/home/harout/run/result.json")).toBe("text");
    expect(filePreviewRoute("apps/hbots-mobile/src/parity.ts")).toBe("text");
  });

  it("sends raster images to the image route", () => {
    expect(filePreviewRoute("shot.png")).toBe("image");
    expect(filePreviewRoute("photo.JPEG")).toBe("image");
  });

  it("leaves anything else unsupported", () => {
    expect(filePreviewRoute("archive.zip")).toBe("unsupported");
    expect(filePreviewRoute("binary")).toBe("unsupported");
  });
});

describe("filePreviewState", () => {
  it("is loading until a file is picked", () => {
    expect(state(null, textSource(success("https://x/a.md"), { _tag: "Pending" }))).toEqual({
      _tag: "Loading",
    });
  });

  it("waits for the signed URL before reading", () => {
    expect(state("NOTES.md", textSource({ _tag: "Loading" }, { _tag: "Pending" }))).toEqual({
      _tag: "Loading",
    });
  });

  it("shows text once the URL is minted and the bytes decode", () => {
    expect(
      state(
        "NOTES.md",
        textSource(success("https://x/a.md"), { _tag: "Loaded", text: "hi", truncated: false }),
      ),
    ).toEqual({ _tag: "Text", text: "hi" });
  });

  it("shows the image once the URL is minted and its size is safe", () => {
    expect(state("shot.png", imageSource(success("https://x/a.png")))).toEqual({
      _tag: "Image",
      url: "https://x/a.png",
    });
    expect(state("shot.png", imageSource(success("https://x/a.png"), { _tag: "Pending" }))).toEqual(
      { _tag: "Loading" },
    );
  });

  it("refuses a text body or an image past the phone's preview cap", () => {
    expect(state("NOTES.md", textSource(success("https://x/a.md"), { _tag: "TooLarge" }))).toEqual({
      _tag: "TooLarge",
    });
    expect(
      state("shot.png", imageSource(success("https://x/a.png"), { _tag: "TooLarge" })),
    ).toEqual({ _tag: "TooLarge" });
    expect(FILE_PREVIEW_TOO_LARGE_TEXT).toBe("This file is too large to preview on the phone.");
  });

  it("reports a failed image size check as a read failure", () => {
    expect(state("shot.png", imageSource(success("https://x/a.png"), { _tag: "Failed" }))).toEqual({
      _tag: "Error",
      reason: "read-failed",
    });
  });

  it("shows the protected state for a credential file", () => {
    const asset: AssetUrlState = { _tag: "Failure", protectedFile: true };
    expect(state("NOTES.md", textSource(asset, { _tag: "Pending" }))).toEqual({ _tag: "Denied" });
    expect(state("shot.png", imageSource(asset))).toEqual({ _tag: "Denied" });
  });

  it("says not found for a path the server cannot see", () => {
    const asset: AssetUrlState = { _tag: "Failure", notFound: true };
    expect(state("NOTES.md", textSource(asset, { _tag: "Pending" }))).toEqual({
      _tag: "Error",
      reason: "not-found",
    });
  });

  it("says the connection is denied when the session lacks the scope", () => {
    const asset: AssetUrlState = { _tag: "Failure", deniedAccess: true };
    expect(state("NOTES.md", textSource(asset, { _tag: "Pending" }))).toEqual({
      _tag: "Error",
      reason: "denied-access",
    });
  });

  it("calls any other mint failure an open failure", () => {
    expect(state("NOTES.md", textSource({ _tag: "Failure" }, { _tag: "Pending" }))).toEqual({
      _tag: "Error",
      reason: "open-failed",
    });
  });

  it("marks non-UTF-8 or binary bytes as not showable", () => {
    expect(state("NOTES.md", textSource(success("https://x/a.md"), { _tag: "Binary" }))).toEqual({
      _tag: "Unsupported",
    });
  });

  it("separates a failed download from a timed-out one", () => {
    expect(state("NOTES.md", textSource(success("https://x/a.md"), { _tag: "Failed" }))).toEqual({
      _tag: "Error",
      reason: "read-failed",
    });
    expect(state("NOTES.md", textSource(success("https://x/a.md"), { _tag: "TimedOut" }))).toEqual({
      _tag: "Error",
      reason: "timed-out",
    });
  });

  it("leaves an unsupported type unsupported once the mint succeeds", () => {
    expect(
      state("archive.zip", { _tag: "Unsupported", asset: success("https://x/a.zip") }),
    ).toEqual({
      _tag: "Unsupported",
    });
    expect(state("archive.zip", { _tag: "Unsupported", asset: { _tag: "Loading" } })).toEqual({
      _tag: "Loading",
    });
  });

  it("still reports a protected or missing file with no phone preview", () => {
    expect(
      state("config", {
        _tag: "Unsupported",
        asset: { _tag: "Failure", protectedFile: true },
      }),
    ).toEqual({ _tag: "Denied" });
    expect(
      state("config", { _tag: "Unsupported", asset: { _tag: "Failure", notFound: true } }),
    ).toEqual({ _tag: "Error", reason: "not-found" });
  });
});

describe("textPreviewRows", () => {
  it("keeps ordinary lines as they are", () => {
    expect(textPreviewRows("one\ntwo\n")).toEqual(["one", "two", ""]);
  });

  it("splits a line longer than the row cap", () => {
    const line = "x".repeat(TEXT_PREVIEW_MAX_ROW_CHARS * 2 + 1);
    const rows = textPreviewRows(line);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.length <= TEXT_PREVIEW_MAX_ROW_CHARS)).toBe(true);
    expect(rows.join("")).toBe(line);
  });

  it("splits the one-megabyte line that used to hang the sheet", () => {
    const line = "a".repeat(1024 * 1024);
    const rows = textPreviewRows(line);
    expect(rows.length).toBeGreaterThan(500);
    expect(rows.every((row) => row.length <= TEXT_PREVIEW_MAX_ROW_CHARS)).toBe(true);
    expect(rows.join("")).toBe(line);
  });

  it("leaves an empty file as one empty row", () => {
    expect(textPreviewRows("")).toEqual([""]);
  });
});

describe("imageSizeVerdict", () => {
  it("passes a declared size at or under the cap", () => {
    expect(imageSizeVerdict("20971520", 20 * 1024 * 1024)).toBe("ready");
    expect(imageSizeVerdict("0", 20 * 1024 * 1024)).toBe("ready");
  });

  it("refuses a declared size over the cap", () => {
    expect(imageSizeVerdict("20971521", 20 * 1024 * 1024)).toBe("too-large");
  });

  it("treats a missing or unusable length as unknown, not a pass", () => {
    expect(imageSizeVerdict(null, 20 * 1024 * 1024)).toBe("unknown");
    expect(imageSizeVerdict("", 20 * 1024 * 1024)).toBe("unknown");
    expect(imageSizeVerdict("-1", 20 * 1024 * 1024)).toBe("unknown");
    expect(imageSizeVerdict("12.5", 20 * 1024 * 1024)).toBe("unknown");
    expect(imageSizeVerdict("huge", 20 * 1024 * 1024)).toBe("unknown");
  });
});

describe("filePreviewErrorText", () => {
  it("gives not-found and denied-access their own sentences", () => {
    const notFound = filePreviewErrorText("not-found");
    const denied = filePreviewErrorText("denied-access");
    expect(notFound).toBe("That file isn't there any more.");
    expect(denied).toBe("This connection isn't allowed to open that file.");
    expect(notFound).not.toBe(denied);
    expect(notFound).not.toBe("Couldn't read that file.");
    expect(denied).not.toBe("Couldn't read that file.");
  });
});
