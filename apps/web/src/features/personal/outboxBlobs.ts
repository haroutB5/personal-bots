/**
 * Bytes of the photos and files in queued messages (IndexedDB; localStorage is
 * too small and text-only). A queued message is only added to the queue after
 * its bytes are stored, so an entry never exists without them.
 */

const DATABASE_NAME = "t3code:personal-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "blobs";

/** Per message: bigger than this cannot wait offline, and the composer says so. */
export const OUTBOX_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface OutboxBlobBackend {
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  /** Deletes every key that starts with the prefix. */
  deletePrefix(prefix: string): Promise<void>;
  keys(): Promise<ReadonlyArray<string>>;
}

export function blobKey(entryId: string, attachmentId: string): string {
  return `${entryId}/${attachmentId}`;
}

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

const indexedDbBackend: OutboxBlobBackend = {
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
    const transaction = (await openDatabase()).transaction(STORE_NAME, "readonly");
    const keys = await requestResult(transaction.objectStore(STORE_NAME).getAllKeys());
    return keys.filter((key): key is string => typeof key === "string");
  },
};

let backend: OutboxBlobBackend = indexedDbBackend;

/** Tests only: an in-memory backend (or the real one again with no argument). */
export function setOutboxBlobBackendForTesting(next?: OutboxBlobBackend): void {
  backend = next ?? indexedDbBackend;
}

/** Stores every file of a message. Rejects when any one could not be kept. */
export async function putOutboxBlobs(
  entryId: string,
  files: ReadonlyArray<{ readonly id: string; readonly blob: Blob }>,
): Promise<void> {
  try {
    for (const file of files) await backend.put(blobKey(entryId, file.id), file.blob);
  } catch (error) {
    await backend.deletePrefix(`${entryId}/`).catch(() => undefined);
    throw error;
  }
}

export function getOutboxBlob(entryId: string, attachmentId: string): Promise<Blob | null> {
  return backend.get(blobKey(entryId, attachmentId)).catch(() => null);
}

/** Waits between tries to delete a cancelled message's bytes; after the last one the next launch's sweep does it. */
export const OUTBOX_BLOB_DELETE_RETRY_MS: ReadonlyArray<number> = [1_000, 5_000, 30_000, 120_000];

/** Entries whose bytes are still on the device after a refused delete. */
const undeletedBlobs = new Set<string>();

/**
 * Deletes the bytes of a message that left the queue (sent or cancelled). A
 * refused delete is not dropped: it is retried a few times (a busy or full
 * database usually frees up), and whatever is still there when this page ends
 * is removed by the sweep the next launch runs against the queue. Resolves
 * true once the bytes are gone, false when this page gave up.
 */
export async function deleteOutboxBlobs(entryId: string, attempt = 0): Promise<boolean> {
  try {
    await backend.deletePrefix(`${entryId}/`);
    undeletedBlobs.delete(entryId);
    return true;
  } catch (error) {
    undeletedBlobs.add(entryId);
    const delay = OUTBOX_BLOB_DELETE_RETRY_MS[attempt];
    if (delay === undefined) {
      console.warn(
        "Could not delete a sent or cancelled message's attachments from this device; the next launch removes them.",
        error,
      );
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return deleteOutboxBlobs(entryId, attempt + 1);
  }
}

/** Bytes whose delete was refused and not yet retried successfully (tests, diagnostics). */
export function undeletedOutboxBlobCount(): number {
  return undeletedBlobs.size;
}

/**
 * Drops bytes whose message is no longer queued (a crash between the two
 * writes, or a delete that was refused). One refused delete does not stop the
 * others. Resolves false when anything could not be read or deleted, so the
 * caller sweeps again later.
 */
export async function sweepOutboxBlobs(liveEntryIds: ReadonlySet<string>): Promise<boolean> {
  let keys: ReadonlyArray<string>;
  try {
    keys = await backend.keys();
  } catch {
    // A device without IndexedDB has nothing to sweep.
    return typeof indexedDB === "undefined";
  }
  const stale = new Set<string>();
  for (const key of keys) {
    const entryId = key.split("/")[0] ?? "";
    if (!liveEntryIds.has(entryId)) stale.add(entryId);
  }
  let complete = true;
  for (const entryId of stale) {
    try {
      await backend.deletePrefix(`${entryId}/`);
      undeletedBlobs.delete(entryId);
    } catch {
      complete = false;
    }
  }
  return complete;
}
