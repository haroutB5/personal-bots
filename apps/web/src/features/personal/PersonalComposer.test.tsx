import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import type { AttachmentUploadState } from "~/lib/attachmentUploadState";
import type { Thread } from "~/types";
import {
  getOutboxSnapshot,
  type OutboxStorage,
  resetOutboxForTesting,
  retryOutboxEntry,
} from "./outbox";
import { setOutboxBlobBackendForTesting } from "./outboxBlobs";
import { isSentTextEcho, PersonalComposer } from "./PersonalComposer";

vi.mock("./AttachmentPreview", () => ({
  AttachmentPreview: ({
    attachment,
    onClose,
  }: {
    attachment: { name: string };
    onClose: () => void;
  }) => (
    <div role="dialog">
      {attachment.name}
      <button onClick={onClose}>Close preview</button>
    </div>
  ),
}));

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

function memoryStorage(): OutboxStorage {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key, next) => (value = next) };
}

/** A failure the way the laptop answers a refused command. */
const refusal = (message: string) =>
  ({
    _tag: "Failure",
    cause: Cause.fail({ _tag: "OrchestrationDispatchCommandError", message }),
  }) as never;

beforeEach(async () => {
  resetOutboxForTesting(memoryStorage());
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
  resetOutboxForTesting(undefined);
  setOutboxBlobBackendForTesting();
});

describe("personal composer sends", () => {
  it("opens and closes a draft attachment without sending or removing the draft", async () => {
    await act(async () =>
      renderer.root.findByProps({ "aria-label": "Open notes.txt" }).props.onClick(),
    );
    expect(renderer.root.findByProps({ role: "dialog" }).children).toContain("notes.txt");
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Close preview"))!
        .props.onClick(),
    );
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(state.draft.prompt).toBe("Send this");
    expect(state.draft.files).toHaveLength(1);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });
  it("retains text and attachments when the server keeps rejecting a message", async () => {
    vi.useFakeTimers();
    state.start.mockResolvedValue(refusal("Thread is deleted."));
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
      await vi.runAllTimersAsync();
    });
    // A refusal is the laptop's answer: one attempt, no retries, the draft comes back.
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.draft.prompt).toBe("Send this");
    expect(state.draft.files).toHaveLength(1);
    expect(state.release).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries).toEqual([]);
    vi.useRealTimers();
  });

  it("keeps trying a send that gets no answer, then queues it instead of losing it", async () => {
    vi.useFakeTimers();
    state.draft.files = [];
    await act(async () => renderer.update(<PersonalComposer {...props} />));
    state.start.mockResolvedValue({ _tag: "Failure" });
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
      await vi.runAllTimersAsync();
    });
    // The first attempt plus the three retries, then it goes on the queue.
    expect(state.start).toHaveBeenCalledTimes(4);
    const [queued] = getOutboxSnapshot().entries;
    expect(queued?.text).toBe("Send this");
    expect(queued?.attempts).toBe(1);
    expect(state.draft.prompt).toBe("");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    // Every attempt, and the queued copy, carry the same message id and command id.
    const sent = state.start.mock.calls.map((call) => call[0].input);
    expect(new Set(sent.map((input) => input.commandId)).size).toBe(1);
    expect(new Set(sent.map((input) => input.message.messageId)).size).toBe(1);
    expect(queued?.id).toBe(sent[0].message.messageId);
    expect(queued?.commandId).toBe(sent[0].commandId);
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

  it("empties the composer the moment Send is tapped, before a slow upload or ack", async () => {
    let land!: (value: { _tag: string }) => void;
    state.start.mockReturnValue(new Promise((resolve) => (land = resolve)));
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
    });
    // Still waiting on the server: text and chips are already gone.
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.draft.prompt).toBe("");
    expect(renderer.root.findAllByProps({ "aria-label": "Open notes.txt" })).toHaveLength(0);
    await act(async () => land({ _tag: "Success" }));
    expect(state.draft.files).toEqual([]);
  });

  it("puts the text and attachments back when the send fails, keeping what was typed since", async () => {
    let land!: (value: unknown) => void;
    state.start.mockReturnValue(new Promise((resolve) => (land = resolve)));
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
      await Promise.resolve();
    });
    expect(state.draft.prompt).toBe("");
    state.draft.prompt = "and one more thing";
    await act(async () => land(refusal("Thread is deleted.")));
    expect(state.draft.prompt).toBe("Send this\nand one more thing");
    expect(renderer.root.findAllByProps({ "aria-label": "Open notes.txt" })).toHaveLength(1);
    vi.useRealTimers();
  });

  it("drops the keyboard re-applying the sent text, then takes new typing", async () => {
    let land!: (value: { _tag: string }) => void;
    state.start.mockReturnValue(new Promise((resolve) => (land = resolve)));
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
    });
    const field = () => renderer.root.findByType("textarea");
    const type = (value: string) =>
      act(async () => field().props.onChange({ target: { value, selectionStart: value.length } }));
    // iOS commits the predictive word after Send cleared the field; an event
    // reading the emptied field in between must not end the guard.
    await type("");
    await type("Send this ");
    expect(state.draft.prompt).toBe("");
    await type("Send thisss");
    expect(state.draft.prompt).toBe("");
    await type("A new message");
    expect(state.draft.prompt).toBe("A new message");
    await act(async () => land({ _tag: "Success" }));
    expect(state.draft.prompt).toBe("A new message");
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
    // Cleared on the tap, not when the upload and the server are done.
    expect(state.draft.prompt).toBe("");
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

  it("tags its Sending row with the chat it was sent from, even if the screen moves on", async () => {
    // The chat route reuses its screen across chats: a send still in flight
    // when the user lands in another bot's chat must not claim that chat.
    let land!: (value: { _tag: string }) => void;
    state.start.mockReturnValue(new Promise((resolve) => (land = resolve)));
    const rows: Array<{ readonly id: string; readonly threadId?: string }> = [];
    const onPendingChange = vi.fn((update: (pending: never[]) => typeof rows) => {
      rows.splice(0, rows.length, ...update(rows as never[]));
    });
    await act(async () =>
      renderer.update(<PersonalComposer {...props} onPendingChange={onPendingChange} />),
    );
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
    });
    await act(async () =>
      renderer.update(
        <PersonalComposer
          {...props}
          threadId={ThreadId.make("other-bot-thread")}
          onPendingChange={onPendingChange}
        />,
      ),
    );
    await act(async () => land({ _tag: "Success" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe("test-thread");
    expect(state.start.mock.calls[0]?.[0]).toMatchObject({ input: { threadId: "test-thread" } });
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
  const sendLabel = "Send, queued until the bot takes it in";

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

  it("leaves Queued to the status under the message when a bot chat asks it to", async () => {
    await act(async () => renderer.update(<PersonalComposer {...working} queuedNotice={false} />));
    await act(async () => renderer.root.findByProps({ "aria-label": sendLabel }).props.onClick());
    expect(state.start).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(0);
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

describe("personal composer replies", () => {
  const quote = { messageId: "bot-msg-1", name: "Mori", excerpt: "All green." };

  async function renderReply(overrides: Record<string, unknown> = {}) {
    state.draft.prompt = "Thanks, ship it";
    state.draft.files = [];
    await act(async () =>
      renderer.update(<PersonalComposer {...props} replyTo={quote} {...overrides} />),
    );
  }

  it("shows who and what is being replied to, with an X that drops it", async () => {
    const onClearReply = vi.fn();
    await renderReply({ onClearReply });
    const bar = renderer.root.findByProps({ "data-testid": "reply-bar" });
    const text = bar
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join("|");
    expect(text).toContain("Replying to ");
    expect(text).toContain("Mori");
    expect(text).toContain("All green.");
    await act(async () =>
      renderer.root.findByProps({ "aria-label": "Cancel reply" }).props.onClick(),
    );
    expect(onClearReply).toHaveBeenCalledOnce();
  });

  it("shows no bar without a reply", async () => {
    await renderReply({ replyTo: null });
    expect(renderer.root.findAllByProps({ "data-testid": "reply-bar" })).toHaveLength(0);
  });

  it("sends the quote with the message as a context record, then drops it", async () => {
    const onClearReply = vi.fn();
    await renderReply({ onClearReply });
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());

    expect(state.start).toHaveBeenCalledOnce();
    const message = state.start.mock.calls[0]?.[0].input.message;
    expect(message.text).toBe("Thanks, ship it");
    expect(message.context.records).toHaveLength(1);
    expect(message.context.records[0]).toMatchObject({
      kind: "personal-reply",
      payload: quote,
    });
    expect(onClearReply).toHaveBeenCalledOnce();
  });

  it("keeps the quote when the send fails, so Send can be tapped again", async () => {
    state.start.mockResolvedValue(refusal("Thread is deleted."));
    vi.useFakeTimers();
    const onClearReply = vi.fn();
    await renderReply({ onClearReply });
    await act(async () => {
      void renderer.root.findByProps({ "aria-label": "Send" }).props.onClick();
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();
    expect(onClearReply).not.toHaveBeenCalled();
  });

  it("carries the quote on the row that says Sending", async () => {
    const rows: Array<{ readonly replyTo?: unknown }> = [];
    const onPendingChange = vi.fn((update: (pending: never[]) => typeof rows) => {
      rows.splice(0, rows.length, ...update(rows as never[]));
    });
    await renderReply({ onPendingChange });
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());
    expect(rows[0]?.replyTo).toEqual(quote);
  });

  it("sends a group message with the quote too", async () => {
    await renderReply({ send: state.groupSend, mentionCandidates: [] });
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());
    expect(state.start).not.toHaveBeenCalled();
    expect(state.groupSend.mock.calls[0]?.[0]).toMatchObject({
      text: "Thanks, ship it",
      replyTo: quote,
    });
  });

  it("sends a plain message without any context when nothing is quoted", async () => {
    await renderReply({ replyTo: null });
    await act(async () => renderer.root.findByProps({ "aria-label": "Send" }).props.onClick());
    expect(state.start.mock.calls[0]?.[0].input.message).not.toHaveProperty("context");
  });
});

describe("personal composer quick send (a tapped choice)", () => {
  type QuickSend = (text: string) => Promise<boolean>;
  const quickSendRef: { current: QuickSend | null } = { current: null };

  async function renderQuick(overrides: Record<string, unknown> = {}) {
    quickSendRef.current = null;
    await act(async () =>
      renderer.update(<PersonalComposer {...props} quickSendRef={quickSendRef} {...overrides} />),
    );
  }

  it("sends the text as the owner's message and leaves the draft alone", async () => {
    await renderQuick();
    let result: boolean | undefined;
    await act(async () => {
      result = await quickSendRef.current!("Yes, ship it");
    });
    expect(result).toBe(true);
    expect(state.start).toHaveBeenCalledOnce();
    const message = state.start.mock.calls[0]?.[0].input.message;
    expect(message.text).toBe("Yes, ship it");
    expect(message.attachments).toEqual([]);
    expect(message).not.toHaveProperty("context");
    // What the owner had typed, and the file they attached, are still there.
    expect(state.draft.prompt).toBe("Send this");
    expect(state.draft.files).toHaveLength(1);
  });

  it("sends once when it is called twice in the same moment", async () => {
    await renderQuick();
    let results: boolean[] = [];
    await act(async () => {
      results = await Promise.all([
        quickSendRef.current!("Not yet"),
        quickSendRef.current!("Not yet"),
      ]);
    });
    expect(results).toEqual([true, false]);
    expect(state.start).toHaveBeenCalledOnce();
  });

  it("does not send while the chat cannot (offline), and says so", async () => {
    await renderQuick({ disabledReason: "Your laptop is offline." });
    let result: boolean | undefined;
    await act(async () => {
      result = await quickSendRef.current!("Yes");
    });
    expect(result).toBe(false);
    expect(state.start).not.toHaveBeenCalled();
  });

  it("does not send an empty line", async () => {
    await renderQuick();
    let result: boolean | undefined;
    await act(async () => {
      result = await quickSendRef.current!("   ");
    });
    expect(result).toBe(false);
    expect(state.start).not.toHaveBeenCalled();
  });

  it("reports a send that failed, so the buttons can be tried again", async () => {
    state.start.mockResolvedValue(refusal("Thread is deleted."));
    vi.useFakeTimers();
    await renderQuick();
    let result: boolean | undefined;
    await act(async () => {
      const pending = quickSendRef.current!("Yes");
      await vi.runAllTimersAsync();
      result = await pending;
    });
    vi.useRealTimers();
    expect(result).toBe(false);
  });

  it("goes through a group's own send as well", async () => {
    await renderQuick({ send: state.groupSend, mentionCandidates: [] });
    await act(async () => {
      await quickSendRef.current!("Option B");
    });
    expect(state.start).not.toHaveBeenCalled();
    expect(state.groupSend.mock.calls[0]?.[0]).toMatchObject({ text: "Option B" });
    expect(state.groupSend.mock.calls[0]?.[0]).not.toHaveProperty("replyTo");
  });
});

describe("isSentTextEcho", () => {
  it("matches the sent text, or it with the last word committed differently", () => {
    expect(isSentTextEcho("saying the issue", "saying the issue")).toBe(true);
    expect(isSentTextEcho("saying the issue ", "saying the issue")).toBe(true);
    expect(isSentTextEcho("saying the issues", "saying the issu")).toBe(true);
    expect(isSentTextEcho("saying the issue and more", "saying the issue")).toBe(false);
    expect(isSentTextEcho("something else", "saying the issue")).toBe(false);
    expect(isSentTextEcho("", "saying the issue")).toBe(false);
    expect(isSentTextEcho("Hi", "Hello")).toBe(false);
  });
});

describe("personal composer offline send queue", () => {
  const OFFLINE = "Your laptop is offline. Messages you send now are saved on this device.";

  async function renderOffline(overrides: Record<string, unknown> = {}) {
    state.draft.prompt = "Sent from the train";
    state.draft.files = [];
    await act(async () =>
      renderer.update(<PersonalComposer {...props} offlineNotice={OFFLINE} {...overrides} />),
    );
  }
  const tapSend = () =>
    act(async () =>
      renderer.root
        .findAll(
          (node) =>
            node.type === "button" &&
            typeof node.props["aria-label"] === "string" &&
            node.props["aria-label"].startsWith("Send"),
        )[0]!
        .props.onClick(),
    );

  it("keeps Send enabled while the laptop is away and says what will happen", async () => {
    await renderOffline();
    const send = renderer.root.findByProps({
      "aria-label": "Send, waits here until your laptop reconnects",
    });
    expect(send.props.disabled).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).toContain(OFFLINE);
    // Said as a status, not an alert: nothing is wrong, the message is just kept.
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("queues the message on the device instead of sending it, and empties the field", async () => {
    const onPendingChange = vi.fn();
    await renderOffline({ onPendingChange });
    await tapSend();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.draft.prompt).toBe("");
    const [queued] = getOutboxSnapshot().entries;
    expect(queued).toMatchObject({
      kind: "turn",
      environmentId: "test-env",
      threadId: "test-thread",
      text: "Sent from the train",
      sendText: "Sent from the train",
      status: "waiting",
      replyTo: null,
      attachments: [],
    });
    expect(queued?.commandId).toBe(`outbox:${queued?.id}`);
    expect(queued?.turn).toMatchObject({
      modelSelection: { instanceId: "claude", model: "test" },
      titleSeed: "Sent from the train",
    });
    // The queue draws its own "Waiting to send" row, not the optimistic "Sending" one.
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("keeps the order: a second message queues behind the first, even once the laptop is back", async () => {
    await renderOffline();
    await tapSend();
    state.draft.prompt = "Second";
    await act(async () => renderer.update(<PersonalComposer {...props} offlineNotice={null} />));
    await tapSend();
    // The laptop is connected again, but the first message has not gone out yet:
    // the second must not overtake it.
    expect(state.start).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries.map((entry) => entry.text)).toEqual([
      "Sent from the train",
      "Second",
    ]);
  });

  it("a tapped choice is queued too, without touching the draft", async () => {
    const quickSendRef: { current: ((text: string) => Promise<boolean>) | null } = {
      current: null,
    };
    await renderOffline({ quickSendRef });
    let result: boolean | undefined;
    await act(async () => {
      result = await quickSendRef.current!("Yes, ship it");
    });
    expect(result).toBe(true);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.draft.prompt).toBe("Sent from the train");
    expect(getOutboxSnapshot().entries.map((entry) => entry.text)).toEqual(["Yes, ship it"]);
  });

  it("a reply keeps its quote in the queue and drops it from the composer", async () => {
    const quote = { messageId: "bot-msg-1", name: "Mori", excerpt: "All green." };
    const onClearReply = vi.fn();
    await renderOffline({ replyTo: quote, onClearReply });
    await tapSend();
    expect(getOutboxSnapshot().entries[0]?.replyTo).toEqual(quote);
    expect(onClearReply).toHaveBeenCalledOnce();
  });

  it("a group message is queued for the group, not as a turn", async () => {
    await renderOffline({ send: state.groupSend, mentionCandidates: [], groupId: "group-1" });
    await tapSend();
    expect(state.groupSend).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries[0]).toMatchObject({
      kind: "group",
      groupId: "group-1",
      turn: null,
      threadId: "test-thread",
    });
  });

  it("queues photos and files with their bytes, and takes them out of the composer", async () => {
    const stored = new Map<string, Blob>();
    setOutboxBlobBackendForTesting({
      put: async (key, blob) => void stored.set(key, blob),
      get: async (key) => stored.get(key) ?? null,
      deletePrefix: async (prefix) => {
        for (const key of [...stored.keys()]) if (key.startsWith(prefix)) stored.delete(key);
      },
      keys: async () => [...stored.keys()],
    });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await renderOffline();
    state.draft.files = [
      { type: "file", id: "file-9", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5, file },
    ] as never;
    await act(async () => renderer.update(<PersonalComposer {...props} offlineNotice={OFFLINE} />));
    await tapSend();
    const [queued] = getOutboxSnapshot().entries;
    expect(queued?.attachments).toEqual([
      { id: "file-9", kind: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
    ]);
    expect([...stored.keys()]).toEqual([`${queued?.id}/file-9`]);
    expect(state.draft.files).toEqual([]);
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();
  });

  it("says so, and keeps the draft, when the attachments are too big to wait", async () => {
    await renderOffline();
    state.draft.files = [
      {
        type: "file",
        id: "file-big",
        name: "movie.mov",
        mimeType: "video/quicktime",
        sizeBytes: 40 * 1024 * 1024,
        file: new File(["x"], "movie.mov"),
      },
    ] as never;
    await act(async () => renderer.update(<PersonalComposer {...props} offlineNotice={OFFLINE} />));
    await tapSend();
    expect(getOutboxSnapshot().entries).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain("too big to wait for the laptop");
    expect(state.draft.prompt).toBe("Sent from the train");
    expect(state.draft.files).toHaveLength(1);
  });

  it("keeps the draft and says why when this device cannot keep the message", async () => {
    resetOutboxForTesting({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    await renderOffline();
    await tapSend();
    expect(getOutboxSnapshot().entries).toEqual([]);
    expect(state.draft.prompt).toBe("Sent from the train");
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Couldn't save that message on this device",
    );
  });

  it("Retry on a waiting message leaves it for the queue to send", async () => {
    await renderOffline();
    await tapSend();
    const id = getOutboxSnapshot().entries[0]!.id;
    retryOutboxEntry(id);
    expect(getOutboxSnapshot().entries[0]?.status).toBe("waiting");
  });
});
