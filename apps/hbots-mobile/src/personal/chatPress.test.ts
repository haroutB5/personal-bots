import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => new Set<string>());
const folder = vi.hoisted(() => ({ broken: false }));
const loader = vi.hoisted(() => ({
  environmentId: "environment-phone",
  prefetch: vi.fn<(threadId: string) => void>(),
}));

vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-crypto", () => ({}));
vi.mock("../platform/secureStorage", () => ({
  writeEncryptedText: async () => undefined,
  readDecryptedText: async () => null,
}));
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      this.uri = `${typeof parent === "string" ? parent : parent.uri}/${name}`;
    }
    get exists() {
      if (folder.broken) throw new Error("the cache folder cannot be read");
      return true;
    }
    create() {}
  }
  class File {
    readonly uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return files.has(this.uri);
    }
  }
  return { Directory, File, Paths: { document: "file:///documents" } };
});
vi.mock("./threadSnapshotLoader", () => ({
  snapshotSessionEnvironmentId: () => loader.environmentId,
  prefetchThreadSnapshot: loader.prefetch,
}));

import { resetPerfOffForTest, setPerfOff } from "../perfFlags";
import { takeChatTap } from "./chatOpenIntent";
import { onChatPress, pressChat } from "./chatPress";

const savedCopy = (environmentId: string, threadId: string) =>
  `file:///documents/hbots-thread-cache/thread-${environmentId}-${threadId}.json`;

afterEach(() => {
  files.clear();
  folder.broken = false;
  loader.prefetch.mockReset();
  resetPerfOffForTest();
  vi.restoreAllMocks();
});

describe("a press on a chat row", () => {
  it("starts the snapshot request for a chat with no saved copy, then opens the chat", () => {
    const open = vi.fn();

    pressChat("t-network", open);

    expect(loader.prefetch).toHaveBeenCalledExactlyOnceWith("t-network");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("starts no request for a chat the phone has a saved copy of, and still opens it", () => {
    files.add(savedCopy("environment-phone", "t-saved"));
    const open = vi.fn();

    pressChat("t-saved", open);

    expect(loader.prefetch).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("starts no request while android-preload-chat is switched off, and still opens the chat", () => {
    setPerfOff(["android-preload-chat"]);
    const open = vi.fn();

    pressChat("t-off", open);

    expect(loader.prefetch).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens the chat once when the saved-copy check throws, and starts no request", () => {
    folder.broken = true;
    const open = vi.fn();

    pressChat("t-broken-folder", open);

    expect(loader.prefetch).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens the chat once when the request itself throws", () => {
    loader.prefetch.mockImplementation(() => {
      throw new Error("no session");
    });
    const open = vi.fn();

    pressChat("t-throws", open);

    expect(loader.prefetch).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not throw from the press hook when the saved-copy check throws", () => {
    folder.broken = true;

    expect(() => onChatPress("t-broken-hook")).not.toThrow();
  });

  it("hands the press time to the chat screen even when the saved-copy check throws", () => {
    folder.broken = true;
    vi.spyOn(performance, "now").mockReturnValue(7_000);

    pressChat("t-timed", () => undefined);

    expect(takeChatTap("t-timed", 7_100)).toBe(7_000);
  });
});
