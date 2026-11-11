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
import { decodeThreadSnapshotJson } from "./threadSnapshotJson";

const CACHE_DIRECTORY = "hbots-thread-cache";

/** Set by a wipe: a save that was already running cannot recreate the folder after it. */
let sealed = false;

/** Deletes every cached chat and the folder itself. Nothing is written again until a new session starts. */
export function wipeThreadCache(): void {
  sealed = true;
  const root = new Directory(Paths.document, CACHE_DIRECTORY);
  if (root.exists) root.delete();
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
  const file = threadFile(environmentId, threadId);
  if (!file.exists) return Option.none();
  const text = await readDecryptedText(file.uri);
  if (text !== null) {
    try {
      return Option.some(decodeThreadSnapshotJson(JSON.parse(text) as unknown));
    } catch {
      // Falls through: decrypted but not a snapshot, so it is dropped like any unreadable file.
    }
  }
  if (file.exists) file.delete();
  return Option.none();
}

/** Writes the snapshot encrypted. Throws when the Keystore helper is missing: nothing is cached in the clear. */
export function writeCachedThread(environmentId: string, snapshot: ThreadSnapshot): void {
  if (sealed) return;
  const file = threadFile(environmentId, snapshot.projection.thread.id);
  writeEncryptedText(file.uri, JSON.stringify(snapshot));
}

/**
 * A thread's last settled detail, kept as one file. A chat opened again in a
 * new run paints from here before the socket catches up, which is what keeps a
 * cached open under the 150 ms budget.
 */
export function createNativeEnvironmentCache(): Persistence.EnvironmentCacheStore["Service"] {
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
      Effect.try({
        try: () => writeCachedThread(environmentId, snapshot),
        catch: (cause) => persistenceError("save-thread", cause),
      }),
    removeThread: (environmentId, threadId) =>
      Effect.try({
        try: () => {
          const file = threadFile(environmentId, threadId);
          if (file.exists) file.delete();
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
