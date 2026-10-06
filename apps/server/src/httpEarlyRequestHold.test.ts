// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - plain Node sockets and wall-clock bounds, no Effect runtime.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { holdEarlyRequestsUntilHandled } from "./httpEarlyRequestHold.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";

const servers: NodeHttp.Server[] = [];

function makeServer(options?: Parameters<typeof holdEarlyRequestsUntilHandled>[1]) {
  // Same order as server.ts: the guard first (its pass-through listeners never answer), the hold on top.
  const server = holdEarlyRequestsUntilHandled(
    guardHttpResponseWriteErrors(NodeHttp.createServer()),
    options,
  );
  servers.push(server);
  return server;
}

function listen(server: NodeHttp.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function get(port: number, path = "/") {
  const request = NodeHttp.get({ host: "127.0.0.1", port, path, agent: false });
  const result = new Promise<{
    status: number;
    body: string;
    headers: NodeHttp.IncomingHttpHeaders;
  }>((resolve, reject) => {
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
        }),
      );
    });
    request.on("error", reject);
  });
  return { request, result };
}

function upgradeRequest(port: number) {
  const socket = NodeNet.connect(port, "127.0.0.1", () => {
    socket.write(
      [
        "GET /ws HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
  });
  const text = new Promise<string>((resolve) => {
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("close", () => resolve(received));
    socket.on("error", () => resolve(received));
  });
  return { socket, text };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("holdEarlyRequestsUntilHandled", () => {
  it("answers a request that arrived before any handler was attached", async () => {
    const replays: Array<{ requests: number; upgrades: number }> = [];
    const server = makeServer({ onReplay: (summary) => replays.push(summary) });
    const port = await listen(server);

    const early = get(port, "/early");
    await tick(150);
    // Nothing answers yet, and the early request is still waiting (not refused, not reset).
    let settled = false;
    void early.result.then(() => {
      settled = true;
    });
    await tick(50);
    expect(settled).toBe(false);

    server.on("request", (request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(`handled ${request.url}`);
    });

    const answered = await early.result;
    expect(answered.status).toBe(200);
    expect(answered.body).toBe("handled /early");
    expect(replays).toEqual([{ requests: 1, upgrades: 0 }]);
  });

  it("hands every held request to the handler exactly once, and later ones go straight to it", async () => {
    const server = makeServer();
    const port = await listen(server);
    const early = [get(port, "/a"), get(port, "/b"), get(port, "/c")];
    await tick(100);

    const seen: string[] = [];
    server.on("request", (request, response) => {
      seen.push(request.url ?? "");
      response.end("ok");
    });
    const results = await Promise.all(early.map((entry) => entry.result));
    expect(results.map((entry) => entry.status)).toEqual([200, 200, 200]);
    expect([...seen].sort()).toEqual(["/a", "/b", "/c"]);

    await get(port, "/late").result;
    expect(seen).toHaveLength(4);
    // The hold is gone: only the guard and the handler remain on the request event.
    expect(server.listenerCount("request")).toBe(2);
    expect(server.listenerCount("upgrade")).toBe(1);
  });

  it("replays a held WebSocket upgrade to the upgrade handler", async () => {
    const replays: Array<{ requests: number; upgrades: number }> = [];
    const server = makeServer({ onReplay: (summary) => replays.push(summary) });
    const port = await listen(server);

    const early = upgradeRequest(port);
    await tick(150);

    server.on("request", (_request, response) => response.end("http"));
    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });

    expect(await early.text).toContain("101 Switching Protocols");
    expect(replays).toEqual([{ requests: 0, upgrades: 1 }]);
  });

  it("does not replay a request whose client gave up while it was held", async () => {
    const server = makeServer();
    const port = await listen(server);

    const abandoned = get(port, "/abandoned");
    abandoned.result.catch(() => {});
    const kept = get(port, "/kept");
    await tick(100);
    abandoned.request.destroy();
    await tick(100);

    const seen: string[] = [];
    server.on("request", (request, response) => {
      seen.push(request.url ?? "");
      response.end("ok");
    });
    expect((await kept.result).status).toBe(200);
    await tick(50);
    expect(seen).toEqual(["/kept"]);
  });

  it("answers a request held past the limit with a fast retryable 503", async () => {
    const server = makeServer({ maxHoldMs: 150 });
    const port = await listen(server);

    const started = Date.now();
    const timedOut = await get(port, "/never").result;
    expect(timedOut.status).toBe(503);
    expect(timedOut.headers["retry-after"]).toBe("1");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("answers an upgrade held past the limit with a 503", async () => {
    const server = makeServer({ maxHoldMs: 150 });
    const port = await listen(server);

    const early = upgradeRequest(port);
    const text = await early.text;
    expect(text).toContain("503 Service Unavailable");
    expect(text).toContain("Retry-After: 1");
  });
});
