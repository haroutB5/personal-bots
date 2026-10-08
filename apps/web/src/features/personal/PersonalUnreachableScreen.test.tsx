import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { enqueueOutboxEntry, resetOutboxForTesting } from "./outbox";
import { PersonalUnreachableScreen } from "./PersonalUnreachableScreen";

let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetOutboxForTesting(null);
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
  resetOutboxForTesting(undefined);
});

const queue = (id: string) =>
  enqueueOutboxEntry({
    id,
    kind: "turn",
    environmentId: "env",
    threadId: "t1",
    groupId: null,
    text: id,
    sendText: id,
    createdAt: "2026-10-08T12:00:00.000Z",
    replyTo: null,
    turn: null,
    attachments: [],
  });

describe("the cold-launch 'Laptop offline' screen", () => {
  it("says nothing about messages when none are waiting", async () => {
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={() => {}} />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Laptop offline");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("waiting to send");
  });

  it("says the messages typed while the laptop was away are still here and go out when it is back", async () => {
    queue("a");
    queue("b");
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={() => {}} />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "2 messages are waiting to send. They go out when it reconnects.",
    );
  });
});
