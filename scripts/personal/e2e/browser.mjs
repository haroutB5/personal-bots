// Brave launch helper for the bot test scripts.
//
// Brave is the only supported test browser (owner rule, 23 Oct 2026). There is
// deliberately no Chrome/Edge channel and no fallback: a missing Brave install
// fails with the paths that were checked. `E2E_BROWSER_EXECUTABLE` overrides the
// search, but it must point at Brave too.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const BROWSER_EXECUTABLE_ENV = "E2E_BROWSER_EXECUTABLE";

const BRAVE_IMAGE = /^brave([ .-]|$)/i;

const envValue = (env, ...names) => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

/** Every Brave executable path this machine might have, most likely first. */
export function braveExecutableCandidates(
  env = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides where Brave is installed.
  platform = NodeOS.platform(),
) {
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

/**
 * The Brave executable to launch. `executable` wins over the environment, which
 * wins over discovery. Throws instead of returning a Chrome path.
 */
export function resolveBraveExecutable({
  executable,
  env = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- see braveExecutableCandidates.
  platform = NodeOS.platform(),
  exists = (path) => NodeFS.existsSync(path),
} = {}) {
  const configured = (executable ?? envValue(env, BROWSER_EXECUTABLE_ENV))?.trim();
  if (configured !== undefined && configured !== "") {
    if (!BRAVE_IMAGE.test(NodePath.basename(configured))) {
      throw new Error(
        `The configured browser is not Brave: ${configured}. Brave is required; Chrome is not used.`,
      );
    }
    if (!exists(configured)) {
      throw new Error(
        `Configured Brave executable not found: ${configured}. ${BROWSER_EXECUTABLE_ENV} must point at Brave.`,
      );
    }
    return configured;
  }

  const candidates = braveExecutableCandidates(env, platform);
  const found = candidates.find((candidate) => exists(candidate));
  if (found !== undefined) return found;
  throw new Error(
    `Brave browser not found. Install Brave or set ${BROWSER_EXECUTABLE_ENV}. Chrome is not used as a fallback. Checked: ${
      candidates.length === 0 ? "(no install location known on this platform)" : candidates.join("; ")
    }`,
  );
}

/**
 * Launches Brave through the Playwright module the suite loaded. `options` are
 * passed through; a `channel` or `executablePath` in them is refused so a caller
 * cannot quietly go back to Chrome.
 */
export async function launchBrave(playwright, options = {}) {
  const { chromium } = playwright;
  if (chromium === undefined) throw new Error("launchBrave: playwright.chromium is missing");
  const { executablePath: configured, channel, ...rest } = options;
  if (channel !== undefined) {
    throw new Error(`launchBrave: channel "${channel}" is not allowed; tests run on Brave.`);
  }
  const executablePath = resolveBraveExecutable({ executable: configured });
  return chromium.launch({ headless: true, ...rest, executablePath });
}
