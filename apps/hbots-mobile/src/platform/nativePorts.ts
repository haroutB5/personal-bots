import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { Alert, AppState, InteractionManager } from "react-native";

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

export function createFileBlobStore(): BlobStore<NativeBlob> {
  const root = new Directory(Paths.document, BLOB_DIRECTORY);
  const ensureRoot = () => {
    if (!root.exists) {
      root.create({ intermediates: true });
    }
    return root;
  };
  const fileFor = (key: string) => new File(ensureRoot(), key.replaceAll("/", "_"));
  return {
    put: async (key, payload) => {
      const target = fileFor(key);
      if (target.exists) target.delete();
      new File(payload.uri).copy(target);
    },
    get: async (key) => {
      const file = fileFor(key);
      if (!file.exists) return null;
      return {
        uri: file.uri,
        size: file.size ?? 0,
        mimeType: "application/octet-stream",
        name: key.replaceAll("/", "_"),
      };
    },
    deletePrefix: async (prefix) => {
      for (const entry of ensureRoot().list()) {
        if (entry instanceof File && entry.name.startsWith(prefix.replaceAll("/", "_"))) {
          entry.delete();
        }
      }
    },
    keys: async () =>
      ensureRoot()
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
