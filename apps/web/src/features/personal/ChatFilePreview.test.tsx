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
}));

vi.mock("~/components/files/projectFilesQueryState", () => ({
  useProjectFileQuery: () => queryState,
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
  it("claims markdown and text chips when the chat has a workspace", () => {
    expect(shouldOpenChatFilePreview("C:/workspace", "C:/reports/REPORT.md")).toBe(true);
    expect(shouldOpenChatFilePreview("C:/workspace", "logs/server.log")).toBe(true);
    expect(shouldOpenChatFilePreview("C:/workspace", "src/app.ts")).toBe(true);
  });

  it("leaves media, binaries and a chat without a workspace to the existing action", () => {
    expect(shouldOpenChatFilePreview("C:/workspace", "shots/screen.png")).toBe(false);
    expect(shouldOpenChatFilePreview("C:/workspace", "docs/spec.pdf")).toBe(false);
    expect(shouldOpenChatFilePreview("C:/workspace", "bin/app.exe")).toBe(false);
    expect(shouldOpenChatFilePreview(undefined, "C:/reports/REPORT.md")).toBe(false);
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
});
