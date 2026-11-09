import { OrchestrationV2ThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => new Map<string, string>());

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

const snapshot = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot))(
  serverBody,
);

describe("thread cache file", () => {
  it("reads back a written thread snapshot", async () => {
    writeCachedThread("environment-phone", snapshot);

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
});
