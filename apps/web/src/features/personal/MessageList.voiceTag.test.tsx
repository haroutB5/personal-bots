/**
 * The "From the call" tag (review should-fix): a message the voice sent during
 * a call reads as the owner's own, so it must carry the tag; a typed one must
 * not.
 */
import { MessageId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import { MessageList } from "./MessageList";

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
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
}));

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

const voiceItem = (id: string, text: string): ConversationItem =>
  ({
    kind: "message",
    id,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      turnId: null,
      streaming: false,
      createdAt: "2026-10-06T10:00:00.000Z",
      updatedAt: "2026-10-06T10:00:00.000Z",
      context: {
        records: [
          {
            kind: "personal-voice-call",
            payload: { callId: "call-1", source: "voice_call" },
          },
        ],
      },
    },
  }) as never;

const typedItem = (id: string, text: string): ConversationItem =>
  ({
    kind: "message",
    id,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      turnId: null,
      streaming: false,
      createdAt: "2026-10-06T10:00:00.000Z",
      updatedAt: "2026-10-06T10:00:00.000Z",
    },
  }) as never;

const render = async (items: ReadonlyArray<ConversationItem>) => {
  await act(async () => {
    renderer = create(<MessageList {...BASE_PROPS} items={items} />);
  });
  return renderer!.root;
};

const tags = (root: { findAllByProps: (props: Record<string, unknown>) => unknown[] }) =>
  root.findAllByProps({ "data-testid": "voice-call-tag" });

describe("the From the call tag", () => {
  it("marks a message the voice sent", async () => {
    const root = await render([voiceItem("user-1", "Deploy it")]);
    const found = tags(root) as ReadonlyArray<{ children: unknown[] }>;
    expect(found).toHaveLength(1);
    expect(found[0]!.children).toContain("From the call");
  });

  it("leaves a typed message alone", async () => {
    const root = await render([typedItem("user-2", "Deploy it")]);
    expect(tags(root)).toHaveLength(0);
  });

  it("marks only the spoken one when both are in the same chat", async () => {
    const root = await render([
      typedItem("user-2", "typed it myself"),
      voiceItem("user-1", "said it out loud"),
    ]);
    expect(tags(root)).toHaveLength(1);
  });
});
