// @effect-diagnostics globalConsole:off globalTimers:off -- Blob deletion retries warn and wait at the store boundary.
/**
 * Bytes of the photos and files in queued messages. The app supplies the blob
 * store: IndexedDB on the web, a file store on a phone. A queued message is
 * only added to the queue after its bytes are stored, so an entry never exists
 * without them.
 */
import type { BlobStore } from "../ports/blobStore.ts";

/** Per message: bigger than this cannot wait offline, and the composer says so. */
export const OUTBOX_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The subset of {@link BlobStore} the queue uses; the package picks the payload type. */
export type OutboxBlobBackend<P = Blob> = Pick<
  BlobStore<P>,
  "put" | "get" | "deletePrefix" | "keys"
>;

export function blobKey(entryId: string, attachmentId: string): string {
  return `${entryId}/${attachmentId}`;
}

let configuredBackend: OutboxBlobBackend<unknown> | null = null;
let backendOverride: OutboxBlobBackend<unknown> | null | undefined;

function backend(): OutboxBlobBackend<unknown> | null {
  return backendOverride === undefined ? configuredBackend : backendOverride;
}

/** Connects the queue to the app's blob store. The web calls this once at boot. */
export function configureOutboxBlobs<P>(store: OutboxBlobBackend<P>): void {
  configuredBackend = store as OutboxBlobBackend<unknown>;
}

/** Tests only: an in-memory backend, or the configured one again with no argument. */
export function setOutboxBlobBackendForTesting<P = Blob>(next?: OutboxBlobBackend<P>): void {
  backendOverride = next === undefined ? undefined : (next as OutboxBlobBackend<unknown>);
}

/** Stores every file of a message. Rejects when any one could not be kept. */
export async function putOutboxBlobs<P>(
  entryId: string,
  files: ReadonlyArray<{ readonly id: string; readonly blob: P }>,
): Promise<void> {
  try {
    const store = backend();
    if (store === null) throw new Error("No outbox blob store is configured.");
    for (const file of files) await store.put(blobKey(entryId, file.id), file.blob);
  } catch (error) {
    const store = backend();
    await store?.deletePrefix(`${entryId}/`).catch(() => undefined);
    throw error;
  }
}

export function getOutboxBlob<P = Blob>(entryId: string, attachmentId: string): Promise<P | null> {
  const store = backend();
  if (store === null) return Promise.resolve(null);
  return store.get(blobKey(entryId, attachmentId)).catch(() => null) as Promise<P | null>;
}

/** Waits between tries to delete a cancelled message's bytes; after the last one the next launch's sweep does it. */
export const OUTBOX_BLOB_DELETE_RETRY_MS: ReadonlyArray<number> = [1_000, 5_000, 30_000, 120_000];

/** Entries whose bytes are still on the device after a refused delete. */
const undeletedBlobs = new Set<string>();

/**
 * Deletes the bytes of a message that left the queue (sent or cancelled). A
 * refused delete is not dropped: it is retried a few times (a busy or full
 * database usually frees up), and whatever is still there when this page ends
 */
export async function deleteOutboxBlobs(entryId: string, attempt = 0): Promise<boolean> {
  const store = backend();
  if (store === null) return true;
  try {
    await store.deletePrefix(`${entryId}/`);
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
  const store = backend();
  if (store === null) return true;
  let keys: ReadonlyArray<string>;
  try {
    keys = await store.keys();
  } catch {
    return false;
  }
  const stale = new Set<string>();
  for (const key of keys) {
    const entryId = key.split("/")[0] ?? "";
    if (!liveEntryIds.has(entryId)) stale.add(entryId);
  }
  let complete = true;
  for (const entryId of stale) {
    try {
      await store.deletePrefix(`${entryId}/`);
      undeletedBlobs.delete(entryId);
    } catch {
      complete = false;
    }
  }
  return complete;
}
