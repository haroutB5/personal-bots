export interface DuplicateRoot {
  readonly root: string;
  readonly files: number;
}

export interface DuplicatePackage {
  readonly name: string;
  readonly roots: ReadonlyArray<DuplicateRoot>;
}

interface PackageCopy {
  readonly name: string;
  readonly root: string;
}

const NODE_MODULES = "/node_modules/";
const WORKSPACE_PACKAGE = /^\/(?:apps|packages)\/([^/]+)\//u;
const PNPM_INTERNALS = new Set([".bin", ".cache", ".pnpm"]);

function copyOf(source: string): PackageCopy | null {
  const at = source.lastIndexOf(NODE_MODULES);
  if (at >= 0) {
    const segments = source.slice(at + NODE_MODULES.length).split("/");
    const first = segments[0];
    if (first === undefined || PNPM_INTERNALS.has(first)) {
      return null;
    }
    const scope = first.startsWith("@") ? `${first}/${segments[1] ?? ""}` : first;
    const fileAt = first.startsWith("@") ? 2 : 1;
    if (segments.length <= fileAt) {
      return null;
    }
    return { name: scope, root: `${source.slice(0, at + NODE_MODULES.length)}${scope}` };
  }
  const workspace = WORKSPACE_PACKAGE.exec(source);
  if (workspace === null) {
    return null;
  }
  const name = `workspace:${workspace[1] ?? ""}`;
  return { name, root: source.slice(0, workspace[0].length - 1) };
}

export function duplicatePackages(sources: ReadonlyArray<string>): ReadonlyArray<DuplicatePackage> {
  const copies = new Map<string, Map<string, number>>();
  for (const source of sources) {
    const copy = copyOf(source);
    if (copy === null) {
      continue;
    }
    const roots = copies.get(copy.name) ?? new Map<string, number>();
    roots.set(copy.root, (roots.get(copy.root) ?? 0) + 1);
    copies.set(copy.name, roots);
  }
  return [...copies]
    .filter(([, roots]) => roots.size > 1)
    .map(([name, roots]) => ({
      name,
      roots: [...roots].map(([root, files]) => ({ root, files })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
