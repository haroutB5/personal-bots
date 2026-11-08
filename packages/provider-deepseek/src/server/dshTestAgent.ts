#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * A stand-in dsh ACP agent for the adapter tests, over stdio JSON-RPC.
 * Env: T3_ACP_REQUEST_LOG_PATH, T3_ACP_DSH_PROMPT_ERROR, T3_ACP_DSH_RESUME_FAIL.
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface PromptBlock {
  readonly type?: string;
  readonly text?: string;
  readonly mimeType?: string;
}

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export const dshTestAgentPath = NodeURL.fileURLToPath(import.meta.url);

const sessionId = "mock-session-1";
const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const promptError = process.env.T3_ACP_DSH_PROMPT_ERROR?.trim() || undefined;
const resumeFails = process.env.T3_ACP_DSH_RESUME_FAIL === "1";

const logRequest = (message: JsonRpcRequest): void => {
  if (requestLogPath === undefined) return;
  NodeFS.appendFileSync(requestLogPath, `${JSON.stringify(message)}\n`);
};

const writeMessage = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const notify = (session: string, update: Record<string, unknown>): void =>
  writeMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: session, update },
  });

const configOptions = (): ReadonlyArray<Record<string, unknown>> => [
  {
    configId: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

const promptBlocks = (prompt: unknown): ReadonlyArray<PromptBlock> =>
  Array.isArray(prompt) ? (prompt as ReadonlyArray<PromptBlock>) : [];

const textOf = (prompt: unknown): string =>
  promptBlocks(prompt)
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");

const imageOf = (prompt: unknown): PromptBlock | undefined =>
  promptBlocks(prompt).find((block) => block.type === "image");

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

let inFlight = false;
let cancelRequested = false;
let resolveCancel: (() => void) | undefined;

const emitText = (session: string, messageId: string, text: string): void =>
  notify(session, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });

const emitThought = (session: string, messageId: string, text: string): void =>
  notify(session, {
    sessionUpdate: "agent_thought_chunk",
    messageId,
    content: { type: "text", text },
  });

const emitToolCall = (
  session: string,
  toolCallId: string,
  title: string,
  status = "pending",
): void =>
  notify(session, {
    sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update",
    toolCallId,
    title,
    kind: "other",
    status,
    ...(status === "pending" ? { rawInput: { command: title } } : {}),
  });

const emitUsage = (session: string, used: number): void =>
  notify(session, { sessionUpdate: "usage_update", used, size: 200_000 });

const runPrompt = async (
  session: string,
  prompt: unknown,
  respond: (payload: RpcResponse) => void,
): Promise<void> => {
  const finish = (stopReason: string): void => {
    notify(session, { sessionUpdate: "state_update", state: "idle", stopReason });
    respond({ result: {} });
  };
  if (promptError !== undefined) {
    await sleep(5);
    respond({
      error: { code: -32603, message: promptError, data: { detail: "recorded dsh failure" } },
    });
    return;
  }
  const text = textOf(prompt);
  if (text.includes("do the three steps")) {
    emitThought(session, "m1", "Let me check what is there.");
    emitToolCall(session, "call-mcp", "mcp__t3-code__save_memory");
    emitToolCall(session, "call-mcp", "mcp__t3-code__save_memory", "completed");
    emitToolCall(session, "call-skill", "skill");
    emitToolCall(session, "call-skill", "skill", "completed");
    await sleep(5);
    emitUsage(session, 1_000);
    emitText(session, "m2", "ECHO:HELLO DSH FALCON-42");
    emitUsage(session, 1_500);
    emitUsage(session, 2_000);
    await sleep(5);
    finish("end_turn");
    return;
  }
  if (text.includes("paragraph-probe")) {
    emitThought(session, "p1", "Let me check the file.");
    await sleep(5);
    emitToolCall(session, "paragraph-tool", "Read");
    emitToolCall(session, "paragraph-tool", "Read", "completed");
    await sleep(5);
    emitThought(session, "p2", "The file is fine.");
    emitText(session, "p3", "Done.");
    await sleep(5);
    finish("end_turn");
    return;
  }
  if (text.includes("dsml-probe")) {
    const marker = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
    emitText(
      session,
      "d1",
      `Before.<${marker} invoke name="web_search"><${marker} parameter name="query">tennis scores</${marker} parameter></${marker} invoke>`,
    );
    emitText(session, "d1", "After.");
    await sleep(5);
    finish("end_turn");
    return;
  }
  if (text.includes("colon-probe")) {
    emitText(session, "c1", "Now the provider");
    emitText(session, "c1", ":");
    await sleep(5);
    emitToolCall(session, "dsh-colon-probe-call", "Read");
    emitToolCall(session, "dsh-colon-probe-call", "Read", "completed");
    await sleep(5);
    emitText(session, "c2", "Done.");
    await sleep(5);
    finish("end_turn");
    return;
  }
  if (text.includes("Start-Sleep -Seconds 60")) {
    emitToolCall(session, "call_cancelled", "execute");
    if (!cancelRequested) {
      await new Promise<void>((resolve) => {
        resolveCancel = resolve;
      });
    }
    notify(session, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_cancelled",
      status: "failed",
      rawOutput: { content: [{ type: "text", text: "Error: tool call aborted" }] },
    });
    finish("cancelled");
    return;
  }
  const image = imageOf(prompt);
  if (image !== undefined) {
    emitText(session, "i1", image.mimeType === "image/png" ? "Image received." : "Unknown image.");
  } else {
    emitText(session, "s1", `ECHO:${text.slice(0, 80)}`);
  }
  await sleep(5);
  finish("end_turn");
};

const handleRequest = (message: JsonRpcRequest): void => {
  const respond = (payload: RpcResponse): void =>
    writeMessage({ jsonrpc: "2.0", id: message.id, ...payload });
  switch (message.method) {
    case "initialize":
      respond({
        result: {
          protocolVersion: 2,
          info: { name: "deepseek-harness-acp", version: "0.2.1-rc.3" },
          capabilities: {
            session: {
              prompt: { image: {}, audio: null, embeddedContext: null },
              resume: {},
              close: {},
              list: {},
              mcp: { http: {}, stdio: {} },
            },
          },
          authMethods: [],
        },
      });
      return;
    case "authenticate":
    case "auth/login":
      respond({ result: {} });
      return;
    case "auth/logout":
      respond({ result: {} });
      return;
    case "session/new":
      respond({ result: { sessionId, configOptions: configOptions() } });
      return;
    case "session/resume": {
      const requested = String(message.params?.sessionId ?? "");
      const foreign = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requested,
      );
      if (resumeFails || foreign) {
        respond({ error: { code: -32602, message: "session not resumable: no such session" } });
        return;
      }
      respond({ result: { configOptions: configOptions() } });
      return;
    }
    case "session/set_config_option":
      respond({ result: { configOptions: configOptions() } });
      return;
    case "session/prompt": {
      if (inFlight) {
        respond({ error: { code: -32600, message: "prompt already in flight" } });
        return;
      }
      inFlight = true;
      cancelRequested = false;
      const finish = (payload: RpcResponse): void => {
        inFlight = false;
        respond(payload);
      };
      void runPrompt(String(message.params?.sessionId ?? sessionId), message.params?.prompt, finish)
        .catch((error: unknown) => finish({ error: { code: -32603, message: String(error) } }))
        .finally(() => {
          inFlight = false;
        });
      return;
    }
    case "session/cancel":
      cancelRequested = true;
      resolveCancel?.();
      respond({ result: {} });
      return;
    default:
      respond({ error: { code: -32601, message: `Unknown method ${String(message.method)}` } });
  }
};

const main = (): void => {
  process.once("SIGTERM", () => process.exit(0));
  process.once("SIGINT", () => process.exit(0));

  const input = NodeReadline.createInterface({ input: process.stdin });
  input.on("line", (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }
    logRequest(message);
    if (message.method === "session/cancel") {
      cancelRequested = true;
      resolveCancel?.();
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    handleRequest(message);
  });
};

if (process.argv[1] === dshTestAgentPath) main();
