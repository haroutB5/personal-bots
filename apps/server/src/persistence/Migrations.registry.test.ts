// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { migrationManifest } from "./Migrations.ts";
import { UPSTREAM_MIGRATION_IDS } from "./upstreamMigrationIds.ts";

// The migrator runs only ids above the latest applied one, so a duplicate id,
// a gap, or an upstream migration left at its upstream number would be
// skipped silently on a live database. These checks read Migrations.ts itself
// to tie every registered id to the file it imports.

const persistenceDir = import.meta.dirname;
const migrationsDir = NodePath.join(persistenceDir, "Migrations");
const registrySource = NodeFS.readFileSync(NodePath.join(persistenceDir, "Migrations.ts"), "utf8");

const importedFiles = new Map<string, string>();
for (const match of registrySource.matchAll(
  /^import (\w+) from "\.\/Migrations\/([^"]+)\.ts";$/gm,
)) {
  importedFiles.set(match[1]!, match[2]!);
}

const registered = [...registrySource.matchAll(/^\s*\[(\d+), "([^"]+)", (\w+)\],$/gm)].map(
  (match) => ({
    id: Number(match[1]),
    name: match[2]!,
    file: importedFiles.get(match[3]!),
  }),
);

const migrationFiles = NodeFS.readdirSync(migrationsDir)
  .filter((file) => /^\d{3}_\w+\.ts$/.test(file) && !file.endsWith(".test.ts"))
  .map((file) => file.slice(0, -".ts".length));

describe("migration registry", () => {
  it("parses the same entries the migrator loads", () => {
    expect(registered.map(({ id, name }) => [id, name])).toEqual(
      migrationManifest.map(([id, name]) => [id, name]),
    );
  });

  it("uses unique, contiguous ids from 1", () => {
    const ids = registered.map((entry) => entry.id);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => index + 1));
  });

  it("registers every migration file exactly once", () => {
    const files = registered.map((entry) => entry.file);
    expect(files.every((file) => file !== undefined)).toBe(true);
    expect(new Set(files).size).toBe(files.length);
    expect([...files].toSorted()).toEqual([...migrationFiles].toSorted());
  });

  it("keeps each file at its own number unless it is a mapped upstream migration", () => {
    for (const entry of registered) {
      const file = entry.file!;
      const fileNumber = Number(file.slice(0, 3));
      const fileName = file.slice(4);
      expect(entry.name, file).toBe(fileName);
      const mappedId = UPSTREAM_MIGRATION_IDS[file];
      expect(entry.id, file).toBe(mappedId ?? fileNumber);
    }
  });

  it("maps only files that exist and are registered", () => {
    for (const [file, id] of Object.entries(UPSTREAM_MIGRATION_IDS)) {
      expect(migrationFiles, file).toContain(file);
      expect(registered.find((entry) => entry.file === file)?.id, file).toBe(id);
    }
  });
});
