// @effect-diagnostics nodeBuiltinImport:off
/**
 * Opens one https link in the laptop's DEFAULT browser, the way a double click
 * would. It must not be the shared automated Chrome of the Computer tab:
 * Google refuses sign-in in an automated browser.
 *
 * No shell is involved. The link is passed as one element of an argument
 * array, and it is never logged.
 *
 * @module provider/openDefaultBrowser
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { resolveWindowsSystemTool } from "./processTree.ts";

export class DefaultBrowserOpenError extends Data.TaggedError("DefaultBrowserOpenError")<{
  readonly reason: "not-https" | "launch-failed";
}> {}

export interface DefaultBrowserLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** The OS handler for the user's default browser. Pure, for tests. */
export function buildDefaultBrowserLaunch(
  url: string,
  platform: NodeJS.Platform,
  rundll32: string = "rundll32.exe",
): DefaultBrowserLaunch {
  if (platform === "win32")
    return { command: rundll32, args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export type SpawnDetached = (launch: DefaultBrowserLaunch) => Promise<void>;

const spawnDetached: SpawnDetached = (launch) =>
  new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(launch.command, [...launch.args], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

export type OpenInDefaultBrowser = (url: string) => Effect.Effect<void, DefaultBrowserOpenError>;

export const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "accounts.google.com" &&
      url.pathname === "/o/oauth2/v2/auth" &&
      !url.username &&
      !url.password &&
      !url.port &&
      value.length <= 16_384 &&
      !/\s/u.test(value)
    );
  } catch {
    return false;
  }
};

export function makeOpenInDefaultBrowser(
  deps: { readonly platform?: NodeJS.Platform; readonly spawn?: SpawnDetached } = {},
): OpenInDefaultBrowser {
  return (url) =>
    Effect.suspend(() => {
      if (!isHttpsUrl(url))
        return Effect.fail(new DefaultBrowserOpenError({ reason: "not-https" }));
      // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform picks the OS URL handler; tests inject it.
      const platform = deps.platform ?? NodeOS.platform();
      const launch = buildDefaultBrowserLaunch(
        new URL(url).href,
        platform,
        platform === "win32" ? resolveWindowsSystemTool(["rundll32.exe"]) : undefined,
      );
      return Effect.tryPromise({
        try: () => (deps.spawn ?? spawnDetached)(launch),
        catch: () => new DefaultBrowserOpenError({ reason: "launch-failed" }),
      });
    });
}

/** Opens a link in the host's default browser. */
export const openInDefaultBrowser: OpenInDefaultBrowser = makeOpenInDefaultBrowser();
