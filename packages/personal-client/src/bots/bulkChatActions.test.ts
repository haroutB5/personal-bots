import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bulkChatFailureFallback,
  bulkChatFailureVerb,
  bulkChatStateInput,
} from "./bulkChatActions.ts";

const ids = ["a", "b"] as unknown as ReadonlyArray<ThreadId>;

describe("bulkChatStateInput", () => {
  it("builds each state action's request", () => {
    expect(bulkChatStateInput("pin", ids, undefined, 0)).toEqual({ threadIds: ids, pinned: true });
    expect(bulkChatStateInput("unpin", ids, undefined, 0)).toEqual({
      threadIds: ids,
      pinned: false,
    });
    expect(bulkChatStateInput("wake", ids, undefined, 0)).toEqual({
      threadIds: ids,
      snoozedUntil: null,
    });
    expect(bulkChatStateInput("markUnread", ids, undefined, 0)).toEqual({
      threadIds: ids,
      markUnread: true,
    });
  });

  it("ends a snooze at the chosen time, or now when none is given", () => {
    const chosen = bulkChatStateInput("snooze", ids, { snoozeUntilMs: 5_000 }, 1_000);
    expect(chosen.snoozedUntil?.epochMilliseconds).toBe(5_000);
    const now = bulkChatStateInput("snooze", ids, undefined, 1_000);
    expect(now.snoozedUntil?.epochMilliseconds).toBe(1_000);
  });
});

describe("bulk failure words", () => {
  it("names the verb of each action", () => {
    expect(bulkChatFailureVerb("delete")).toBe("delete");
    expect(bulkChatFailureVerb("markUnread")).toBe("mark");
    expect(bulkChatFailureVerb("wake")).toBe("wake");
    expect(bulkChatFailureVerb("archive")).toBe("archive");
    expect(bulkChatFailureVerb("unarchive")).toBe("unarchive");
    expect(bulkChatFailureFallback("pin")).toBe("Couldn't pin these chats. Try again.");
  });
});
