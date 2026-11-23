// @effect-diagnostics preferSchemaOverJson:off - the bridge speaks JSON-RPC; each caller narrows what it reads.
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

export interface BridgeLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface RpcStep {
  readonly method: string;
  readonly params: unknown;
  readonly timeoutMs: number;
  /** When it returns true for this step's reply, the later steps are not run. */
  readonly stopWhen?: (reply: RpcReply) => boolean;
}

export interface RpcReply {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export class BridgeChannelError extends Error {
  readonly kind: "spawn" | "exit" | "timeout" | "protocol";
  constructor(kind: BridgeChannelError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

const PROTOCOL_VERSION = "2025-11-25";

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

/**
 * Runs one MCP session against a freshly started bridge: initialize, the
 * initialized notice, then each step in order, and always stops the child it
 * started. The child is signalled by the handle this call holds, never found
 * by name.
 */
export const runBridgeSession = (
  launch: BridgeLaunch,
  steps: ReadonlyArray<RpcStep>,
  signal?: AbortSignal,
): Promise<ReadonlyArray<RpcReply>> =>
  new Promise((resolve, reject) => {
    let child: NodeChildProcess.ChildProcessByStdio<NodeStream.Writable, NodeStream.Readable, null>;
    try {
      child = NodeChildProcess.spawn(launch.command, [...launch.args], {
        env: { ...launch.env },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (cause) {
      reject(new BridgeChannelError("spawn", `Could not start the mail bridge: ${String(cause)}`));
      return;
    }

    const replies: Array<RpcReply> = [];
    const pending = new Map<number, (reply: RpcReply) => void>();
    let buffer = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (
      outcome: { readonly ok: true } | { readonly ok: false; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdin.destroy();
      child.kill("SIGTERM");
      if (outcome.ok) resolve(replies);
      else reject(outcome.error);
    };
    const onAbort = () =>
      finish({ ok: false, error: new BridgeChannelError("exit", "Cancelled.") });
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (cause) =>
      finish({
        ok: false,
        error: new BridgeChannelError("spawn", `Could not start the mail bridge: ${cause.message}`),
      }),
    );
    child.on("exit", () =>
      finish({
        ok: false,
        error: new BridgeChannelError("exit", "The mail bridge stopped before it answered."),
      }),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const message = record(parsed);
        const id = message["id"];
        if (typeof id === "number") pending.get(id)?.(message as RpcReply);
      }
    });

    const request = (id: number, method: string, params: unknown, timeoutMs: number) =>
      new Promise<RpcReply>((done, fail) => {
        timer = setTimeout(
          () =>
            fail(
              new BridgeChannelError(
                "timeout",
                `The mail bridge did not answer ${method} in time.`,
              ),
            ),
          timeoutMs,
        );
        pending.set(id, (reply) => {
          if (timer !== undefined) clearTimeout(timer);
          pending.delete(id);
          done(reply);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    const run = async () => {
      const init = await request(
        1,
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "hbots", version: "1" },
        },
        10_000,
      );
      if (init.error !== undefined) {
        throw new BridgeChannelError("protocol", "The mail bridge refused to start a session.");
      }
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      let id = 2;
      for (const step of steps) {
        const reply = await request(id, step.method, step.params, step.timeoutMs);
        replies.push(reply);
        if (step.stopWhen?.(reply) === true) break;
        id += 1;
      }
    };

    run().then(
      () => finish({ ok: true }),
      (error: unknown) =>
        finish({
          ok: false,
          error: error instanceof Error ? error : new BridgeChannelError("protocol", String(error)),
        }),
    );
  });

export interface ToolReply {
  readonly isError: boolean;
  readonly value: unknown;
  /** Later text blocks: the bridge appends its own notices there. */
  readonly notices: ReadonlyArray<string>;
}

export const readToolReply = (reply: RpcReply): ToolReply => {
  const result = record(reply.result);
  const blocks = Array.isArray(result["content"]) ? result["content"].map(record) : [];
  const texts = blocks.flatMap((block) =>
    block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [],
  );
  const first = texts[0] ?? "";
  let value: unknown = first;
  try {
    value = JSON.parse(first) as unknown;
  } catch {
    value = first;
  }
  return { isError: result["isError"] === true, value, notices: texts.slice(1) };
};

const UNREACHABLE =
  /Connection discovery failed|Connection failed|Is Thunderbird running with the MCP extension/i;

export const isUnreachableText = (text: string) => UNREACHABLE.test(text);

export const errorTextOf = (value: unknown): string => {
  const inner = record(value)["error"];
  return typeof inner === "string"
    ? inner
    : typeof value === "string"
      ? value
      : "The add-on reported an error.";
};
