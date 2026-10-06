import { assert, describe, it } from "@effect/vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import { makeSecretRedactor } from "../personal/secrets/secretRedaction.ts";
import { makeProviderEventSecretFilter } from "./secretEventRedaction.ts";

const KEY = "sk-live-AbCdEf0123456789xyzQ";

const event = (type: string, extra: Record<string, unknown>, id = "e1"): ProviderRuntimeEvent =>
  ({
    eventId: id,
    provider: "claudeAgent",
    providerInstanceId: "claudeAgent",
    threadId: "thread-1",
    createdAt: "2026-10-07T00:00:00.000Z",
    type,
    ...extra,
  }) as unknown as ProviderRuntimeEvent;

const delta = (text: string, id: string, itemId = "item-1") =>
  event(
    "content.delta",
    {
      turnId: "turn-1",
      itemId,
      payload: { streamKind: "assistant_text", delta: text },
      raw: { x: text },
    },
    id,
  );

const textOf = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.map((entry) => (entry.payload as { delta?: string }).delta ?? "").join("");

const make = () => {
  const redactor = makeSecretRedactor();
  redactor.set("VERCEL_TOKEN", KEY);
  return makeProviderEventSecretFilter(redactor);
};

describe("makeProviderEventSecretFilter", () => {
  it("passes every event through untouched when no key is known", () => {
    const filter = makeProviderEventSecretFilter(makeSecretRedactor());
    const input = delta(`value ${KEY}`, "a");
    assert.deepStrictEqual(filter.process(input), [input]);
  });

  it("masks a key in a single delta and drops the raw copy", () => {
    const [out, ...rest] = make().process(delta(`the key is ${KEY}!`, "a"));
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(
      (out!.payload as { delta: string }).delta,
      "the key is [secret VERCEL_TOKEN]!",
    );
    assert.notProperty(out!, "raw");
  });

  it("masks a key split across deltas at any point, and releases a held tail at item end", () => {
    const text = `before ${KEY} after`;
    for (let cut = 1; cut < text.length; cut++) {
      const filter = make();
      const out = [
        ...filter.process(delta(text.slice(0, cut), "a")),
        ...filter.process(delta(text.slice(cut), "b")),
        ...filter.process(
          event("item.completed", { turnId: "turn-1", itemId: "item-1", payload: {} }),
        ),
      ];
      assert.strictEqual(textOf(out), "before [secret VERCEL_TOKEN] after", `cut ${cut}`);
      assert.strictEqual(filter.holding(), 0);
    }
  });

  it("a held tail that was not a key comes out ahead of the event that ended the stream", () => {
    const filter = make();
    const first = filter.process(delta("see sk-live-AbC", "a"));
    assert.strictEqual(textOf(first), "see ");
    assert.strictEqual(filter.holding(), 1);
    const ended = filter.process(
      event("turn.completed", { turnId: "turn-1", payload: { state: "completed" } }),
    );
    assert.deepStrictEqual(
      ended.map((entry) => entry.type),
      ["content.delta", "turn.completed"],
    );
    assert.strictEqual(textOf(ended), "sk-live-AbC");
    assert.strictEqual(filter.holding(), 0);
  });

  it("keeps two items' streams apart", () => {
    const filter = make();
    const a1 = filter.process(delta(KEY.slice(0, 10), "a1", "item-a"));
    const b1 = filter.process(delta("hello", "b1", "item-b"));
    const a2 = filter.process(delta(KEY.slice(10), "a2", "item-a"));
    assert.strictEqual(textOf(a1), "");
    assert.strictEqual(textOf(b1), "hello");
    assert.strictEqual(textOf(a2), "[secret VERCEL_TOKEN]");
  });

  it("masks keys inside tool output, activity detail, errors and nested data", () => {
    const filter = make();
    const completed = filter.process(
      event("item.completed", {
        turnId: "turn-1",
        itemId: "item-1",
        payload: {
          itemType: "command_execution",
          detail: `echo $PB_SECRET_VERCEL_TOKEN -> ${KEY}`,
          data: { item: { aggregated_output: `${KEY}\n`, command: "echo" }, exitCode: 0 },
        },
        raw: { payload: KEY },
      }),
    );
    const serialized = JSON.stringify(completed);
    assert.notInclude(serialized, KEY);
    assert.include(serialized, "[secret VERCEL_TOKEN]");
    const error = filter.process(event("runtime.error", { payload: { message: `bad ${KEY}` } }));
    assert.notInclude(JSON.stringify(error), KEY);
  });

  it("does not hold or change an image payload", () => {
    const filter = make();
    const image = { mimeType: "image/png", data: `AAAA${KEY}AAAA` };
    const [out] = filter.process(event("item.completed", { payload: { data: image } }));
    assert.strictEqual((out!.payload as { data: unknown }).data, image);
  });
});
