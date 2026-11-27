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
  formatExternalMcpFetchError,
  personalExternalMcpEnabled,
} from "./PersonalExternalMcpService.ts";

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
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

const isTextLikeContentType = (contentType: string | null): boolean => {
  if (contentType === null) return true;
  const lower = contentType.toLowerCase();
  return (
    lower.includes("json") ||
    lower.includes("text/") ||
    lower.includes("xml") ||
    lower.includes("javascript") ||
    lower.includes("x-www-form-urlencoded")
  );
};

const redactUpstreamText = (
  bodyText: string,
  contentType: string | null,
  bearerToken: string | null,
): string => {
  if (bodyText.length === 0) return bodyText;
  const lower = (contentType ?? "").toLowerCase();
  let redacted: string;
  if (
    lower.includes("json") ||
    bodyText.trimStart().startsWith("{") ||
    bodyText.trimStart().startsWith("[")
  ) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      redacted = JSON.stringify(secretRedactor.redact(parsed));
    } catch {
      redacted = secretRedactor.redactText(bodyText);
    }
  } else {
    redacted = secretRedactor.redactText(bodyText);
  }
  if (bearerToken !== null && bearerToken.length > 0) {
    redacted = redacted.replaceAll(bearerToken, "[redacted]");
  }
  return redacted;
};

/** Start index of the longest suffix of `text` that is a proper prefix of `token`. */
const tokenHoldStart = (text: string, token: string): number => {
  const from = Math.max(0, text.length - (token.length - 1));
  for (let idx = from; idx < text.length; idx += 1) {
    const suffix = text.slice(idx);
    if (token.startsWith(suffix)) return idx;
  }
  return text.length;
};

const makeRedactingSseStream = (
  source: ReadableStream<Uint8Array>,
  bearerToken: string | null,
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const secretStream = secretRedactor.stream();
  const hasToken = bearerToken !== null && bearerToken.length > 0;
  let tokenCarry = "";

  const scrubTokenChunk = (chunk: string): string => {
    if (!hasToken) return chunk;
    const combined = (tokenCarry + chunk).replaceAll(bearerToken, "[redacted]");
    const holdAt = tokenHoldStart(combined, bearerToken);
    tokenCarry = combined.slice(holdAt);
    return combined.slice(0, holdAt);
  };

  const flushTokenChunk = (tail: string): string => {
    if (!hasToken) return tail;
    const combined = (tokenCarry + tail).replaceAll(bearerToken, "[redacted]");
    tokenCarry = "";
    return combined;
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const out = scrubTokenChunk(secretStream.push(text));
      if (out.length > 0) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      const tail = decoder.decode();
      const secretTail = secretStream.push(tail) + secretStream.flush();
      const out = flushTokenChunk(secretTail);
      if (out.length > 0) controller.enqueue(encoder.encode(out));
    },
  });

  return source.pipeThrough(transform);
};

class ResponseTooLargeError extends Error {
  constructor() {
    super("Upstream external MCP response exceeds maximum size.");
    this.name = "ResponseTooLargeError";
  }
}

const readBoundedResponseBytes = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

export interface PersonalExternalMcpProxyOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly env?: () => NodeJS.ProcessEnv;
  readonly upstreamTimeoutMs?: number;
  readonly maxResponseBytes?: number;
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
    const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BODY_BYTES;
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(new DOMException("Upstream request timed out.", "TimeoutError"));
    }, upstreamTimeoutMs);
    const clearUpstreamTimeout = () => {
      clearTimeout(timeoutHandle);
    };

    const upstreamResult = yield* Effect.tryPromise({
      try: (signal) => {
        const onAbort = () => abortController.abort(signal.reason);
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        return fetchImpl(target.url, {
          method,
          headers: upstreamHeaders,
          redirect: "error",
          ...(outboundBody !== undefined ? { body: outboundBody } : {}),
          signal: abortController.signal,
        }).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onFailure: (cause) => {
          clearUpstreamTimeout();
          return {
            _tag: "Error" as const,
            message: timedOut
              ? `Upstream request timed out after ${upstreamTimeoutMs} ms.`
              : formatExternalMcpFetchError(cause, target.bearerToken, upstreamTimeoutMs),
          };
        },
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
      // Headers arrived within the timeout; keep the SSE stream open without a fixed body timeout.
      clearUpstreamTimeout();
      const redactedStream = makeRedactingSseStream(upstream.body, target.bearerToken);
      const bodyStream = Stream.fromReadableStream({
        evaluate: () => redactedStream,
        onError: (cause) => cause,
      }).pipe(Stream.catch(() => Stream.empty));
      return HttpServerResponse.stream(bodyStream, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    if (upstream.status === 204) {
      clearUpstreamTimeout();
      return HttpServerResponse.empty({ status: 204, headers: responseHeaders });
    }

    const bodyResult = yield* Effect.tryPromise({
      try: () => readBoundedResponseBytes(upstream, maxResponseBytes),
      catch: (cause) => cause,
    }).pipe(
      Effect.ensuring(Effect.sync(clearUpstreamTimeout)),
      Effect.match({
        onFailure: (cause) => ({ _tag: "Error" as const, cause }),
        onSuccess: (bytes) => ({ _tag: "Bytes" as const, bytes }),
      }),
    );

    if (bodyResult._tag === "Error") {
      if (bodyResult.cause instanceof ResponseTooLargeError) {
        return jsonRpcError(502, -32002, bodyResult.cause.message);
      }
      const message = timedOut
        ? `Upstream request timed out after ${upstreamTimeoutMs} ms.`
        : formatExternalMcpFetchError(bodyResult.cause, target.bearerToken, upstreamTimeoutMs);
      return jsonRpcError(502, -32002, `Upstream external MCP server error: ${message}`);
    }

    let bytes = bodyResult.bytes;
    if (bytes.byteLength > 0 && isTextLikeContentType(upstreamContentType)) {
      const text = new TextDecoder().decode(bytes);
      const redacted = redactUpstreamText(text, upstreamContentType, target.bearerToken);
      if (redacted !== text) {
        bytes = new TextEncoder().encode(redacted);
      }
    }

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
