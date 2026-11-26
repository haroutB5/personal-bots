/** Keep bundler externals and staged runtime dependency roots aligned. */
// Filesystem-loaded externals need dependencies outside the bundle.
const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  // Cursor ships computed Webpack imports and platform helper packages.
  "@cursor/sdk",
  // Playwright reads package.json and browsers.json beside its runtime modules.
  "playwright-core",
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "transcribe-cpp",
  "@transcribe-cpp/",
  "koffi",
  "@koromix/",
  "@napi-rs/keyring",
  "@clerk/electron-passkeys",
  "node-gyp-build",
  "node-addon-api",
  "bufferutil",
  "utf-8-validate",
  // The personal browser's Playwright driver. It is CommonJS and locates its
  // own files (injected scripts, browser registry) through __dirname, which
  // does not exist once inlined into the ESM bundle: every Chrome launch then
  // failed with "__dirname is not defined in ES module scope". It has no
  // dependencies of its own, so the external closure is just itself.
  "playwright-core",
  // Local CPU ONNX embeddings for hybrid semantic memory retrieval.
  "@huggingface/transformers",
  "@huggingface/jinja",
  "@huggingface/tokenizers",
  "onnxruntime-node",
  "onnxruntime-common",
  "onnxruntime-web",
  "sharp",
  "@img/",
  "@protobufjs/",
] as const;

// Transitive runtime dependencies of @huggingface/transformers, onnxruntime-node, and sharp.
const TRANSFORMERS_RUNTIME_DEPENDENCIES = [
  "adm-zip",
  "boolean",
  "define-data-property",
  "define-properties",
  "detect-libc",
  "detect-node",
  "es-define-property",
  "es-errors",
  "es6-error",
  "escape-string-regexp",
  "flatbuffers",
  "global-agent",
  "globalthis",
  "gopd",
  "guid-typescript",
  "has-property-descriptors",
  "json-stringify-safe",
  "long",
  "matcher",
  "object-keys",
  "platform",
  "protobufjs",
  "roarr",
  "semver",
  "semver-compare",
  "serialize-error",
  "sprintf-js",
  "type-fest",
  "undici-types",
  "@types/node",
] as const;

// Match Cursor dependency boundaries so zod does not externalize zod-to-json-schema.
const CURSOR_RUNTIME_DEPENDENCIES = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-node",
  "@connectrpc/connect-web",
  "@statsig/js-client",
  "@statsig/client-core",
  "zod",
  "undici",
  "@fastify/busboy",
] as const;

export function isRuntimeExternalCliDependency(id: string): boolean {
  return (
    CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix)) ||
    CURSOR_RUNTIME_DEPENDENCIES.some((name) => id === name || id.startsWith(`${name}/`)) ||
    TRANSFORMERS_RUNTIME_DEPENDENCIES.some((name) => id === name || id.startsWith(`${name}/`))
  );
}

/** Use neverBundle: false from alwaysBundle means no opinion and leaves transitive packages bundled. */
export function isExternalCliDependency(id: string): boolean {
  return isRuntimeExternalCliDependency(id);
}

export function shouldBundleCliDependency(id: string): boolean {
  if (id.startsWith("node:")) return false;
  return !isExternalCliDependency(id);
}

export function selectCliRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isRuntimeExternalCliDependency(name)),
  );
}

/** regionCount distinguishes a clean bundle from a changed marker format the scan cannot see. */
export function findInlinedExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
} {
  // Rolldown marks each inlined module with a `//#region <path>` line; newer
  // releases (vite-plus 1.4) emit a bare `// <path>` line instead.
  const regionPattern = /^\/\/(?:#region)?[ \t]+(\S+)[ \t]*$/gm;
  const packagePattern = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;

  let regionCount = 0;
  const inlined = new Set<string>();
  const inlinedPackages = new Set<string>();
  for (const region of source.matchAll(regionPattern)) {
    regionCount += 1;
    const regionPath = region[1] ?? "";
    for (const candidate of regionPath.matchAll(packagePattern)) {
      const name = candidate[1];
      if (name === undefined || name === ".pnpm") continue;
      inlinedPackages.add(name);
      if (isExternalCliDependency(name)) inlined.add(name);
    }
  }

  return {
    regionCount,
    inlined: [...inlined].sort(),
    inlinedPackages: [...inlinedPackages].sort(),
  };
}
