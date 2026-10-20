/**
 * How an installed registry agent is started: the trimmed environment it and
 * npm get, finding Node and npm, and the spawn input for the ACP runtime.
 *
 * @module provider/catalog/launch
 */
import {
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveCommandPath, CommandResolutionCache } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { AcpSpawnInput } from "../acp/AcpSessionRuntime.ts";

/**
 * What a third-party program may inherit. Everything else in the server's
 * environment (tokens, API keys, pairing secrets) stays behind. Proxy and
 * certificate settings are kept so a laptop behind a proxy still installs.
 */
const INHERITED_NAMES = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ].map((name) => name.toUpperCase()),
);

export function minimalEnvironment(host: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined || value === "") continue;
    if (INHERITED_NAMES.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}

/** The Node.js that runs npm agents and npm itself: this server's own when it is a script run by Node. */
export const resolveNodePath = Effect.fn("CatalogLaunch.resolveNodePath")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const platform = yield* HostProcessPlatform;
  const executablePath = yield* HostProcessExecutablePath;
  if (!(yield* HostProcessIsExecutable)) return executablePath;
  const path = yield* Path.Path;
  const found = yield* resolveCommandPath(platform === "win32" ? "node.exe" : "node", {
    env: platform === "win32" ? { ...environment, PATHEXT: ".EXE" } : environment,
  }).pipe(
    Effect.provideService(CommandResolutionCache, new Map()),
    Effect.map((commandPath) => path.resolve(commandPath)),
    Effect.option,
  );
  return found._tag === "Some" ? found.value : null;
});

/** `npm-cli.js` beside a Node install, so npm runs without a `.cmd` shim or a shell. */
export const resolveNpmCli = Effect.fn("CatalogLaunch.resolveNpmCli")(function* (nodePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(nodePath);
  const candidates = [
    path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return path.resolve(candidate);
  }
  return null;
});

export interface InstalledLaunch {
  /** Absolute folder the agent was installed into. */
  readonly directory: string;
  readonly runner: "native" | "node";
  /** Forward-slash path of the program (native) or script (node) inside `directory`. */
  readonly entry: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Spawn input for an installed agent. `nodePath` is required for npm agents.
 * `extraEnv` (overlay presets, a saved API key) wins over the registry's env.
 * With `inheritEnvironment` the child gets the server's whole environment, as
 * built-in drivers do; without it, only the trimmed one.
 */
export function toSpawnInput(
  launch: InstalledLaunch,
  options: {
    readonly nodePath: string | null;
    readonly hostEnvironment: NodeJS.ProcessEnv;
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly inheritEnvironment?: boolean;
  },
  join: (...segments: string[]) => string,
): AcpSpawnInput | null {
  const entry = join(launch.directory, ...launch.entry.split("/"));
  if (launch.runner === "node" && options.nodePath === null) return null;
  const env = {
    ...(options.inheritEnvironment === true ? {} : minimalEnvironment(options.hostEnvironment)),
    ...launch.env,
    ...options.extraEnv,
  };
  return {
    command: launch.runner === "node" ? options.nodePath! : entry,
    args: launch.runner === "node" ? [entry, ...launch.args] : [...launch.args],
    cwd: launch.directory,
    env,
    extendEnv: options.inheritEnvironment === true,
  };
}
