import { OrchestrationV2ThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => new Map<string, string>());
const writer = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("../platform/secureStorage", () => ({
  writeEncryptedText: async (path: string, text: string) => {
    await Promise.resolve();
    if (writer.failure !== null) throw writer.failure;
    files.set(path, `v2:${Buffer.from(text).toString("base64")}`);
  },
  readDecryptedText: async (path: string) => {
    const raw = files.get(path);
    if (raw === undefined) return null;
    if (!raw.startsWith("v2:")) {
      files.delete(path);
      return null;
    }
    return Buffer.from(raw.slice(3), "base64").toString("utf8");
  },
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      this.uri = `${typeof parent === "string" ? parent : parent.uri}/${name}`;
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      return [];
    }
  }
  class File {
    readonly uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return files.has(this.uri);
    }
    text() {
      return Promise.resolve(files.get(this.uri) ?? "");
    }
    write(content: string) {
      files.set(this.uri, content);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  return { Directory, File, Paths: { document: "file:///documents" } };
});

import serverBody from "./fixtures/boundedThreadSnapshot.json";
import { readCachedThread, writeCachedThread } from "./nativeCache";

const FILE =
  "file:///documents/hbots-thread-cache/thread-environment-phone-f37b73c4-f46d-4da7-8d7b-32007f18562b.json";

const snapshot = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot))(
  serverBody,
);

describe("thread cache file", () => {
  beforeEach(() => {
    files.clear();
    writer.failure = null;
  });

  it("reads back a written thread snapshot", async () => {
    await writeCachedThread("environment-phone", snapshot);

    const loaded = await readCachedThread(
      "environment-phone",
      ThreadId.make("f37b73c4-f46d-4da7-8d7b-32007f18562b"),
    );

    const thread = Option.getOrThrow(loaded);
    expect(DateTime.formatIso(thread.projection.thread.createdAt)).toBe("2026-11-08T21:03:43.806Z");
    expect(thread.projection.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "phone flow ping 1794171823895"],
      ["assistant", "Got it."],
    ]);
  });

  it("stores the snapshot as ciphertext, not JSON", async () => {
    await writeCachedThread("environment-phone", snapshot);

    const stored = files.get(FILE) ?? "";
    expect(stored.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stored)).toThrow();
    expect(stored).not.toContain("phone flow ping");
  });

  const withMessageText = (text: string) => ({
    ...snapshot,
    projection: {
      ...snapshot.projection,
      messages: snapshot.projection.messages.map((message, index) =>
        index === 0 ? { ...message, text } : message,
      ),
    },
  });

  it("does not write a copy over 2 MB and removes the one already on the phone", async () => {
    await writeCachedThread("environment-phone", snapshot);
    expect(files.has(FILE)).toBe(true);

    await writeCachedThread("environment-phone", withMessageText("x".repeat(2_097_152)));

    expect(files.has(FILE)).toBe(false);
  });

  it("counts bytes, not characters, against the cap", async () => {
    await writeCachedThread("environment-phone", withMessageText("é".repeat(1_048_576)));

    expect(files.has(FILE)).toBe(false);
  });

  it("writes the long chat's 1.08 MB copy that the old 1 MB cap refused", async () => {
    await writeCachedThread("environment-phone", withMessageText("x".repeat(1_084_678)));

    const loaded = await readCachedThread(
      "environment-phone",
      ThreadId.make("f37b73c4-f46d-4da7-8d7b-32007f18562b"),
    );
    expect(Option.getOrThrow(loaded).projection.messages[0]?.text.length).toBe(1_084_678);
  });

  it("fails the save when the native writer fails, so the save waits for it", async () => {
    writer.failure = new Error("disk full");

    await expect(writeCachedThread("environment-phone", snapshot)).rejects.toThrow("disk full");
    expect(files.has(FILE)).toBe(false);
  });

  it("deletes a copy saved in the old v1 format and treats it as a miss", async () => {
    files.set(FILE, `v1:${Buffer.from(JSON.stringify(serverBody)).toString("base64")}`);

    const loaded = await readCachedThread(
      "environment-phone",
      ThreadId.make("f37b73c4-f46d-4da7-8d7b-32007f18562b"),
    );

    expect(Option.isNone(loaded)).toBe(true);
    expect(files.has(FILE)).toBe(false);
  });

  it("deletes an old plaintext file and treats it as a miss", async () => {
    files.set(FILE, JSON.stringify({ projection: { thread: { id: "x" } } }));

    const loaded = await readCachedThread(
      "environment-phone",
      ThreadId.make("f37b73c4-f46d-4da7-8d7b-32007f18562b"),
    );

    expect(Option.isNone(loaded)).toBe(true);
    expect(files.has(FILE)).toBe(false);
  });

  it("deletes a file that decrypts to something that is not a snapshot", async () => {
    files.set(FILE, `v2:${Buffer.from("not json").toString("base64")}`);

    const loaded = await readCachedThread(
      "environment-phone",
      ThreadId.make("f37b73c4-f46d-4da7-8d7b-32007f18562b"),
    );

    expect(Option.isNone(loaded)).toBe(true);
    expect(files.has(FILE)).toBe(false);
  });
});
