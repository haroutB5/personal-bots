import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ConnectionVendorError } from "../../adapters.ts";
import {
  BridgeChannelError,
  errorTextOf,
  isUnreachableText,
  readToolReply,
  runBridgeSession,
  type BridgeLaunch,
  type RpcReply,
} from "./bridgeChannel.ts";
import {
  COMMONPOST_BRIDGE_PROFILE,
  COMMONPOST_BRIDGE_SHA256,
  COMMONPOST_TOOLS_FINGERPRINT,
  toolsFingerprint,
  type CommonpostTool,
} from "./pins.ts";
import {
  THUNDERBIRD_ADDON_LINE,
  THUNDERBIRD_CLOSED_LINE,
  accountsFromList,
  type ThunderbirdStatus,
} from "./status.ts";
import { ThunderbirdProcess } from "./thunderbirdProcess.ts";

export interface CommonpostConfig {
  readonly nodePath: string;
  readonly bridgePath: string;
  readonly expectedBridgeSha256: string;
  readonly expectedToolsFingerprint: string;
  /** Where Thunderbird writes its connection file. The bridge looks under this folder. */
  readonly tmpDir: string;
  readonly home: string;
  readonly timeouts?: {
    readonly callMs: number;
    readonly composeMs: number;
    readonly listMs: number;
  };
}

export const defaultCommonpostConfig = (home: string = NodeOS.homedir()): CommonpostConfig => ({
  nodePath: NodePath.basename(process.execPath).startsWith("node") ? process.execPath : "node",
  bridgePath: NodePath.join(home, "commonpost-mcp", "mcp-bridge.cjs"),
  expectedBridgeSha256: COMMONPOST_BRIDGE_SHA256,
  expectedToolsFingerprint: COMMONPOST_TOOLS_FINGERPRINT,
  tmpDir: "/tmp",
  home,
});

const DEFAULT_TIMEOUTS = { callMs: 30_000, composeMs: 180_000, listMs: 30_000 } as const;
const COMPOSE_TOOLS: ReadonlySet<CommonpostTool> = new Set(["saveDraft", "replyToMessage"]);

export class CommonpostClient extends Context.Service<
  CommonpostClient,
  {
    /** Only the eight tools `CommonpostTool` names can be asked for. */
    readonly call: (
      tool: CommonpostTool,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<unknown, ConnectionVendorError>;
    /** Never fails: every way Thunderbird can be unavailable is a value of the status. */
    readonly status: () => Effect.Effect<ThunderbirdStatus>;
  }
>()("t3/personal/connections/email/thunderbird/CommonpostClient") {}

type BridgeCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const checkBridge = (config: CommonpostConfig): BridgeCheck => {
  let bytes: Buffer;
  try {
    bytes = NodeFS.readFileSync(config.bridgePath);
  } catch {
    return {
      ok: false,
      reason: "The Commonpost mail bridge is not installed on the laptop.",
    };
  }
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return digest === config.expectedBridgeSha256
    ? { ok: true }
    : {
        ok: false,
        reason: "The Commonpost mail bridge is not the version hbots was reviewed with.",
      };
};

const launchFor = (config: CommonpostConfig): BridgeLaunch => ({
  command: config.nodePath,
  args: [config.bridgePath],
  env: {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: config.home,
    TMPDIR: config.tmpDir,
    COMMONPOST_MCP_PROFILE: COMMONPOST_BRIDGE_PROFILE,
  },
});

const channelFailure = (operationId: string, error: unknown): ConnectionVendorError =>
  new ConnectionVendorError({
    operationId,
    detail:
      error instanceof BridgeChannelError
        ? error.message
        : "The mail bridge failed in a way hbots did not expect.",
  });

export const makeCommonpostClient = (config: CommonpostConfig) =>
  Effect.gen(function* () {
    const process_ = yield* ThunderbirdProcess;
    const timeouts = config.timeouts ?? DEFAULT_TIMEOUTS;

    const unavailable = (operationId: string) =>
      Effect.gen(function* () {
        const running = yield* process_.running();
        return yield* new ConnectionVendorError({
          operationId,
          detail: running ? THUNDERBIRD_ADDON_LINE : THUNDERBIRD_CLOSED_LINE,
          unavailable: true,
        });
      });

    const session = (
      steps: Parameters<typeof runBridgeSession>[1],
      operationId: string,
    ): Effect.Effect<ReadonlyArray<RpcReply>, ConnectionVendorError> => {
      const bridge = checkBridge(config);
      if (!bridge.ok) {
        return Effect.fail(new ConnectionVendorError({ operationId, detail: bridge.reason }));
      }
      return Effect.tryPromise({
        try: (signal) => runBridgeSession(launchFor(config), steps, signal),
        catch: (error) => channelFailure(operationId, error),
      });
    };

    const call: CommonpostClient["Service"]["call"] = (tool, args) => {
      const operationId = `thunderbird.${tool}`;
      return Effect.gen(function* () {
        const replies = yield* session(
          [
            {
              method: "tools/call",
              params: { name: tool, arguments: args },
              timeoutMs: COMPOSE_TOOLS.has(tool) ? timeouts.composeMs : timeouts.callMs,
            },
          ],
          operationId,
        );
        const reply = replies[0];
        if (reply === undefined || reply.error !== undefined) {
          return yield* new ConnectionVendorError({
            operationId,
            detail: reply?.error?.message ?? "The mail bridge sent no answer.",
          });
        }
        const read = readToolReply(reply);
        if (!read.isError) return read.value;
        const text = errorTextOf(read.value);
        if (isUnreachableText(text)) return yield* unavailable(operationId);
        return yield* new ConnectionVendorError({ operationId, detail: text });
      });
    };

    const status: CommonpostClient["Service"]["status"] = () =>
      Effect.gen(function* () {
        const bridge = checkBridge(config);
        if (!bridge.ok) return { _tag: "unsupported", reason: bridge.reason } as const;
        const outcome = yield* Effect.tryPromise({
          try: (signal) =>
            runBridgeSession(
              launchFor(config),
              [
                {
                  method: "tools/call",
                  params: { name: "listAccounts", arguments: {} },
                  timeoutMs: timeouts.listMs,
                  stopWhen: (reply) => readToolReply(reply).isError,
                },
                { method: "tools/list", params: {}, timeoutMs: timeouts.listMs },
              ],
              signal,
            ),
          catch: (error) => error,
        }).pipe(Effect.result);
        if (outcome._tag === "Failure") {
          const error = outcome.failure;
          return {
            _tag: "unsupported",
            reason: error instanceof BridgeChannelError ? error.message : "The mail bridge failed.",
          } as const;
        }
        const [accounts, listed] = outcome.success;
        const tools = ((): ReadonlyArray<{ name: string; inputSchema: unknown }> => {
          const value = (listed?.result ?? {}) as { readonly tools?: unknown };
          return Array.isArray(value.tools)
            ? (value.tools as ReadonlyArray<{ name: string; inputSchema: unknown }>)
            : [];
        })();
        if (accounts === undefined) return { _tag: "unsupported", reason: "No answer." } as const;
        const read = readToolReply(accounts);
        const notice = read.notices.find((text) => text.startsWith("Commonpost notice"));
        if (notice !== undefined) return { _tag: "unsupported", reason: notice } as const;
        if (read.isError) {
          const text = errorTextOf(read.value);
          if (isUnreachableText(text)) {
            const running = yield* process_.running();
            return running ? ({ _tag: "addon-missing" } as const) : ({ _tag: "closed" } as const);
          }
          return { _tag: "unsupported", reason: text } as const;
        }
        if (toolsFingerprint(tools) !== config.expectedToolsFingerprint) {
          return {
            _tag: "unsupported",
            reason: "The add-on's tools differ from the version hbots was reviewed with.",
          } as const;
        }
        return { _tag: "ready", accounts: accountsFromList(read.value) } as const;
      });

    return CommonpostClient.of({ call, status });
  });

export const layer = (config: CommonpostConfig = defaultCommonpostConfig()) =>
  Layer.effect(CommonpostClient, makeCommonpostClient(config));

export const layerOf = (impl: CommonpostClient["Service"]) => Layer.succeed(CommonpostClient, impl);
