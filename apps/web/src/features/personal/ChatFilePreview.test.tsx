import type { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const queryState = vi.hoisted(() => ({
  data: null as {
    readonly relativePath: string;
    readonly contents: string;
    readonly byteLength: number;
    readonly truncated: boolean;
  } | null,
  error: null as string | null,
  isPending: true,
  isNotFile: false,
  isBinary: false,
  isProtected: false,
}));

type MockAssetState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure"; readonly protectedFile?: true }
  | { readonly _tag: "Success"; readonly url: string; readonly sourcePath?: string };

const assetState = vi.hoisted(() => ({
  inline: { _tag: "Loading" } as MockAssetState,
  download: { _tag: "Loading" } as MockAssetState,
  requests: [] as Array<{ readonly _tag: string; readonly disposition?: string }>,
}));

vi.mock("~/components/files/projectFilesQueryState", () => ({
  useProjectFileQuery: () => queryState,
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: (
    _environmentId: unknown,
    resource: { readonly _tag: string; readonly disposition?: string } | null,
  ) => {
    if (resource === null) return { _tag: "Loading" };
    assetState.requests.push(resource);
    return resource.disposition === "download" ? assetState.download : assetState.inline;
  },
}));

import {
  ChatFilePreviewBody,
  type ChatFileOpenRequest,
  shouldOpenChatFilePreview,
} from "./ChatFilePreview";

let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  Object.assign(queryState, {
    data: null,
    error: null,
    isPending: true,
    isNotFile: false,
    isBinary: false,
    isProtected: false,
  });
  assetState.inline = { _tag: "Loading" };
  assetState.download = { _tag: "Loading" };
  assetState.requests = [];
});

const request: ChatFileOpenRequest = {
  path: "C:/Claude/AI/reports/REPORT.md",
  line: undefined,
  label: "REPORT.md",
};

const environmentId = "env-1" as EnvironmentId;

function renderBody(next: ChatFileOpenRequest): string {
  act(() => {
    renderer = create(
      <ChatFilePreviewBody request={next} environmentId={environmentId} cwd="C:/workspace" />,
    );
  });
  return JSON.stringify(renderer!.toJSON());
}

describe("shouldOpenChatFilePreview", () => {
  it("claims every file chip when the chat has a workspace", () => {
    expect(shouldOpenChatFilePreview("C:/workspace", "C:/reports/REPORT.md")).toBe(true);
    expect(shouldOpenChatFilePreview("/home/h/work", ".personal-bots/qa/x/RESULT.md")).toBe(true);
    expect(shouldOpenChatFilePreview("/home/h/work", "~/notes/a.md")).toBe(true);
    expect(shouldOpenChatFilePreview("/home/h/work", "shots/screen.png")).toBe(true);
    expect(shouldOpenChatFilePreview("/home/h/work", "docs/spec.pdf")).toBe(true);
    expect(shouldOpenChatFilePreview("/home/h/work", "bin/app.exe")).toBe(true);
  });

  it("leaves a chat without a workspace and an empty path to the existing action", () => {
    expect(shouldOpenChatFilePreview(undefined, "C:/reports/REPORT.md")).toBe(false);
    expect(shouldOpenChatFilePreview("/home/h/work", "  ")).toBe(false);
  });
});

describe("ChatFilePreviewBody", () => {
  it("renders a markdown file through the sanitised preview", () => {
    queryState.data = {
      relativePath: request.path,
      contents: "# Report\n\n<script>alert(1)</script>\n\nAll tests pass.",
      byteLength: 60,
      truncated: false,
    };
    queryState.error = null;
    queryState.isPending = false;

    const markup = renderBody(request);
    expect(markup).toContain("Report");
    expect(markup).toContain("All tests pass.");
    expect(markup).not.toContain("alert(1)");
    expect(markup).not.toContain("Showing the first 1 MB");
  });

  it("shows a source file as preformatted text", () => {
    queryState.data = {
      relativePath: "src/app.ts",
      contents: "export const answer = 42;",
      byteLength: 25,
      truncated: false,
    };
    queryState.error = null;
    queryState.isPending = false;

    const markup = renderBody({ ...request, path: "src/app.ts", label: "app.ts" });
    expect(markup).toContain("pre");
    expect(markup).toContain("export const answer = 42;");
    expect(markup).not.toContain("h1");
  });

  it("says a large file is truncated", () => {
    queryState.data = {
      relativePath: request.path,
      contents: "# Report",
      byteLength: 1024 * 1024 + 1,
      truncated: true,
    };
    queryState.error = null;
    queryState.isPending = false;

    expect(renderBody(request)).toContain("Showing the first 1 MB of this file.");
  });

  it("shows loading while the read is pending", () => {
    queryState.data = null;
    queryState.error = null;
    queryState.isPending = true;

    expect(renderBody(request)).toContain("Loading file");
  });

  it("shows a read failure instead of an empty sheet", () => {
    queryState.data = null;
    queryState.error = "path_not_file";

    const markup = renderBody(request);
    expect(markup).toContain("Couldn't open this file");
    expect(markup).toContain("moved or been deleted");
  });

  it("shows a PDF as an Open PDF link to the signed URL, not an inline frame", () => {
    assetState.inline = { _tag: "Success", url: "https://h/api/assets/t/spec.pdf" };
    assetState.download = { _tag: "Success", url: "https://h/api/assets/d/spec.pdf" };

    const markup = renderBody({ ...request, path: "docs/spec.pdf", label: "spec.pdf" });
    expect(markup).toContain("Open PDF");
    expect(markup).toContain("https://h/api/assets/t/spec.pdf");
    expect(markup).toContain("Download");
    expect(markup).not.toContain("iframe");
    expect(markup).not.toContain("embed");
  });

  it("shows an image as an image", () => {
    assetState.inline = { _tag: "Success", url: "https://h/api/assets/t/screen.png" };
    assetState.download = { _tag: "Success", url: "https://h/api/assets/d/screen.png" };

    const markup = renderBody({ ...request, path: "shots/screen.png", label: "screen.png" });
    expect(markup).toContain('"type":"img"');
    expect(markup).toContain("https://h/api/assets/t/screen.png");
  });

  it("offers Download, not an error, for a type with no preview", () => {
    assetState.download = { _tag: "Success", url: "https://h/api/assets/d/app.exe" };

    const markup = renderBody({ ...request, path: "bin/app.exe", label: "app.exe" });
    expect(markup).toContain("No preview for this type of file.");
    expect(markup).toContain("Download");
    expect(markup).toContain("https://h/api/assets/d/app.exe");
    expect(markup).not.toContain("Couldn't open");
  });

  it("falls back to Download when an unknown type turns out to be binary", () => {
    queryState.error = "binary_file";
    queryState.isPending = false;
    queryState.isBinary = true;
    assetState.download = { _tag: "Success", url: "https://h/api/assets/d/data.bin" };

    const markup = renderBody({ ...request, path: "data.bin", label: "data.bin" });
    expect(markup).toContain("No preview for this type of file.");
    expect(markup).toContain("https://h/api/assets/d/data.bin");
  });

  it("says a protected file is never shown, for text and for media", () => {
    queryState.error = "protected_file";
    queryState.isPending = false;
    queryState.isProtected = true;
    expect(renderBody({ ...request, path: "work/.env", label: ".env" })).toContain(
      "never shown or downloaded",
    );

    assetState.inline = { _tag: "Failure", protectedFile: true };
    expect(renderBody({ ...request, path: "keys/token.png", label: "token.png" })).toContain(
      "never shown or downloaded",
    );
  });

  it("says a folder is a folder", () => {
    queryState.error = "path_not_file";
    queryState.isPending = false;
    queryState.isNotFile = true;

    expect(renderBody({ ...request, path: "docs/notes", label: "notes" })).toContain(
      "This is a folder, not a file.",
    );
  });

  it("reports the path the server opened", () => {
    queryState.data = {
      relativePath: "/home/harout/.personal-bots/qa/x/RESULT.md",
      contents: "# Result",
      byteLength: 8,
      truncated: false,
    };
    queryState.error = null;
    queryState.isPending = false;
    const resolved: string[] = [];

    act(() => {
      renderer = create(
        <ChatFilePreviewBody
          request={{ ...request, path: ".personal-bots/qa/x/RESULT.md" }}
          environmentId={environmentId}
          cwd="/home/harout/work"
          onResolvedPath={(path) => resolved.push(path)}
        />,
      );
    });
    expect(resolved).toEqual(["/home/harout/.personal-bots/qa/x/RESULT.md"]);
  });
});
