import type { DesktopPreviewRecordingArtifact } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  awaitPreparedConnection: vi.fn<() => Promise<{ readonly httpBaseUrl: string } | null>>(),
  deletePendingAttachmentUpload: vi.fn(),
  runAttachmentUploadCycle: vi.fn(),
}));

vi.mock("~/state/session", () => ({
  awaitPreparedConnection: mocks.awaitPreparedConnection,
}));

vi.mock("@t3tools/client-runtime/state/attachments", () => ({
  deletePendingAttachmentUpload: mocks.deletePendingAttachmentUpload,
  runAttachmentUploadCycle: mocks.runAttachmentUploadCycle,
}));

vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: {}, remove: {} },
}));

import { uploadBrowserRecording } from "./browserRecordingUpload";

const artifact: DesktopPreviewRecordingArtifact = {
  id: "recording-1",
  tabId: "tab-1",
  path: "/tmp/recording.webm",
  mimeType: "video/webm",
  sizeBytes: 4,
  createdAt: "2026-09-14T12:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runAttachmentUploadCycle.mockResolvedValue({
    status: "uploaded",
    attachmentId: "attachment-1",
  });
});

describe("browser recording upload", () => {
  it("waits for an unmounted prepared connection before resolving the upload URL", async () => {
    let provideConnection!: (connection: { readonly httpBaseUrl: string }) => void;
    mocks.awaitPreparedConnection.mockReturnValue(
      new Promise((resolve) => {
        provideConnection = resolve;
      }),
    );

    await expect(
      uploadBrowserRecording(
        {
          environmentId: EnvironmentId.make("environment-recording"),
          threadId: ThreadId.make("thread-recording"),
        },
        artifact,
        new Blob(["test"], { type: artifact.mimeType }),
        Date.now() + 30_000,
      ),
    ).resolves.toBe("attachment-1");

    const cycle = mocks.runAttachmentUploadCycle.mock.calls[0]?.[0] as {
      readonly resolveUploadUrl: (relativeUrl: string) => Promise<string | null>;
    };
    let settled = false;
    const resolvedUrl = cycle.resolveUploadUrl("/api/attachments/upload/token").then((url) => {
      settled = true;
      return url;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    provideConnection({ httpBaseUrl: "https://environment.test/base/" });
    await expect(resolvedUrl).resolves.toBe(
      "https://environment.test/api/attachments/upload/token",
    );
    expect(mocks.awaitPreparedConnection).toHaveBeenCalledWith(
      EnvironmentId.make("environment-recording"),
    );
  });
});
