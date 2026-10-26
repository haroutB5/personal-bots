import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
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

const render = async (props: Partial<Parameters<typeof MessageList>[0]> = {}) => {
  await act(async () => {
    renderer = create(<MessageList {...BASE_PROPS} {...props} />);
  });
  return renderer!.root;
};

const DIVIDER: ConversationItem = {
  kind: "divider",
  id: "divider:1",
  at: new Date("2026-10-06T10:00:00.000Z"),
};

const NOTE = <p data-testid="progress-note">Plan for migration test:</p>;

/** The class names of one rendered node, as a list. */
const classesOf = (node: { props: { className?: string } }): string[] =>
  (node.props.className ?? "").split(/\s+/);

describe("a status line over a short transcript", () => {
  // A short transcript sits at the bottom of the screen. The progress note used
  // to hang under the header, so a working chat read as one line, a blank void
  // (the rest of the short transcript's room), then the first row (hbots 1.66.97).
  it("is drawn inside the list, right above the scroller, and the pair sits at the bottom", async () => {
    const root = await render({ items: [DIVIDER], statusLine: NOTE });
    const note = root.findByProps({ "data-testid": "progress-note" });
    const list = note.parent!;
    expect(classesOf(list)).toContain("justify-end");
    expect(list.children[0]).toBe(note);
    const scroller = list.children[1] as unknown as { props: { className?: string } };
    expect(classesOf(scroller)).toContain("flex-initial");
    expect(classesOf(scroller)).not.toContain("flex-1");
  });

  it("leaves the list exactly as it was without a note", async () => {
    const root = await render({ items: [DIVIDER] });
    const scroller = root.findByProps({ role: "log" }).parent!;
    expect(classesOf(scroller)).toContain("flex-1");
    expect(classesOf(scroller)).not.toContain("flex-initial");
    expect(classesOf(scroller.parent!)).not.toContain("justify-end");
    expect(root.findAllByProps({ "data-testid": "progress-note" })).toHaveLength(0);
  });

  it("keeps an empty chat's greeting centred in a scroller that fills the list", async () => {
    const root = await render({ items: [], statusLine: NOTE });
    const scroller = root.findByProps({ role: "log" }).parent!;
    expect(classesOf(scroller)).toContain("flex-1");
    expect(classesOf(scroller.parent!)).not.toContain("justify-end");
  });
});
