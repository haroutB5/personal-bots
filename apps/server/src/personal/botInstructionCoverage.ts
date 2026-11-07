/**
 * Ground truth for "does a bot on this provider actually get its persona?".
 *
 * A personal bot's name, instructions and app rules only reach the model
 * when its provider's adapter passes them through `withBotInstructions`
 * (see `provider/RuntimeInstructions.ts`). An adapter that ignores
 * `systemInstructions` answers as the bare model and says nothing about it.
 *
 * Rather than trust a hand-written list, this module derives the covered set
 * from the source: it walks each built-in driver to the adapter module it
 * builds, follows that adapter's local imports, and reports whether
 * `withBotInstructions` is called anywhere in that closure. The test beside
 * this file compares the result with `BOT_INSTRUCTION_DRIVER_KINDS` in
 * contracts, which is what the bot form and seeding actually read.
 *
 * It is a source scan, not a type-level check, because the call sites are
 * deep inside adapter internals (Codex reaches it two modules down, through
 * `CodexSessionRuntime` -> `CodexDeveloperInstructions`) and no runtime
 * value exposes the fact.
 *
 * @module personal/botInstructionCoverage
 */
// A source-tree analyser used by a test, never by the running server: it reads
// adapter files off disk to prove which drivers really call
// `withBotInstructions`. Effect's FileSystem would buy nothing here and would
// turn a plain synchronous walk into an Effect program.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * A *call* to `withBotInstructions`. The declaration is excluded
 * deliberately: every adapter imports `RuntimeInstructions.ts` for the
 * harness blurb, so matching the module that declares the function would
 * mark all six drivers as covered.
 */
const INSTRUCTIONS_CALL = /\bwithBotInstructions\s*\(/;
const INSTRUCTIONS_DECLARATION = /function\s+withBotInstructions\s*\(/;

const callsWithBotInstructions = (source: string): boolean =>
  INSTRUCTIONS_CALL.test(source) && !INSTRUCTIONS_DECLARATION.test(source);

const DRIVER_KIND_PATTERN = /ProviderDriverKind\.make\(\s*"([^"]+)"\s*\)/;
const DRIVER_KIND_CONSTANT_PATTERN = /\b([A-Z][A-Z0-9_]*_DRIVER_KIND)\b/;
const RELATIVE_IMPORT_PATTERN = /from\s+"(\.[^"]+\.ts)"/g;

export interface DriverInstructionCoverage {
  /** Driver kind slug, as declared by the driver module itself. */
  readonly driverKind: string;
  /** Driver source file, relative to the provider directory. */
  readonly driverFile: string;
  /** Adapter modules the driver imports; empty means the scan found none. */
  readonly adapterFiles: ReadonlyArray<string>;
  /** True when `withBotInstructions` is called in the adapter's import closure. */
  readonly carriesBotInstructions: boolean;
  /** The file in that closure holding the call, for a readable failure. */
  readonly callSite: string | null;
}

const readFile = (file: string): string => NodeFS.readFileSync(file, "utf8");

const PACKAGE_IMPORT_PATTERN = /from\s+"@t3tools\/([^"/]+)\/([^"]+)"/g;

const localImportsOf = (file: string): ReadonlyArray<string> => {
  const directory = NodePath.dirname(file);
  const resolved: Array<string> = [];
  for (const match of readFile(file).matchAll(RELATIVE_IMPORT_PATTERN)) {
    const target = NodePath.resolve(directory, match[1]!);
    if (NodeFS.existsSync(target)) resolved.push(target);
  }
  return resolved;
};

/** Workspace package imports, so a shared adapter (ACP) stays in the closure. */
const packageImportsOf = (file: string, packagesDirectory: string): ReadonlyArray<string> => {
  const resolved: Array<string> = [];
  for (const match of readFile(file).matchAll(PACKAGE_IMPORT_PATTERN)) {
    const subpath = match[2]!.endsWith(".ts") ? match[2]! : `${match[2]!}.ts`;
    const target = NodePath.join(packagesDirectory, match[1]!, "src", subpath);
    if (NodeFS.existsSync(target)) resolved.push(target);
  }
  return resolved;
};

/**
 * A driver declares its kind inline, or imports a `*_DRIVER_KIND` constant
 * from a sibling module (fx does the latter).
 */
const driverKindOf = (file: string): string | undefined => {
  const source = readFile(file);
  const direct = DRIVER_KIND_PATTERN.exec(source)?.[1];
  if (direct !== undefined) return direct;
  const constant = DRIVER_KIND_CONSTANT_PATTERN.exec(source)?.[1];
  if (constant === undefined) return undefined;
  const declaration = new RegExp(
    `export const ${constant} = ProviderDriverKind\\.make\\(\\s*"([^"]+)"\\s*\\)`,
  );
  for (const imported of localImportsOf(file)) {
    const match = declaration.exec(readFile(imported));
    if (match !== null) return match[1];
  }
  return undefined;
};

/**
 * Breadth-first walk of an adapter's local import closure, stopping at the
 * first module that calls `withBotInstructions`. `maxDepth` keeps the walk
 * near the adapter: the real call sites are at depth 0 (Claude, OpenCode)
 * and depth 2 (Codex), so a module that merely happens to sit far below an
 * adapter cannot make an uncovered provider look covered.
 */
const findInstructionsCall = (
  entries: ReadonlyArray<string>,
  maxDepth: number,
  packagesDirectory: string,
): string | null => {
  const seen = new Set<string>(entries);
  let frontier = [...entries];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: Array<string> = [];
    for (const file of frontier) {
      if (callsWithBotInstructions(readFile(file))) return file;
      if (depth === maxDepth) continue;
      for (const imported of [
        ...localImportsOf(file),
        ...packageImportsOf(file, packagesDirectory),
      ]) {
        if (seen.has(imported)) continue;
        seen.add(imported);
        next.push(imported);
      }
    }
    frontier = next;
  }
  return null;
};

/**
 * Scan every `*Driver.ts` under `provider/Drivers` and report, per driver
 * kind, whether the adapter it builds carries bot instructions.
 */
export function scanDriverInstructionCoverage(
  providerDirectory: string,
  options?: {
    readonly maxDepth?: number;
    /** Also scan package drivers, e.g. a `packages/provider-<name>/src/server/driver.ts` file. */
    readonly extraDriverFiles?: ReadonlyArray<string>;
    /** Workspace packages root, for imports such as `@t3tools/provider-acp/server/adapter`. */
    readonly packagesDirectory?: string;
  },
): ReadonlyArray<DriverInstructionCoverage> {
  const packagesDirectory =
    options?.packagesDirectory ?? NodePath.resolve(providerDirectory, "../../../../packages");
  const driversDirectory = NodePath.join(providerDirectory, "Drivers");
  const localDriverFiles = NodeFS.readdirSync(driversDirectory)
    .filter((name) => name.endsWith("Driver.ts") && !name.includes(".test."))
    .sort()
    .map((name) => NodePath.join(driversDirectory, name));
  const driverFiles = [...localDriverFiles, ...(options?.extraDriverFiles ?? [])].filter((file) =>
    NodeFS.existsSync(file),
  );
  const coverage: Array<DriverInstructionCoverage> = [];
  for (const driverFile of driverFiles) {
    const driverKind = driverKindOf(driverFile);
    if (driverKind === undefined) continue;
    const adapterFiles = localImportsOf(driverFile).filter(
      (file) => /(?:^|\/)adapter\.ts$/.test(file) || /Adapter(?:V2)?\.ts$/.test(file),
    );
    const callSite = findInstructionsCall(adapterFiles, options?.maxDepth ?? 3, packagesDirectory);
    coverage.push({
      driverKind,
      driverFile: NodePath.relative(providerDirectory, driverFile).replaceAll("\\", "/"),
      adapterFiles: adapterFiles.map((file) =>
        NodePath.relative(providerDirectory, file).replaceAll("\\", "/"),
      ),
      carriesBotInstructions: callSite !== null,
      callSite:
        callSite === null
          ? null
          : NodePath.relative(providerDirectory, callSite).replaceAll("\\", "/"),
    });
  }
  return coverage;
}
