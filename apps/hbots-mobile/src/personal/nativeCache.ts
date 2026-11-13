import {
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot as ThreadSnapshot,
  type ServerConfig,
  type ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { ConnectionPersistenceError, Persistence } from "@t3tools/client-runtime/platform";
import { Directory, File, Paths } from "expo-file-system";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { readDecryptedText, writeEncryptedText } from "../platform/secureStorage";
import { noteCacheRead, noteCacheWrite } from "./chatOpenPerf";
import { decodeThreadSnapshotJson } from "./threadSnapshotJson";

export const CACHE_DIRECTORY = "hbots-thread-cache";

/**
 * The largest chat copy kept on the phone, in UTF-8 bytes: twice the server's page limit
 * (`maxEncodedBytes`), because control state rides on top of the window and a cap equal to
 * the limit left out exactly the largest chats. A bigger copy is not saved: that chat opens
 * from the server instead. The Kotlin `MAX_CACHED_TEXT_BYTES` refuses to read anything larger.
 */
export const MAX_CACHED_THREAD_BYTES = 2_097_152;

/** The UTF-8 length of `text`, or any number over `limit` once it passes it: counting stops there. */
function utf8Bytes(text: string, limit: number): number {
  if (text.length > limit) return text.length;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** Set by a wipe: a save that was already running cannot recreate the folder after it. */
let sealed = false;

function removeCacheRoot(): void {
  const root = new Directory(Paths.document, CACHE_DIRECTORY);
  if (root.exists) root.delete();
}

/** Deletes every cached chat, the wrapped data key and the folder itself. Nothing is written again until a new session starts. */
export function wipeThreadCache(): void {
  sealed = true;
  removeCacheRoot();
}

function cacheRoot(): Directory {
  const root = new Directory(Paths.document, CACHE_DIRECTORY);
  if (!root.exists) root.create({ intermediates: true });
  return root;
}

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function threadFile(environmentId: string, threadId: string): File {
  return new File(cacheRoot(), `thread-${safeKey(environmentId)}-${safeKey(threadId)}.json`);
}

function persistenceError(
  operation: ConnectionPersistenceError["operation"],
  cause: unknown,
): ConnectionPersistenceError {
  return new ConnectionPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

/**
 * The last cached detail of a thread, or none. A file that cannot be read back
 * (an old plaintext file, a lost key, damage) is deleted and counts as a miss,
 * so the thread is fetched again instead of failing.
 */
export async function readCachedThread(
  environmentId: string,
  threadId: string,
): Promise<Option.Option<ThreadSnapshot>> {
  if (sealed) return Option.none();
  const startedAt = performance.now();
  const file = threadFile(environmentId, threadId);
  const exists = file.exists;
  const bytes = exists ? (file.size ?? 0) : 0;
  const finish = (snapshot: Option.Option<ThreadSnapshot>, decodedFrom: number) => {
    const at = performance.now();
    console.info(
      noteCacheRead(threadId, {
        at,
        ms: at - startedAt,
        decodeMs: at - decodedFrom,
        bytes,
        hit: Option.isSome(snapshot),
      }),
    );
    return snapshot;
  };
  if (!exists) return finish(Option.none(), startedAt);
  const text = await readDecryptedText(file.uri);
  const decodedFrom = performance.now();
  if (text !== null) {
    try {
      return finish(
        Option.some(decodeThreadSnapshotJson(JSON.parse(text) as unknown)),
        decodedFrom,
      );
    } catch {
      // Falls through: decrypted but not a snapshot, so it is dropped like any unreadable file.
    }
  }
  if (file.exists) file.delete();
  return finish(Option.none(), decodedFrom);
}

/**
 * Writes the snapshot encrypted unless it is over the cap. The encryption and the file write
 * run off the JS thread. Rejects when the Keystore helper is missing: nothing is cached in the clear.
 */
export async function writeCachedThread(
  environmentId: string,
  snapshot: ThreadSnapshot,
): Promise<void> {
  if (sealed) return;
  const file = threadFile(environmentId, snapshot.projection.thread.id);
  const startedAt = performance.now();
  const text = JSON.stringify(snapshot);
  const bytes = utf8Bytes(text, MAX_CACHED_THREAD_BYTES);
  if (bytes > MAX_CACHED_THREAD_BYTES) {
    // Too big to read back safely: drop the older copy too, so no stale one is shown later.
    if (file.exists) file.delete();
    return;
  }
  const handedOffAt = performance.now();
  await writeEncryptedText(file.uri, text);
  // A sign-out that ran while the native side was writing already deleted the folder.
  if (sealed) {
    removeCacheRoot();
    return;
  }
  console.info(
    noteCacheWrite({ ms: performance.now() - startedAt, jsMs: handedOffAt - startedAt, bytes }),
  );
}

/**
 * A thread's last settled detail, kept as one file. A chat opened again in a
 * new run paints from here before the socket catches up, which is what keeps a
 * cached open under the 150 ms budget.
 */
export function createNativeEnvironmentCache(
  onThreadRemoved?: (environmentId: string, threadId: string) => void,
): Persistence.EnvironmentCacheStore["Service"] {
  sealed = false;
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none<OrchestrationV2ShellSnapshot>()),
    saveShell: () => Effect.void,
    loadThread: (environmentId, threadId: ThreadId) =>
      Effect.tryPromise({
        try: () => readCachedThread(environmentId, threadId),
        catch: (cause) => persistenceError("load-thread", cause),
      }),
    saveThread: (environmentId, snapshot) =>
      Effect.tryPromise({
        try: () => writeCachedThread(environmentId, snapshot),
        catch: (cause) => persistenceError("save-thread", cause),
      }),
    removeThread: (environmentId, threadId) =>
      Effect.try({
        try: () => {
          const file = threadFile(environmentId, threadId);
          if (file.exists) file.delete();
          onThreadRemoved?.(environmentId, threadId);
        },
        catch: (cause) => persistenceError("remove-thread", cause),
      }),
    loadServerConfig: () => Effect.succeed(Option.none<ServerConfig>()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none<VcsListRefsResult>()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () =>
      Effect.try({
        try: () => {
          for (const entry of cacheRoot().list()) {
            if (entry instanceof File) entry.delete();
          }
        },
        catch: (cause) => persistenceError("clear-environment", cause),
      }),
  });
}
