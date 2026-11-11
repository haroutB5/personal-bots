import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { sharedAttachError } from "./browserBackend.ts";

const PROBE_TIMEOUT_MS = 2_000;
const CHROME_PRODUCT = /^(Headless)?Chrome\//;

interface PortFile {
  readonly port: number;
  readonly browserPath: string;
}

const readPortFile = async (userDataDir: string): Promise<PortFile> => {
  const text = await NodeFSP.readFile(
    NodePath.join(userDataDir, "DevToolsActivePort"),
    "utf8",
  ).catch((cause: NodeJS.ErrnoException) => {
    throw cause.code === "ENOENT" ? sharedAttachError("brave-not-running") : cause;
  });
  const [portLine = "", pathLine = ""] = text.trim().split("\n");
  const port = Number(portLine.trim());
  const browserPath = pathLine.trim();
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !browserPath.startsWith("/devtools/")
  ) {
    throw sharedAttachError("port-file-stale");
  }
  return { port, browserPath };
};

const probeVersion = async (port: number): Promise<unknown> => {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).catch((cause: unknown) => {
    throw cause instanceof Error && cause.name === "TimeoutError"
      ? sharedAttachError("wrong-browser")
      : sharedAttachError("port-file-stale");
  });
  if (!response.ok) throw sharedAttachError("wrong-browser");
  return response.json().catch(() => {
    throw sharedAttachError("wrong-browser");
  });
};

export const resolveSharedEndpoint = async (
  userDataDir: string,
): Promise<{ readonly wsEndpoint: string }> => {
  const { port, browserPath } = await readPortFile(userDataDir);
  const version = await probeVersion(port);
  const answer = (typeof version === "object" && version !== null ? version : {}) as {
    readonly Browser?: unknown;
    readonly webSocketDebuggerUrl?: unknown;
  };
  const advertised =
    typeof answer.webSocketDebuggerUrl === "string"
      ? URL.canParse(answer.webSocketDebuggerUrl)
        ? new URL(answer.webSocketDebuggerUrl).pathname
        : null
      : null;
  if (
    typeof answer.Browser !== "string" ||
    !CHROME_PRODUCT.test(answer.Browser) ||
    advertised !== browserPath
  ) {
    throw sharedAttachError("wrong-browser");
  }
  return { wsEndpoint: `ws://127.0.0.1:${port}${browserPath}` };
};
