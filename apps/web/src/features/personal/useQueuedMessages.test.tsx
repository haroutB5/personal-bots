import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  enqueueOutboxEntry,
  getOutboxSnapshot,
  type NewOutboxEntry,
  type OutboxStorage,
  resetOutboxForTesting,
  setOutboxSending,
} from "./outbox";
import { setOutboxBlobBackendForTesting } from "./outboxBlobs";
import { useQueuedMessages } from "./useQueuedMessages";

const draft = vi.hoisted(() => ({ prompt: "" }));
vi.mock("~/composerDraftStore", () => {
  const store = {
    getComposerDraft: () => ({ prompt: draft.prompt }),
    setPrompt: (_ref: unknown, prompt: string) => {
      draft.prompt = prompt;
    },
  };
  return { useComposerDraftStore: Object.assign(() => store, { getState: () => store }) };
});

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("t1");

function memoryStorage(): OutboxStorage {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key, next) => (value = next) };
}

function entry(id: string, extra: Partial<NewOutboxEntry> = {}): NewOutboxEntry {
  return {
    id,
    kind: "turn",
    environmentId: "env",
    threadId: "t1",
    groupId: null,
    text: `text ${id}`,
    sendText: `text ${id}`,
    createdAt: "2026-10-08T12:00:00.000Z",
    replyTo: null,
    turn: null,
    attachments: [],
    ...extra,
  };
}

type Api = ReturnType<typeof useQueuedMessages>;
let api: Api;
let renderer: ReactTestRenderer;

function Probe(props: {
  messages: ReadonlyArray<{ id: string }>;
  onRestoreReply?: (quote: { messageId: string; name: string; excerpt: string }) => void;
}) {
  api = useQueuedMessages({ environmentId, threadId, ...props });
  return null;
}

const mount = async (props: Parameters<typeof Probe>[0]) => {
  await act(async () => {
    renderer = create(<Probe {...props} />);
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetOutboxForTesting(memoryStorage());
  draft.prompt = "";
  setOutboxBlobBackendForTesting({
    put: async () => {},
    get: async () => null,
    deletePrefix: async () => {},
    keys: async () => [],
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
  resetOutboxForTesting(undefined);
  setOutboxBlobBackendForTesting();
});

describe("a chat's queued messages", () => {
  it("lists this chat's waiting messages in order, and only this chat's", async () => {
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("elsewhere", { threadId: "t2" }));
    enqueueOutboxEntry(entry("b"));
    await mount({ messages: [] });
    expect(api.rows.map((row) => [row.entry.id, row.state])).toEqual([
      ["a", "waiting"],
      ["b", "waiting"],
    ]);
  });

  it("Cancel removes the message from the queue", async () => {
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("b"));
    await mount({ messages: [] });
    await act(async () => api.onCancel("a"));
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["b"]);
    expect(api.rows.map((row) => row.entry.id)).toEqual(["b"]);
  });

  it("Edit takes the message out of the queue and puts its text back in the composer, ahead of what was typed since", async () => {
    const quote = { messageId: "bot-1", name: "Mori", excerpt: "All green." };
    enqueueOutboxEntry(entry("a", { text: "typed offline", replyTo: quote as never }));
    draft.prompt = "and now this";
    const onRestoreReply = vi.fn();
    await mount({ messages: [], onRestoreReply });
    const waiting = api.rows[0]!.entry;
    await act(async () => api.onEdit(waiting));
    expect(getOutboxSnapshot().entries).toEqual([]);
    expect(draft.prompt).toBe("typed offline\nand now this");
    // The quote it replied to comes back with it.
    expect(onRestoreReply).toHaveBeenCalledWith(quote);
  });

  it("Edit into an empty composer is just the text", async () => {
    enqueueOutboxEntry(entry("a", { text: "typed offline" }));
    await mount({ messages: [] });
    await act(async () => api.onEdit(api.rows[0]!.entry));
    expect(draft.prompt).toBe("typed offline");
  });

  it("a message that already shows in the transcript did land: it is dropped, not drawn twice or sent again", async () => {
    enqueueOutboxEntry(entry("landed"));
    enqueueOutboxEntry(entry("still-waiting"));
    await mount({ messages: [{ id: "landed" }] });
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["still-waiting"]);
    expect(api.rows.map((row) => row.entry.id)).toEqual(["still-waiting"]);
  });

  it("but not while its own send is in flight: the flusher settles that one", async () => {
    enqueueOutboxEntry(entry("landed"));
    setOutboxSending("landed", true);
    await mount({ messages: [{ id: "landed" }] });
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["landed"]);
    // ...yet it is not drawn a second time while the transcript already has it.
    expect(api.rows).toEqual([]);
  });

  it("Retry puts a failed message back in the queue", async () => {
    enqueueOutboxEntry(entry("a"));
    const { markOutboxFailed } = await import("./outbox");
    markOutboxFailed("a", "Couldn't send: nope.", true);
    await mount({ messages: [] });
    expect(api.rows[0]?.state).toBe("failed");
    await act(async () => api.onRetry("a"));
    expect(api.rows[0]?.state).toBe("waiting");
    expect(api.rows[0]?.entry.commandId).toBe("outbox:a:2");
  });
});
