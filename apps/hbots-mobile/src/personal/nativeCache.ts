import {
  OrchestrationThreadDetailSnapshot,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot as ThreadSnapshot,
  type ServerConfig,
  type ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import {
  ConnectionPersistenceError,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import { Directory, File, Paths } from "expo-file-system";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CACHE_DIRECTORY = "hbots-thread-cache";

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

const decodeThreadSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);

/**
 * A thread's last settled detail, kept as one file. A chat opened again in a
 * new run paints from here before the socket catches up, which is what keeps a
 * cached open under the 150 ms budget.
 */
export function createNativeEnvironmentCache(): EnvironmentCacheStore["Service"] {
  return EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none<OrchestrationShellSnapshot>()),
    saveShell: () => Effect.void,
    loadThread: (environmentId, threadId: ThreadId) =>
      Effect.tryPromise({
        try: async () => {
          const file = threadFile(environmentId, threadId);
          if (!file.exists) return Option.none<ThreadSnapshot>();
          return Option.some(decodeThreadSnapshot(JSON.parse(await file.text()) as unknown));
        },
        catch: (cause) => persistenceError("load-thread", cause),
      }),
    saveThread: (environmentId, snapshot) =>
      Effect.try({
        try: () => {
          threadFile(environmentId, snapshot.thread.id).write(JSON.stringify(snapshot));
        },
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
