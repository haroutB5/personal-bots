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
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as SecretEncryption from "../../auth/secretEncryption.ts";
import {
  SecretStoreDecodeError,
  SecretStoreEncodeError,
  SecretStoreLockedError,
  SecretStoreSecureError,
  ServerSecretStore,
  type SecretStoreError,
} from "../../auth/ServerSecretStore.ts";

/** Saved website passwords, managed connection credentials, bot API keys and external MCP tokens. */
const SEALED_SECRET_NAME_PREFIXES: ReadonlyArray<string> = [
  "personal-login-",
  "personal-connection-",
  "personal-secret-",
  "personal-external-mcp:",
];

export const isEncryptedSecretName = (name: string): boolean =>
  SEALED_SECRET_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Holds the machine-wrapped data-encryption key. Never a secret value itself. */
const DATA_KEY_FILE_NAME = "data-encryption-key.json";

interface StoreFiles {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

export type DataKeyState =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Open"; readonly key: Uint8Array }
  | {
      readonly _tag: "Locked";
      readonly reason: SecretEncryption.DataKeyLockReason;
      readonly source: SecretEncryption.MachineMaterialSource | null;
      readonly fileHash: string | null;
    };

export interface SealedSecretStoreOptions {
  readonly resolveMachineMaterial?: (
    required?: SecretEncryption.MachineMaterialSource,
  ) => SecretEncryption.MachineMaterial | null;
}

const sha256Hex = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const lockedError = (state: Extract<DataKeyState, { _tag: "Locked" }>) =>
  new SecretStoreLockedError({ reason: state.reason, source: state.source });

/** Builds the sealing layer over a plain store, then seals any legacy file. */
export const decorateSecretStore = (
  base: ServerSecretStore["Service"],
  files: StoreFiles,
  options?: SealedSecretStoreOptions,
): Effect.Effect<ServerSecretStore["Service"], SecretStoreError> =>
  Effect.gen(function* () {
    const { fileSystem, path } = files;
    const resolveMaterial =
      options?.resolveMachineMaterial ?? SecretEncryption.resolveMachineMaterial;
    const directory = base.directory;
    const dataKeyPath =
      directory === undefined ? undefined : path.join(directory, DATA_KEY_FILE_NAME);
    const dataKeyLock = yield* Semaphore.make(1);
    let cachedDataKey: Uint8Array | null = null;
    let lockedState: Extract<DataKeyState, { _tag: "Locked" }> | null = null;

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

    const countSealedFiles = Effect.gen(function* () {
      if (directory === undefined) return 0;
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed<ReadonlyArray<string>>([])
              : Effect.fail(secureFailure(cause)),
          ),
        );
      let count = 0;
      for (const entry of entries) {
        if (!entry.endsWith(".bin")) continue;
        if (!isEncryptedSecretName(entry.slice(0, -".bin".length))) continue;
        const bytes = yield* fileSystem.readFile(path.join(directory, entry)).pipe(
          Effect.map(Option.some),
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<Uint8Array>())
              : Effect.fail(secureFailure(cause)),
          ),
        );
        if (Option.isSome(bytes) && SecretEncryption.isSealedSecret(Uint8Array.from(bytes.value))) {
          count += 1;
        }
      }
      return count;
    });

    const openKeyText = (raw: string): DataKeyState => {
      const fileHash = sha256Hex(raw);
      if (lockedState !== null && lockedState.fileHash === fileHash) return lockedState;
      const outcome = SecretEncryption.tryUnwrapDataKeyText(raw, resolveMaterial);
      if (outcome._tag === "Opened") {
        lockedState = null;
        return { _tag: "Open", key: outcome.dataKey };
      }
      const locked: Extract<DataKeyState, { _tag: "Locked" }> = {
        _tag: "Locked",
        reason: outcome.reason,
        source: outcome.source,
        fileHash,
      };
      lockedState = outcome.reason === "material-unavailable" ? null : locked;
      return locked;
    };

    const readState: Effect.Effect<DataKeyState, SecretStoreError> = Effect.gen(function* () {
      if (dataKeyPath === undefined) {
        return yield* Effect.fail(
          secureFailure(new Error("The secret store has no directory to seal in.")),
        );
      }
      if (cachedDataKey !== null) return { _tag: "Open", key: cachedDataKey } as const;
      const existing = yield* readDataKeyFile(dataKeyPath);
      if (Option.isSome(existing)) {
        const state = openKeyText(existing.value);
        if (state._tag === "Open") cachedDataKey = state.key;
        return state;
      }
      const sealed = yield* countSealedFiles;
      if (sealed > 0) {
        lockedState = null;
        return { _tag: "Locked", reason: "key-missing", source: null, fileHash: null } as const;
      }
      return { _tag: "Absent" } as const;
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
      const state = yield* readState;
      if (state._tag === "Open") return state.key;
      if (state._tag === "Locked") return yield* lockedError(state);
      const material = resolveMaterial();
      if (material === null) {
        return yield* secureFailure(
          new Error("No machine material is available to protect secrets."),
        );
      }
      const created = SecretEncryption.createWrappedDataKey(material);
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
        const winner = openKeyText(raced.value);
        if (winner._tag === "Open") {
          cachedDataKey = winner.key;
          return winner.key;
        }
        if (winner._tag === "Locked") return yield* lockedError(winner);
        return yield* secureFailure(new Error("Secret key file could not be read."));
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
              (isEncryptedSecretName(name) ? dataKey : Effect.void).pipe(
                Effect.andThen(base.getOrCreateRandom(name, bytes)),
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

    const probeDataKey = Effect.gen(function* () {
      const state = yield* readState;
      if (state._tag !== "Locked") return state;
      const sealed = yield* countSealedFiles.pipe(Effect.orElseSucceed(() => 0));
      yield* Effect.logWarning(
        `Saved secrets are locked: reason=${state.reason} source=${state.source ?? "none"} sealed=${sealed}. ` +
          "Sealed keys and logins cannot be opened or saved until the key is moved over. " +
          "Run `secrets status` to inspect, then `secrets rewrap` or `secrets import` to recover.",
      );
      return state;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Could not check the saved-secret key at boot (${error._tag}).`).pipe(
          Effect.as<DataKeyState>({ _tag: "Absent" }),
        ),
      ),
    );

    const bootState = yield* probeDataKey;
    if (bootState._tag !== "Locked") yield* migratePlaintextSecrets;
    return service;
  });
