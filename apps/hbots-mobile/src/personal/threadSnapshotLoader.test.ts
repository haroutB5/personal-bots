import {
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { omitLocalVisibleTurnItems } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-crypto", () => ({}));

import type { StoredSession } from "../session";
import serverBody from "./fixtures/boundedThreadSnapshot.json";
import { takeChatOpenReport } from "./chatOpenPerf";
import {
  PREFETCH_MAX_AGE_MS,
  loadThreadSnapshot,
  prefetchThreadSnapshot,
  threadSnapshotLoader,
} from "./threadSnapshotLoader";

const THREAD_ID = ThreadId.make("f37b73c4-f46d-4da7-8d7b-32007f18562b");

const STORED: StoredSession = {
  environmentId: "environment-phone",
  label: "Laptop",
  httpBaseUrl: "http://192.168.0.50:3773",
  wsBaseUrl: "ws://192.168.0.50:3773",
  accessToken: "token",
  authMethod: "bearer",
  scope: "",
  expiresAt: 0,
  pairedAt: 0,
};

const load = () => loadThreadSnapshot(STORED, THREAD_ID);

const BOUNDED_URL =
  "http://192.168.0.50:3773/api/orchestration/threads/f37b73c4-f46d-4da7-8d7b-32007f18562b/bounded?compactTurnItems=1&dedupeBodies=1&compactIds=1&deferWork=1";

const AT = "2026-11-08T21:04:00.000Z";
const toolCall = (id: string, ordinal: number, output: string) => ({
  id,
  type: "command_execution",
  threadId: String(THREAD_ID),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  input: `cat ${id}.log`,
  output,
  exitCode: 0,
  startedAt: AT,
  completedAt: AT,
  updatedAt: AT,
});
const LOCAL = [toolCall("local-1", 1, "x".repeat(4000)), toolCall("local-2", 2, "done")];
const OLDER = toolCall("older-dependency", 0, "older output");
const plainBody = {
  ...serverBody,
  projection: {
    ...serverBody.projection,
    turnItems: [...LOCAL, OLDER],
    visibleTurnItems: LOCAL.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: String(THREAD_ID),
      sourceItemId: item.id,
      item,
    })),
  },
};
const plain = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot))(
  plainBody,
);

const encodeBoundedSnapshot = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);

/** What the server sends with all four opt-ins, built with the server's own compaction steps. */
function compactBody(): unknown {
  // On the server a visible row and its turn item are one object; compaction checks that.
  const shared = {
    ...plain.projection,
    visibleTurnItems: plain.projection.visibleTurnItems.map((row, index) => ({
      ...row,
      item: plain.projection.turnItems[index]!,
    })),
  };
  const compacted = omitLocalVisibleTurnItems(dedupeSnapshotBodies(shared));
  if (compacted === null) throw new Error("the fixture must compact");
  return encodeBoundedSnapshot({
    snapshotSequence: plain.snapshotSequence,
    projection: compacted,
    historyCursor: null,
    hasMoreHistory: false,
    latestLocalTurnOrdinal: 1,
    turnItemsOmitLocalVisible: true,
    idTable: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A clock only the stubbed fetch moves: the request leaves at `now`, answers at `respondAt`, decodes by `decodedAt`. */
function stubClockedFetch(now: number, respondAt: number, decodedAt: number) {
  const clock = { now };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  vi.stubGlobal("fetch", () => {
    clock.now = respondAt;
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => {
        clock.now = decodedAt;
        return Promise.resolve(serverBody);
      },
    });
  });
}

describe("loadThreadSnapshot", () => {
  it("decodes the server's /bounded JSON, ISO date strings included", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (input: URL) => {
      urls.push(String(input));
      return Promise.resolve(Response.json(serverBody));
    });

    const result = await load();

    expect(urls).toEqual([BOUNDED_URL]);
    if (result._tag !== "present") throw new Error(`expected present, got ${result._tag}`);
    expect(result.snapshot.snapshotSequence).toBe(46);
    expect(DateTime.formatIso(result.snapshot.projection.thread.createdAt)).toBe(
      "2026-11-08T21:03:43.806Z",
    );
    expect(
      result.snapshot.projection.messages.map((message) => [message.role, message.text]),
    ).toEqual([
      ["user", "phone flow ping 1794171823895"],
      ["assistant", "Got it."],
    ]);
    expect(result.history).toEqual({
      historyCursor: null,
      hasMoreHistory: false,
      latestLocalTurnOrdinal: 1,
    });
  });

  it("expands the compact body to the same projection as the plain one", async () => {
    const compact = compactBody() as {
      readonly ids?: unknown;
      readonly projection: { readonly turnItems: ReadonlyArray<unknown> };
    };
    expect([Array.isArray(compact.ids), compact.projection.turnItems.length]).toEqual([true, 1]);
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json(compact)));

    const result = await load();

    if (result._tag !== "present") throw new Error(`expected present, got ${result._tag}`);
    expect(result.snapshot.projection).toEqual(plain.projection);
    expect(result.snapshot.projection.turnItems.map((item) => item.id)).toEqual([
      "local-1",
      "local-2",
      "older-dependency",
    ]);
    expect(result.history).toEqual({
      historyCursor: null,
      hasMoreHistory: false,
      latestLocalTurnOrdinal: 1,
    });
  });

  it("reports a missing thread on 404", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 404 })));

    expect(await load()).toEqual({ _tag: "missing" });
  });

  it("times the response and the decode of its own request for the open report", async () => {
    const own = ThreadId.make("thread-timed-on-its-own");
    stubClockedFetch(1_010, 1_052, 1_069);

    await loadThreadSnapshot(STORED, own);

    expect(takeChatOpenReport(String(own), 1_000, 1_100).body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 100,
      store: "network",
      requestAtMs: 10,
      responseMs: 42,
      decodeMs: 17,
    });
  });
  describe("a prefetch from the press", () => {
    const respondWith = (...responses: Array<() => Response>) => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", (input: URL) => {
        calls.push(String(input));
        return Promise.resolve((responses[calls.length - 1] ?? responses.at(-1)!)());
      });
      return calls;
    };
    const ok = () => Response.json(serverBody);

    it("makes one request when the mount asks for the chat the press prefetched", async () => {
      threadSnapshotLoader(STORED);
      const calls = respondWith(ok);

      prefetchThreadSnapshot(THREAD_ID);
      const result = await load();

      expect(calls).toEqual([BOUNDED_URL]);
      expect(result._tag).toBe("present");
    });

    it("makes two requests when nothing was prefetched and the chat opens twice", async () => {
      const calls = respondWith(ok);

      await load();
      await load();

      expect(calls).toHaveLength(2);
    });

    it("hands a prefetch to one open only", async () => {
      threadSnapshotLoader(STORED);
      const calls = respondWith(ok);

      prefetchThreadSnapshot(THREAD_ID);
      await load();
      await load();

      expect(calls).toHaveLength(2);
    });

    it("presses twice on the same row, one request", async () => {
      threadSnapshotLoader(STORED);
      const calls = respondWith(ok);

      prefetchThreadSnapshot(THREAD_ID);
      prefetchThreadSnapshot(THREAD_ID);
      await load();

      expect(calls).toHaveLength(1);
    });

    it("does not give another chat's prefetch to this one", async () => {
      threadSnapshotLoader(STORED);
      const calls = respondWith(ok);

      prefetchThreadSnapshot(ThreadId.make("another-thread"));
      await load();

      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("another-thread");
      expect(calls[1]).toBe(BOUNDED_URL);
    });

    it("drops a prefetch older than 5 s and asks again", async () => {
      threadSnapshotLoader(STORED);
      const calls = respondWith(ok);
      const clock = vi.spyOn(performance, "now");
      clock.mockReturnValue(10_000);
      prefetchThreadSnapshot(THREAD_ID);

      clock.mockReturnValue(10_000 + PREFETCH_MAX_AGE_MS + 1);
      await load();

      expect(calls).toHaveLength(2);
    });

    it("keeps a prefetch that is exactly at the limit", async () => {
      threadSnapshotLoader(STORED);
      const calls = respondWith(ok);
      const clock = vi.spyOn(performance, "now");
      clock.mockReturnValue(10_000);
      prefetchThreadSnapshot(THREAD_ID);

      clock.mockReturnValue(10_000 + PREFETCH_MAX_AGE_MS);
      await load();

      expect(calls).toHaveLength(1);
    });

    it("asks again when the prefetch failed, so a blip at the press does not fail the open", async () => {
      threadSnapshotLoader(STORED);
      const calls = respondWith(() => new Response(null, { status: 503 }), ok);

      prefetchThreadSnapshot(THREAD_ID);
      const result = await load();

      expect(calls).toHaveLength(2);
      expect(result._tag).toBe("present");
    });

    it("does nothing before a session has started", async () => {
      vi.resetModules();
      const fresh = await import("./threadSnapshotLoader");
      const calls = respondWith(ok);

      fresh.prefetchThreadSnapshot(THREAD_ID);

      expect(calls).toHaveLength(0);
    });

    it("marks the request as sent at the press, with its response and decode times", async () => {
      const own = ThreadId.make("thread-with-own-marks");
      threadSnapshotLoader(STORED);
      stubClockedFetch(10_020, 10_061, 10_078);

      prefetchThreadSnapshot(own);
      await loadThreadSnapshot(STORED, own);

      expect(takeChatOpenReport(String(own), 10_240, 10_300, 10_000).body).toEqual({
        event: "perf",
        journey: "a-chat-open",
        ms: 60,
        fromTapMs: 300,
        store: "network",
        requestAtMs: 0,
        prefetched: true,
        responseMs: 41,
        decodeMs: 17,
      });
    });
  });
});
