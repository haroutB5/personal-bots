// @effect-diagnostics nodeBuiltinImport:off
/**
 * Chooses the browser executable for the shared bot browser.
 *
 * Brave is the only supported browser (owner rule, 23 Oct 2026). Chrome is
 * never a fallback: when no Brave executable can be found the launch fails
 * with a message naming every path that was checked, so a missing install is
 * visible instead of silently running a different browser.
 *
 * `T3CODE_PERSONAL_BROWSER_EXECUTABLE` still overrides the search, but it must
 * point at a Brave executable too. The ordinary Windows install locations are
 * tried in this order: the per-user install under LOCALAPPDATA, then the two
 * machine-wide Program Files roots.
 *
 * @module personal/browser/browserExecutable
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const BROWSER_EXECUTABLE_ENV = "T3CODE_PERSONAL_BROWSER_EXECUTABLE";

/** Brave's Windows image and macOS app executable both start with "brave". */
const BRAVE_IMAGE = /^brave([ .-]|$)/i;

export class BrowserExecutableUnavailable extends Error {
  readonly candidates: ReadonlyArray<string>;

  constructor(message: string, candidates: ReadonlyArray<string>) {
    super(message);
    this.name = "BrowserExecutableUnavailable";
    this.candidates = candidates;
  }
}

export interface BrowserExecutableInput {
  /** An explicit executable from the environment or options; wins over the search. */
  readonly configured?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
}

const envValue = (env: NodeJS.ProcessEnv, ...names: ReadonlyArray<string>) => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

/** Every Brave executable path this machine might have, most likely first. */
export function braveExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides which install locations exist; tests inject it.
  platform: NodeJS.Platform = NodeOS.platform(),
): ReadonlyArray<string> {
  if (platform === "win32") {
    const roots = [
      envValue(env, "LOCALAPPDATA"),
      envValue(env, "ProgramFiles", "PROGRAMFILES"),
      envValue(env, "ProgramFiles(x86)", "PROGRAMFILES(X86)"),
    ];
    return roots.flatMap((root) =>
      root === undefined
        ? []
        : [NodePath.win32.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")],
    );
  }
  if (platform === "darwin") {
    return [
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      NodePath.posix.join(
        NodeOS.homedir(),
        "Applications",
        "Brave Browser.app",
        "Contents",
        "MacOS",
        "Brave Browser",
      ),
    ];
  }
  return ["/usr/bin/brave-browser", "/usr/bin/brave", "/snap/bin/brave"];
}

/** The first installed Brave executable, or undefined when there is none. */
export function discoverBraveExecutable(
  env: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- see braveExecutableCandidates.
  platform: NodeJS.Platform = NodeOS.platform(),
  exists: (path: string) => boolean = (path) => NodeFS.existsSync(path),
): string | undefined {
  return braveExecutableCandidates(env, platform).find((candidate) => exists(candidate));
}

const isBraveExecutable = (path: string) =>
  BRAVE_IMAGE.test(NodePath.basename(path));

/**
 * Resolves the executable the shared browser must launch.
 *
 * An explicit path must exist and must be Brave. Otherwise the ordinary Brave
 * locations are checked. There is deliberately no Chrome search and no
 * `channel: "chrome"` fallback.
 */
export function resolveBrowserExecutable(input: BrowserExecutableInput = {}): string {
  const env = input.env ?? process.env;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- see braveExecutableCandidates.
  const platform = input.platform ?? NodeOS.platform();
  const exists = input.exists ?? ((path: string) => NodeFS.existsSync(path));
  const configured = (input.configured ?? envValue(env, BROWSER_EXECUTABLE_ENV))?.trim();

  if (configured !== undefined && configured !== "") {
    if (!isBraveExecutable(configured)) {
      throw new BrowserExecutableUnavailable(
        `The configured browser is not Brave: ${configured}. Brave is required; Chrome is not used.`,
        [configured],
      );
    }
    if (!exists(configured)) {
      throw new BrowserExecutableUnavailable(
        `Configured Brave executable not found: ${configured}. ${BROWSER_EXECUTABLE_ENV} must point at Brave.`,
        [configured],
      );
    }
    return configured;
  }

  const candidates = braveExecutableCandidates(env, platform);
  const found = candidates.find((candidate) => exists(candidate));
  if (found !== undefined) return found;

  throw new BrowserExecutableUnavailable(
    `Brave browser not found. Install Brave or set ${BROWSER_EXECUTABLE_ENV}. Chrome is not used as a fallback. Checked: ${
      candidates.length === 0 ? "(no install location known on this platform)" : candidates.join("; ")
    }`,
    candidates,
  );
}
