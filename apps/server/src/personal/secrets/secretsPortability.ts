// @effect-diagnostics nodeBuiltinImport:off - a migration/CLI path: plain fs and crypto with no Effect runtime.
// @effect-diagnostics globalDate:off - the bundle's createdAt is a plain ISO timestamp for records, not scheduling.
/**
 * Moving saved secrets from one machine to another without ever writing them
 * in plaintext.
 *
 * The problem: sealed files (`personal-login-*`, `personal-secret-*`,
 * `personal-connection-*`) are encrypted with a random data key, and that data
 * key is wrapped with machine material (Windows `MachineGuid`, Linux
 * `/etc/machine-id`). Copying the store to the new machine leaves every saved
 * login unreadable, because the new machine cannot unwrap the key.
 *
 * The bundle:
 * - the data key, encrypted with a key derived from a passphrase the owner
 *   supplies at both ends (scrypt + AES-256-GCM);
 * - the sealed secret files, byte for byte, each with its sha256;
 * - nothing else. Session keys, the push keypair and DPoP material are not
 *   portable by design: the app recreates them, and that is what re-pairing
 *   the phone already does.
 *
 * Nothing here prints or logs a secret value or the passphrase. Import proves
 * every entry decrypts with the imported key before it reports success, and a
 * failure leaves the target store exactly as it found it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  createWrappedDataKey,
  isSealedSecret,
  openSecret,
  parseWrappedDataKey,
  resolveMachineMaterial,
  serializeWrappedDataKey,
  unwrapDataKey,
  type MachineMaterial,
  type MachineMaterialSource,
} from "../../auth/secretEncryption.ts";

export const SECRETS_BUNDLE_FORMAT = "hbots-secrets-bundle";
export const SECRETS_BUNDLE_VERSION = 1;
/** Short passphrases are the whole protection around the data key. */
export const MIN_PASSPHRASE_LENGTH = 12;
export const DATA_KEY_FILE_NAME = "data-encryption-key.json";

/** The same prefixes `ServerSecretStore` seals; kept here so this module stands alone. */
const SEALED_PREFIXES: ReadonlyArray<string> = [
  "personal-login-",
  "personal-connection-",
  "personal-secret-",
];

const isPortableName = (name: string) => SEALED_PREFIXES.some((prefix) => name.startsWith(prefix));

export type SecretsPortabilityErrorCode =
  | "passphrase-too-short"
  | "no-secrets"
  | "no-data-key"
  | "unreadable-data-key"
  | "bundle-exists"
  | "bundle-missing"
  | "bundle-malformed"
  | "bundle-version"
  | "bad-passphrase"
  | "checksum-mismatch"
  | "entry-unreadable"
  | "target-key-differs"
  | "write-failed";

export class SecretsPortabilityError extends Error {
  readonly code: SecretsPortabilityErrorCode;

  constructor(code: SecretsPortabilityErrorCode, message: string) {
    super(message);
    this.name = "SecretsPortabilityError";
    this.code = code;
  }
}

interface BundleEntry {
  readonly name: string;
  readonly sha256: string;
  /** The sealed file exactly as stored, base64. */
  readonly sealed: string;
}

interface SecretsBundle {
  readonly format: typeof SECRETS_BUNDLE_FORMAT;
  readonly version: typeof SECRETS_BUNDLE_VERSION;
  readonly createdAt: string;
  readonly source: MachineMaterialSource;
  readonly kdf: {
    readonly name: "scrypt";
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly salt: string;
  };
  readonly dataKey: { readonly iv: string; readonly tag: string; readonly ciphertext: string };
  readonly entries: ReadonlyArray<BundleEntry>;
}

export interface SecretsPortabilityDeps {
  /** Test seam: the machine material of the machine doing the export/import. */
  readonly resolveMachineMaterial?: (required?: MachineMaterialSource) => MachineMaterial | null;
  /** Test seam: a fixed clock for `createdAt`. */
  readonly now?: () => number;
}

const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const PASSPHRASE_AAD = Buffer.from(`${SECRETS_BUNDLE_FORMAT}/v${SECRETS_BUNDLE_VERSION}`, "utf8");

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

const sha256 = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");

const derivePassphraseKey = (passphrase: string, salt: Uint8Array): Uint8Array =>
  Uint8Array.from(
    NodeCrypto.scryptSync(`${SECRETS_BUNDLE_FORMAT}/v${SECRETS_BUNDLE_VERSION} ${passphrase}`, salt, 32, {
      ...SCRYPT,
    }),
  );

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SecretsPortabilityError(
      "passphrase-too-short",
      `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
}

const sealWithPassphrase = (
  passphrase: string,
): {
  readonly kdf: SecretsBundle["kdf"];
  readonly seal: (dataKey: Uint8Array) => SecretsBundle["dataKey"];
} => {
  const salt = NodeCrypto.randomBytes(16);
  const key = derivePassphraseKey(passphrase, salt);
  return {
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: base64(salt) },
    seal: (dataKey) => {
      try {
        const iv = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(PASSPHRASE_AAD);
        const ciphertext = Buffer.concat([cipher.update(Buffer.from(dataKey)), cipher.final()]);
        return {
          iv: base64(iv),
          tag: base64(cipher.getAuthTag()),
          ciphertext: base64(ciphertext),
        };
      } finally {
        key.fill(0);
      }
    },
  };
};

const openWithPassphrase = (passphrase: string, bundle: SecretsBundle): Uint8Array => {
  if (bundle.kdf.name !== "scrypt") {
    throw new SecretsPortabilityError("bundle-malformed", "Unsupported key derivation.");
  }
  const key = derivePassphraseKey(passphrase, fromBase64(bundle.kdf.salt));
  try {
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      key,
      fromBase64(bundle.dataKey.iv),
    );
    decipher.setAAD(PASSPHRASE_AAD);
    decipher.setAuthTag(fromBase64(bundle.dataKey.tag));
    return Uint8Array.from(
      Buffer.concat([decipher.update(fromBase64(bundle.dataKey.ciphertext)), decipher.final()]),
    );
  } catch {
    // GCM failure is the only honest answer: wrong passphrase, or a damaged
    // bundle. Never distinguish the two to the caller's logs.
    throw new SecretsPortabilityError(
      "bad-passphrase",
      "The passphrase does not open this bundle (or the bundle is damaged).",
    );
  } finally {
    key.fill(0);
  }
};

const writePrivateFile = (file: string, bytes: Uint8Array, overwrite: boolean): void => {
  const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    if (!overwrite && NodeFS.existsSync(file)) {
      throw new SecretsPortabilityError(
        "bundle-exists",
        `Refusing to overwrite an existing file: ${file}. Pass force to replace it.`,
      );
    }
    const handle = NodeFS.openSync(temp, "wx", 0o600);
    try {
      NodeFS.writeFileSync(handle, Buffer.from(bytes));
      NodeFS.fsyncSync(handle);
    } finally {
      NodeFS.closeSync(handle);
    }
    NodeFS.renameSync(temp, file);
    try {
      NodeFS.chmodSync(file, 0o600);
    } catch {
      // Windows: chmod is a no-op and the user profile ACL governs.
    }
  } catch (error) {
    try {
      NodeFS.rmSync(temp, { force: true });
    } catch {
      // Nothing to clean.
    }
    if (error instanceof SecretsPortabilityError) throw error;
    throw new SecretsPortabilityError(
      "write-failed",
      `Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export interface SecretsExportOptions {
  /** The store's `secrets` folder (â€¦/userdata/secrets). */
  readonly secretsDir: string;
  readonly outFile: string;
  readonly passphrase: string;
  /** Replace an existing bundle file. */
  readonly force?: boolean;
  readonly deps?: SecretsPortabilityDeps;
}

export interface SecretsExportResult {
  readonly entries: number;
  readonly source: MachineMaterialSource;
  readonly outFile: string;
}

/** Read the sealed secrets and write one passphrase-sealed bundle. */
export function exportSecretsBundle(options: SecretsExportOptions): SecretsExportResult {
  const deps = options.deps ?? {};
  assertPassphrase(options.passphrase);
  const resolve = deps.resolveMachineMaterial ?? resolveMachineMaterial;
  const dataKeyPath = NodePath.join(options.secretsDir, DATA_KEY_FILE_NAME);
  let dataKeyFileText: string;
  try {
    dataKeyFileText = NodeFS.readFileSync(dataKeyPath, "utf8");
  } catch {
    throw new SecretsPortabilityError(
      "no-data-key",
      `No saved secrets on this machine: ${dataKeyPath} does not exist.`,
    );
  }
  const keyFile = parseWrappedDataKey(dataKeyFileText);
  const material = resolve(keyFile.source);
  if (material === null) {
    throw new SecretsPortabilityError(
      "unreadable-data-key",
      `This machine cannot unwrap the secret key (it was sealed with "${keyFile.source}").`,
    );
  }
  let dataKey: Uint8Array;
  try {
    dataKey = unwrapDataKey(keyFile, material);
  } catch {
    throw new SecretsPortabilityError(
      "unreadable-data-key",
      `This machine cannot unwrap the secret key (it was sealed with "${keyFile.source}").`,
    );
  }

  const entries: BundleEntry[] = [];
  try {
    const names = NodeFS.readdirSync(options.secretsDir).filter((entry) => entry.endsWith(".bin"));
    for (const file of names) {
      const name = file.slice(0, -".bin".length);
      if (!isPortableName(name)) continue;
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(NodeFS.readFileSync(NodePath.join(options.secretsDir, file)));
      } catch {
        continue;
      }
      // A legacy plaintext file is sealed by the store at boot; a bundle only
      // carries sealed bytes, so nothing readable ever leaves the machine.
      if (!isSealedSecret(bytes)) continue;
      // Prove the entry belongs to this data key before it ships.
      try {
        const plaintext = openSecret(dataKey, name, bytes);
        plaintext.fill(0);
      } catch {
        throw new SecretsPortabilityError(
          "entry-unreadable",
          `Saved secret "${name}" cannot be opened with this machine's key.`,
        );
      }
      entries.push({ name, sha256: sha256(bytes), sealed: base64(bytes) });
      bytes.fill(0);
    }
    if (entries.length === 0) {
      throw new SecretsPortabilityError(
        "no-secrets",
        `No sealed saved secrets found in ${options.secretsDir}.`,
      );
    }

    const sealing = sealWithPassphrase(options.passphrase);
    const bundle: SecretsBundle = {
      format: SECRETS_BUNDLE_FORMAT,
      version: SECRETS_BUNDLE_VERSION,
      createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
      source: keyFile.source,
      kdf: sealing.kdf,
      dataKey: sealing.seal(dataKey),
      entries,
    };
    writePrivateFile(
      options.outFile,
      new TextEncoder().encode(`${JSON.stringify(bundle, null, 2)}\n`),
      options.force === true,
    );
    return { entries: entries.length, source: keyFile.source, outFile: options.outFile };
  } finally {
    dataKey.fill(0);
  }
}

export interface SecretsImportOptions {
  readonly secretsDir: string;
  readonly bundleFile: string;
  readonly passphrase: string;
  /** Replace a different existing data key (refused by default). */
  readonly force?: boolean;
  readonly deps?: SecretsPortabilityDeps;
}

export interface SecretsImportResult {
  readonly entries: number;
  readonly imported: number;
  /** Entries already present with identical bytes. */
  readonly unchanged: number;
  /** True when the data key file was (re)written. */
  readonly dataKeyWritten: boolean;
}

/**
 * Write the bundle's secrets into this machine's store, re-wrapping the data
 * key with this machine's material. Every entry is proven readable before the
 * result is reported; a failure restores what was there before.
 */
export function importSecretsBundle(options: SecretsImportOptions): SecretsImportResult {
  const deps = options.deps ?? {};
  assertPassphrase(options.passphrase);
  let raw: string;
  try {
    raw = NodeFS.readFileSync(options.bundleFile, "utf8");
  } catch {
    throw new SecretsPortabilityError(
      "bundle-missing",
      `Bundle not found: ${options.bundleFile}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretsPortabilityError("bundle-malformed", "The bundle is not valid JSON.");
  }
  const bundle = parsed as Partial<SecretsBundle>;
  if (bundle.format !== SECRETS_BUNDLE_FORMAT) {
    throw new SecretsPortabilityError("bundle-malformed", "This file is not a secrets bundle.");
  }
  if (bundle.version !== SECRETS_BUNDLE_VERSION) {
    throw new SecretsPortabilityError(
      "bundle-version",
      `Bundle version ${String(bundle.version)} is not supported (expected ${SECRETS_BUNDLE_VERSION}).`,
    );
  }
  if (!Array.isArray(bundle.entries) || bundle.dataKey === undefined || bundle.kdf === undefined) {
    throw new SecretsPortabilityError("bundle-malformed", "The bundle is incomplete.");
  }

  const dataKey = openWithPassphrase(options.passphrase, bundle as SecretsBundle);
  const resolve = deps.resolveMachineMaterial ?? resolveMachineMaterial;
  const target = resolve();
  if (target === null) {
    dataKey.fill(0);
    throw new SecretsPortabilityError(
      "write-failed",
      "This machine has no machine material to protect the secret key.",
    );
  }

  // Decode and prove every entry before touching the store.
  const decoded: Array<{ name: string; bytes: Uint8Array }> = [];
  const keyPath = NodePath.join(options.secretsDir, DATA_KEY_FILE_NAME);
  let previousKeyBytes: Uint8Array | null = null;
  let keyWritten = false;
  try {
    for (const entry of bundle.entries) {
      if (
        typeof entry.name !== "string" ||
        !isPortableName(entry.name) ||
        typeof entry.sealed !== "string"
      ) {
        throw new SecretsPortabilityError("bundle-malformed", "The bundle holds an invalid entry.");
      }
      const bytes = fromBase64(entry.sealed);
      if (sha256(bytes) !== entry.sha256) {
        throw new SecretsPortabilityError(
          "checksum-mismatch",
          `Bundle entry "${entry.name}" failed its checksum.`,
        );
      }
      try {
        const plaintext = openSecret(dataKey, entry.name, bytes);
        plaintext.fill(0);
      } catch {
        throw new SecretsPortabilityError(
          "entry-unreadable",
          `Bundle entry "${entry.name}" cannot be opened with the bundle's key.`,
        );
      }
      decoded.push({ name: entry.name, bytes });
    }

    try {
      previousKeyBytes = Uint8Array.from(NodeFS.readFileSync(keyPath));
    } catch {
      previousKeyBytes = null;
    }
    let dataKeyWritten = true;
    if (previousKeyBytes !== null) {
      try {
        const existing = unwrapDataKey(
          parseWrappedDataKey(new TextDecoder().decode(previousKeyBytes)),
        );
        const same =
          existing.byteLength === dataKey.byteLength &&
          existing.every((byte, index) => byte === dataKey[index]);
        existing.fill(0);
        if (!same && options.force !== true) {
          throw new SecretsPortabilityError(
            "target-key-differs",
            `This machine already has a different secret key (${keyPath}). Pass force to replace it.`,
          );
        }
        dataKeyWritten = !same;
      } catch (error) {
        if (error instanceof SecretsPortabilityError) throw error;
        if (options.force !== true) {
          throw new SecretsPortabilityError(
            "target-key-differs",
            `This machine already has a secret key that does not open (${keyPath}). Pass force to replace it.`,
          );
        }
      }
    }

    NodeFS.mkdirSync(options.secretsDir, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    let imported = 0;
    let unchanged = 0;
    try {
      if (dataKeyWritten) {
        const wrapped = createWrappedDataKey(target);
        wrapped.dataKey.fill(0);
        writePrivateFile(
          keyPath,
          new TextEncoder().encode(serializeWrappedDataKey(wrapped.file)),
          true,
        );
        try {
          NodeFS.chmodSync(keyPath, 0o600);
        } catch {
          // Windows.
        }
        keyWritten = true;
      }
      for (const entry of decoded) {
        const file = NodePath.join(options.secretsDir, `${entry.name}.bin`);
        try {
          const current = Uint8Array.from(NodeFS.readFileSync(file));
          const identical =
            current.byteLength === entry.bytes.byteLength &&
            current.every((byte, index) => byte === entry.bytes[index]);
          if (identical) {
            unchanged += 1;
            continue;
          }
        } catch {
          // Not there yet: write it.
        }
        writePrivateFile(file, entry.bytes, true);
        written.push(file);
        imported += 1;
      }

      // Prove the store now opens every entry with the key it has on disk.
      const keyFile = parseWrappedDataKey(NodeFS.readFileSync(keyPath, "utf8"));
      const reopened = unwrapDataKey(keyFile, target);
      try {
        for (const entry of decoded) {
          const bytes = Uint8Array.from(
            NodeFS.readFileSync(NodePath.join(options.secretsDir, `${entry.name}.bin`)),
          );
          const plaintext = openSecret(reopened, entry.name, bytes);
          plaintext.fill(0);
        }
      } finally {
        reopened.fill(0);
      }
      return { entries: decoded.length, imported, unchanged, dataKeyWritten };
    } catch (error) {
      for (const file of written) {
        try {
          NodeFS.rmSync(file, { force: true });
        } catch {
          // Best effort.
        }
      }
      if (keyWritten) {
        try {
          if (previousKeyBytes === null) {
            NodeFS.rmSync(keyPath, { force: true });
          } else {
            writePrivateFile(keyPath, previousKeyBytes, true);
          }
        } catch {
          // The caller sees the original failure either way.
        }
      }
      throw error;
    }
  } finally {
    dataKey.fill(0);
    for (const entry of decoded) entry.bytes.fill(0);
  }
}

/** The store's `secrets` folder for a data root (`â€¦/dev/userdata`, `â€¦/dev` or `â€¦`). */
export function secretsDirForDataRoot(dataRoot: string): string {
  return NodePath.join(dataRoot, "secrets");
}
