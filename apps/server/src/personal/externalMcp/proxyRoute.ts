/**
 * Sensitive-site-guarded and secret-redacting Streamable HTTP MCP reverse proxy.
 *
 * Route: `/api/personal/external-mcp/:serverId/mcp` (POST, GET, DELETE).
 *
 * Provider processes authenticate to this route using the thread's existing T3
 * MCP Bearer token (from `McpSessionRegistry`), so upstream external MCP Bearer
 * tokens (such as an Executor token) never enter provider subprocesses or argv.
 */
import {
  PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX,
  PersonalExternalMcpServerId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { parseBearerToken } from "../../auth/EnvironmentAuth.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  threadExposureKey,
} from "../browser/sensitiveExposureStore.ts";
import { secretRedactor } from "../secrets/secretRedaction.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import {
  PersonalExternalMcpService,
  personalExternalMcpEnabled,
} from "./PersonalExternalMcpService.ts";

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const SENSITIVE_SITE_BLOCKED_MESSAGE =
  "Blocked: a sensitive site is open in this chat, so external MCP servers cannot be called.";

const PROXY_BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const jsonRpcError = (status: number, code: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code, message },
    },
    { status, headers: PROXY_BASE_HEADERS },
  );

const parseServerIdFromPath = (pathname: string): PersonalExternalMcpServerId | null => {
  const prefix = `${PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX}/`;
  const suffix = "/mcp";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(pathname.slice(prefix.length, pathname.length - suffix.length));
  } catch {
    return null;
  }
  if (raw.length === 0 || raw.includes("/")) return null;
  return PersonalExternalMcpServerId.make(raw);
};

const scrubToken = (text: string, token: string | null): string => {
  let out = secretRedactor.redactText(text);
  if (token !== null && token.length > 0) {
    out = out.replaceAll(token, "[redacted]");
  }
  return out;
};

const redactOutboundBody = (bodyText: string, contentType: string | undefined): string => {
  if (bodyText.length === 0) return bodyText;
  const lower = (contentType ?? "").toLowerCase();
  if (
    lower.includes("application/json") ||
    bodyText.trimStart().startsWith("{") ||
    bodyText.trimStart().startsWith("[")
  ) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      const redacted = secretRedactor.redact(parsed);
      return JSON.stringify(redacted);
    } catch {
      return secretRedactor.redactText(bodyText);
    }
  }
  return secretRedactor.redactText(bodyText);
};

export interface PersonalExternalMcpProxyOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly env?: () => NodeJS.ProcessEnv;
}

const makeProxyHandler = (
  method: "POST" | "GET" | "DELETE",
  options: PersonalExternalMcpProxyOptions = {},
) =>
  Effect.gen(function* () {
    const getEnv = options.env ?? (() => process.env);
    if (!personalExternalMcpEnabled(getEnv())) {
      return jsonRpcError(503, -32000, "External MCP proxy is disabled.");
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return jsonRpcError(400, -32600, "Invalid request URL.");
    }
    const serverId = parseServerIdFromPath(url.value.pathname);
    if (serverId === null) {
      return jsonRpcError(404, -32000, "External MCP server route not found.");
    }

    const bearer = parseBearerToken(request);
    if (bearer === null) {
      return jsonRpcError(401, -32001, "Missing MCP bearer token.");
    }
    const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
    const scope = yield* mcpRegistry.resolve(bearer);
    if (scope === undefined) {
      return jsonRpcError(401, -32001, "Invalid or expired MCP bearer token.");
    }

    const threadId = scope.thread.threadId;
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const link = yield* bots
      .getThreadLink({ threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(link)) {
      return jsonRpcError(403, -32003, "External MCP servers are only available to personal bots.");
    }
    const botId = link.value.botId;

    const externalMcp = yield* PersonalExternalMcpService;
    const targetOpt = yield* externalMcp.resolveForProxy(serverId, botId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("External MCP proxy lookup failed.", {
          serverId,
          botId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(targetOpt)) {
      return jsonRpcError(403, -32003, "External MCP server is not available for this bot.");
    }
    const target = targetOpt.value;

    // Sensitive-site taint check (fail closed on DB errors).
    const sql = yield* SqlClient.SqlClient;
    const exposureKeys = yield* sql<{ readonly rootTaskId: string }>`
      SELECT root_task_id AS "rootTaskId"
      FROM personal_tasks
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => {
        const rootTaskId = rows[0]?.rootTaskId;
        return rootTaskId !== undefined
          ? [threadExposureKey(threadId), rootExposureKey(rootTaskId)]
          : [threadExposureKey(threadId)];
      }),
      Effect.catchCause(() => Effect.succeed([threadExposureKey(threadId)])),
    );
    const exposed = yield* makeSensitiveExposureStore(sql)
      .read(exposureKeys)
      .pipe(
        Effect.map((exposure) => exposure.sources.size > 0),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Sensitive-site exposure check failed on external MCP proxy; failing closed.",
            { threadId, serverId, cause: Cause.pretty(cause) },
          ).pipe(Effect.as(true)),
        ),
      );
    if (exposed) {
      return jsonRpcError(403, -32003, SENSITIVE_SITE_BLOCKED_MESSAGE);
    }

    // Read and redact request body for POST (and any request with a body).
    let outboundBody: string | undefined;
    if (method === "POST") {
      const declaredLength = Number(request.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
        return jsonRpcError(413, -32600, "Request body exceeds maximum size.");
      }
      let receivedBytes = 0;
      const collected = yield* collectUint8StreamText({
        stream: request.stream.pipe(
          Stream.takeUntil((chunk) => {
            receivedBytes += chunk.byteLength;
            return receivedBytes > MAX_REQUEST_BODY_BYTES;
          }),
        ),
        maxBytes: MAX_REQUEST_BODY_BYTES + 1,
      }).pipe(Effect.orElseSucceed(() => null));
      if (collected === null) {
        return jsonRpcError(400, -32600, "Could not read request body.");
      }
      if (collected.bytes > MAX_REQUEST_BODY_BYTES) {
        return jsonRpcError(413, -32600, "Request body exceeds maximum size.");
      }
      outboundBody = redactOutboundBody(collected.text, request.headers["content-type"]);
    }

    const upstreamHeaders: Record<string, string> = {};
    const forwardHeaderNames = [
      "accept",
      "content-type",
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
    ] as const;
    for (const name of forwardHeaderNames) {
      const value = request.headers[name];
      if (typeof value === "string" && value.length > 0) {
        upstreamHeaders[name] = value;
      }
    }
    if (target.bearerToken !== null && target.bearerToken.length > 0) {
      upstreamHeaders["authorization"] = `Bearer ${target.bearerToken}`;
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const upstreamResult = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImpl(target.url, {
          method,
          headers: upstreamHeaders,
          ...(outboundBody !== undefined ? { body: outboundBody } : {}),
          signal,
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({
          _tag: "Error" as const,
          message: scrubToken(
            cause instanceof Error ? cause.message : String(cause),
            target.bearerToken,
          ),
        }),
        onSuccess: (res) => ({ _tag: "Response" as const, res }),
      }),
    );

    if (upstreamResult._tag === "Error") {
      return jsonRpcError(
        502,
        -32002,
        `Upstream external MCP server error: ${upstreamResult.message}`,
      );
    }

    const upstream = upstreamResult.res;
    const responseHeaders: Record<string, string> = { ...PROXY_BASE_HEADERS };
    const upstreamContentType = upstream.headers.get("content-type");
    if (upstreamContentType !== null) responseHeaders["content-type"] = upstreamContentType;
    const upstreamSessionId = upstream.headers.get("mcp-session-id");
    if (upstreamSessionId !== null) responseHeaders["mcp-session-id"] = upstreamSessionId;
    const upstreamProtocolVersion = upstream.headers.get("mcp-protocol-version");
    if (upstreamProtocolVersion !== null) {
      responseHeaders["mcp-protocol-version"] = upstreamProtocolVersion;
    }

    if (
      upstreamContentType !== null &&
      upstreamContentType.toLowerCase().includes("text/event-stream") &&
      upstream.body !== null
    ) {
      const bodyStream = Stream.fromReadableStream({
        evaluate: () => upstream.body!,
        onError: (cause) => cause,
      }).pipe(Stream.catch(() => Stream.empty));
      return HttpServerResponse.stream(bodyStream, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    if (upstream.status === 204) {
      return HttpServerResponse.empty({ status: 204, headers: responseHeaders });
    }

    const bytes = yield* Effect.tryPromise({
      try: async () => new Uint8Array(await upstream.arrayBuffer()),
      catch: () => new Uint8Array(),
    }).pipe(Effect.orElseSucceed(() => new Uint8Array()));

    return HttpServerResponse.uint8Array(bytes, {
      status: upstream.status,
      headers: responseHeaders,
    });
  });

export const makePersonalExternalMcpProxyRouteLayer = (
  options: PersonalExternalMcpProxyOptions = {},
) => {
  const pattern = `${PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX}/:serverId/mcp` as const;
  return Layer.mergeAll(
    HttpRouter.add("POST", pattern, makeProxyHandler("POST", options)),
    HttpRouter.add("GET", pattern, makeProxyHandler("GET", options)),
    HttpRouter.add("DELETE", pattern, makeProxyHandler("DELETE", options)),
  );
};

export const personalExternalMcpProxyRouteLayer = makePersonalExternalMcpProxyRouteLayer();
