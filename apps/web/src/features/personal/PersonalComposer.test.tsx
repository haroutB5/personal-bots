import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { AttachmentUploadState } from "~/lib/attachmentUploadState";
import type { Thread } from "~/types";
import { PersonalComposer } from "./PersonalComposer";

const state = vi.hoisted(() => ({
  draft: {
    prompt: "Send this",
    images: [],
    files: [{ type: "file", id: "file-1", name: "notes.txt" }],
  },
  start: vi.fn(),
  waitUploads: vi.fn(),
  release: vi.fn(),
  retry: vi.fn(),
  uploads: {} as Record<string, AttachmentUploadState>,
}));

vi.mock("~/composerDraftStore", () => {
  const store = {
    getComposerDraft: () => state.draft,
    setPrompt: (_ref: unknown, prompt: string) => {
      state.draft.prompt = prompt;
    },
    removeImage: vi.fn(),
    removeFile: (_ref: unknown, id: string) => {
      state.draft.files = state.draft.files.filter((file) => file.id !== id);
    },
  };
  return {
    useComposerThreadDraft: () => state.draft,
    useComposerDraftStore: Object.assign(
      (select: (value: typeof store) => unknown) => select(store),
      {
        getState: () => store,
      },
    ),
  };
});
vi.mock("~/state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { startTurn: "start", updateMetadata: "metadata" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "start" ? state.start : vi.fn()),
}));
vi.mock("~/lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: () => state.waitUploads(),
  getUploadedAttachments: () => [{ type: "file", id: "uploaded-file" }],
  releaseDraftAttachment: (value: unknown) => state.release(value),
  retryAttachmentUpload: (value: unknown) => state.retry(value),
  useAttachmentUploadStore: (
    select: (store: { uploadsByImageId: Record<string, AttachmentUploadState> }) => unknown,
  ) => select({ uploadsByImageId: state.uploads }),
}));
vi.mock("~/lib/imageCompression", () => ({ prepareImageForAttachment: vi.fn() }));

let renderer: ReactTestRenderer;
const props = {
  environmentId: EnvironmentId.make("test-env"),
  threadId: ThreadId.make("test-thread"),
  thread: {
    messages: [{ role: "assistant" }],
    modelSelection: { instanceId: "claude", model: "test" },
  } as unknown as Thread,
  botName: "Assistant",
  disabledReason: null,
  working: false,
  canInterrupt: false,
  onInterrupt: async () => null,
  onPendingChange: vi.fn(),
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  state.draft = {
    prompt: "Send this",
    images: [],
    files: [{ type: "file", id: "file-1", name: "notes.txt" }],
  };
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  state.waitUploads.mockReset().mockResolvedValue(undefined);
  state.release.mockClear();
  state.retry.mockClear();
  state.uploads = {};
  await act(async () => {
    renderer = create(<PersonalComposer {...props} />);
  });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("personal composer sends", () => {
  it("retains text and attachments when the server rejects a message", async () => {
    state.start.mockResolvedValue({ _tag: "Failure" });
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.draft.prompt).toBe("Send this");
    expect(state.draft.files).toHaveLength(1);
    expect(state.release).not.toHaveBeenCalled();
  });

  it("preserves edits made during upload and releases accepted attachments", async () => {
    let resolveUpload!: () => void;
    const upload = {
      promise: new Promise<void>((resolve) => {
        resolveUpload = resolve;
      }),
      resolve: () => resolveUpload(),
    };
    state.waitUploads.mockReturnValue(upload.promise);
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());
    expect(state.draft.prompt).toBe("Send this");
    state.draft.prompt = "My next message";
    await act(async () => {
      upload.resolve();
      await upload.promise;
    });
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.draft.prompt).toBe("My next message");
    expect(state.draft.files).toEqual([]);
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("clears an accepted draft and prevents two sends in the same render", async () => {
    await act(async () => {
      const click = renderer.root.findByProps({ "aria-label": "Send" }).props.onClick;
      click();
      click();
    });
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.draft.prompt).toBe("");
    expect(state.draft.files).toEqual([]);
  });

  it("shows upload progress and exposes a failed attachment retry", async () => {
    state.uploads = {
      "file-1": {
        status: "uploading",
        environmentId: props.environmentId,
        progress: 0.42,
      },
    };
    await act(async () => renderer.update(<PersonalComposer {...props} />));
    expect(renderer.root.findByProps({ "aria-label": "Uploading notes.txt: 42%" })).toBeDefined();

    state.uploads = {
      "file-1": {
        status: "failed",
        environmentId: props.environmentId,
        reason: "Connection interrupted",
      },
    };
    await act(async () => renderer.update(<PersonalComposer {...props} />));

    const alert = renderer.root.findAllByProps({ role: "alert" });
    expect(
      alert.some((node) => node.children.join("").includes("Upload failed for notes.txt")),
    ).toBe(true);
    const retry = renderer.root.findByProps({
      "aria-label": "Upload failed for notes.txt: Connection interrupted. Retry upload",
    });
    await act(async () => retry.props.onClick());
    expect(state.retry).toHaveBeenCalledWith({
      environmentId: props.environmentId,
      image: state.draft.files[0],
      draftTarget: {
        environmentId: props.environmentId,
        threadId: props.threadId,
      },
    });
  });
});
