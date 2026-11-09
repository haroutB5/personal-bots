import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";
import { describe, expect, it } from "vite-plus/test";

import { filePreviewErrorText, filePreviewState } from "./filePreviewModel.ts";

const FOLDER = "/home/harout/.personal-bots/dev/personal-workspace";
const success = (url: string): AssetUrlState => ({
  _tag: "Success",
  url,
  expiresAt: 4_000_000_000_000,
});
const pendingText = { _tag: "Pending" } as const;

describe("filePreviewState", () => {
  it("asks for a folder when the chat has none", () => {
    expect(
      filePreviewState({
        folder: null,
        path: "README.md",
        asset: success("https://phone.test/api/assets/readme"),
        text: pendingText,
      }),
    ).toEqual({ _tag: "NoFolder" });
  });

  it("loads while the asset URL is being minted", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "README.md",
        asset: { _tag: "Loading" },
        text: pendingText,
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("loads while the text is being read", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "README.md",
        asset: success("https://phone.test/api/assets/readme"),
        text: pendingText,
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("shows the text it read", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "README.md",
        asset: success("https://phone.test/api/assets/readme"),
        text: { _tag: "Loaded", text: "# Notes\nOne line." },
      }),
    ).toEqual({ _tag: "Text", text: "# Notes\nOne line." });
  });

  it("shows an image once its URL is ready", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "screens/home.png",
        asset: success("https://phone.test/api/assets/home"),
        text: pendingText,
      }),
    ).toEqual({ _tag: "Image", url: "https://phone.test/api/assets/home" });
  });

  it("names a kind the phone cannot show", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "release-notes.pdf",
        asset: success("https://phone.test/api/assets/release-notes"),
        text: pendingText,
      }),
    ).toEqual({ _tag: "Unsupported" });
  });

  it("refuses a protected file", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: ".env",
        asset: { _tag: "Failure", protectedFile: true },
        text: pendingText,
      }),
    ).toEqual({ _tag: "Denied" });
  });

  it("says a missing file is gone", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "docs/removed.md",
        asset: { _tag: "Failure", notFound: true },
        text: pendingText,
      }),
    ).toEqual({ _tag: "Error", reason: "not-found" });
  });

  it("stops on a text read that ran out of time", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "logs/2026-11-09.log",
        asset: success("https://phone.test/api/assets/log"),
        text: { _tag: "TimedOut" },
      }),
    ).toEqual({ _tag: "Error", reason: "timed-out" });
  });

  it("stops on a failed text read", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "notes.md",
        asset: success("https://phone.test/api/assets/notes"),
        text: { _tag: "Failed" },
      }),
    ).toEqual({ _tag: "Error", reason: "read-failed" });
  });

  it("stops on any other asset failure", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "notes.md",
        asset: { _tag: "Failure" },
        text: pendingText,
      }),
    ).toEqual({ _tag: "Error", reason: "open-failed" });
  });
});

describe("filePreviewErrorText", () => {
  it("gives each reason its own line", () => {
    expect({
      notFound: filePreviewErrorText("not-found"),
      openFailed: filePreviewErrorText("open-failed"),
      readFailed: filePreviewErrorText("read-failed"),
      timedOut: filePreviewErrorText("timed-out"),
    }).toEqual({
      notFound: "That file isn't there any more.",
      openFailed: "Couldn't open that file.",
      readFailed: "Couldn't read that file.",
      timedOut: "That file took too long to read.",
    });
  });
});
