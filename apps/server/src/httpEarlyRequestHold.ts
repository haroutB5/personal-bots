// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a raw Node socket server callback, outside any Effect fiber; each timer is cleared on every completion path.
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

/**
 * The listening socket opens as soon as the HTTP server layer is built, but
 * the application's request and upgrade handlers are attached only when the
 * routes layer has finished (after migrations and the provider registry, about
 * 0.4 to 1.5 s later). Until then nothing answers: the guard's pass-through
 * listeners see the request and do not respond, so a request that arrives in
 * that window hangs until the client gives up, even after the server is ready.
 * A reconnecting phone hits exactly that window after every update.
 *
 * The port stays bound early (a second server on the same port still fails
 * fast), and this wrapper holds each early request or WebSocket upgrade. As
 * soon as the first real handler is attached it replays the held ones to it,
 * so they are answered the moment the server is ready, without a client retry.
 * A request held longer than `maxHoldMs` gets a fast retryable 503 instead.
 */
export const EARLY_REQUEST_MAX_HOLD_MS = 30_000;

export interface EarlyRequestHoldOptions {
  readonly maxHoldMs?: number;
  readonly onReplay?: (summary: { readonly requests: number; readonly upgrades: number }) => void;
}

type HeldRequest = {
  readonly kind: "request";
  readonly request: NodeHttp.IncomingMessage;
  readonly response: NodeHttp.ServerResponse;
  readonly timer: ReturnType<typeof setTimeout>;
};
type HeldUpgrade = {
  readonly kind: "upgrade";
  readonly request: NodeHttp.IncomingMessage;
  readonly socket: NodeStream.Duplex;
  readonly head: Buffer;
  readonly timer: ReturnType<typeof setTimeout>;
};

const RETRYABLE_503 = [
  "HTTP/1.1 503 Service Unavailable",
  "Retry-After: 1",
  "Connection: close",
  "Content-Length: 0",
  "",
  "",
].join("\r\n");

export function holdEarlyRequestsUntilHandled<T extends NodeHttp.Server>(
  server: T,
  options: EarlyRequestHoldOptions = {},
): T {
  const maxHoldMs = options.maxHoldMs ?? EARLY_REQUEST_MAX_HOLD_MS;
  const held = new Set<HeldRequest | HeldUpgrade>();
  let released = false;
  let flushScheduled = false;

  const holdRequest = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const entry: HeldRequest = {
      kind: "request",
      request,
      response,
      timer: setTimeout(() => {
        held.delete(entry);
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(503, { "Retry-After": "1", "Content-Length": "0" });
        }
        response.end();
      }, maxHoldMs),
    };
    entry.timer.unref();
    held.add(entry);
    response.once("close", () => {
      clearTimeout(entry.timer);
      held.delete(entry);
    });
  };

  const holdUpgrade = (
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ) => {
    const entry: HeldUpgrade = {
      kind: "upgrade",
      request,
      socket,
      head,
      timer: setTimeout(() => {
        held.delete(entry);
        if (!socket.destroyed) {
          socket.end(RETRYABLE_503);
        }
      }, maxHoldMs),
    };
    entry.timer.unref();
    held.add(entry);
    socket.once("close", () => {
      clearTimeout(entry.timer);
      held.delete(entry);
    });
  };

  const flush = () => {
    flushScheduled = false;
    const entries = [...held];
    held.clear();
    let requests = 0;
    let upgrades = 0;
    for (const entry of entries) {
      clearTimeout(entry.timer);
      if (entry.kind === "request") {
        if (entry.response.destroyed) continue;
        requests += 1;
        server.emit("request", entry.request, entry.response);
      } else {
        if (entry.socket.destroyed) continue;
        upgrades += 1;
        server.emit("upgrade", entry.request, entry.socket, entry.head);
      }
    }
    if (requests + upgrades > 0) options.onReplay?.({ requests, upgrades });
  };

  // `newListener` fires before the listener is added. The first listener added
  // after this wrapper is the application's own handler: stop holding at once
  // (so nothing is held after that) and replay what was held once both the
  // request and the upgrade handler are in place.
  const onNewListener = (event: string | symbol) => {
    if (released || (event !== "request" && event !== "upgrade")) return;
    server.off("request", holdRequest);
    server.off("upgrade", holdUpgrade);
    server.off("newListener", onNewListener);
    released = true;
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flush);
    }
  };

  server.on("request", holdRequest);
  server.on("upgrade", holdUpgrade);
  server.on("newListener", onNewListener);
  return server;
}
