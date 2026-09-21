import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const makeServerSecretStoreLayer = () =>
  Layer.provide(ServerSecretStore.layer, makeServerConfigLayer());

const PermissionDeniedFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makePermissionDeniedSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(PermissionDeniedFileSystemLayer),
  );

const RenameFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRenameFailureSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RenameFailureFileSystemLayer),
  );

const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRemoveFailureSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RemoveFailureFileSystemLayer),
  );

const ConcurrentReadMissFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeConcurrentCreateSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(ConcurrentReadMissFileSystemLayer),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(makeConcurrentCreateSecretStoreLayer())),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () => {
    const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
    const openCalls: Array<{ readonly path: string; readonly mode: number | undefined }> = [];
    const recordingFileSystemLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        return {
          ...fileSystem,
          open: (path, options) =>
            Effect.andThen(
              Effect.sync(() => {
                openCalls.push({ path: String(path), mode: options?.mode });
              }),
              fileSystem.open(path, options),
            ),
          chmod: (path, mode) =>
            Effect.andThen(
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
              fileSystem.chmod(path, mode),
            ),
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));

      assert.isTrue(
        chmodCalls.some((call) => call.mode === 0o700 && /[\\/]secrets$/.test(call.path)),
      );
      // I3: every file this store creates carries its mode at open time. A
      // write-then-chmod leaves a window at the process umask, and on Windows
      // the later chmod is a no-op so the window never closes at all.
      assert.isAtLeast(openCalls.length, 1);
      assert.isTrue(openCalls.every((call) => call.mode === 0o600));
      assert.isTrue(openCalls.some((call) => call.path.endsWith(".tmp")));
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(makeServerConfigLayer()),
          Layer.provideMerge(recordingFileSystemLayer),
        ),
      ),
    );
  });

  // C1: a saved password must not be readable with `cat`. Encryption does not
  // stop code running as the same OS user, but it does stop a file read.
  it.effect("keeps saved-login secrets unreadable on disk and round-trips them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const password = "correct horse battery staple";

      yield* secretStore.create("personal-login-abc", new TextEncoder().encode(password));
      const onDisk = yield* fileSystem.readFile(`${config.secretsDir}/personal-login-abc.bin`);
      const read = yield* secretStore.get("personal-login-abc");

      assert.notInclude(Buffer.from(onDisk).toString("utf8"), password);
      assert.equal(new TextDecoder().decode(Option.getOrThrow(read)), password);

      // Updating through the atomic path keeps the file sealed.
      yield* secretStore.set("personal-login-abc", new TextEncoder().encode("second-password"));
      const updatedOnDisk = yield* fileSystem.readFile(
        `${config.secretsDir}/personal-login-abc.bin`,
      );
      const updated = yield* secretStore.get("personal-login-abc");
      assert.notInclude(Buffer.from(updatedOnDisk).toString("utf8"), "second-password");
      assert.equal(new TextDecoder().decode(Option.getOrThrow(updated)), "second-password");

      // Other store entries keep their existing plaintext format, so no
      // pre-existing install has to be migrated to boot.
      yield* secretStore.set("session-signing-key", Uint8Array.from([7, 7, 7]));
      const plain = yield* fileSystem.readFile(`${config.secretsDir}/session-signing-key.bin`);
      assert.deepEqual(Array.from(plain), [7, 7, 7]);
      // One layer instance, so the store and the assertions share one temp dir.
    }).pipe(Effect.provide(Layer.provideMerge(ServerSecretStore.layer, makeServerConfigLayer()))),
  );

  it.effect("keeps connection credentials sealed on disk", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const token = "fake-connection-token-on-disk";
      const name = "personal-connection-opaque-ref-v1";

      yield* secretStore.create(name, new TextEncoder().encode(token));
      const onDisk = yield* fileSystem.readFile(`${config.secretsDir}/${name}.bin`);
      const read = yield* secretStore.get(name);

      assert.notInclude(Buffer.from(onDisk).toString("utf8"), token);
      assert.equal(new TextDecoder().decode(Option.getOrThrow(read)), token);
    }).pipe(Effect.provide(Layer.provideMerge(ServerSecretStore.layer, makeServerConfigLayer()))),
  );

  it.effect("encrypts a legacy plaintext saved login on boot, idempotently", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const configLayer = Layer.succeed(ServerConfig.ServerConfig, config);
      const legacyPath = `${config.secretsDir}/personal-login-legacy.bin`;
      yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
      yield* fileSystem.writeFile(legacyPath, new TextEncoder().encode("legacy-password"));

      // Each boot builds the store layer again against the same directory.
      const boot = <A>(body: Effect.Effect<A, never, ServerSecretStore.ServerSecretStore>) =>
        body.pipe(Effect.provide(Layer.provide(ServerSecretStore.layer, configLayer)));

      // First boot: the plaintext file is sealed in place.
      const first = yield* boot(
        Effect.gen(function* () {
          const store = yield* ServerSecretStore.ServerSecretStore;
          return yield* store.get("personal-login-legacy").pipe(Effect.orDie);
        }),
      );
      const sealed = yield* fileSystem.readFile(legacyPath);
      assert.notInclude(Buffer.from(sealed).toString("utf8"), "legacy-password");
      assert.equal(new TextDecoder().decode(Option.getOrThrow(first)), "legacy-password");

      // Second boot: already sealed, so the bytes do not change (no re-seal,
      // no double encryption) and the value still reads back.
      const second = yield* boot(
        Effect.gen(function* () {
          const store = yield* ServerSecretStore.ServerSecretStore;
          return yield* store.get("personal-login-legacy").pipe(Effect.orDie);
        }),
      );
      const afterSecondBoot = yield* fileSystem.readFile(legacyPath);
      assert.deepEqual(Array.from(afterSecondBoot), Array.from(sealed));
      assert.equal(new TextDecoder().decode(Option.getOrThrow(second)), "legacy-password");
    }).pipe(Effect.provide(makeServerConfigLayer())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makePermissionDeniedSecretStoreLayer())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makeRenameFailureSecretStoreLayer())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makeRemoveFailureSecretStoreLayer())),
  );
});
