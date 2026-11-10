import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";
import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewErrorText,
  filePreviewRoute,
  filePreviewState,
  type FilePreviewSource,
  type FileTextRead,
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

const imageSource = (asset: AssetUrlState): FilePreviewSource => ({ _tag: "Image", asset });

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

  it("shows the image once the URL is minted", () => {
    expect(state("shot.png", imageSource(success("https://x/a.png")))).toEqual({
      _tag: "Image",
      url: "https://x/a.png",
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

  it("leaves an unsupported type unsupported", () => {
    expect(state("archive.zip", { _tag: "Unsupported" })).toEqual({ _tag: "Unsupported" });
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
