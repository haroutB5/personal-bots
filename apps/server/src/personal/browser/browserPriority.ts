// @effect-diagnostics nodeBuiltinImport:off
/**
 * Keeps the shared Chrome at Normal priority or higher (Windows).
 *
 * Bot provider processes now start at BelowNormal (see
 * `provider/botProcessPriority.ts`), so the live view's Chrome only has to
 * avoid being BelowNormal itself. Normally it is not: the server runs
 * AboveNormal, and a child of such a parent starts at Normal. But a server
 * that was started BelowNormal (the logon task, or a restart run from a bot's
 * shell, before the priority is raised) hands that class to Chrome and every
 * process it starts. After a launch, any Chrome process of ours found below
 * Normal is raised to Normal; processes Chrome starts later inherit from its
 * browser process.
 *
 * Only Chrome processes that are direct children of this server, and their
 * descendants, are touched. A Chrome a bot started from its own shell is a
 * descendant of a provider process and is left alone on purpose.
 *
 * `PERSONAL_BOT_PROCESS_PRIORITY=normal` turns this off with the rest.
 *
 * @module personal/browser/browserPriority
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { botProcessPriorityDisabled } from "../../provider/botProcessPriority.ts";
import { descendantsOf, listProcesses, type ProcessEntry } from "../../provider/processTree.ts";

const CHROME_IMAGE = /^(chrome|msedge|chromium|chrome-headless-shell)(\.exe)?$/i;

export interface BrowserPriorityDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly serverPid?: number;
  readonly listProcesses?: () => Promise<ProcessEntry[] | null>;
  readonly getPriority?: (pid: number) => number;
  readonly setPriority?: (pid: number, priority: number) => void;
}

export interface BrowserPriorityResult {
  /** Browser processes looked at. */
  readonly checked: number;
  /** PIDs raised to Normal because they were below it. */
  readonly raised: ReadonlyArray<number>;
  /** PIDs that could not be read or changed. */
  readonly failed: ReadonlyArray<number>;
  readonly skipped?: "disabled" | "unsupported-platform" | "no-process-list" | "no-browser";
}

/**
 * The Chrome processes started by this server: image-named direct children
 * of `serverPid` (plus the configured executable's image name) and everything
 * below them.
 */
export function ourBrowserProcesses(
  snapshot: ReadonlyArray<ProcessEntry>,
  serverPid: number,
  executablePath?: string,
): ProcessEntry[] {
  const configured =
    executablePath === undefined
      ? undefined
      : NodePath.win32.basename(executablePath).toLowerCase();
  const roots = snapshot.filter(
    (entry) =>
      entry.parentPid === serverPid &&
      (CHROME_IMAGE.test(entry.name) || entry.name.toLowerCase() === configured),
  );
  const out = new Map<number, ProcessEntry>();
  for (const root of roots) {
    out.set(root.pid, root);
    for (const child of descendantsOf(snapshot, root.pid)) out.set(child.pid, child);
  }
  return [...out.values()];
}

export async function keepBrowserPriorityNormal(
  executablePath: string | undefined,
  deps: BrowserPriorityDeps = {},
): Promise<BrowserPriorityResult> {
  const none = (skipped: BrowserPriorityResult["skipped"]): BrowserPriorityResult => ({
    checked: 0,
    raised: [],
    failed: [],
    ...(skipped === undefined ? {} : { skipped }),
  });
  if (botProcessPriorityDisabled(deps.env)) return none("disabled");
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides whether Windows priority classes exist; tests inject it.
  if ((deps.platform ?? NodeOS.platform()) !== "win32") return none("unsupported-platform");
  const snapshot = await (deps.listProcesses ?? listProcesses)();
  if (snapshot === null) return none("no-process-list");
  const browser = ourBrowserProcesses(snapshot, deps.serverPid ?? process.pid, executablePath);
  if (browser.length === 0) return none("no-browser");
  const getPriority = deps.getPriority ?? NodeOS.getPriority;
  const setPriority = deps.setPriority ?? NodeOS.setPriority;
  const raised: number[] = [];
  const failed: number[] = [];
  // Parents first, so a process raised here hands Normal to what it starts next.
  for (const entry of browser) {
    try {
      // Positive is below Normal (BelowNormal 10, Idle 19); 0 and below is Normal or higher.
      if (getPriority(entry.pid) > NodeOS.constants.priority.PRIORITY_NORMAL) {
        setPriority(entry.pid, NodeOS.constants.priority.PRIORITY_NORMAL);
        raised.push(entry.pid);
      }
    } catch {
      failed.push(entry.pid);
    }
  }
  return { checked: browser.length, raised, failed };
}
