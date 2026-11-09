/**
 * Seals the secret values the personal features save, without changing the
 * plain store's format for every other entry.
 *
 * The decorator runs over `ServerSecretStore`: a `personal-login-*`,
 * `personal-connection-*` or `personal-secret-*` value is AES-256-GCM sealed
 * with a machine-wrapped data key before it reaches disk, and unsealed on read.
 * Session keys, DPoP material and the push key keep their existing plaintext
 * format, so no install has to migrate them.
 *
 * A plaintext file left by an earlier version is sealed at boot. The migration
 * is idempotent: a file that already carries the envelope magic is skipped and
 * its bytes never change, so every later boot is a no-op. Read back compares
 * the value before the original is discarded; a failure restores it. No value,
 * key name or key material is ever logged.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as SecretEncryption from "../../auth/secretEncryption.ts";
import {
  SecretStoreDecodeError,
  SecretStoreEncodeError,
  SecretStoreSecureError,
  ServerSecretStore,
  type SecretStoreError,
} from "../../auth/ServerSecretStore.ts";

/** Saved website passwords, managed connection credentials and bot API keys. */
const SEALED_SECRET_NAME_PREFIXES: ReadonlyArray<string> = [
  "personal-login-",
  "personal-connection-",
  "personal-secret-",
];

export const isEncryptedSecretName = (name: string): boolean =>
  SEALED_SECRET_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Holds the machine-wrapped data-encryption key. Never a secret value itself. */
const DATA_KEY_FILE_NAME = "data-encryption-key.json";

interface StoreFiles {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** Builds the sealing layer over a plain store, then seals any legacy file. */
export const decorateSecretStore = (
  base: ServerSecretStore["Service"],
  files: StoreFiles,
): Effect.Effect<ServerSecretStore["Service"], SecretStoreError> =>
  Effect.gen(function* () {
    const { fileSystem, path } = files;
    const directory = base.directory;
    const dataKeyPath =
      directory === undefined ? undefined : path.join(directory, DATA_KEY_FILE_NAME);
    const dataKeyLock = yield* Semaphore.make(1);
    let cachedDataKey: Uint8Array | null = null;

    const secureFailure = (cause: unknown) =>
      new SecretStoreSecureError({ resource: "secret encryption key", cause });

    const readDataKeyFile = (file: string) =>
      fileSystem.readFileString(file).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(secureFailure(cause)),
        ),
      );

    const writeDataKeyFile = (file: string, raw: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(file, { flag: "wx", mode: 0o600 });
          yield* handle.writeAll(new TextEncoder().encode(raw));
          yield* handle.sync;
        }),
      );

    const unwrap = (raw: string): Effect.Effect<Uint8Array, SecretStoreError> =>
      Effect.try({
        try: () => SecretEncryption.unwrapDataKey(SecretEncryption.parseWrappedDataKey(raw)),
        catch: secureFailure,
      });

    /**
     * Created on first use, not at boot, so installs with no saved passwords
     * never grow a key file. Two servers racing the `wx` open is handled by
     * re-reading the winner's file.
     */
    const loadDataKey = Effect.gen(function* () {
      if (dataKeyPath === undefined) {
        return yield* Effect.fail(
          secureFailure(new Error("The secret store has no directory to seal in.")),
        );
      }
      if (cachedDataKey !== null) return cachedDataKey;
      const existing = yield* readDataKeyFile(dataKeyPath);
      if (Option.isSome(existing)) {
        const key = yield* unwrap(existing.value);
        cachedDataKey = key;
        return key;
      }
      const created = yield* Effect.try({
        try: () => SecretEncryption.createWrappedDataKey(),
        catch: secureFailure,
      });
      const written = yield* writeDataKeyFile(
        dataKeyPath,
        SecretEncryption.serializeWrappedDataKey(created.file),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!written) {
        const raced = yield* readDataKeyFile(dataKeyPath);
        if (Option.isNone(raced)) {
          return yield* secureFailure(new Error("Secret key file could not be written."));
        }
        const key = yield* unwrap(raced.value);
        cachedDataKey = key;
        return key;
      }
      yield* fileSystem.chmod(dataKeyPath, 0o600).pipe(Effect.ignore);
      cachedDataKey = created.dataKey;
      return created.dataKey;
    });

    const dataKey = Effect.suspend(() =>
      cachedDataKey !== null ? Effect.succeed(cachedDataKey) : dataKeyLock.withPermit(loadDataKey),
    );

    const seal = (name: string, value: Uint8Array): Effect.Effect<Uint8Array, SecretStoreError> =>
      isEncryptedSecretName(name)
        ? dataKey.pipe(
            Effect.flatMap((key) =>
              Effect.try({
                try: () => SecretEncryption.sealSecret(key, name, value),
                catch: (cause) => new SecretStoreEncodeError({ resource: `secret ${name}`, cause }),
              }),
            ),
          )
        : Effect.succeed(value);

    const unseal = (
      name: string,
      value: Uint8Array,
    ): Effect.Effect<Uint8Array, SecretStoreError> =>
      isEncryptedSecretName(name) && SecretEncryption.isSealedSecret(value)
        ? dataKey.pipe(
            Effect.flatMap((key) =>
              Effect.try({
                try: () => SecretEncryption.openSecret(key, name, value),
                catch: (cause) => new SecretStoreDecodeError({ resource: `secret ${name}`, cause }),
              }),
            ),
          )
        : Effect.succeed(value);

    const get: ServerSecretStore["Service"]["get"] = (name) =>
      base.get(name).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<Uint8Array>()),
            onSome: (bytes) => unseal(name, bytes).pipe(Effect.map(Option.some)),
          }),
        ),
        Effect.withSpan("SealedSecretStore.get"),
      );

    const set: ServerSecretStore["Service"]["set"] = (name, value) =>
      seal(name, value).pipe(
        Effect.flatMap((payload) => base.set(name, payload)),
        Effect.withSpan("SealedSecretStore.set"),
      );

    const create: ServerSecretStore["Service"]["create"] = (name, value) =>
      seal(name, value).pipe(
        Effect.flatMap((payload) => base.create(name, payload)),
        Effect.withSpan("SealedSecretStore.create"),
      );

    /** Reads through `get` so a sealed value comes back plaintext. */
    const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
      get(name).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              base.getOrCreateRandom(name, bytes).pipe(
                Effect.flatMap((generated) =>
                  isEncryptedSecretName(name)
                    ? seal(name, generated).pipe(
                        Effect.flatMap((payload) => base.set(name, payload)),
                        Effect.as(generated),
                      )
                    : Effect.succeed(generated),
                ),
              ),
          }),
        ),
      );

    const remove: ServerSecretStore["Service"]["remove"] = (name) => base.remove(name);

    const service = ServerSecretStore.of({
      ...(directory === undefined ? {} : { directory }),
      get,
      set,
      create,
      getOrCreateRandom,
      remove,
    });

    const migratePlaintextSecrets = Effect.gen(function* () {
      if (directory === undefined) return;
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
      let sealedCount = 0;
      let failedCount = 0;
      for (const entry of entries) {
        if (!entry.endsWith(".bin")) continue;
        const name = entry.slice(0, -".bin".length);
        if (!isEncryptedSecretName(name)) continue;
        const secretPath = path.join(directory, entry);
        const current = yield* fileSystem.readFile(secretPath).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<Uint8Array>())),
        );
        if (Option.isNone(current)) continue;
        const bytes = Uint8Array.from(current.value);
        if (SecretEncryption.isSealedSecret(bytes)) continue;
        const outcome = yield* set(name, bytes).pipe(
          Effect.flatMap(() => get(name)),
          Effect.map(
            (readBack) =>
              Option.isSome(readBack) &&
              readBack.value.byteLength === bytes.byteLength &&
              readBack.value.every((byte, index) => byte === bytes[index]),
          ),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (outcome) {
          sealedCount += 1;
        } else {
          failedCount += 1;
          // Put the original back so the value stays usable; best effort.
          yield* fileSystem.writeFile(secretPath, bytes).pipe(Effect.ignore);
        }
        bytes.fill(0);
      }
      if (sealedCount > 0) {
        yield* Effect.logInfo(`Encrypted ${sealedCount} saved secret file(s) at rest.`);
      }
      if (failedCount > 0) {
        yield* Effect.logWarning(
          `Could not encrypt ${failedCount} saved secret file(s) at rest; they stay as they were.`,
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not encrypt existing saved secrets at rest.", cause),
      ),
    );

    yield* migratePlaintextSecrets;
    return service;
  });
