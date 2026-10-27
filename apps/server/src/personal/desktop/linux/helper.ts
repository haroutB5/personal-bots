// @effect-diagnostics nodeBuiltinImport:off - a long-lived child process speaking a line protocol over stdio, like the Windows helper.
// @effect-diagnostics globalTimers:off - request timeouts and the hold wait are plain timers.
/**
 * The Linux input helper as a process: one `pbdesk-wl` for the session, kept
 * alive between actions. It owns the virtual pointer and keyboard, which is
 * what keeps a held key resolving against the same keymap for the whole hold
 * (the wtype lesson in SPEC.md 7.3).
 *
 * Every command is one line, `<id> <cmd> [args]`; the helper answers
 * `ok <id> <us>` or `err <id> <message>` after a compositor roundtrip. Text
 * after `type ` is literal.
 *
 * The compositor does not release input held by a helper that died, so a new
 * helper always sends `releaseall` before its first real command (SPEC.md 7.4).
 */
import * as NodeChildProcess from "node:child_process";

import { DesktopHelperError } from "../DesktopHelper.ts";
import { ensureLinuxHelperBuilt } from "./helperBuild.ts";
import { type LinuxSession, sessionEnv } from "./session.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class LinuxDesktopHelper {
  private child: NodeChildProcess.ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  /** A helper has held input and may have died without releasing it. */
  private needsPanic = false;
  private readonly pending = new Map<number, Pending>();
  private readonly killListeners: Array<() => void> = [];
  private nextId = 1;
  private disposed = false;
  private layout: string;

  private readonly session: LinuxSession;
  private readonly dir: string;
  /** A prebuilt or fake binary; production builds it from source once. */
  private readonly binary: string | null;

  constructor(session: LinuxSession, dir: string, layout = "us", binary: string | null = null) {
    this.session = session;
    this.dir = dir;
    this.layout = layout;
    this.binary = binary;
  }

  onKill(listener: () => void): void {
    this.killListeners.push(listener);
  }

  get running(): boolean {
    return this.child !== null;
  }

  get currentLayout(): string {
    return this.layout;
  }

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let binary: string;
      try {
        binary = this.binary ?? ensureLinuxHelperBuilt(this.dir);
      } catch (error) {
        this.ready = null;
        reject(error);
        return;
      }
      const child = NodeChildProcess.spawn(binary, [this.layout], {
        stdio: ["pipe", "pipe", "pipe"],
        env: sessionEnv(this.session),
      });
      this.child = child;
      let settled = false;
      let buffer = "";
      let stderr = "";
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(
          new DesktopHelperError(
            "unavailable",
            `The Linux desktop helper did not start in time.${stderr.trim() === "" ? "" : ` ${stderr.trim().slice(0, 300)}`}`,
          ),
        );
      }, READY_TIMEOUT_MS);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.stdin?.on("error", () => undefined);

      const onLine = (line: string) => {
        if (line.startsWith("ready")) {
          if (!settled) {
            settled = true;
            clearTimeout(readyTimer);
            resolve();
          }
          return;
        }
        const ok = /^ok (\d+) (\d+)(?: (.*))?$/.exec(line);
        if (ok !== null) {
          const id = Number(ok[1]);
          const waiter = this.pending.get(id);
          if (waiter === undefined) return;
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          const extra: Record<string, unknown> = {};
          for (const token of (ok[3] ?? "").split(/\s+/)) {
            const [key, value] = token.split("=");
            if (key !== undefined && key.length > 0) extra[key] = value ?? true;
          }
          waiter.resolve({ id, us: Number(ok[2]), ...extra });
          return;
        }
        const err = /^err (\d+) (.*)$/.exec(line);
        if (err !== null) {
          const id = Number(err[1]);
          const waiter = this.pending.get(id);
          if (waiter === undefined) return;
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(new DesktopHelperError("invalid", err[2] ?? "The desktop helper refused."));
        }
      };

      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length > 0) onLine(line);
        }
      });

      child.on("exit", (code) => {
        this.child = null;
        this.ready = null;
        if (this.disposed) return;
        const error = new DesktopHelperError(
          "helper_exited",
          `The Linux desktop helper stopped (exit ${code ?? "?"}).${stderr.trim() === "" ? "" : ` ${stderr.trim().slice(0, 300)}`}`,
        );
        this.needsPanic = true;
        for (const [id, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
          this.pending.delete(id);
        }
        // A helper that died while input was held must not leave it down: the
        // compositor does not clean up. The next start releases everything.
        for (const listener of this.killListeners) listener();
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(error);
        }
      });
      child.on("error", (error) => {
        this.needsPanic = true;
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          this.ready = null;
          reject(
            new DesktopHelperError(
              "unavailable",
              `The Linux desktop helper could not start: ${error.message}`,
            ),
          );
        }
      });
    });
    return this.ready;
  }

  /** One command; resolves with the ack's extra fields (`layout=`, `keys=`). */
  async request(
    cmd: string,
    args: ReadonlyArray<string | number> = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.disposed) {
      throw new DesktopHelperError("unavailable", "The desktop helper is shut down.");
    }
    await this.start();
    const child = this.child;
    if (child === null || child.stdin === null) {
      throw new DesktopHelperError("helper_exited", "The Linux desktop helper is not running.");
    }
    if (cmd === "layout" && typeof args[0] === "string") this.layout = args[0];
    const id = this.nextId++;
    const send = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new DesktopHelperError("timeout", `The desktop action "${cmd}" timed out.`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        child.stdin!.write(`${id} ${cmd}${args.length === 0 ? "" : ` ${args.join(" ")}`}\n`);
      });
    if (this.needsPanic && cmd !== "releaseall" && cmd !== "panic" && cmd !== "quit") {
      this.needsPanic = false;
      // A fresh helper knows nothing that was down; releaseall clears the
      // compositor's stuck state before this command touches anything.
      await this.sendPanic();
    }
    return send();
  }

  private async sendPanic(): Promise<void> {
    const child = this.child;
    if (child === null || child.stdin === null) return;
    const id = this.nextId++;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve();
      }, 3_000);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          resolve();
        },
        timer,
      });
      child.stdin!.write(`${id} releaseall\n`);
    });
  }

  /** Lets go of everything, then quits. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child === null) return;
    if (child.stdin !== null && child.exitCode === null) {
      const id = this.nextId++;
      const finished = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        this.pending.set(id, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: () => {
            clearTimeout(timer);
            resolve();
          },
          timer,
        });
        child.stdin!.write(`${id} quit\n`);
      });
      await finished.catch(() => undefined);
    }
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}
