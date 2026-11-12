import { OrchestrationV2ThreadDetailSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fs = vi.hoisted(() => ({
  dirs: new Set<string>(),
  files: new Map<string, string>(),
  keyDeletes: 0,
  notifyWipes: 0,
  secure: new Map<string, string>(),
  nativeMissing: false,
  purgeCalls: 0,
  voiceWipes: 0,
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
  /** Like the native one: every file under the folders that is not in the v1 format goes. */
  purgeLegacyPlaintext: (directories: readonly string[]) => {
    fs.purgeCalls += 1;
    if (fs.nativeMissing) return false;
    const doomed = Array.from(fs.files.keys()).filter(
      (key) =>
        directories.some((directory) => key.startsWith(`${directory}/`)) &&
        !(fs.files.get(key) ?? "").startsWith("v1:"),
    );
    for (const key of doomed) fs.files.delete(key);
    return true;
  },
}));

vi.mock("../notifications/nativeNotify", () => ({
  wipeNativeNotifications: () => {
    fs.notifyWipes += 1;
  },
}));

vi.mock("../voice/voiceWipe", () => ({
  wipeVoiceCalls: () => {
    fs.voiceWipes += 1;
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
vi.mock("expo-secure-store", () => ({
  getItem: (key: string) => fs.secure.get(key) ?? null,
  setItem: (key: string, value: string) => {
    fs.secure.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    fs.secure.delete(key);
  },
}));
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
      const nested = Array.from(fs.dirs).filter((key) => key.startsWith(`${this.uri}/`));
      for (const key of nested) fs.dirs.delete(key);
      for (const key of fs.files.keys()) {
        if (key.startsWith(`${this.uri}/`)) fs.files.delete(key);
      }
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    /** Direct children only, as the real API does: a folder for a name with files below it. */
    list() {
      const prefix = `${this.uri}/`;
      const children = new Map<string, "file" | "directory">();
      for (const key of [...fs.files.keys(), ...fs.dirs]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          children.set(rest, fs.dirs.has(key) ? "directory" : "file");
        } else {
          children.set(rest.slice(0, slash), "directory");
        }
      }
      return [...children].map(([name, kind]) =>
        kind === "directory" ? new Directory(this.uri, name) : new File(this.uri, name),
      );
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
import {
  configureOutbox,
  enqueueOutboxEntry,
  getOutboxSnapshot,
  OUTBOX_STORAGE_KEY,
} from "@hbots/personal-client/composer/outbox";
import { OUTGOING_INDEX_KEY, outgoingStorageKey } from "../chat/composerSendModel";
import {
  createFileBlobStore,
  createSecureKeyValueStore,
  purgeLegacyCache,
  secureStoreKey,
  wipeLocalData,
} from "./nativePorts";

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
  fs.secure.clear();
  fs.nativeMissing = false;
  fs.purgeCalls = 0;
  fs.dirs.add("file:///cache-dir");
  fs.dirs.add("file:///documents");
  fs.voiceWipes = 0;
  fs.launcherWipes = 0;
  createNativeEnvironmentCache();
});

describe("wipe on sign-out and revoke", () => {
  it("leaves no chat file and no attachment behind", async () => {
    writeCachedThread("environment-phone", snapshot);
    await createFileBlobStore().put("entry/photo", payload);
    expect(filesUnder(CACHE)).toHaveLength(1);
    expect(filesUnder(BLOBS)).toHaveLength(1);

    await wipeLocalData();

    expect(filesUnder(CACHE)).toEqual([]);
    expect(filesUnder(BLOBS)).toEqual([]);
    expect(fs.dirs.has(CACHE)).toBe(false);
    expect(fs.dirs.has(BLOBS)).toBe(false);
  });

  it("deletes the encryption key", async () => {
    await wipeLocalData();

    expect(fs.keyDeletes).toBe(1);
  });

  it("clears shown notifications, channels and the push policy", async () => {
    await wipeLocalData();

    expect(fs.notifyWipes).toBe(1);
  });

  it("ends a running call and drops its state", () => {
    wipeLocalData();

    expect(fs.voiceWipes).toBe(1);
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

    await wipeLocalData();

    expect(filesUnder(OPEN)).toEqual([]);
    expect(fs.dirs.has(OPEN)).toBe(false);
  });

  it("is safe when nothing was ever stored", async () => {
    await expect(wipeLocalData()).resolves.toBeUndefined();
  });

  it("keeps a save that was already running from writing after the wipe", async () => {
    const blobs = createFileBlobStore();
    await wipeLocalData();

    writeCachedThread("environment-phone", snapshot);
    await expect(blobs.put("entry/photo", payload)).rejects.toThrow();

    expect(filesUnder(CACHE)).toEqual([]);
    expect(filesUnder(BLOBS)).toEqual([]);
    expect(fs.dirs.has(CACHE)).toBe(false);
    expect(fs.dirs.has(BLOBS)).toBe(false);
  });

  it("reads nothing after the wipe, and caches again for the next session", async () => {
    writeCachedThread("environment-phone", snapshot);
    await wipeLocalData();
    expect((await readCachedThread("environment-phone", THREAD_ID))._tag).toBe("None");

    createNativeEnvironmentCache();
    writeCachedThread("environment-phone", snapshot);
    expect(filesUnder(CACHE)).toHaveLength(1);
  });

  it("clears the whole app cache folder, including HTTP, image and share intake files", async () => {
    const stray = [
      "file:///cache-dir/http-cache/journal",
      "file:///cache-dir/http-cache/abc.1",
      "file:///cache-dir/image_cache/v2/10/pic.cnt",
      "file:///cache-dir/share-intake/share-1/text.txt",
      "file:///cache-dir/something-a-library-adds-later/blob",
      "file:///cache-dir/loose-file.tmp",
    ];
    for (const path of stray) fs.files.set(path, "secret words");
    fs.files.set("file:///cache-dir/updates/bundle.js", "bundle");

    await wipeLocalData();

    expect(filesUnder("file:///cache-dir").filter((path) => !path.includes("/updates/"))).toEqual(
      [],
    );
    // The update bundle is not session data.
    expect(fs.files.has("file:///cache-dir/updates/bundle.js")).toBe(true);
  });

  it("leaves nothing under the cache root, blobs, thread cache, intake and the queue", async () => {
    writeCachedThread("environment-phone", snapshot);
    await createFileBlobStore().put("entry/photo", payload);
    fs.files.set("file:///cache-dir/share-intake/share-2/note.txt", "shared text");
    configureOutbox({
      store: createSecureKeyValueStore(),
      ids: { randomUUID: () => "id" },
    });
    enqueueOutboxEntry({
      id: "m1",
      kind: "turn",
      environmentId: "environment-phone",
      threadId: "t1",
      groupId: null,
      text: "private words",
      sendText: "private words",
      createdAt: "2026-10-08T12:00:00.000Z",
      replyTo: null,
      turn: {} as never,
      attachments: [],
    });
    expect(fs.secure.has(secureStoreKey(OUTBOX_STORAGE_KEY))).toBe(true);

    await wipeLocalData();

    expect(filesUnder("file:///cache-dir")).toEqual([]);
    expect(filesUnder("file:///documents")).toEqual([]);
    expect(fs.secure.has(secureStoreKey(OUTBOX_STORAGE_KEY))).toBe(false);
    expect(getOutboxSnapshot().entries).toEqual([]);
    expect(fs.keyDeletes).toBe(1);
  });

  it("does not leave queued messages for the next pairing, even without a configured queue", async () => {
    fs.secure.set(secureStoreKey(OUTBOX_STORAGE_KEY), '[{"id":"x"}]');

    await wipeLocalData();

    expect(fs.secure.has(secureStoreKey(OUTBOX_STORAGE_KEY))).toBe(false);
  });

  it("removes an unsent message's saved text and its index on sign-out", async () => {
    const key = outgoingStorageKey("environment-phone", "thread-1");
    fs.secure.set(secureStoreKey(key), '[{"id":"message-1","text":"private words"}]');
    fs.secure.set(secureStoreKey(OUTGOING_INDEX_KEY), JSON.stringify([key]));

    await wipeLocalData();

    expect(fs.secure.has(secureStoreKey(key))).toBe(false);
    expect(fs.secure.has(secureStoreKey(OUTGOING_INDEX_KEY))).toBe(false);
  });
});

describe("the first start after the cache became encrypted", () => {
  const OLD_THREAD = `${CACHE}/thread-old.json`;
  const OLD_BLOB = `${BLOBS}/old-photo`;
  const OLD_HTTP = "file:///cache-dir/http-cache/journal";

  function legacyFiles() {
    fs.files.set(OLD_THREAD, '{"plain":"chat"}');
    fs.files.set(OLD_BLOB, "plain attachment");
    fs.files.set(OLD_HTTP, "cached api response");
    fs.dirs.add(CACHE);
    fs.dirs.add(BLOBS);
    fs.dirs.add("file:///cache-dir/http-cache");
  }

  it("deletes every plaintext cache file and keeps the encrypted ones", () => {
    legacyFiles();
    writeCachedThread("environment-phone", snapshot);

    purgeLegacyCache();

    expect(fs.files.has(OLD_THREAD)).toBe(false);
    expect(fs.files.has(OLD_BLOB)).toBe(false);
    expect(fs.files.has(OLD_HTTP)).toBe(false);
    expect(filesUnder(CACHE)).toHaveLength(1);
  });

  it("scans once, then leaves the cache alone on later starts", () => {
    legacyFiles();
    purgeLegacyCache();
    purgeLegacyCache();

    expect(fs.purgeCalls).toBe(1);
  });

  it("tries again next start when the Keystore helper was missing", () => {
    legacyFiles();
    fs.nativeMissing = true;
    purgeLegacyCache();
    expect(fs.files.has(OLD_THREAD)).toBe(true);

    fs.nativeMissing = false;
    purgeLegacyCache();
    expect(fs.files.has(OLD_THREAD)).toBe(false);
  });
});
