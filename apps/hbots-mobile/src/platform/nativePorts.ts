import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { Alert, AppState, InteractionManager } from "react-native";

import { wipeNativeNotifications } from "../notifications/nativeNotify";
import { wipeThreadCache } from "../personal/nativeCache";
import { decryptFile, deleteCacheKey, encryptFile } from "./secureStorage";
import {
  discardOutbox,
  OUTBOX_REMOVED_STORAGE_KEY,
  OUTBOX_STORAGE_KEY,
} from "@hbots/personal-client/composer/outbox";
import type { BlobStore } from "@hbots/personal-client/ports/blobStore";
import type { Clock } from "@hbots/personal-client/ports/clock";
import type { Confirm, ConfirmRequest } from "@hbots/personal-client/ports/confirm";
import type { Ids } from "@hbots/personal-client/ports/ids";
import type { KeyValueStore } from "@hbots/personal-client/ports/keyValueStore";
import type { Lifecycle, LifecycleState } from "@hbots/personal-client/ports/lifecycle";
import type { PersonalPorts } from "@hbots/personal-client/ports/personalPorts";

/**
 * Expo SecureStore only accepts `[A-Za-z0-9._-]` in a key, while the package
 * uses readable keys such as `t3code:chats-snapshot:v3`. Every other byte
 * becomes `_xx`, and `_` itself becomes `__`, so the mapping cannot collide.
 */
export function secureStoreKey(key: string): string {
  return `kv.${key.replace(/[^A-Za-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replaceAll("_", "__")}`;
}

export function createSecureKeyValueStore(): KeyValueStore {
  const cache = new Map<string, string | null>();
  const read = (key: string): string | null => {
    const encoded = secureStoreKey(key);
    if (cache.has(encoded)) {
      return cache.get(encoded) ?? null;
    }
    try {
      const value = SecureStore.getItem(encoded);
      cache.set(encoded, value);
      return value;
    } catch {
      return null;
    }
  };
  return {
    getItem: read,
    setItem: (key, value) => {
      const encoded = secureStoreKey(key);
      cache.set(encoded, value);
      try {
        SecureStore.setItem(encoded, value);
      } catch {
        // The in-memory copy still serves this run; the next launch retries.
      }
    },
    removeItem: (key) => {
      const encoded = secureStoreKey(key);
      cache.set(encoded, null);
      void SecureStore.deleteItemAsync(encoded).catch(() => undefined);
    },
    subscribe: () => () => undefined,
  };
}

export interface NativeBlob {
  readonly uri: string;
  readonly size: number;
  readonly mimeType: string;
  readonly name: string;
}

const BLOB_DIRECTORY = "hbots-blobs";
/** Plain copies made for one upload. They live in the cache folder and go as soon as the message leaves the queue. */
const OPEN_DIRECTORY = "hbots-blobs-open";

/** Set by a wipe: a copy that was already running cannot recreate the folder after it. */
let blobsSealed = false;

/** Deletes every stored attachment and the folder itself, until a new session starts. */
export function wipeBlobDirectory(): void {
  blobsSealed = true;
  for (const root of [
    new Directory(Paths.document, BLOB_DIRECTORY),
    new Directory(Paths.cache, OPEN_DIRECTORY),
  ]) {
    if (root.exists) root.delete();
  }
}

/**
 * Entries of the app cache folder that are not session data. expo-updates
 * keeps its downloaded bundle there; everything else is ours or a library's
 * (the HTTP cache, the image cache, share intake, upload copies).
 */
const KEPT_CACHE_ENTRIES: ReadonlySet<string> = new Set(["updates"]);

/**
 * Deletes everything in the app cache folder, not a list of names: a library
 * that starts caching tomorrow must not outlive a sign-out. Includes the share
 * intake folder, which holds the text and files someone shared into the app.
 */
export function wipeCacheRoot(): void {
  const root = new Directory(Paths.cache);
  if (!root.exists) return;
  for (const entry of root.list()) {
    if (KEPT_CACHE_ENTRIES.has(entry.name)) continue;
    try {
      entry.delete();
    } catch (cause) {
      console.warn("Could not remove a cache entry on sign-out.", cause);
    }
  }
}

/**
 * Forgets every queued message. The in-memory queue goes first so a send that
 * is about to start finds nothing, then the stored copies are deleted and the
 * deletes are awaited: a sign-out that returns has really removed them.
 */
async function wipeOutbox(): Promise<void> {
  discardOutbox();
  await Promise.all(
    [OUTBOX_STORAGE_KEY, OUTBOX_REMOVED_STORAGE_KEY].map((key) =>
      SecureStore.deleteItemAsync(secureStoreKey(key)),
    ),
  );
}

/**
 * Everything this phone kept for a signed-in session: cached chats, queued
 * messages and attachments, the app cache folder (HTTP, image, share intake)
 * and the key. Resolves once the asynchronous deletes finished.
 */
export async function wipeLocalData(): Promise<void> {
  // Everything synchronous happens before the first await, so a caller that
  // does not wait still gets the folders, the key and the queue in memory gone.
  const stored = wipeOutbox().catch((cause: unknown) => {
    console.warn("Could not remove the queued messages on sign-out.", cause);
  });
  for (const wipe of [
    wipeThreadCache,
    wipeBlobDirectory,
    wipeCacheRoot,
    deleteCacheKey,
    wipeNativeNotifications,
  ]) {
    try {
      wipe();
    } catch (cause) {
      console.warn("Could not remove local data on sign-out.", cause);
    }
  }
  await stored;
}

export function createFileBlobStore(): BlobStore<NativeBlob> {
  blobsSealed = false;
  const root = new Directory(Paths.document, BLOB_DIRECTORY);
  const open = new Directory(Paths.cache, OPEN_DIRECTORY);
  // Plain copies from a run that ended mid-upload do not outlive that run.
  if (open.exists) open.delete();
  const ensure = (directory: Directory) => {
    if (!directory.exists) {
      directory.create({ intermediates: true });
    }
    return directory;
  };
  const nameOf = (key: string) => key.replaceAll("/", "_");
  const fileFor = (key: string) => new File(ensure(root), nameOf(key));
  const removeMatching = (directory: Directory, prefix: string) => {
    if (!directory.exists) return;
    for (const entry of directory.list()) {
      if (entry instanceof File && entry.name.startsWith(prefix)) {
        entry.delete();
      }
    }
  };
  return {
    put: async (key, payload) => {
      if (blobsSealed) throw new Error("Local data was removed on sign-out.");
      const target = fileFor(key);
      if (target.exists) target.delete();
      if (!(await encryptFile(payload.uri, target.uri))) {
        throw new Error("The attachment could not be stored.");
      }
    },
    get: async (key) => {
      if (blobsSealed) return null;
      const stored = fileFor(key);
      if (!stored.exists) return null;
      const plain = new File(ensure(open), nameOf(key));
      if (plain.exists) plain.delete();
      if (!(await decryptFile(stored.uri, plain.uri))) return null;
      return {
        uri: plain.uri,
        size: plain.size ?? 0,
        mimeType: "application/octet-stream",
        name: nameOf(key),
      };
    },
    deletePrefix: async (prefix) => {
      if (blobsSealed) return;
      removeMatching(ensure(root), nameOf(prefix));
      removeMatching(open, nameOf(prefix));
    },
    keys: async () =>
      blobsSealed
        ? []
        : ensure(root)
            .list()
            .filter((entry): entry is File => entry instanceof File)
            .map((file) => file.name),
    sizeOf: (payload) => payload.size,
  };
}

export function createNativeClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (work, delayMs) => {
      const timer = setTimeout(work, delayMs);
      return () => clearTimeout(timer);
    },
    whenIdle: (work, fallbackMs) => {
      const fallback = setTimeout(work, fallbackMs);
      let interaction: { cancel: () => void } | null = null;
      const run = () => {
        clearTimeout(fallback);
        work();
      };
      interaction = InteractionManager.runAfterInteractions(run);
      return () => {
        clearTimeout(fallback);
        interaction?.cancel();
      };
    },
    nextFrame: (work) => {
      const frame = requestAnimationFrame(work);
      return () => cancelAnimationFrame(frame);
    },
  };
}

export function createNativeLifecycle(): Lifecycle {
  const current = (): LifecycleState =>
    AppState.currentState === "active" ? "foreground" : "background";
  return {
    current,
    subscribe: (listener) => {
      const subscription = AppState.addEventListener("change", (state) => {
        listener(state === "active" ? "foreground" : "background");
      });
      return () => subscription.remove();
    },
  };
}

export function createNativeConfirm(): Confirm {
  return {
    confirm: (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        Alert.alert(
          request.title,
          request.body,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: request.confirmLabel ?? "OK",
              style: request.destructive ? "destructive" : "default",
              onPress: () => resolve(true),
            },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      }),
  };
}

export function createNativeIds(): Ids {
  return { randomUUID: () => Crypto.randomUUID() };
}

export function createNativePorts(): PersonalPorts<NativeBlob> {
  return {
    kv: createSecureKeyValueStore(),
    blobs: createFileBlobStore(),
    clock: createNativeClock(),
    lifecycle: createNativeLifecycle(),
    confirm: createNativeConfirm(),
    ids: createNativeIds(),
  };
}
