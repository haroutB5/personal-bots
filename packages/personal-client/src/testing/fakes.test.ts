import { describe, expect, it } from "@effect/vitest";

import {
  createFakeConfirm,
  createFakeLifecycle,
  createManualClock,
  createMemoryBlobStore,
  createMemoryKeyValueStore,
  createSequentialIds,
} from "./fakes.ts";

describe("memory key value store", () => {
  it("reads back what it wrote and returns null after removal", () => {
    const kv = createMemoryKeyValueStore({ seeded: "1" });
    kv.setItem("a", "x");
    expect([kv.getItem("a"), kv.getItem("seeded"), kv.getItem("missing")]).toEqual([
      "x",
      "1",
      null,
    ]);
    kv.removeItem("a");
    expect(kv.getItem("a")).toBeNull();
  });

  it("tells subscribers about outside writes but not about its own", () => {
    const kv = createMemoryKeyValueStore();
    const heard: Array<string | null> = [];
    const cancel = kv.subscribe((key) => heard.push(key));
    kv.setItem("own", "1");
    kv.writeFromOutside("other", "2");
    kv.clearFromOutside();
    cancel();
    kv.writeFromOutside("after", "3");
    expect(heard).toEqual(["other", null]);
    expect(kv.getItem("after")).toBe("3");
    expect(kv.getItem("own")).toBeNull();
  });
});

describe("memory blob store", () => {
  it("stores, lists and deletes by prefix", async () => {
    const blobs = createMemoryBlobStore<string>((payload) => payload.length);
    await blobs.put("entry-1/a", "aaa");
    await blobs.put("entry-1/b", "bb");
    await blobs.put("entry-2/a", "c");
    await blobs.deletePrefix("entry-1/");
    expect(await blobs.keys()).toEqual(["entry-2/a"]);
    expect(await blobs.get("entry-1/a")).toBeNull();
    expect(await blobs.get("entry-2/a")).toBe("c");
    expect(blobs.sizeOf("hello")).toBe(5);
  });
});

describe("manual clock", () => {
  it("runs timers in due order, including ones scheduled by a timer", () => {
    const clock = createManualClock(1_000);
    const log: string[] = [];
    clock.setTimeout(() => {
      log.push(`late@${clock.now()}`);
    }, 300);
    clock.setTimeout(() => {
      log.push(`early@${clock.now()}`);
      clock.setTimeout(() => log.push(`chained@${clock.now()}`), 100);
    }, 100);
    clock.advance(250);
    expect(log).toEqual(["early@1100", "chained@1200"]);
    expect(clock.now()).toBe(1_250);
    clock.advance(50);
    expect(log).toEqual(["early@1100", "chained@1200", "late@1300"]);
    expect(clock.pendingCount()).toBe(0);
  });

  it("does not run a cancelled timer", () => {
    const clock = createManualClock();
    let ran = false;
    const cancel = clock.whenIdle(() => {
      ran = true;
    }, 1_500);
    cancel();
    clock.advance(5_000);
    expect(ran).toBe(false);
  });

  it("fires the idle callback after its fallback and a frame after 16 ms", () => {
    const clock = createManualClock();
    const log: string[] = [];
    clock.whenIdle(() => log.push("idle"), 1_500);
    clock.nextFrame(() => log.push("frame"));
    clock.advance(16);
    expect(log).toEqual(["frame"]);
    clock.advance(1_484);
    expect(log).toEqual(["frame", "idle"]);
  });
});

describe("fake lifecycle", () => {
  it("notifies once per change and stops after cancel", () => {
    const lifecycle = createFakeLifecycle();
    const seen: string[] = [];
    const cancel = lifecycle.subscribe((state) => seen.push(state));
    lifecycle.set("foreground");
    lifecycle.set("background");
    cancel();
    lifecycle.set("foreground");
    expect(seen).toEqual(["background"]);
    expect(lifecycle.current()).toBe("foreground");
  });
});

describe("fake confirm", () => {
  it("answers from the script in order, records requests and then falls back", async () => {
    const confirm = createFakeConfirm([true, false]);
    const first = await confirm.confirm({ title: "Delete bot", destructive: true });
    const second = await confirm.confirm({
      title: "Leave",
      body: "Unsent text",
      destructive: false,
    });
    const third = await confirm.confirm({ title: "Again", destructive: false });
    expect([first, second, third]).toEqual([true, false, false]);
    expect(confirm.requests.map((request) => request.title)).toEqual([
      "Delete bot",
      "Leave",
      "Again",
    ]);
  });
});

describe("sequential ids", () => {
  it("counts up in a UUID shape", () => {
    const ids = createSequentialIds();
    expect([ids.randomUUID(), ids.randomUUID()]).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });
});
