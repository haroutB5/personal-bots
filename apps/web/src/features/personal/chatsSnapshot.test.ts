import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildChatsSnapshot,
  dropChatFromSnapshot,
  MAX_SNAPSHOT_PREVIEW_CHARS,
  MAX_SNAPSHOT_ROWS,
  readChatsSnapshot,
  writeChatsSnapshot,
  type ChatsSnapshotRowInput,
} from "./chatsSnapshot";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function stubWindow(storage?: Storage): Storage {
  const localStorage = storage ?? createLocalStorageStub();
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  return localStorage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function row(botId: string, overrides: Partial<ChatsSnapshotRowInput> = {}): ChatsSnapshotRowInput {
  return {
    botId,
    name: `Bot ${botId}`,
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    providerLabel: "Claude Code",
    previewLabel: "Delegated to Developer",
    previewAtMs: 1_757_800_000_000,
    threadId: `thread-${botId}`,
    threadTitle: `Thread ${botId}`,
    ...overrides,
  };
}

describe("buildChatsSnapshot", () => {
  it("keeps only the render fields, one preview line, capped", () => {
    const snapshot = buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 1_757_800_000_000,
      rows: [
        row("a", {
          previewLabel: "  first line\nsecond line that must not persist\nthird",
          name: "  Ada  ",
        }),
      ],
    });

    expect(snapshot).toEqual({
      version: 1,
      environmentId: "env-1",
      savedAtMs: 1_757_800_000_000,
      rows: [
        expect.objectContaining({
          botId: "a",
          name: "Ada",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          providerLabel: "Claude Code",
          preview: "first line",
        }),
      ],
    });
    // No message bodies, no secrets, no live state.
    expect(Object.keys(snapshot.rows[0]!).toSorted()).toEqual(
      [
        "avatarColor",
        "avatarShape",
        "botId",
        "name",
        "preview",
        "previewAtMs",
        "providerLabel",
        "threadId",
        "threadTitle",
      ].toSorted(),
    );
  });

  it("never lets message text reach the stored envelope", () => {
    // A chat whose newest message is ordinary prose has no turn label, so the
    // row carries none and the stored preview falls back to the thread title.
    const snapshot = buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 0,
      rows: [
        row("a", { previewLabel: null, threadTitle: "Weekly plan" }),
        row("b", { previewLabel: null, threadTitle: null }),
      ],
    });

    expect(snapshot.rows[0]!.preview).toBe("Weekly plan");
    expect(snapshot.rows[1]!.preview).toBe("");

    // The module's stated invariant, asserted rather than assumed. The type
    // has no field a message body can enter; the builder also copies field by
    // field, so a caller that spreads a richer object in carries nothing extra
    // to disk.
    const smuggled = buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 0,
      rows: [
        {
          ...row("c", { previewLabel: null, threadTitle: "Weekly plan" }),
          preview: "my passport number is 123456789",
          messageText: "my passport number is 123456789",
        } as ChatsSnapshotRowInput,
      ],
    });

    expect(JSON.stringify({ environmentId: "env-1", snapshot: smuggled })).not.toContain(
      "passport",
    );
  });

  it("truncates long previews and caps the row count", () => {
    const rows = Array.from({ length: MAX_SNAPSHOT_ROWS + 10 }, (_, index) =>
      row(`bot-${index}`, { previewLabel: "x".repeat(MAX_SNAPSHOT_PREVIEW_CHARS + 50) }),
    );
    const snapshot = buildChatsSnapshot({ environmentId: "env-1", savedAtMs: 0, rows });

    expect(snapshot.rows).toHaveLength(MAX_SNAPSHOT_ROWS);
    expect(snapshot.rows[0]!.botId).toBe("bot-0");
    for (const entry of snapshot.rows) {
      expect(entry.preview.length).toBeLessThanOrEqual(MAX_SNAPSHOT_PREVIEW_CHARS);
    }
  });

  it("drops least-recent rows until the byte budget holds", () => {
    const rows = Array.from({ length: MAX_SNAPSHOT_ROWS }, (_, index) =>
      row(`bot-${index}`, {
        previewLabel: "y".repeat(MAX_SNAPSHOT_PREVIEW_CHARS),
        threadTitle: "z".repeat(120),
      }),
    );
    const snapshot = buildChatsSnapshot({ environmentId: "env-1", savedAtMs: 0, rows });
    const bytes = new TextEncoder().encode(
      JSON.stringify({ environmentId: "env-1", snapshot }),
    ).length;

    expect(bytes).toBeLessThanOrEqual(64_000);
    expect(snapshot.rows.length).toBeGreaterThan(0);
    // Most recent rows survive; the tail is dropped first.
    expect(snapshot.rows[0]!.botId).toBe("bot-0");
  });
});

describe("chats snapshot storage", () => {
  it("round-trips a snapshot for the same environment", () => {
    stubWindow();
    const snapshot = buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 1_757_800_000_000,
      rows: [row("a"), row("b", { threadId: null, threadTitle: null, previewAtMs: null })],
    });

    writeChatsSnapshot("env-1", snapshot);

    expect(readChatsSnapshot("env-1")).toEqual(snapshot);
  });

  it("misses on another environment and clears the stale entry", () => {
    const storage = stubWindow();
    writeChatsSnapshot(
      "env-1",
      buildChatsSnapshot({ environmentId: "env-1", savedAtMs: 0, rows: [row("a")] }),
    );

    expect(readChatsSnapshot("env-2")).toBeNull();
    expect(storage.getItem("t3code:chats-snapshot:v1")).toBeNull();
  });

  it("returns null without an environment and never writes", () => {
    const storage = stubWindow();

    expect(readChatsSnapshot(null)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("drops corrupt entries instead of throwing", () => {
    const storage = stubWindow();
    storage.setItem("t3code:chats-snapshot:v1", "not-json{{{");

    expect(readChatsSnapshot("env-1")).toBeNull();
    expect(storage.getItem("t3code:chats-snapshot:v1")).toBeNull();
  });

  it("rejects wrong-shape payloads instead of rendering them", () => {
    const storage = stubWindow();
    storage.setItem(
      "t3code:chats-snapshot:v1",
      JSON.stringify({ environmentId: "env-1", snapshot: { version: 2, rows: [] } }),
    );

    expect(readChatsSnapshot("env-1")).toBeNull();
    expect(storage.getItem("t3code:chats-snapshot:v1")).toBeNull();
  });

  it("survives quota failures on write without throwing", () => {
    const storage = stubWindow();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const snapshot = buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 0,
      rows: [row("a")],
    });

    expect(() => writeChatsSnapshot("env-1", snapshot)).not.toThrow();
    expect(readChatsSnapshot("env-1")).toBeNull();
  });

  it("drops a deleted chat so a cold start stops painting it", () => {
    stubWindow();
    writeChatsSnapshot(
      "env-1",
      buildChatsSnapshot({
        environmentId: "env-1",
        savedAtMs: 0,
        rows: [row("a"), row("b")],
      }),
    );

    const remaining = dropChatFromSnapshot("env-1", (entry) => entry.threadId === "thread-a");

    expect(remaining?.rows.map((entry) => entry.botId)).toEqual(["b"]);
    expect(readChatsSnapshot("env-1")?.rows.map((entry) => entry.threadId)).toEqual(["thread-b"]);
  });

  it("drops every chat of a deleted bot, clearing the entry when nothing is left", () => {
    const storage = stubWindow();
    writeChatsSnapshot(
      "env-1",
      buildChatsSnapshot({ environmentId: "env-1", savedAtMs: 0, rows: [row("a")] }),
    );

    expect(dropChatFromSnapshot("env-1", (entry) => entry.botId === "a")).toBeNull();
    expect(readChatsSnapshot("env-1")).toBeNull();
    expect(storage.getItem("t3code:chats-snapshot:v1")).toBeNull();
  });

  it("leaves the snapshot alone when nothing matches, and no-ops without an environment", () => {
    stubWindow();
    const snapshot = buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 0,
      rows: [row("a")],
    });
    writeChatsSnapshot("env-1", snapshot);

    expect(dropChatFromSnapshot("env-1", (entry) => entry.threadId === "thread-missing")).toEqual(
      snapshot,
    );
    expect(dropChatFromSnapshot(null, () => true)).toBeNull();
    expect(readChatsSnapshot("env-1")).toEqual(snapshot);
  });

  it("reads null when storage itself is unavailable", () => {
    stubWindow();
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(readChatsSnapshot("env-1")).toBeNull();
  });
});
