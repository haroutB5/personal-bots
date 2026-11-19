// @effect-diagnostics nodeBuiltinImport:off - the fixture writes real secret-store files into a temp folder.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  createWrappedDataKey,
  sealSecret,
  serializeWrappedDataKey,
  wrapDataKey,
  type MachineMaterial,
} from "../../auth/secretEncryption.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { decorateSecretStore } from "../secrets/sealedSecretStore.ts";

export const DATA_KEY_FILE = "data-encryption-key.json";
export const OLD_MACHINE: MachineMaterial = { source: "machine-id", material: "old-machine" };
export const NEW_MACHINE: MachineMaterial = { source: "machine-id", material: "new-machine" };

export const materialOf =
  (current: MachineMaterial) =>
  (required?: MachineMaterial["source"]): MachineMaterial | null =>
    required === undefined || required === current.source ? current : null;

export const seedSealedStore = (
  dir: string,
  wrappedFor: MachineMaterial,
  secrets: Readonly<Record<string, string>>,
  options: { readonly keyFile?: boolean } = {},
): Uint8Array => {
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { dataKey, file } = createWrappedDataKey(wrappedFor);
  if (options.keyFile !== false) {
    NodeFS.writeFileSync(NodePath.join(dir, DATA_KEY_FILE), serializeWrappedDataKey(file));
  }
  for (const [name, value] of Object.entries(secrets)) {
    NodeFS.writeFileSync(
      NodePath.join(dir, `${name}.bin`),
      Buffer.from(sealSecret(dataKey, name, new TextEncoder().encode(value))),
    );
  }
  return dataKey;
};

export const writeKeyFileFor = (dir: string, dataKey: Uint8Array, material: MachineMaterial) => {
  NodeFS.writeFileSync(
    NodePath.join(dir, DATA_KEY_FILE),
    serializeWrappedDataKey(wrapDataKey(dataKey, material)),
  );
};

export const snapshotDir = (dir: string): ReadonlyMap<string, string> =>
  new Map(
    NodeFS.readdirSync(dir).map((entry) => [
      entry,
      NodeFS.readFileSync(NodePath.join(dir, entry)).toString("base64"),
    ]),
  );

export const layerStoreOnMachine = (
  current: MachineMaterial,
  seed?: (secretsDir: string) => void,
) =>
  Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      seed?.(config.secretsDir);
      const base = yield* ServerSecretStore.make;
      return yield* decorateSecretStore(
        base,
        { fileSystem, path },
        { resolveMachineMaterial: materialOf(current) },
      );
    }),
  );
