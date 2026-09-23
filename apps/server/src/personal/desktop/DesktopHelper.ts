// @effect-diagnostics nodeBuiltinImport:off - a long-lived child process speaking line JSON over stdio; Effect's Command API adds nothing for a duplex protocol.
// @effect-diagnostics globalTimers:off - request timeouts on a callback-based child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DESKTOP_HELPER_SOURCE } from "./helperSource.ts";

/**
 * The seam between the desktop service and the machine: the real helper in
 * production, a fake in tests.
 */
export interface DesktopDriver {
  /** Sends one command; rejects with {@link DesktopHelperError} on a helper-side refusal. */
  readonly request: (
    cmd: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  /** Called when the user presses the stop hotkey. */
  readonly onKill: (listener: () => void) => void;
  readonly dispose: () => void;
}

export class DesktopHelperError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const HOST_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Web.Extensions
$bytes = [System.IO.File]::ReadAllBytes($env:PB_DESKTOP_HELPER_DLL)
$assembly = [System.Reflection.Assembly]::Load($bytes)
$assembly.GetType('PbDesktopHelper').GetMethod('Run').Invoke($null, @())
`;

const DEFAULT_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;

function frameworkTool(name: string): string {
  const windows = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return NodePath.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", name);
}

/**
 * Compiles the helper once per source version into `dir`. The DLL is loaded
 * from bytes by powershell.exe rather than run as an exe: Smart App Control
 * refuses to start a freshly compiled, unsigned exe.
 */
export function ensureHelperCompiled(dir: string): { dllPath: string; hostPath: string } {
  const hash = NodeCrypto.createHash("sha256")
    .update(DESKTOP_HELPER_SOURCE)
    .digest("hex")
    .slice(0, 16);
  NodeFS.mkdirSync(dir, { recursive: true });
  const dllPath = NodePath.join(dir, `PbDesktopHelper-${hash}.dll`);
  const hostPath = NodePath.join(dir, "host.ps1");
  if (!NodeFS.existsSync(hostPath) || NodeFS.readFileSync(hostPath, "utf8") !== HOST_SCRIPT) {
    NodeFS.writeFileSync(hostPath, HOST_SCRIPT, "utf8");
  }
  if (NodeFS.existsSync(dllPath)) return { dllPath, hostPath };
  const sourcePath = NodePath.join(dir, `PbDesktopHelper-${hash}.cs`);
  NodeFS.writeFileSync(sourcePath, DESKTOP_HELPER_SOURCE, "utf8");
  const csc = frameworkTool("csc.exe");
  if (!NodeFS.existsSync(csc)) {
    throw new DesktopHelperError(
      "unavailable",
      "The .NET Framework C# compiler is missing, so the desktop helper cannot be built.",
    );
  }
  const tempDll = `${dllPath}.${process.pid}.tmp`;
  const result = NodeChildProcess.spawnSync(
    csc,
    [
      "-nologo",
      "-target:library",
      "-optimize",
      "-nowarn:420",
      `-out:${tempDll}`,
      "-r:System.Drawing.dll",
      "-r:System.Windows.Forms.dll",
      "-r:System.Web.Extensions.dll",
      sourcePath,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0 || !NodeFS.existsSync(tempDll)) {
    throw new DesktopHelperError(
      "unavailable",
      `The desktop helper did not compile: ${(result.stdout || result.stderr || String(result.error)).slice(0, 800)}`,
    );
  }
  NodeFS.renameSync(tempDll, dllPath);
  return { dllPath, hostPath };
}

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The real helper: one powershell.exe hosting the compiled assembly, started
 * on first use and restarted on the next request after it exits.
 */
export class WindowsDesktopDriver implements DesktopDriver {
  private child: NodeChildProcess.ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly killListeners: Array<() => void> = [];
  private nextId = 1;
  private disposed = false;

  private readonly helperDir: string;

  constructor(helperDir: string) {
    this.helperDir = helperDir;
  }

  onKill(listener: () => void): void {
    this.killListeners.push(listener);
  }

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let paths: { dllPath: string; hostPath: string };
      try {
        paths = ensureHelperCompiled(this.helperDir);
      } catch (error) {
        this.ready = null;
        reject(error);
        return;
      }
      const powershell = NodePath.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const child = NodeChildProcess.spawn(
        powershell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.hostPath],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, PB_DESKTOP_HELPER_DLL: paths.dllPath },
        },
      );
      this.child = child;
      let settled = false;
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new DesktopHelperError("unavailable", "The desktop helper did not start in time."));
      }, READY_TIMEOUT_MS);
      let buffer = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length === 0) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (message.event === "ready") {
            if (!settled) {
              settled = true;
              clearTimeout(readyTimer);
              resolve();
            }
            continue;
          }
          if (message.event === "kill") {
            for (const listener of this.killListeners) listener();
            continue;
          }
          const id = typeof message.id === "number" ? message.id : Number(message.id);
          const waiter = this.pending.get(id);
          if (waiter === undefined) continue;
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          if (message.ok === true) waiter.resolve(message);
          else
            waiter.reject(
              new DesktopHelperError(
                typeof message.code === "string" ? message.code : "internal",
                typeof message.error === "string" ? message.error : "The desktop action failed.",
              ),
            );
        }
      });
      child.on("exit", (code) => {
        this.child = null;
        this.ready = null;
        const error = new DesktopHelperError(
          "helper_exited",
          `The desktop helper stopped (exit ${code ?? "?"}). ${stderr.trim().slice(0, 300)}`.trim(),
        );
        for (const [id, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
          this.pending.delete(id);
        }
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(error);
        }
      });
      child.on("error", (cause) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          this.ready = null;
          reject(
            new DesktopHelperError(
              "unavailable",
              `The desktop helper failed to start: ${cause.message}`,
            ),
          );
        }
      });
    });
    return this.ready;
  }

  async request(
    cmd: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.disposed)
      throw new DesktopHelperError("unavailable", "The desktop helper is shut down.");
    await this.start();
    const child = this.child;
    if (child === null || child.stdin === null) {
      throw new DesktopHelperError("helper_exited", "The desktop helper is not running.");
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DesktopHelperError("timeout", `The desktop action "${cmd}" timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ ...params, id, cmd })}\n`);
    });
  }

  /** Whether the helper process is up, without starting it. */
  get running(): boolean {
    return this.child !== null;
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (child !== null) {
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 1_000).unref();
    }
  }
}
