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
  groupSend: vi.fn(),
  metadata: vi.fn(),
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
  useAtomCommand: (command: string) =>
    command === "start" ? state.start : command === "metadata" ? state.metadata : vi.fn(),
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
  botLastSpokeAtMs: null,
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
  state.groupSend.mockReset().mockResolvedValue({ _tag: "Success" });
  state.metadata.mockReset().mockResolvedValue({ _tag: "Success" });
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
  it("retains text and attachments when the server keeps rejecting a message", async () => {
    vi.useFakeTimers();
    state.start.mockResolvedValue({ _tag: "Failure" });
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
      await vi.runAllTimersAsync();
    });
    // The first attempt plus the three retries, then it gives up.
    expect(state.start).toHaveBeenCalledTimes(4);
    expect(state.draft.prompt).toBe("Send this");
    expect(state.draft.files).toHaveLength(1);
    expect(state.release).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("sends again on its own after a failure, without a second tap", async () => {
    vi.useFakeTimers();
    state.start
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValue({ _tag: "Success" } as never);
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
      await vi.runAllTimersAsync();
    });
    expect(state.start).toHaveBeenCalledTimes(2);
    // Accepted on the retry: the draft is consumed and no error is shown.
    expect(state.draft.prompt).toBe("");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    vi.useRealTimers();
  });

  it("counts a duplicate-id refusal as delivered rather than posting twice", async () => {
    // The retry reuses the message id, so this is what a lost reply looks like
    // on the way back: the first attempt did land.
    vi.useFakeTimers();
    state.start.mockReset();
    state.start.mockRejectedValueOnce(new Error("network down")).mockResolvedValue({
      _tag: "Failure",
      cause: { detail: "Message 'm-1' already exists on thread 't-1'." },
    } as never);
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
      await vi.runAllTimersAsync();
    });
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(state.draft.prompt).toBe("");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    vi.useRealTimers();
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

  it("names a new chat only through the turn's title seed", async () => {
    // A metadata rename would be a manual title and block the server's AI title.
    const newChat = { ...props.thread, messages: [] } as unknown as Thread;
    await act(async () => renderer.update(<PersonalComposer {...props} thread={newChat} />));
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.start.mock.calls[0]?.[0]).toMatchObject({ input: { titleSeed: "Send this" } });
    expect(state.metadata).not.toHaveBeenCalled();
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

/**
 * A group composer is the same composer: the draft store, the retry loop, the
 * pending row and Stop are all shared. Only where a message goes changes, and
 * what `@` offers.
 */
describe("personal composer in a group", () => {
  const members = [
    { botId: "bot-ada", name: "Ada" },
    { botId: "bot-grace", name: "Grace" },
  ];

  async function renderGroup(overrides: Record<string, unknown> = {}) {
    await act(async () =>
      renderer.update(
        <PersonalComposer
          {...props}
          send={state.groupSend}
          mentionCandidates={members}
          {...overrides}
        />,
      ),
    );
  }

  it("sends through the group RPC instead of starting a turn on the group thread", async () => {
    state.draft.prompt = "@Ada what do you think?";
    await renderGroup();
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());

    expect(state.start).not.toHaveBeenCalled();
    expect(state.groupSend).toHaveBeenCalledOnce();
    expect(state.groupSend.mock.calls[0]?.[0]).toMatchObject({
      text: "@Ada what do you think?",
    });
    expect(state.draft.prompt).toBe("");
  });

  it("takes no attachments: a group would pay for one image once per member", async () => {
    await renderGroup();
    expect(renderer.root.findAllByProps({ "aria-label": "Add photos or files" })).toHaveLength(0);
  });

  it("offers the members when an @ is typed, and inserts the one that is picked", async () => {
    state.draft.prompt = "";
    await renderGroup();
    const textarea = renderer.root.findByType("textarea");
    await act(async () =>
      textarea.props.onChange({ target: { value: "ask @gr", selectionStart: 7 } }),
    );

    const popover = renderer.root.findByProps({ "aria-label": "Mention a bot" });
    const rows = popover.findAllByType("button");
    // Only Grace matches "gr": the list narrows as the name is typed.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.props["aria-current"]).toBe("true");
    await act(async () => rows[0]!.props.onClick());
    // "@Grace " — the trailing space closes the token and is what would be
    // typed next anyway.
    expect(state.draft.prompt).toBe("ask @Grace ");
    expect(renderer.root.findAllByProps({ "aria-label": "Mention a bot" })).toHaveLength(0);
  });

  it("stays shut for an @ that is not opening a name", async () => {
    state.draft.prompt = "";
    await renderGroup();
    const textarea = renderer.root.findByType("textarea");
    await act(async () =>
      textarea.props.onChange({ target: { value: "mail ada@example.com", selectionStart: 20 } }),
    );
    expect(renderer.root.findAllByProps({ "aria-label": "Mention a bot" })).toHaveLength(0);
  });

  it("never offers mentions in an ordinary bot chat", async () => {
    state.draft.prompt = "";
    await act(async () => renderer.update(<PersonalComposer {...props} />));
    const textarea = renderer.root.findByType("textarea");
    await act(async () => textarea.props.onChange({ target: { value: "@", selectionStart: 1 } }));
    expect(renderer.root.findAllByProps({ "aria-label": "Mention a bot" })).toHaveLength(0);
  });
});

/**
 * The server takes a mid-turn start unconditionally and every adapter folds it
 * into the running turn, so the phone no longer has to hold the message until
 * the bot is idle. Sending it is also what makes it survive closing the PWA:
 * the draft store is this device's, the sent message is on the laptop.
 */
describe("personal composer queues while the bot works", () => {
  const working = { ...props, working: true, canInterrupt: true };
  const sendLabel = "Send, queued until this turn finishes";

  it("sends mid-turn and says the message is waiting its turn", async () => {
    await act(async () => renderer.update(<PersonalComposer {...working} />));

    const send = renderer.root.findByProps({ "aria-label": sendLabel });
    expect(send.props.disabled).toBe(false);
    await act(async () => send.props.onClick());

    expect(state.start).toHaveBeenCalledOnce();
    expect(state.draft.prompt).toBe("");
    const status = renderer.root.findAllByProps({ role: "status" });
    expect(status.some((node) => node.children.join("").includes("Queued"))).toBe(true);
  });

  it("says nothing about queueing for a message sent to an idle bot", async () => {
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(0);
  });

  it("stops offering Stop in the composer once there is something to send", async () => {
    await act(async () => renderer.update(<PersonalComposer {...working} />));
    expect(renderer.root.findAllByProps({ "aria-label": "Stop" })).toHaveLength(0);

    // Stop comes back on an empty draft; the chat menu offers it either way.
    state.draft.prompt = "";
    state.draft.files = [];
    await act(async () => renderer.update(<PersonalComposer {...working} />));
    expect(renderer.root.findByProps({ "aria-label": "Stop" })).toBeDefined();
  });

  it("drops the queued notice once the bot answers, without waiting for the turn", async () => {
    // The reported bug: a steered message is usually answered long before the
    // turn ends, and "Queued. The bot gets it as soon as this turn finishes."
    // stayed on screen underneath the reply it had already produced.
    await act(async () => renderer.update(<PersonalComposer {...working} />));
    await act(async () => renderer.root.findByProps({ "aria-label": sendLabel }).props.onClick());
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(1);

    await act(async () =>
      renderer.update(<PersonalComposer {...working} botLastSpokeAtMs={Date.now() + 1} />),
    );
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(0);
  });

  it("keeps the queued notice while the only bot output predates the message", async () => {
    const spokeBefore = Date.now() - 10_000;
    await act(async () =>
      renderer.update(<PersonalComposer {...working} botLastSpokeAtMs={spokeBefore} />),
    );
    await act(async () => renderer.root.findByProps({ "aria-label": sendLabel }).props.onClick());

    await act(async () =>
      renderer.update(<PersonalComposer {...working} botLastSpokeAtMs={spokeBefore} />),
    );
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(1);
  });

  it("drops the queued notice when the turn ends", async () => {
    await act(async () => renderer.update(<PersonalComposer {...working} />));
    await act(async () => renderer.root.findByProps({ "aria-label": sendLabel }).props.onClick());
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(1);

    await act(async () =>
      renderer.update(<PersonalComposer {...working} working={false} canInterrupt={false} />),
    );
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(0);
  });
});
