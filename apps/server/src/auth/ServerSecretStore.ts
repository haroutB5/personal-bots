import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as SecretEncryption from "./secretEncryption.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedError<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedError<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedError<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedError<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedError<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedError<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedError<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedError<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedError<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

/**
 * Saved website passwords and managed connection credentials are sealed at
 * rest. Other store entries (session keys, DPoP material) keep their existing
 * plaintext format, so no existing install has to be migrated.
 */
export const ENCRYPTED_SECRET_NAME_PREFIX = "personal-login-";
export const ENCRYPTED_CONNECTION_SECRET_NAME_PREFIX = "personal-connection-";

export const isEncryptedSecretName = (name: string): boolean =>
  name.startsWith(ENCRYPTED_SECRET_NAME_PREFIX) ||
  name.startsWith(ENCRYPTED_CONNECTION_SECRET_NAME_PREFIX);

/** Holds the machine-wrapped data-encryption key. Never a secret value itself. */
export const DATA_KEY_FILE_NAME = "data-encryption-key.json";

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${serverConfig.secretsDir}`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);

  const dataKeyPath = path.join(serverConfig.secretsDir, DATA_KEY_FILE_NAME);
  const dataKeyLock = yield* Semaphore.make(1);
  let cachedDataKey: Uint8Array | null = null;

  const secureFailure = (cause: unknown) =>
    new SecretStoreSecureError({ resource: "secret encryption key", cause });

  const readDataKeyFile = fileSystem.readFileString(dataKeyPath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(secureFailure(cause)),
    ),
  );

  const writeDataKeyFile = (raw: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(dataKeyPath, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(raw));
        yield* file.sync;
      }),
    );

  /**
   * Created on first use, not at boot, so installs with no saved passwords never
   * grow a key file. Two servers racing the `wx` open is handled by re-reading.
   */
  const loadDataKey = Effect.gen(function* () {
    if (cachedDataKey !== null) return cachedDataKey;
    const existing = yield* readDataKeyFile;
    if (Option.isSome(existing)) {
      const key = yield* Effect.try({
        try: () =>
          SecretEncryption.unwrapDataKey(SecretEncryption.parseWrappedDataKey(existing.value)),
        catch: secureFailure,
      });
      cachedDataKey = key;
      return key;
    }
    const created = yield* Effect.try({
      try: () => SecretEncryption.createWrappedDataKey(),
      catch: secureFailure,
    });
    const written = yield* writeDataKeyFile(
      SecretEncryption.serializeWrappedDataKey(created.file),
    ).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!written) {
      const raced = yield* readDataKeyFile;
      if (Option.isNone(raced)) {
        return yield* secureFailure(new Error("Secret key file could not be written."));
      }
      const key = yield* Effect.try({
        try: () =>
          SecretEncryption.unwrapDataKey(SecretEncryption.parseWrappedDataKey(raced.value)),
        catch: secureFailure,
      });
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

  /** Sealing is per-name, so migrating other store entries is not required. */
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

  const unseal = (name: string, value: Uint8Array): Effect.Effect<Uint8Array, SecretStoreError> =>
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
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.map((bytes): Option.Option<Uint8Array> => Option.some(Uint8Array.from(bytes))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<Uint8Array>())
          : Effect.fail(
              new SecretStoreReadError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<Uint8Array>()),
          onSome: (bytes) => unseal(name, bytes).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.withSpan("ServerSecretStore.get"),
    );

  const set: ServerSecretStore["Service"]["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return seal(name, value).pipe(
      Effect.flatMap((payload) =>
        crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new SecretStoreTemporaryPathError({
                resource: `secret ${name}`,
                cause,
              }),
          ),
          Effect.flatMap((uuid) => {
            const tempPath = `${secretPath}.${uuid}.tmp`;
            return Effect.scoped(
              Effect.gen(function* () {
                // Opened `wx` with the mode up front: the old write-then-chmod
                // left a window at the process umask, and on Windows the later
                // chmod is a no-op so the window never closed at all.
                const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
                yield* file.writeAll(payload);
                yield* file.sync;
              }),
            ).pipe(
              Effect.andThen(fileSystem.rename(tempPath, secretPath)),
              Effect.andThen(fileSystem.chmod(secretPath, 0o600).pipe(Effect.ignore)),
              Effect.catch((cause) =>
                // The temp file never survives a failure, on any path.
                fileSystem.remove(tempPath).pipe(
                  Effect.ignore,
                  Effect.flatMap(() =>
                    Effect.fail(
                      new SecretStorePersistError({
                        resource: `secret ${name}`,
                        cause,
                      }),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
      ),
      Effect.withSpan("ServerSecretStore.set"),
    );
  };

  const create: ServerSecretStore["Service"]["create"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return seal(name, value).pipe(
      Effect.flatMap((payload) =>
        Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(secretPath, {
              flag: "wx",
              mode: 0o600,
            });
            yield* file.writeAll(payload);
            yield* file.sync;
            yield* fileSystem.chmod(secretPath, 0o600);
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new SecretStorePersistError({
                resource: `secret ${name}`,
                cause,
              }),
          ),
        ),
      ),
    );
  };

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.remove"),
    );

  /**
   * Seals any `personal-login-*.bin` left in plaintext by an earlier version.
   * Idempotent: a file that already carries the envelope magic is skipped, so
   * every later boot is a no-op. A failure here leaves the status quo (a
   * readable file) rather than an unreadable one, so it is logged, not fatal.
   */
  const migratePlaintextSecrets = Effect.gen(function* () {
    const entries = yield* fileSystem
      .readDirectory(serverConfig.secretsDir)
      .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
    for (const entry of entries) {
      if (!entry.startsWith(ENCRYPTED_SECRET_NAME_PREFIX) || !entry.endsWith(".bin")) continue;
      const name = entry.slice(0, -".bin".length);
      const current = yield* fileSystem.readFile(resolveSecretPath(name)).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none<Uint8Array>())),
      );
      if (Option.isNone(current)) continue;
      const bytes = Uint8Array.from(current.value);
      if (SecretEncryption.isSealedSecret(bytes)) continue;
      yield* set(name, bytes).pipe(Effect.ensuring(Effect.sync(() => bytes.fill(0))));
      yield* Effect.logInfo(`Encrypted a saved login secret at rest: ${name}`);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not encrypt existing saved-login secrets at rest.", cause),
    ),
  );

  yield* migratePlaintextSecrets;

  return ServerSecretStore.of({
    get,
    set,
    create,
    getOrCreateRandom,
    remove,
  });
});

export const layer = Layer.effect(ServerSecretStore, make);
