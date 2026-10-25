// @effect-diagnostics nodeBuiltinImport:off - the fixtures are real secret-store files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  createWrappedDataKey,
  openSecret,
  parseWrappedDataKey,
  sealSecret,
  serializeWrappedDataKey,
  unwrapDataKey,
  type MachineMaterial,
} from "../../auth/secretEncryption.ts";
import {
  DATA_KEY_FILE_NAME,
  SecretsPortabilityError,
  exportSecretsBundle,
  importSecretsBundle,
} from "./secretsPortability.ts";

const PASSPHRASE = "correct horse battery staple";
const WINDOWS: MachineMaterial = {
  source: "win-machine-guid",
  material: "11111111-2222-3333-4444-555555555555",
};
const LINUX: MachineMaterial = { source: "machine-id", material: "0123456789abcdef0123456789abcdef" };

interface FakeStore {
  readonly dir: string;
  readonly values: ReadonlyMap<string, string>;
}

/** A store shaped like the live one: sealed logins and keys plus plaintext others. */
function makeStore(material: MachineMaterial, secrets: Record<string, string>): FakeStore {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-secrets-"));
  const { dataKey, file } = createWrappedDataKey(material);
  NodeFS.writeFileSync(NodePath.join(dir, DATA_KEY_FILE_NAME), serializeWrappedDataKey(file));
  for (const [name, value] of Object.entries(secrets)) {
    const sealed = sealSecret(dataKey, name, new TextEncoder().encode(value));
    NodeFS.writeFileSync(NodePath.join(dir, `${name}.bin`), Buffer.from(sealed));
  }
  // Not part of the bundle: session keys are plaintext and machine-bound.
  NodeFS.writeFileSync(NodePath.join(dir, "cloud-link-ed25519-key-pair.bin"), "session-material");
  dataKey.fill(0);
  return { dir, values: new Map(Object.entries(secrets)) };
}

const material =
  (current: MachineMaterial) =>
  (required?: MachineMaterial["source"]): MachineMaterial | null =>
    required === undefined || required === current.source ? current : null;

function readSecrets(dir: string, as: MachineMaterial): Map<string, string> {
  const keyFile = parseWrappedDataKey(
    NodeFS.readFileSync(NodePath.join(dir, DATA_KEY_FILE_NAME), "utf8"),
  );
  const dataKey = unwrapDataKey(keyFile, as);
  const out = new Map<string, string>();
  for (const file of NodeFS.readdirSync(dir)) {
    if (!file.endsWith(".bin")) continue;
    const name = file.slice(0, -".bin".length);
    if (!name.startsWith("personal-")) continue;
    const plaintext = openSecret(
      dataKey,
      name,
      Uint8Array.from(NodeFS.readFileSync(NodePath.join(dir, file))),
    );
    out.set(name, new TextDecoder().decode(plaintext));
    plaintext.fill(0);
  }
  dataKey.fill(0);
  return out;
}

const secrets = {
  "personal-login-aaaa": "fake-password-1",
  "personal-secret-bbbb": "sk-fake-api-key",
  "personal-connection-cccc": "fake-connection-token",
};

describe("secretsPortability", () => {
  it("moves saved secrets from Windows to Linux without plaintext on disk", () => {
    const source = makeStore(WINDOWS, secrets);
    const bundleFile = NodePath.join(NodeOS.tmpdir(), `bundle-${Date.now()}.json`);
    const exported = exportSecretsBundle({
      secretsDir: source.dir,
      outFile: bundleFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(WINDOWS) },
    });
    expect(exported.entries).toBe(3);
    expect(exported.source).toBe("win-machine-guid");

    // The bundle holds no readable secret value, and not the session key.
    const raw = NodeFS.readFileSync(bundleFile, "utf8");
    for (const value of Object.values(secrets)) expect(raw.includes(value)).toBe(false);
    expect(raw.includes("session-material")).toBe(false);
    expect(raw.includes(PASSPHRASE)).toBe(false);

    const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-secrets-linux-"));
    const imported = importSecretsBundle({
      secretsDir: target,
      bundleFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(LINUX) },
    });
    expect(imported).toEqual({
      entries: 3,
      imported: 3,
      unchanged: 0,
      dataKeyWritten: true,
    });
    // The new machine opens the same values with its OWN material.
    expect(readSecrets(target, LINUX)).toEqual(new Map(Object.entries(secrets)));
    // ... and the file records the Linux material, not Windows.
    expect(() => readSecrets(target, WINDOWS)).toThrow();

    // Idempotent: a second import writes nothing and keeps the key.
    const again = importSecretsBundle({
      secretsDir: target,
      bundleFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(LINUX) },
    });
    expect(again).toEqual({ entries: 3, imported: 0, unchanged: 3, dataKeyWritten: false });
  });

  it("refuses a wrong passphrase and a tampered bundle", () => {
    const source = makeStore(WINDOWS, secrets);
    const bundleFile = NodePath.join(NodeOS.tmpdir(), `bundle-bad-${Date.now()}.json`);
    exportSecretsBundle({
      secretsDir: source.dir,
      outFile: bundleFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(WINDOWS) },
    });
    const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-target-"));
    const wrong = () =>
      importSecretsBundle({
        secretsDir: target,
        bundleFile,
        passphrase: "not the right passphrase",
        deps: { resolveMachineMaterial: material(LINUX) },
      });
    expect(wrong).toThrow(SecretsPortabilityError);
    try {
      wrong();
    } catch (error) {
      expect((error as SecretsPortabilityError).code).toBe("bad-passphrase");
    }

    const bundle = JSON.parse(NodeFS.readFileSync(bundleFile, "utf8"));
    bundle.entries[0].sealed = Buffer.from("tampered").toString("base64");
    NodeFS.writeFileSync(bundleFile, JSON.stringify(bundle));
    try {
      importSecretsBundle({
        secretsDir: target,
        bundleFile,
        passphrase: PASSPHRASE,
        deps: { resolveMachineMaterial: material(LINUX) },
      });
      throw new Error("the import should have failed");
    } catch (error) {
      expect((error as SecretsPortabilityError).code).toBe("checksum-mismatch");
    }
  });

  it("does not silently replace a machine that already has another key", () => {
    const source = makeStore(WINDOWS, secrets);
    const bundleFile = NodePath.join(NodeOS.tmpdir(), `bundle-key-${Date.now()}.json`);
    exportSecretsBundle({
      secretsDir: source.dir,
      outFile: bundleFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(WINDOWS) },
    });
    const target = makeStore(LINUX, { "personal-secret-old": "old-value" });
    try {
      importSecretsBundle({
        secretsDir: target.dir,
        bundleFile,
        passphrase: PASSPHRASE,
        deps: { resolveMachineMaterial: material(LINUX) },
      });
      throw new Error("the import should have refused");
    } catch (error) {
      expect((error as SecretsPortabilityError).code).toBe("target-key-differs");
    }
    const forced = importSecretsBundle({
      secretsDir: target.dir,
      bundleFile,
      passphrase: PASSPHRASE,
      force: true,
      deps: { resolveMachineMaterial: material(LINUX) },
    });
    expect(forced.imported).toBe(3);
    expect(readSecrets(target.dir, LINUX)).toEqual(new Map(Object.entries(secrets)));
  });

  it("validates the passphrase and refuses to overwrite a bundle by accident", () => {
    const source = makeStore(WINDOWS, secrets);
    const outFile = NodePath.join(NodeOS.tmpdir(), `bundle-twice-${Date.now()}.json`);
    expect(() =>
      exportSecretsBundle({
        secretsDir: source.dir,
        outFile,
        passphrase: "short",
        deps: { resolveMachineMaterial: material(WINDOWS) },
      }),
    ).toThrow(SecretsPortabilityError);
    exportSecretsBundle({
      secretsDir: source.dir,
      outFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(WINDOWS) },
    });
    try {
      exportSecretsBundle({
        secretsDir: source.dir,
        outFile,
        passphrase: PASSPHRASE,
        deps: { resolveMachineMaterial: material(WINDOWS) },
      });
      throw new Error("the export should have refused");
    } catch (error) {
      expect((error as SecretsPortabilityError).code).toBe("bundle-exists");
    }
    expect(() =>
      exportSecretsBundle({
        secretsDir: source.dir,
        outFile,
        passphrase: PASSPHRASE,
        force: true,
        deps: { resolveMachineMaterial: material(WINDOWS) },
      }),
    ).not.toThrow();
  });

  it("refuses a bundle whose key does not match its entries", () => {
    const source = makeStore(WINDOWS, secrets);
    const bundleFile = NodePath.join(NodeOS.tmpdir(), `bundle-swap-${Date.now()}.json`);
    exportSecretsBundle({
      secretsDir: source.dir,
      outFile: bundleFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(WINDOWS) },
    });
    const other = makeStore(WINDOWS, { "personal-login-dddd": "other-password" });
    const otherBundle = NodePath.join(NodeOS.tmpdir(), `bundle-other-${Date.now()}.json`);
    exportSecretsBundle({
      secretsDir: other.dir,
      outFile: otherBundle,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(WINDOWS) },
    });
    const bundle = JSON.parse(NodeFS.readFileSync(bundleFile, "utf8"));
    const otherRaw = JSON.parse(NodeFS.readFileSync(otherBundle, "utf8"));
    bundle.entries = otherRaw.entries;
    NodeFS.writeFileSync(bundleFile, JSON.stringify(bundle));
    const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-swap-"));
    try {
      importSecretsBundle({
        secretsDir: target,
        bundleFile,
        passphrase: PASSPHRASE,
        deps: { resolveMachineMaterial: material(LINUX) },
      });
      throw new Error("the import should have failed");
    } catch (error) {
      expect((error as SecretsPortabilityError).code).toBe("entry-unreadable");
    }
    // Nothing was left behind.
    expect(NodeFS.readdirSync(target)).toEqual([]);
  });
});
