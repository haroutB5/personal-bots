import { MessageId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { assert, describe, it } from "vite-plus/test";

import { makeAssistantStreamingFilter } from "../orchestration-v2/assistantStreaming.ts";
import {
  makePersonalAssistantStreamingFilter,
  PERSONAL_LIVE_STREAM_INTERVAL_MS,
} from "./liveStreaming.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;
type Filter = ReturnType<typeof makeAssistantStreamingFilter>;

const createdAt = DateTime.makeUnsafe(0);
const driver = ProviderDriverKind.make("claude");
const threadId = ThreadId.make("thread");

const message = (id: string, text: string, streaming: boolean): Event => ({
  type: "message.updated",
  driver,
  message: {
    createdBy: "agent",
    creationSource: "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming,
    createdAt,
    updatedAt: createdAt,
  },
});

const turnItemBase = {
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running" as const,
  title: null,
  startedAt: createdAt,
  completedAt: null,
  updatedAt: createdAt,
};

const assistantItem = (messageId: string, text: string, streaming: boolean): Event => ({
  type: "turn_item.updated",
  driver,
  turnItem: {
    ...turnItemBase,
    id: TurnItemId.make(`item:${messageId}`),
    type: "assistant_message",
    messageId: MessageId.make(messageId),
    text,
    streaming,
  },
});

const reasoningItem = (id: string, text: string, streaming: boolean): Event => ({
  type: "turn_item.updated",
  driver,
  turnItem: { ...turnItemBase, id: TurnItemId.make(id), type: "reasoning", text, streaming },
});

type Delivery = { readonly at: number; readonly event: Event };

const bodyOf = (event: Event): string => {
  if (event.type === "message.updated") return event.message.text;
  if (event.type === "turn_item.updated" && "text" in event.turnItem) return event.turnItem.text;
  return "";
};

/** Drives a filter the way the run loop does: due flushes fire at their deadline, before the next event. */
function drive(
  filter: Filter,
  script: ReadonlyArray<{ readonly at: number; readonly events: ReadonlyArray<Event> }>,
  until: number,
): ReadonlyArray<Delivery> {
  const delivered: Array<Delivery> = [];
  const flushUpTo = (limit: number) => {
    for (let due = filter.nextIdleFlushAt(); due !== null && due <= limit;) {
      for (const event of filter.takeIdleFlushes(due)) delivered.push({ at: due, event });
      const next = filter.nextIdleFlushAt();
      due = next !== null && next > due ? next : null;
    }
  };
  for (const step of script) {
    flushUpTo(step.at);
    for (const event of step.events) {
      const released = filter.filter(event, step.at);
      if (released !== null) delivered.push({ at: step.at, event: released });
    }
  }
  flushUpTo(until);
  return delivered;
}

const DELTA_CHARS = 12;
const DELTA_GAP_MS = 50;
const DELTA_COUNT = 30;

const flatDeltas = () => {
  const pieces = Array.from({ length: DELTA_COUNT }, (_, index) =>
    String.fromCharCode(97 + (index % 26)).repeat(DELTA_CHARS),
  );
  const full = pieces.join("");
  const script = pieces.map((_, index) => {
    const text = pieces.slice(0, index + 1).join("");
    const streaming = index < DELTA_COUNT - 1;
    return { at: index * DELTA_GAP_MS, events: [message("m1", text, streaming)] };
  });
  return { full, script, lastAt: (DELTA_COUNT - 1) * DELTA_GAP_MS };
};

describe("personal live streaming", () => {
  it("delivers a reply with no blank line within one interval of its first delta and never leaves a gap", () => {
    const { full, script, lastAt } = flatDeltas();
    const delivered = drive(
      makePersonalAssistantStreamingFilter("paragraph", { env: {} }),
      script,
      lastAt + 1_000,
    );
    const times = delivered.map((entry) => entry.at);

    assert.isAtMost(times[0] ?? Number.POSITIVE_INFINITY, PERSONAL_LIVE_STREAM_INTERVAL_MS);
    const gaps = times.slice(1).map((at, index) => at - (times[index] ?? 0));
    assert.isAtMost(Math.max(...gaps), 150);
    assert.isAtLeast(delivered.length, 12);
    assert.strictEqual(bodyOf(delivered.at(-1)!.event), full);
  });

  it("only ever delivers text that grows toward the final text", () => {
    const { full, script, lastAt } = flatDeltas();
    const delivered = drive(
      makePersonalAssistantStreamingFilter("paragraph", { env: {} }),
      script,
      lastAt + 1_000,
    );
    let previous = "";
    for (const entry of delivered) {
      const text = bodyOf(entry.event);
      assert.isTrue(full.startsWith(text), "delivered text is a prefix of the final text");
      assert.isAtLeast(text.length, previous.length);
      previous = text;
    }
  });

  it("delivers the final text at once and never replays older held text after it", () => {
    const filter = makePersonalAssistantStreamingFilter("paragraph", { env: {} });
    assert.isNotNull(filter.filter(message("m1", "Hello", true), 0));
    assert.isNull(filter.filter(message("m1", "Hello wor", true), 30));
    const final = filter.filter(message("m1", "Hello world.", false), 40);
    assert.strictEqual(final === null ? null : bodyOf(final), "Hello world.");
    assert.deepEqual(filter.takeIdleFlushes(500), []);
    assert.isNull(filter.nextIdleFlushAt());
  });

  it("releases a message and its turn item together with the same text", () => {
    const pieces = Array.from({ length: 24 }, (_, index) => `word${index} `);
    const script = pieces.map((_, index) => {
      const text = pieces.slice(0, index + 1).join("");
      return {
        at: index * 37,
        events: [message("m1", text, true), assistantItem("m1", text, true)],
      };
    });
    const delivered = drive(
      makePersonalAssistantStreamingFilter("paragraph", { env: {} }),
      script,
      2_000,
    );

    let shownByMessage = "";
    let items = 0;
    for (const { event } of delivered) {
      if (event.type === "message.updated") shownByMessage = bodyOf(event);
      else {
        items += 1;
        assert.strictEqual(bodyOf(event), shownByMessage);
      }
    }
    assert.isAtLeast(items, 6);
  });

  it("keeps two messages on their own clocks", () => {
    const filter = makePersonalAssistantStreamingFilter("paragraph", { env: {} });
    assert.isNotNull(filter.filter(message("a", "A1", true), 0));
    assert.isNotNull(filter.filter(message("b", "B1", true), 60));
    assert.isNull(filter.filter(message("a", "A12", true), 70));
    assert.isNull(filter.filter(message("b", "B12", true), 90));
    assert.strictEqual(filter.nextIdleFlushAt(), 100);
    assert.deepEqual(filter.takeIdleFlushes(100).map(bodyOf), ["A12"]);
    assert.strictEqual(filter.nextIdleFlushAt(), 160);
    assert.deepEqual(filter.takeIdleFlushes(160).map(bodyOf), ["B12"]);
    assert.isNull(filter.nextIdleFlushAt());
  });

  it("streams a reasoning item live", () => {
    const filter = makePersonalAssistantStreamingFilter("paragraph", { env: {} });
    const first = filter.filter(reasoningItem("r1", "Thinking", true), 0);
    assert.strictEqual(first === null ? null : bodyOf(first), "Thinking");
    assert.isNull(filter.filter(reasoningItem("r1", "Thinking about it", true), 40));
    assert.deepEqual(filter.takeIdleFlushes(100).map(bodyOf), ["Thinking about it"]);
  });

  it("keeps hiding the running assistant node", () => {
    const filter = makePersonalAssistantStreamingFilter("paragraph", { env: {} });
    const node = {
      type: "node.updated",
      driver,
      node: { kind: "assistant_message", status: "running" },
    } as unknown as Event;
    assert.isNull(filter.filter(node, 0));
  });

  it("leaves turn mode alone: nothing streams, the final text arrives whole", () => {
    const filter = makePersonalAssistantStreamingFilter("turn", { env: {} });
    assert.isNull(filter.filter(message("m1", "Hello", true), 0));
    assert.isNull(filter.nextIdleFlushAt());
    const final = filter.filter(message("m1", "Hello world.", false), 500);
    assert.strictEqual(final === null ? null : bodyOf(final), "Hello world.");
  });

  describe("T3CODE_PERSONAL_LIVE_STREAMING=off", () => {
    it.each(["off", "0", "false", "no", "disabled", " OFF "])(
      "restores paragraph delivery when set to %j",
      (value) => {
        const { script, lastAt } = flatDeltas();
        const env = { T3CODE_PERSONAL_LIVE_STREAMING: value };
        const personal = drive(
          makePersonalAssistantStreamingFilter("paragraph", { env }),
          script,
          lastAt + 2_000,
        );
        const upstream = drive(makeAssistantStreamingFilter("paragraph"), script, lastAt + 2_000);

        assert.deepEqual(
          personal.map((entry) => [entry.at, bodyOf(entry.event)]),
          upstream.map((entry) => [entry.at, bodyOf(entry.event)]),
        );
        assert.isAtLeast(personal[0]?.at ?? 0, 800);
      },
    );

    it.each([undefined, "", "on", "1"])("stays live when set to %j", (value) => {
      const { script, lastAt } = flatDeltas();
      const env = value === undefined ? {} : { T3CODE_PERSONAL_LIVE_STREAMING: value };
      const delivered = drive(
        makePersonalAssistantStreamingFilter("paragraph", { env }),
        script,
        lastAt + 2_000,
      );
      assert.isAtMost(
        delivered[0]?.at ?? Number.POSITIVE_INFINITY,
        PERSONAL_LIVE_STREAM_INTERVAL_MS,
      );
    });
  });
});
