import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import { MessageList } from "./MessageList";
import type { OutboxEntry, OutboxRow } from "./outbox";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrls: () => [] }));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  shouldPreserveAssistantLineBreaks: () => false,
}));
vi.mock("~/session-logic", () => ({ selectMessageImageResources: () => [] }));
vi.mock("./ToolDetails", () => ({ ToolDetails: () => null }));
vi.mock("./AttachmentPreview", () => ({ AttachmentPreview: () => null }));

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("document", {});
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const BASE_PROPS = {
  environmentId: "env-1" as EnvironmentId,
  threadRef: { threadId: "thread-1" } as ScopedThreadRef,
  items: [] as ConversationItem[],
  pending: [],
  working: false,
  botName: "Mori",
  workspaceRoot: undefined,
  approvals: [],
  respondingIds: new Set<string>(),
  onRespondToApproval: () => {},
  onAnswerQuestion: () => {},
  onDismissQuestion: () => {},
  onProvideSecret: () => {},
  onDeclineSecret: () => {},
  onDecideConnectionApproval: () => {},
  approvalRespondingIds: new Set<string>(),
  approvalsNowMs: Date.parse("2026-10-06T10:00:00.000Z"),
  errorText: null,
  loadEarlier: null,
  now: new Date("2026-10-06T10:01:00.000Z"),
  describeTurn: () => "",
  renderDelegation: () => null,
} as const;

function entry(id: string, extra: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id,
    commandId: `outbox:${id}`,
    commandAttempt: 1,
    kind: "turn",
    environmentId: "env-1",
    threadId: "thread-1",
    groupId: null,
    text: `message ${id}`,
    sendText: `message ${id}`,
    createdAt: "2026-10-08T12:00:00.000Z",
    replyTo: null,
    turn: null,
    attachments: [],
    seq: 1,
    queuedAt: 1,
    status: "waiting",
    error: null,
    rejected: false,
    attempts: 0,
    ...extra,
  };
}

const row = (item: OutboxEntry, state: OutboxRow["state"] = "waiting"): OutboxRow => ({
  entry: item,
  state,
});

const render = async (props: Partial<Parameters<typeof MessageList>[0]> = {}) => {
  await act(async () => {
    renderer = create(<MessageList {...BASE_PROPS} {...props} />);
  });
  return renderer!.root;
};

const text = () => JSON.stringify(renderer!.toJSON());
/** The words inside one rendered element. */
const wordsIn = (node: { children: ReadonlyArray<unknown> }): string =>
  node.children
    .map((child) =>
      typeof child === "string" ? child : wordsIn(child as { children: ReadonlyArray<unknown> }),
    )
    .join("");
const buttons = (root: ReturnType<typeof create>["root"], label: string) =>
  root.findAllByType("button").filter((button) => button.children.includes(label));

describe("a message waiting for the laptop", () => {
  it("is drawn like a sent one, with its state in the status line and Edit and Cancel", async () => {
    const onCancel = vi.fn();
    const onEdit = vi.fn();
    const waiting = entry("m1");
    const root = await render({
      queued: [row(waiting)],
      onCancelQueued: onCancel,
      onEditQueued: onEdit,
    });
    expect(text()).toContain("message m1");
    expect(text()).toContain("Waiting to send");
    const status = root
      .findAllByProps({ role: "status" })
      .find((node) => wordsIn(node).includes("Waiting to send"));
    expect(status).toBeDefined();
    await act(async () => buttons(root, "Cancel")[0]!.props.onClick());
    expect(onCancel).toHaveBeenCalledWith("m1");
    await act(async () => buttons(root, "Edit")[0]!.props.onClick());
    expect(onEdit).toHaveBeenCalledWith(waiting);
  });

  it("shows the order it was typed in", async () => {
    await render({
      queued: [row(entry("a", { text: "first" })), row(entry("b", { text: "second" }))],
      onCancelQueued: () => {},
    });
    expect(text().indexOf("first")).toBeGreaterThan(-1);
    expect(text().indexOf("first")).toBeLessThan(text().indexOf("second"));
  });

  it("while it is being sent says Sending and can no longer be cancelled", async () => {
    const root = await render({
      queued: [row(entry("m1"), "sending")],
      onCancelQueued: () => {},
      onEditQueued: () => {},
    });
    expect(text()).toContain("Sending");
    expect(text()).not.toContain("Waiting to send");
    expect(buttons(root, "Cancel")).toHaveLength(0);
    expect(buttons(root, "Edit")).toHaveLength(0);
  });

  it("with a photo or file can be cancelled but not edited", async () => {
    const root = await render({
      queued: [
        row(
          entry("m1", {
            text: "",
            attachments: [
              { id: "a1", kind: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
            ],
          }),
        ),
      ],
      onCancelQueued: () => {},
      onEditQueued: () => {},
    });
    expect(text()).toContain("notes.txt");
    expect(buttons(root, "Cancel")).toHaveLength(1);
    expect(buttons(root, "Edit")).toHaveLength(0);
  });

  it("shows the quote of the message it replies to", async () => {
    const root = await render({
      queued: [
        row(entry("m1", { replyTo: { messageId: "bot-1", name: "Mori", excerpt: "All green." } })),
      ],
    });
    expect(root.findByProps({ "data-testid": "reply-quote" }).props["aria-label"]).toContain(
      "Mori",
    );
  });

  it("keeps the chat from reading as empty", async () => {
    await render({ queued: [row(entry("m1"))] });
    expect(text()).toContain("message m1");
  });

  it("is not drawn by a screen that has no queue", async () => {
    await render({});
    expect(text()).not.toContain("Waiting to send");
  });
});

describe("a queued message the laptop refused", () => {
  it('reads "Couldn\'t send: ..." in the failed-turn card, with Retry and Cancel', async () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const root = await render({
      queued: [
        row(
          entry("m1", {
            status: "failed",
            error: "Couldn't send: that chat is gone.",
            rejected: true,
          }),
          "failed",
        ),
      ],
      onRetryQueued: onRetry,
      onCancelQueued: onCancel,
    });
    const alert = root.findByProps({ role: "alert" });
    expect(wordsIn(alert)).toContain("Couldn't send: that chat is gone.");
    expect(text()).not.toContain("Waiting to send");
    await act(async () => buttons(root, "Retry")[0]!.props.onClick());
    expect(onRetry).toHaveBeenCalledWith("m1");
    await act(async () => buttons(root, "Cancel")[0]!.props.onClick());
    expect(onCancel).toHaveBeenCalledWith("m1");
  });
});

describe("the turn failure card, now shared with queued messages", () => {
  it("still shows the reason, Details and Retry for a failed turn", async () => {
    const onRetry = vi.fn();
    const root = await render({
      errorText: "Couldn't send: the bot couldn't start a reply.",
      errorDetail: "provider said no",
      errorTone: "danger",
      errorRetry: { onRetry, busy: false },
    });
    expect(text()).toContain("Couldn't send: the bot couldn't start a reply.");
    expect(text()).toContain("provider said no");
    await act(async () => buttons(root, "Retry")[0]!.props.onClick());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says Retrying while busy, and offers no Retry on a neutral notice", async () => {
    const root = await render({
      errorText: "That reply failed. Trying again (1 of 3).",
      errorTone: "info",
      errorRetry: { onRetry: () => {}, busy: false },
    });
    expect(root.findByProps({ role: "status", "data-tone": "info" })).toBeDefined();
    expect(buttons(root, "Retry")).toHaveLength(0);
    await act(async () =>
      renderer!.update(
        <MessageList
          {...BASE_PROPS}
          errorText="Couldn't send: x"
          errorTone="danger"
          errorRetry={{ onRetry: () => {}, busy: true }}
        />,
      ),
    );
    expect(text()).toContain("Retrying…");
  });
});
