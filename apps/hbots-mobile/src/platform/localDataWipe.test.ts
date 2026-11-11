import { OrchestrationV2ThreadDetailSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fs = vi.hoisted(() => ({
  dirs: new Set<string>(),
  files: new Map<string, string>(),
  keyDeletes: 0,
  notifyWipes: 0,
  launcherWipes: 0,
}));

vi.mock("./secureStorage", () => ({
  writeEncryptedText: (path: string, text: string) => {
    fs.files.set(path, `v1:${Buffer.from(text).toString("base64")}`);
  },
  readDecryptedText: async () => null,
  encryptFile: async (source: string, destination: string) => {
    fs.files.set(destination, `v1:${fs.files.get(source) ?? ""}`);
    return true;
  },
  decryptFile: async (source: string, destination: string) => {
    fs.files.set(destination, (fs.files.get(source) ?? "").slice(3));
    return true;
  },
  deleteCacheKey: () => {
    fs.keyDeletes += 1;
  },
}));

vi.mock("../notifications/nativeNotify", () => ({
  wipeNativeNotifications: () => {
    fs.notifyWipes += 1;
  },
}));

vi.mock("../launcher/nativeLauncher", () => ({
  wipeNativeLauncher: () => {
    fs.launcherWipes += 1;
  },
}));

vi.mock("react-native", () => ({
  Alert: { alert: () => undefined },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  InteractionManager: { runAfterInteractions: () => ({ cancel: () => undefined }) },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-file-system", () => {
  const uriOf = (parent: { uri: string } | string, name?: string) =>
    name === undefined
      ? String(parent)
      : `${typeof parent === "string" ? parent : parent.uri}/${name}`;
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri = uriOf(parent, name);
    }
    get exists() {
      return fs.dirs.has(this.uri);
    }
    create() {
      fs.dirs.add(this.uri);
    }
    delete() {
      fs.dirs.delete(this.uri);
      for (const key of fs.files.keys()) {
        if (key.startsWith(`${this.uri}/`)) fs.files.delete(key);
      }
    }
    list() {
      return [...fs.files.keys()]
        .filter((key) => key.startsWith(`${this.uri}/`))
        .map((key) => new File(key));
    }
  }
  class File {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri = uriOf(parent, name);
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    get exists() {
      return fs.files.has(this.uri);
    }
    get size() {
      return (fs.files.get(this.uri) ?? "").length;
    }
    text() {
      return Promise.resolve(fs.files.get(this.uri) ?? "");
    }
    write(content: string) {
      fs.files.set(this.uri, content);
    }
    copy(target: File) {
      fs.files.set(target.uri, fs.files.get(this.uri) ?? "");
    }
    delete() {
      fs.files.delete(this.uri);
    }
  }
  return { Directory, File, Paths: { document: "file:///documents", cache: "file:///cache-dir" } };
});

import serverBody from "../personal/fixtures/boundedThreadSnapshot.json";
import {
  createNativeEnvironmentCache,
  readCachedThread,
  writeCachedThread,
} from "../personal/nativeCache";
import { createFileBlobStore, wipeLocalData } from "./nativePorts";

const snapshot = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot))(
  serverBody,
);
const THREAD_ID = snapshot.projection.thread.id;
const CACHE = "file:///documents/hbots-thread-cache";
const BLOBS = "file:///documents/hbots-blobs";
const OPEN = "file:///cache-dir/hbots-blobs-open";
const payload = { uri: "file:///cache/photo.jpg", size: 3, mimeType: "image/jpeg", name: "photo" };

function filesUnder(directory: string): string[] {
  return [...fs.files.keys()].filter((key) => key.startsWith(`${directory}/`));
}

beforeEach(() => {
  fs.dirs.clear();
  fs.files.clear();
  fs.files.set(payload.uri, "abc");
  fs.keyDeletes = 0;
  fs.notifyWipes = 0;
  fs.launcherWipes = 0;
  createNativeEnvironmentCache();
});

describe("wipe on sign-out and revoke", () => {
  it("leaves no chat file and no attachment behind", async () => {
    writeCachedThread("environment-phone", snapshot);
    await createFileBlobStore().put("entry/photo", payload);
    expect(filesUnder(CACHE)).toHaveLength(1);
    expect(filesUnder(BLOBS)).toHaveLength(1);

    wipeLocalData();

    expect(filesUnder(CACHE)).toEqual([]);
    expect(filesUnder(BLOBS)).toEqual([]);
    expect(fs.dirs.has(CACHE)).toBe(false);
    expect(fs.dirs.has(BLOBS)).toBe(false);
  });

  it("deletes the encryption key", () => {
    wipeLocalData();

    expect(fs.keyDeletes).toBe(1);
  });

  it("clears shown notifications, channels and the push policy", () => {
    wipeLocalData();

    expect(fs.notifyWipes).toBe(1);
  });

  it("clears the launcher shortcuts and the widget feed", () => {
    wipeLocalData();

    expect(fs.launcherWipes).toBe(1);
  });

  it("removes the plain copy made for an upload as well", async () => {
    const blobs = createFileBlobStore();
    await blobs.put("entry/photo", payload);
    const opened = await blobs.get("entry/photo");
    expect(opened?.uri).toBe(`${OPEN}/entry_photo`);
    expect(filesUnder(OPEN)).toHaveLength(1);

    wipeLocalData();

    expect(filesUnder(OPEN)).toEqual([]);
    expect(fs.dirs.has(OPEN)).toBe(false);
  });

  it("is safe when nothing was ever stored", () => {
    expect(() => wipeLocalData()).not.toThrow();
  });

  it("keeps a save that was already running from writing after the wipe", async () => {
    const blobs = createFileBlobStore();
    wipeLocalData();

    writeCachedThread("environment-phone", snapshot);
    await expect(blobs.put("entry/photo", payload)).rejects.toThrow();

    expect(filesUnder(CACHE)).toEqual([]);
    expect(filesUnder(BLOBS)).toEqual([]);
    expect(fs.dirs.has(CACHE)).toBe(false);
    expect(fs.dirs.has(BLOBS)).toBe(false);
  });

  it("reads nothing after the wipe, and caches again for the next session", async () => {
    writeCachedThread("environment-phone", snapshot);
    wipeLocalData();
    expect((await readCachedThread("environment-phone", THREAD_ID))._tag).toBe("None");

    createNativeEnvironmentCache();
    writeCachedThread("environment-phone", snapshot);
    expect(filesUnder(CACHE)).toHaveLength(1);
  });
});
