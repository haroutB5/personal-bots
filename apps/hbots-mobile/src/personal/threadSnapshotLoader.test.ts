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
import { loadThreadSnapshot } from "./threadSnapshotLoader";

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
});

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
});
