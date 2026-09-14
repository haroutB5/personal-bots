// @effect-diagnostics nodeBuiltinImport:off - crypto primitives and the machine-material probes are plain Node calls at a trust boundary.
/**
 * At-rest encryption for the secret files the personal features write.
 *
 * Threat model, stated honestly because the guarantee is narrower than
 * "encrypted secrets" usually implies:
 *
 * - This prevents direct plaintext reads of the password files. Machine
 *   identifiers are not secrets: a copy of the files can still be decrypted
 *   anywhere if the original machine material is known.
 * - What this does NOT stop: code running as the same OS user. It can read the
 *   same key file and the same machine material this module reads. Defeating
 *   that needs an OS-enforced boundary between bot runtimes and the credential
 *   broker, including its key and browser profile. An OS keystore under the
 *   same user identity alone does not provide that boundary.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

/** "T3SEC1" — distinguishes a sealed file from a legacy plaintext one. */
const ENVELOPE_MAGIC = Uint8Array.from([0x54, 0x33, 0x53, 0x45, 0x43, 0x31]);
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.length + IV_BYTES + TAG_BYTES;

const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** Any `personal-login-*` file written from this version on is sealed. */
export const isSealedSecret = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= ENVELOPE_HEADER_BYTES &&
  ENVELOPE_MAGIC.every((byte, index) => bytes[index] === byte);

/**
 * AES-256-GCM. The secret's own name is the additional authenticated data, so
 * a sealed file cannot be renamed onto another login's `secret_ref` to make
 * `use_login` fill the wrong password.
 */
export const sealSecret = (key: Uint8Array, name: string, plaintext: Uint8Array): Uint8Array => {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Uint8Array.from(Buffer.concat([ENVELOPE_MAGIC, iv, tag, body]));
};

export const openSecret = (key: Uint8Array, name: string, envelope: Uint8Array): Uint8Array => {
  if (!isSealedSecret(envelope)) throw new Error("Secret file is not a sealed envelope.");
  const buffer = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const iv = buffer.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + IV_BYTES);
  const tag = buffer.subarray(ENVELOPE_MAGIC.length + IV_BYTES, ENVELOPE_HEADER_BYTES);
  const body = buffer.subarray(ENVELOPE_HEADER_BYTES);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(tag);
  return Uint8Array.from(Buffer.concat([decipher.update(body), decipher.final()]));
};

export type MachineMaterialSource = "win-machine-guid" | "machine-id" | "host";

const windowsMachineGuid = (): string | null => {
  if (HostProcessPlatform.defaultValue() !== "win32") return null;
  try {
    const output = NodeChildProcess.execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    return /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
};

const linuxMachineId = (): string | null => {
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = NodeFS.readFileSync(candidate, "utf8").trim();
      if (value.length > 0) return value;
    } catch {
      continue;
    }
  }
  return null;
};

/** Always available, and always the weakest option: only used when the others are. */
const hostMaterial = (): string =>
  [
    NodeOS.hostname(),
    HostProcessPlatform.defaultValue(),
    NodeOS.homedir(),
    NodeOS.userInfo().username,
  ].join("|");

export interface MachineMaterial {
  readonly source: MachineMaterialSource;
  readonly material: string;
}

/**
 * `required` pins the source recorded in an existing key file, so a transient
 * failure of a stronger probe can never silently re-derive a different key and
 * make every saved password unreadable.
 */
export const resolveMachineMaterial = (
  required?: MachineMaterialSource,
): MachineMaterial | null => {
  const guid =
    required === undefined || required === "win-machine-guid" ? windowsMachineGuid() : null;
  if (guid !== null) return { source: "win-machine-guid", material: guid };
  const machineId = required === undefined || required === "machine-id" ? linuxMachineId() : null;
  if (machineId !== null) return { source: "machine-id", material: machineId };
  if (required === undefined || required === "host") {
    return { source: "host", material: hostMaterial() };
  }
  return null;
};

const deriveWrappingKey = (material: string, salt: Uint8Array): Uint8Array =>
  Uint8Array.from(
    NodeCrypto.scryptSync(`t3/personal-secrets/v1 ${material}`, salt, KEY_BYTES, {
      ...SCRYPT_OPTIONS,
    }),
  );

/** Protect this file: machine material is not a secret independent wrapping key. */
export interface WrappedDataKeyFile {
  readonly v: 1;
  readonly source: MachineMaterialSource;
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly key: string;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

export const createWrappedDataKey = (): {
  readonly dataKey: Uint8Array;
  readonly file: WrappedDataKeyFile;
} => {
  const resolved = resolveMachineMaterial();
  if (resolved === null) throw new Error("No machine material is available to protect secrets.");
  const dataKey = Uint8Array.from(NodeCrypto.randomBytes(KEY_BYTES));
  const salt = NodeCrypto.randomBytes(SALT_BYTES);
  const wrappingKey = deriveWrappingKey(resolved.material, salt);
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", wrappingKey, iv);
  const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    dataKey,
    file: {
      v: 1,
      source: resolved.source,
      salt: base64(salt),
      iv: base64(iv),
      tag: base64(cipher.getAuthTag()),
      key: base64(body),
    },
  };
};

export const unwrapDataKey = (file: WrappedDataKeyFile): Uint8Array => {
  if (file.v !== 1) throw new Error(`Unsupported secret key file version ${String(file.v)}.`);
  const resolved = resolveMachineMaterial(file.source);
  if (resolved === null) {
    throw new Error(`Machine material "${file.source}" is not available on this machine.`);
  }
  const wrappingKey = deriveWrappingKey(resolved.material, fromBase64(file.salt));
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", wrappingKey, fromBase64(file.iv));
  decipher.setAuthTag(fromBase64(file.tag));
  return Uint8Array.from(Buffer.concat([decipher.update(fromBase64(file.key)), decipher.final()]));
};

export const serializeWrappedDataKey = (file: WrappedDataKeyFile): string =>
  `${JSON.stringify(file, null, 2)}\n`;

export const parseWrappedDataKey = (raw: string): WrappedDataKeyFile => {
  const parsed = JSON.parse(raw) as Partial<WrappedDataKeyFile>;
  if (
    parsed.v !== 1 ||
    typeof parsed.source !== "string" ||
    typeof parsed.salt !== "string" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.key !== "string"
  ) {
    throw new Error("Secret key file is malformed.");
  }
  return parsed as WrappedDataKeyFile;
};
