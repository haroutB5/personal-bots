import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewErrorText,
  filePreviewRoute,
  filePreviewState,
  fileTextRead,
  type FileReadOutcome,
  type FileTextRead,
} from "./filePreviewModel.ts";

const FOLDER = "/home/harout/.personal-bots/dev/personal-workspace";

const success = (url: string): AssetUrlState => ({
  _tag: "Success",
  url,
  expiresAt: 4_000_000_000_000,
});

const readResult = (overrides: Partial<ProjectReadFileResult>): ProjectReadFileResult => ({
  relativePath: "NOTES.md",
  contents: "",
  byteLength: 0,
  truncated: false,
  ...overrides,
});

const loaded = (contents: string): FileReadOutcome => ({
  _tag: "Loaded",
  result: readResult({ contents, byteLength: contents.length }),
});

const failed = (failure: "protected_file" | "binary_file" | "path_not_file"): FileReadOutcome => ({
  _tag: "Failed",
  failure,
});

const pendingRead: FileTextRead = { _tag: "Pending" };

describe("filePreviewRoute", () => {
  it("reads markdown, text, JSON and source through the file RPC", () => {
    expect({
      markdown: filePreviewRoute("NOTES.md"),
      text: filePreviewRoute("a.txt"),
      json: filePreviewRoute("data.json"),
      source: filePreviewRoute("src/sheets/FilePreviewSheet.tsx"),
    }).toEqual({
      markdown: "text",
      text: "text",
      json: "text",
      source: "text",
    });
  });

  it("loads an image from its asset URL", () => {
    expect(filePreviewRoute("shots/pic.png")).toBe("image");
  });

  it("names a kind the phone cannot show", () => {
    expect(filePreviewRoute("release-notes.pdf")).toBe("unsupported");
  });
});

describe("fileTextRead", () => {
  it("turns the read into text", () => {
    expect(fileTextRead(loaded("# Notes\nOne line."))).toEqual({
      _tag: "Loaded",
      text: "# Notes\nOne line.",
      truncated: false,
    });
  });

  it("keeps a truncated read labelled", () => {
    expect(
      fileTextRead({ _tag: "Loaded", result: readResult({ contents: "a", truncated: true }) }),
    ).toEqual({ _tag: "Loaded", text: "a", truncated: true });
  });

  it("refuses a protected file", () => {
    expect(fileTextRead(failed("protected_file"))).toEqual({ _tag: "Denied" });
  });

  it("reports an absent file", () => {
    expect(
      fileTextRead({
        _tag: "Loaded",
        result: readResult({ contents: "", byteLength: 0, exists: false }),
      }),
    ).toEqual({ _tag: "NotFound" });
  });

  it("marks binary bytes unsupported", () => {
    expect(fileTextRead(failed("binary_file"))).toEqual({ _tag: "Binary" });
  });

  it("keeps every other failure generic", () => {
    expect(fileTextRead(failed("path_not_file"))).toEqual({ _tag: "Failed" });
  });

  it("waits while the read is pending", () => {
    expect(fileTextRead({ _tag: "Pending" })).toEqual({ _tag: "Pending" });
  });
});

describe("filePreviewState", () => {
  it("asks for a folder when the chat has none", () => {
    expect(
      filePreviewState({
        folder: null,
        path: "NOTES.md",
        source: { _tag: "Text", read: pendingRead },
      }),
    ).toEqual({ _tag: "NoFolder" });
  });

  it("loads while no file is picked", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: null,
        source: { _tag: "Unsupported" },
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("loads while the file is being read", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "NOTES.md",
        source: { _tag: "Text", read: pendingRead },
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("shows the text it read", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "NOTES.md",
        source: {
          _tag: "Text",
          read: { _tag: "Loaded", text: "# Notes\nOne line.", truncated: false },
        },
      }),
    ).toEqual({ _tag: "Text", text: "# Notes\nOne line." });
  });

  it("refuses a protected text file", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: ".env",
        source: { _tag: "Text", read: { _tag: "Denied" } },
      }),
    ).toEqual({ _tag: "Denied" });
  });

  it("says a missing text file is gone", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "docs/removed.md",
        source: { _tag: "Text", read: { _tag: "NotFound" } },
      }),
    ).toEqual({ _tag: "Error", reason: "not-found" });
  });

  it("names binary content the phone cannot show", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "data.json",
        source: { _tag: "Text", read: { _tag: "Binary" } },
      }),
    ).toEqual({ _tag: "Unsupported" });
  });

  it("stops on a text read that ran out of time", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "logs/2026-11-09.log",
        source: { _tag: "Text", read: { _tag: "TimedOut" } },
      }),
    ).toEqual({ _tag: "Error", reason: "timed-out" });
  });

  it("stops on a failed text read", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "notes.md",
        source: { _tag: "Text", read: { _tag: "Failed" } },
      }),
    ).toEqual({ _tag: "Error", reason: "read-failed" });
  });

  it("loads while an image URL is being minted", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "shots/pic.png",
        source: { _tag: "Image", asset: { _tag: "Loading" } },
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("shows an image once its URL is ready", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "shots/pic.png",
        source: { _tag: "Image", asset: success("https://phone.test/api/assets/pic") },
      }),
    ).toEqual({ _tag: "Image", url: "https://phone.test/api/assets/pic" });
  });

  it("refuses a protected image", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "shots/secret.png",
        source: { _tag: "Image", asset: { _tag: "Failure", protectedFile: true } },
      }),
    ).toEqual({ _tag: "Denied" });
  });

  it("says a missing image is gone", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "shots/removed.png",
        source: { _tag: "Image", asset: { _tag: "Failure", notFound: true } },
      }),
    ).toEqual({ _tag: "Error", reason: "not-found" });
  });

  it("stops on any other image failure", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "shots/pic.png",
        source: { _tag: "Image", asset: { _tag: "Failure" } },
      }),
    ).toEqual({ _tag: "Error", reason: "open-failed" });
  });

  it("names a kind with no preview at all", () => {
    expect(
      filePreviewState({
        folder: FOLDER,
        path: "release-notes.pdf",
        source: { _tag: "Unsupported" },
      }),
    ).toEqual({ _tag: "Unsupported" });
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
