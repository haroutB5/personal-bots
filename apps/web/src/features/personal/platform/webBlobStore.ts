import type { BlobStore } from "@hbots/personal-client/ports/blobStore";

/** Bytes of queued photos and files: IndexedDB, because localStorage is small and text-only. */
const DATABASE_NAME = "t3code:personal-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "blobs";

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This device has no IndexedDB."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("The send queue is blocked.")));
  }).catch((error: unknown) => {
    // A failed open is not cached: the next call tries again.
    database = undefined;
    throw error;
  }));
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function requestResult<A>(request: IDBRequest<A>): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

const indexedDbBackend: BlobStore<Blob> = {
  async put(key, blob) {
    const transaction = (await openDatabase()).transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(blob, key);
    await finished(transaction);
  },
  async get(key) {
    const transaction = (await openDatabase()).transaction(STORE_NAME, "readonly");
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(key));
    return value instanceof Blob ? value : null;
  },
  async deletePrefix(prefix) {
    const transaction = (await openDatabase()).transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    await finished(transaction);
  },
  async keys() {
    if (typeof indexedDB === "undefined") return [];
    const transaction = (await openDatabase()).transaction(STORE_NAME, "readonly");
    const keys = await requestResult(transaction.objectStore(STORE_NAME).getAllKeys());
    return keys.filter((key): key is string => typeof key === "string");
  },
  sizeOf: (blob) => blob.size,
};

export const webBlobStore: BlobStore<Blob> = indexedDbBackend;
