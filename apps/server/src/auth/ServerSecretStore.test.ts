import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());
const layerSealedStore = () => Layer.provideMerge(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
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
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
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
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
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
                  return yield* PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFile",
                    pathOrDescriptor: String(path),
                    description: "Secret file does not exist yet.",
                  });
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ServerSecretStore.layer", (it) => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
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
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
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
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

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

      yield* secretStore.set("personal-login-abc", new TextEncoder().encode("second-password"));
      const updatedOnDisk = yield* fileSystem.readFile(
        `${config.secretsDir}/personal-login-abc.bin`,
      );
      const updated = yield* secretStore.get("personal-login-abc");
      assert.notInclude(Buffer.from(updatedOnDisk).toString("utf8"), "second-password");
      assert.equal(new TextDecoder().decode(Option.getOrThrow(updated)), "second-password");

      yield* secretStore.set("session-signing-key", Uint8Array.from([7, 7, 7]));
      const plain = yield* fileSystem.readFile(`${config.secretsDir}/session-signing-key.bin`);
      assert.deepEqual(Array.from(plain), [7, 7, 7]);
    }).pipe(Effect.provide(layerSealedStore())),
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
    }).pipe(Effect.provide(layerSealedStore())),
  );

  it.effect("keeps bot API keys sealed on disk", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const apiKey = "sk-live-fake-api-key-on-disk-1234567890";
      const name = "personal-secret-bot-1-GITHUB_TOKEN";

      yield* secretStore.set(name, new TextEncoder().encode(apiKey));
      const onDisk = yield* fileSystem.readFile(`${config.secretsDir}/${name}.bin`);
      assert.notInclude(Buffer.from(onDisk).toString("utf8"), apiKey);
      assert.notInclude(Buffer.from(onDisk).toString("base64"), btoa(apiKey).slice(0, 16));
      assert.equal(
        new TextDecoder().decode(Option.getOrThrow(yield* secretStore.get(name))),
        apiKey,
      );
    }).pipe(Effect.provide(layerSealedStore())),
  );

  it.effect("encrypts a legacy plaintext saved login on boot, idempotently", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const configLayer = Layer.succeed(ServerConfig.ServerConfig, config);
      const legacyPath = `${config.secretsDir}/personal-login-legacy.bin`;
      yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
      yield* fileSystem.writeFile(legacyPath, new TextEncoder().encode("legacy-password"));

      const boot = <A>(body: Effect.Effect<A, never, ServerSecretStore.ServerSecretStore>) =>
        body.pipe(Effect.provide(Layer.provide(ServerSecretStore.layer, configLayer)));

      const readLegacy = Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        return yield* store.get("personal-login-legacy").pipe(Effect.orDie);
      });

      const first = yield* boot(readLegacy);
      const sealed = yield* fileSystem.readFile(legacyPath);
      assert.notInclude(Buffer.from(sealed).toString("utf8"), "legacy-password");
      assert.equal(new TextDecoder().decode(Option.getOrThrow(first)), "legacy-password");

      const second = yield* boot(readLegacy);
      const afterSecondBoot = yield* fileSystem.readFile(legacyPath);
      assert.deepEqual(Array.from(afterSecondBoot), Array.from(sealed));
      assert.equal(new TextDecoder().decode(Option.getOrThrow(second)), "legacy-password");
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect(
    "encrypts legacy plaintext bot API keys on boot, idempotently, leaving others alone",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const configLayer = Layer.succeed(ServerConfig.ServerConfig, config);
        const keyName = "personal-secret-bot-1-TAVILY_API_KEY";
        const keyPath = `${config.secretsDir}/${keyName}.bin`;
        const otherPath = `${config.secretsDir}/session-signing-key.bin`;
        yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
        yield* fileSystem.writeFile(keyPath, new TextEncoder().encode("tvly-legacy-plain-key"));
        yield* fileSystem.writeFile(otherPath, Uint8Array.from([9, 9, 9]));

        const boot = <A>(body: Effect.Effect<A, never, ServerSecretStore.ServerSecretStore>) =>
          body.pipe(Effect.provide(Layer.provide(ServerSecretStore.layer, configLayer)));
        const readKey = Effect.gen(function* () {
          const store = yield* ServerSecretStore.ServerSecretStore;
          return yield* store.get(keyName).pipe(Effect.orDie);
        });

        const first = yield* boot(readKey);
        const sealed = yield* fileSystem.readFile(keyPath);
        assert.notInclude(Buffer.from(sealed).toString("utf8"), "tvly-legacy-plain-key");
        assert.equal(new TextDecoder().decode(Option.getOrThrow(first)), "tvly-legacy-plain-key");
        assert.deepEqual(Array.from(yield* fileSystem.readFile(otherPath)), [9, 9, 9]);

        const second = yield* boot(readKey);
        assert.deepEqual(Array.from(yield* fileSystem.readFile(keyPath)), Array.from(sealed));
        assert.equal(new TextDecoder().decode(Option.getOrThrow(second)), "tvly-legacy-plain-key");
      }).pipe(Effect.provide(layerServerConfig())),
  );
});
