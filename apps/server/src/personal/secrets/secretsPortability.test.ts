// @effect-diagnostics nodeBuiltinImport:off - the fixtures are real secret-store files.
// @effect-diagnostics globalDate:off - test fixtures name their temp files by wall clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeModule from "node:module";

import { describe, expect, it } from "@effect/vitest";

import {
  createWrappedDataKey,
  openSecret,
  parseWrappedDataKey,
  sealSecret,
  serializeWrappedDataKey,
  tryUnwrapDataKey,
  type MachineMaterial,
} from "../../auth/secretEncryption.ts";
import { runSecretsRewrap, runSecretsStatus } from "../../cli/secrets.ts";
import {
  NEW_MACHINE,
  OLD_MACHINE,
  seedSealedStore,
  snapshotDir,
} from "../testing/lockedSecretStoreFixture.ts";
import {
  DATA_KEY_FILE_NAME,
  SecretsPortabilityError,
  exportSecretsBundle,
  importSecretsBundle,
  inspectSealedStore,
  rewrapDataKey,
} from "./secretsPortability.ts";

const PASSPHRASE = "correct horse battery staple";
const WINDOWS: MachineMaterial = {
  source: "win-machine-guid",
  material: "11111111-2222-3333-4444-555555555555",
};
const LINUX: MachineMaterial = {
  source: "machine-id",
  material: "0123456789abcdef0123456789abcdef",
};

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
  const opened = tryUnwrapDataKey(keyFile, as);
  if (opened._tag === "Locked") throw new Error(`key does not open: ${opened.reason}`);
  const dataKey = opened.dataKey;
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
      keyBackup: null,
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
    expect(again).toEqual({
      entries: 3,
      imported: 0,
      unchanged: 3,
      dataKeyWritten: false,
      keyBackup: null,
    });
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

  it("never strands saved secrets on a machine that already has another key", () => {
    const source = makeStore(WINDOWS, secrets);
    const bundleFile = NodePath.join(NodeOS.tmpdir(), `bundle-key-${Date.now()}.json`);
    exportSecretsBundle({
      secretsDir: source.dir,
      outFile: bundleFile,
      passphrase: PASSPHRASE,
      deps: { resolveMachineMaterial: material(WINDOWS) },
    });
    const target = makeStore(LINUX, { "personal-secret-old": "old-value" });
    const attempt = (force: boolean): string => {
      try {
        importSecretsBundle({
          secretsDir: target.dir,
          bundleFile,
          passphrase: PASSPHRASE,
          force,
          deps: { resolveMachineMaterial: material(LINUX) },
        });
        return "ok";
      } catch (error) {
        return (error as SecretsPortabilityError).code;
      }
    };
    // Without force, and again with it: the old store must not be orphaned.
    expect(attempt(false)).toBe("target-key-differs");
    expect(attempt(true)).toBe("target-key-differs");
    expect(readSecrets(target.dir, LINUX)).toEqual(new Map([["personal-secret-old", "old-value"]]));

    // A key file with no saved secrets behind it may be replaced with force.
    const stray = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-stray-"));
    const strayKey = createWrappedDataKey(LINUX);
    NodeFS.writeFileSync(
      NodePath.join(stray, DATA_KEY_FILE_NAME),
      serializeWrappedDataKey(strayKey.file),
    );
    strayKey.dataKey.fill(0);
    const forced = importSecretsBundle({
      secretsDir: stray,
      bundleFile,
      passphrase: PASSPHRASE,
      force: true,
      deps: { resolveMachineMaterial: material(LINUX) },
    });
    expect(forced.imported).toBe(3);
    expect(readSecrets(stray, LINUX)).toEqual(new Map(Object.entries(secrets)));
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

const codeOf = (action: () => unknown): string => {
  try {
    action();
    return "ok";
  } catch (error) {
    return error instanceof SecretsPortabilityError ? error.code : "other-error";
  }
};

const thirteen: Record<string, string> = {
  "personal-login-0001": "fake-login-1",
  "personal-login-0002": "fake-login-2",
  ...Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => [`personal-secret-${index}`, `fake-key-${index}`]),
  ),
};

function movedStore(extra: Record<string, string> = {}) {
  const old = makeStore(OLD_MACHINE, { ...thirteen, ...extra });
  const moved = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-moved-"));
  for (const file of NodeFS.readdirSync(old.dir)) {
    NodeFS.copyFileSync(NodePath.join(old.dir, file), NodePath.join(moved, file));
  }
  const bundleFile = NodePath.join(NodeOS.tmpdir(), `bundle-moved-${NodeCrypto.randomUUID()}.json`);
  return { old, moved, bundleFile };
}

const exportOld = (dir: string, bundleFile: string) =>
  exportSecretsBundle({
    secretsDir: dir,
    outFile: bundleFile,
    passphrase: PASSPHRASE,
    deps: { resolveMachineMaterial: material(OLD_MACHINE) },
  });

const importOnNew = (dir: string, bundleFile: string, force = false) =>
  importSecretsBundle({
    secretsDir: dir,
    bundleFile,
    passphrase: PASSPHRASE,
    force,
    deps: { resolveMachineMaterial: material(NEW_MACHINE) },
  });

const sealUnderOldKey = (dir: string, name: string, value: string) => {
  const keyFile = parseWrappedDataKey(
    NodeFS.readFileSync(NodePath.join(dir, DATA_KEY_FILE_NAME), "utf8"),
  );
  const opened = tryUnwrapDataKey(keyFile, OLD_MACHINE);
  if (opened._tag === "Locked") throw new Error(`key does not open: ${opened.reason}`);
  NodeFS.writeFileSync(
    NodePath.join(dir, `${name}.bin`),
    Buffer.from(sealSecret(opened.dataKey, name, new TextEncoder().encode(value))),
  );
  opened.dataKey.fill(0);
};

const keyBackups = (dir: string) =>
  NodeFS.readdirSync(dir).filter((name) => name.startsWith(`${DATA_KEY_FILE_NAME}.locked-`));

describe("a moved store whose key does not open here", () => {
  it("imports in place when every local entry opens with the bundle key", () => {
    const { old, moved, bundleFile } = movedStore();
    exportOld(old.dir, bundleFile);
    const entryBytesBefore = [...snapshotDir(moved)].filter(([name]) => name.endsWith(".bin"));
    const oldKeyText = NodeFS.readFileSync(NodePath.join(moved, DATA_KEY_FILE_NAME), "utf8");

    const result = importOnNew(moved, bundleFile);

    const [backupName, ...otherBackups] = keyBackups(moved);
    expect(otherBackups).toEqual([]);
    const backupPath = NodePath.join(moved, backupName!);
    expect(result).toEqual({
      entries: 13,
      imported: 0,
      unchanged: 13,
      dataKeyWritten: true,
      keyBackup: backupPath,
    });
    expect(NodeFS.readFileSync(backupPath, "utf8")).toBe(oldKeyText);
    expect(NodeFS.statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(readSecrets(moved, NEW_MACHINE)).toEqual(new Map(Object.entries(thirteen)));
    expect([...snapshotDir(moved)].filter(([name]) => name.endsWith(".bin"))).toEqual(
      entryBytesBefore,
    );
  });

  it("refuses and writes nothing when a local entry is sealed under another key", () => {
    const { old, moved, bundleFile } = movedStore();
    exportOld(old.dir, bundleFile);
    seedSealedStore(NodePath.join(moved, "other"), NEW_MACHINE, { "personal-secret-stray": "x" });
    NodeFS.copyFileSync(
      NodePath.join(moved, "other", "personal-secret-stray.bin"),
      NodePath.join(moved, "personal-secret-stray.bin"),
    );
    NodeFS.rmSync(NodePath.join(moved, "other"), { recursive: true });
    const before = snapshotDir(moved);

    expect(codeOf(() => importOnNew(moved, bundleFile))).toBe("target-key-differs");
    expect(codeOf(() => importOnNew(moved, bundleFile, true))).toBe("target-key-differs");
    expect(snapshotDir(moved)).toEqual(before);
  });
});

describe("import over a store with no key file", () => {
  it("refuses and writes nothing when a local entry is sealed under the lost key", () => {
    const { old, moved, bundleFile } = movedStore();
    exportOld(old.dir, bundleFile);
    NodeFS.rmSync(NodePath.join(moved, DATA_KEY_FILE_NAME));
    const lost = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-lost-"));
    seedSealedStore(lost, NEW_MACHINE, { "personal-secret-0": "sealed-under-lost-key" });
    NodeFS.copyFileSync(
      NodePath.join(lost, "personal-secret-0.bin"),
      NodePath.join(moved, "personal-secret-0.bin"),
    );
    const before = snapshotDir(moved);

    expect(codeOf(() => importOnNew(moved, bundleFile))).toBe("target-key-differs");
    expect(codeOf(() => importOnNew(moved, bundleFile, true))).toBe("target-key-differs");
    expect(snapshotDir(moved)).toEqual(before);
  });

  it("imports when every local entry is a byte copy of the bundle", () => {
    const { old, moved, bundleFile } = movedStore();
    exportOld(old.dir, bundleFile);
    NodeFS.rmSync(NodePath.join(moved, DATA_KEY_FILE_NAME));

    const result = importOnNew(moved, bundleFile);

    expect(result).toEqual({
      entries: 13,
      imported: 0,
      unchanged: 13,
      dataKeyWritten: true,
      keyBackup: null,
    });
    expect(readSecrets(moved, NEW_MACHINE)).toEqual(new Map(Object.entries(thirteen)));
    expect(keyBackups(moved)).toEqual([]);
  });
});

describe("a failed import", () => {
  it("puts back the original bytes of every entry it overwrote and the original key file", () => {
    const { old, moved, bundleFile } = movedStore({ "personal-secret-zznew": "only-in-bundle" });
    exportOld(old.dir, bundleFile);
    NodeFS.rmSync(NodePath.join(moved, "personal-secret-zznew.bin"));
    sealUnderOldKey(moved, "personal-secret-0", "local-value-differs-from-bundle");
    const before = snapshotDir(moved);

    const fsCjs = NodeModule.createRequire(import.meta.url)("node:fs") as typeof NodeFS;
    const original = fsCjs.renameSync;
    fsCjs.renameSync = ((from: NodeFS.PathLike, to: NodeFS.PathLike) => {
      if (String(to).endsWith("personal-secret-zznew.bin")) throw new Error("injected ENOSPC");
      return original(from, to);
    }) as typeof NodeFS.renameSync;
    NodeModule.syncBuiltinESMExports();
    let code = "";
    try {
      code = codeOf(() => importOnNew(moved, bundleFile));
    } finally {
      fsCjs.renameSync = original;
      NodeModule.syncBuiltinESMExports();
    }

    expect(code).toBe("write-failed");
    expect(snapshotDir(moved)).toEqual(before);
  });
});

describe("secrets rewrap and status", () => {
  const okIo = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) },
    };
  };

  it("reports a moved store as locked with its sealed count, and an opened one as open", () => {
    const { moved } = movedStore();
    expect(inspectSealedStore(moved, { resolveMachineMaterial: material(NEW_MACHINE) })).toEqual({
      state: "locked",
      reason: "material-mismatch",
      source: "machine-id",
      sealed: 13,
    });
    expect(inspectSealedStore(moved, { resolveMachineMaterial: material(OLD_MACHINE) })).toEqual({
      state: "open",
      source: "machine-id",
      sealed: 13,
      unreadable: 0,
    });
    const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-empty-"));
    expect(inspectSealedStore(empty)).toEqual({ state: "absent", sealed: 0 });

    const printed = okIo();
    const code = runSecretsStatus({ secretsDir: moved, json: true }, printed.io);
    expect(code).toBe(1);
    expect(JSON.parse(printed.out.join(""))).toMatchObject({ state: "locked", sealed: 13 });
  });

  it("writes nothing with the wrong material and exits with wrong-material", () => {
    const { moved } = movedStore();
    const before = snapshotDir(moved);

    expect(
      codeOf(() =>
        rewrapDataKey({
          secretsDir: moved,
          oldMaterial: "not-the-old-machine",
          check: false,
          deps: { resolveMachineMaterial: material(NEW_MACHINE) },
        }),
      ),
    ).toBe("wrong-material");

    const printed = okIo();
    const code = runSecretsRewrap(
      { secretsDir: moved, fromMaterialEnv: "OLD_MATERIAL", check: false, json: true },
      { env: { OLD_MATERIAL: "not-the-old-machine" }, io: printed.io },
    );
    expect(code).toBe(1);
    expect(JSON.parse(printed.out.join(""))).toEqual({ ok: false, code: "wrong-material" });
    expect(printed.err.join("")).not.toContain("not-the-old-machine");
    expect(snapshotDir(moved)).toEqual(before);
  });

  it("with --check proves the old material and writes nothing", () => {
    const { moved } = movedStore();
    const before = snapshotDir(moved);
    const result = rewrapDataKey({
      secretsDir: moved,
      oldMaterial: OLD_MACHINE.material,
      check: true,
      deps: { resolveMachineMaterial: material(NEW_MACHINE) },
    });
    expect(result).toEqual({ status: "would-rewrap", entries: 13 });
    expect(snapshotDir(moved)).toEqual(before);
  });

  it("re-wraps for this machine, keeps a backup, and a second run is a no-op", () => {
    const { moved } = movedStore();
    const oldKeyText = NodeFS.readFileSync(NodePath.join(moved, DATA_KEY_FILE_NAME), "utf8");
    const deps = { resolveMachineMaterial: material(NEW_MACHINE), now: () => 1_700_000_000_000 };

    const first = rewrapDataKey({
      secretsDir: moved,
      oldMaterial: OLD_MACHINE.material,
      check: false,
      deps,
    });

    expect(first.status).toBe("rewrapped");
    expect(readSecrets(moved, NEW_MACHINE)).toEqual(new Map(Object.entries(thirteen)));
    const backups = NodeFS.readdirSync(moved).filter((name) =>
      name.startsWith(`${DATA_KEY_FILE_NAME}.locked-`),
    );
    expect(backups).toHaveLength(1);
    const backupPath = NodePath.join(moved, backups[0]!);
    expect(NodeFS.readFileSync(backupPath, "utf8")).toBe(oldKeyText);
    expect(NodeFS.statSync(backupPath).mode & 0o777).toBe(0o600);

    const afterFirst = snapshotDir(moved);
    const second = rewrapDataKey({
      secretsDir: moved,
      oldMaterial: OLD_MACHINE.material,
      check: false,
      deps,
    });
    expect(second).toEqual({ status: "already-open", entries: 13 });
    expect(snapshotDir(moved)).toEqual(afterFirst);
  });

  it("refuses with entry-unreadable when an entry is sealed under another key", () => {
    const { moved } = movedStore();
    const stray = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-stray-entry-"));
    seedSealedStore(stray, NEW_MACHINE, { "personal-secret-stray": "x" });
    NodeFS.copyFileSync(
      NodePath.join(stray, "personal-secret-stray.bin"),
      NodePath.join(moved, "personal-secret-stray.bin"),
    );
    const before = snapshotDir(moved);

    expect(
      codeOf(() =>
        rewrapDataKey({
          secretsDir: moved,
          oldMaterial: OLD_MACHINE.material,
          check: false,
          deps: { resolveMachineMaterial: material(NEW_MACHINE) },
        }),
      ),
    ).toBe("entry-unreadable");
    expect(snapshotDir(moved)).toEqual(before);
  });
});
