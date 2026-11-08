import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadThreadSnapshot", () => {
  it.fails("decodes the server's /bounded JSON, ISO date strings included", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (input: URL) => {
      urls.push(String(input));
      return Promise.resolve(Response.json(serverBody));
    });

    const result = await load();

    expect(urls).toEqual([
      "http://192.168.0.50:3773/api/orchestration/threads/f37b73c4-f46d-4da7-8d7b-32007f18562b/bounded",
    ]);
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

  it("reports a missing thread on 404", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 404 })));

    expect(await load()).toEqual({ _tag: "missing" });
  });
});
