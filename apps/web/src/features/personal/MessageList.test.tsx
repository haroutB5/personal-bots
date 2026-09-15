import { MessageId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { MessageList } from "./MessageList";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrls: () => [null] }));
vi.mock("~/components/ChatMarkdown", () => ({ default: ({ text }: { text: string }) => text }));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  shouldPreserveAssistantLineBreaks: () => false,
}));
vi.mock("~/session-logic", () => ({
  selectMessageImageResources: () => [
    { _tag: "attachment", attachmentId: "thread-1-dead-attachment" },
  ],
}));
vi.mock("./ToolDetails", () => ({ ToolDetails: () => null }));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("renders a missing image attachment as an inert placeholder", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  await act(async () => {
    renderer = create(
      <MessageList
        environmentId={"env-1" as EnvironmentId}
        threadRef={{ threadId: "thread-1" } as ScopedThreadRef}
        items={[
          {
            kind: "message",
            id: "message-1",
            message: {
              id: MessageId.make("message-1"),
              role: "user",
              text: "See attached",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-dead-attachment",
                  name: "deleted.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                },
              ],
              turnId: null,
              streaming: false,
              createdAt: "2026-09-14T10:00:00.000Z",
              updatedAt: "2026-09-14T10:00:00.000Z",
            },
          },
        ]}
        pending={[]}
        working={false}
        botName="Assistant"
        workspaceRoot={undefined}
        approvals={[]}
        userInputs={[]}
        respondingIds={new Set()}
        onRespondToApproval={() => {}}
        errorText={null}
        loadEarlier={null}
        now={new Date("2026-09-14T10:01:00.000Z")}
        describeTurn={() => ""}
        renderDelegation={() => null}
      />,
    );
  });

  expect(renderer!.root.findAllByType("img")).toEqual([]);
  expect(
    renderer!.root.findAll(
      (node) =>
        node.type === "span" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("size-24") &&
        node.props.className.includes("personal-fill-muted"),
    ),
  ).toHaveLength(1);
});
