import { assert, describe, it } from "@effect/vitest";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { makeSecretRedactor } from "../personal/secrets/secretRedaction.ts";
import { makeProviderEventSecretFilter } from "./secretEventRedaction.ts";

type ProviderEvent = ProviderAdapter.ProviderAdapterV2Event;

const KEY = "sk-live-AbCdEf0123456789xyzQ";

const event = (body: Record<string, unknown>): ProviderEvent =>
  ({ driver: "claudeAgent", ...body }) as unknown as ProviderEvent;

const delta = (text: string, itemId = "item-1") =>
  event({
    type: "command_output.delta",
    threadId: "thread-1",
    itemId,
    chunk: text,
  });

const itemEnd = (itemId = "item-1") =>
  event({
    type: "turn_item.updated",
    turnItem: {
      id: itemId,
      threadId: "thread-1",
      status: "completed",
    },
  });

const textOf = (events: ReadonlyArray<ProviderEvent>) =>
  events.map((entry) => (entry.type === "command_output.delta" ? entry.chunk : "")).join("");

const make = () => {
  const redactor = makeSecretRedactor();
  redactor.set("VERCEL_TOKEN", KEY);
  return makeProviderEventSecretFilter(redactor);
};

describe("makeProviderEventSecretFilter", () => {
  it("passes every event through untouched when no key is known", () => {
    const filter = makeProviderEventSecretFilter(makeSecretRedactor());
    const input = delta(`value ${KEY}`);
    assert.deepStrictEqual(filter.process(input), [input]);
  });

  it("masks a key in a single delta", () => {
    const [out, ...rest] = make().process(delta(`the key is ${KEY}!`));
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(
      out!.type === "command_output.delta" && out!.chunk,
      "the key is [secret VERCEL_TOKEN]!",
    );
  });

  it("masks a key split across deltas at any point, and releases a held tail at item end", () => {
    const text = `before ${KEY} after`;
    for (let cut = 1; cut < text.length; cut++) {
      const filter = make();
      const out = [
        ...filter.process(delta(text.slice(0, cut))),
        ...filter.process(delta(text.slice(cut))),
        ...filter.process(itemEnd()),
      ];
      assert.strictEqual(textOf(out), "before [secret VERCEL_TOKEN] after", `cut ${cut}`);
      assert.strictEqual(filter.holding(), 0);
    }
  });

  it("a held tail that was not a key comes out ahead of the event that ended the item", () => {
    const filter = make();
    const first = filter.process(delta("see sk-live-AbC"));
    assert.strictEqual(textOf(first), "see ");
    assert.strictEqual(filter.holding(), 1);
    const ended = filter.process(itemEnd());
    assert.deepStrictEqual(
      ended.map((entry) => entry.type),
      ["command_output.delta", "turn_item.updated"],
    );
    assert.strictEqual(textOf(ended), "sk-live-AbC");
    assert.strictEqual(filter.holding(), 0);
  });

  it("keeps two items' streams apart", () => {
    const filter = make();
    const a1 = filter.process(delta(KEY.slice(0, 10), "item-a"));
    const b1 = filter.process(delta("hello", "item-b"));
    const a2 = filter.process(delta(KEY.slice(10), "item-a"));
    assert.strictEqual(textOf(a1), "");
    assert.strictEqual(textOf(b1), "hello");
    assert.strictEqual(textOf(a2), "[secret VERCEL_TOKEN]");
  });

  it("masks keys inside tool items and nested data", () => {
    const filter = make();
    const completed = filter.process(
      event({
        type: "turn_item.updated",
        turnItem: {
          id: "item-1",
          threadId: "thread-1",
          status: "completed",
          detail: `echo $PB_SECRET_VERCEL_TOKEN -> ${KEY}`,
          data: { item: { aggregated_output: `${KEY}\n`, command: "echo" }, exitCode: 0 },
        },
      }),
    );
    const serialized = JSON.stringify(completed);
    assert.notInclude(serialized, KEY);
    assert.include(serialized, "[secret VERCEL_TOKEN]");
  });

  it("does not change an image payload", () => {
    const filter = make();
    const image = { mimeType: "image/png", data: `AAAA${KEY}AAAA` };
    const [out] = filter.process(
      event({
        type: "turn_item.updated",
        turnItem: { id: "item-1", threadId: "thread-1", status: "completed", data: image },
      }),
    );
    assert.strictEqual((out as unknown as { turnItem: { data: unknown } }).turnItem.data, image);
  });
});
