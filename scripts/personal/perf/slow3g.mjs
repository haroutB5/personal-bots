// hbots perf: slow-connection journeys, the way Theo measured upstream T3 Code
// ("I made t3 code faster again", 3G, median of 3).
//
//   node scripts/personal/perf/slow3g.mjs --target http://127.0.0.1:40781 \
//        --biggest "/bots/<botId>?chat=<threadId>" --chats "<pathA>,<pathB>,<pathC>" \
//        [--runs 3] [--down-kbps 400] [--up-kbps 400] [--rtt 400] [--label before] [--out file.json]
//
// --target is a throwaway server (never the live one); sign in to it once with
// login.mjs. The script puts a byte-counting TCP proxy in front of it and
// drives Brave at the proxy, so "wire" is every byte both ways on the TCP
// connections (HTTP and the WebSocket, compressed as sent), and "JSON" is the
// decoded JSON the page parsed (HTTP JSON bodies plus WebSocket text frames,
// from CDP). Throttling is CDP Network.emulateNetworkConditions (400 kbps down
// and up, 400 ms latency by default) with the HTTP cache off for the cold run.
// Each run is a fresh Brave with a fresh profile, so no connection, cache or
// service worker carries over from the run before.
//
// Journeys per run:
//   cold       new profile, empty caches -> deep link to the biggest chat -> its
//              newest message and a typeable composer are on screen
//   reconnect  Brave closed and relaunched on the same profile (assets in the
//              service worker, new connections) -> /bots -> live chat rows
//   open-A/B/C in that app, in-app navigation to each chat -> newest message shown
// Each journey also waits for the network to go quiet (2 s with no bytes) and
// reports "settled" (last byte) plus the bytes up to then.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium, authStatePath, median, round, PERF_HOME } from "./lib.mjs";
import { resolveBraveExecutable } from "../e2e/browser.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null))
    .filter(Boolean),
);
if (typeof args.target !== "string" || typeof args.biggest !== "string") {
  console.error("usage: slow3g.mjs --target <throwaway url> --biggest <chat path> [--chats a,b,c]");
  process.exit(2);
}
const target = new URL(args.target);
const runs = Number(args.runs ?? 3);
const downKbps = Number(args["down-kbps"] ?? 400);
const upKbps = Number(args["up-kbps"] ?? 400);
const rtt = Number(args.rtt ?? 400);
const label = typeof args.label === "string" ? args.label : "run";
const chats = typeof args.chats === "string" ? args.chats.split(",").filter(Boolean) : [];
const out =
  typeof args.out === "string"
    ? args.out
    : NodePath.join(PERF_HOME, `slow3g-${label}-${Date.now()}.json`);
const QUIET_MS = 2000;
const probeSource = NodeFS.readFileSync(new URL("./probe.js", import.meta.url), "utf8");
const statePath = authStatePath(target.origin);
if (!NodeFS.existsSync(statePath)) {
  console.error(
    `No signed-in state for ${target.origin}. Run login.mjs with a pairing link first.`,
  );
  process.exit(2);
}
const cookies = JSON.parse(NodeFS.readFileSync(statePath, "utf8")).cookies;

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
};

// The newest message of the open chat is painted, and the composer is typeable.
const MESSAGE_WATCHER = `() => {
  if (window.__perfExpect && location.pathname !== window.__perfExpect) return null;
  const log = [...document.querySelectorAll('[role="log"]')].find((l) => l.getBoundingClientRect().height > 0);
  return log && log.querySelector('[data-transcript-row]') &&
    document.querySelector('textarea[placeholder^="Message"]:not([disabled])') && log;
}`;

/** Byte-counting TCP proxy; every byte both ways, per journey. */
function startProxy() {
  const meter = { down: 0, up: 0, connections: 0, lastByteAt: 0 };
  const sockets = new Set();
  const server = NodeNet.createServer((client) => {
    meter.connections += 1;
    const upstream = NodeNet.connect(Number(target.port), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (chunk) => {
      meter.up += chunk.length;
      meter.lastByteAt = performance.now();
    });
    upstream.on("data", (chunk) => {
      meter.down += chunk.length;
      meter.lastByteAt = performance.now();
    });
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        meter,
        origin: `http://127.0.0.1:${server.address().port}`,
        dropAll: () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
        },
        close: () => new Promise((yes) => server.close(yes)),
      });
    });
  });
}

/** Decoded JSON the page received: HTTP JSON bodies and WebSocket text frames. */
function watchJson(cdp, origin) {
  const state = {
    http: 0,
    ws: 0,
    requests: [],
    frames: new Map(),
    sent: 0,
    sentSamples: [],
    t0: performance.now(),
  };
  const since = () => Math.round(performance.now() - state.t0);
  const started = new Map();
  const json = new Map();
  const methods = new Map();
  const uploads = new Map();
  cdp.on("Network.responseReceived", (e) => {
    if (!e.response.url.startsWith(origin)) return;
    const path = new URL(e.response.url).pathname + new URL(e.response.url).search;
    const entry = {
      path: path.slice(0, 160),
      json: /json/.test(e.response.mimeType ?? ""),
      encoding:
        e.response.headers["content-encoding"] ?? e.response.headers["Content-Encoding"] ?? "",
      decoded: 0,
      wire: 0,
      cached: Boolean(e.response.fromServiceWorker || e.response.fromDiskCache),
      type: e.type,
      postKB: round((uploads.get(e.requestId) ?? 0) / 1024, 1),
      startMs: started.get(e.requestId) ?? since(),
      endMs: null,
    };
    json.set(e.requestId, entry);
    state.requests.push(entry);
  });
  cdp.on("Network.dataReceived", (e) => {
    const entry = json.get(e.requestId);
    if (!entry) return;
    entry.decoded += e.dataLength;
    if (entry.json) state.http += e.dataLength;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const entry = json.get(e.requestId);
    if (!entry) return;
    entry.wire = e.encodedDataLength ?? 0;
    entry.endMs = since();
  });
  cdp.on("Network.webSocketFrameReceived", (e) => {
    if (e.response?.opcode !== 1) return;
    const text = e.response.payloadData ?? "";
    const bytes = Buffer.byteLength(text);
    state.ws += bytes;
    // Group frames by their RPC tag so the report says what the socket carried.
    const tag = (text.match(/"_tag":"([^"]{1,60})"/) ?? [])[1] ?? "?";
    const id = (text.match(/"requestId":"?([^",]{1,40})/) ?? [])[1] ?? "";
    const key = `${methods.get(id) ?? "?"} ${tag}`;
    const f = state.frames.get(key) ?? {
      frames: 0,
      bytes: 0,
      sample: text.slice(0, 160),
      firstMs: since(),
    };
    f.frames += 1;
    f.bytes += bytes;
    state.frames.set(key, f);
    void id;
  });
  cdp.on("Network.webSocketFrameSent", (e) => {
    const text = e.response?.payloadData ?? "";
    state.sent += Buffer.byteLength(text);
    if (state.sentSamples.length < 40) state.sentSamples.push(text.slice(0, 140));
    const m = text.match(/"_tag":"Request","id":"?([^",]+)"?,"tag":"([^"]+)"/);
    if (m) methods.set(m[1], m[2]);
  });
  cdp.on("Network.requestWillBeSent", (e) => {
    if (!e.request.url.startsWith(origin)) return;
    uploads.set(e.requestId, e.request.postData ? Buffer.byteLength(e.request.postData) : 0);
    if (!started.has(e.requestId)) started.set(e.requestId, since());
  });
  return {
    reset() {
      state.http = 0;
      state.ws = 0;
      state.requests = [];
      state.frames = new Map();
      state.sent = 0;
      state.t0 = performance.now();
      started.clear();
    },
    read: () => ({
      jsonKB: round((state.http + state.ws) / 1024, 1),
      httpJsonKB: round(state.http / 1024, 1),
      wsJsonKB: round(state.ws / 1024, 1),
      top: state.requests
        .filter((r) => r.json && !r.cached)
        .sort((a, b) => b.decoded - a.decoded)
        .slice(0, 6)
        .map((r) => ({
          path: r.path,
          decodedKB: round(r.decoded / 1024, 1),
          wireKB: round(r.wire / 1024, 1),
          encoding: r.encoding,
        })),
      ...(args.detail
        ? {
            wsSentKB: round(state.sent / 1024, 1),
            sentSamples: state.sentSamples,
            requests: state.requests.map((r) => ({
              path: r.path.slice(0, 90),
              type: r.type,
              wireKB: round(r.wire / 1024, 1),
              decodedKB: round(r.decoded / 1024, 1),
              encoding: r.encoding,
              cached: r.cached,
              postKB: r.postKB,
              startMs: r.startMs,
              endMs: r.endMs,
            })),
            frames: [...state.frames.entries()]
              .sort((a, b) => b[1].bytes - a[1].bytes)
              .slice(0, 15)
              .map(([tag, f]) => ({
                tag,
                frames: f.frames,
                KB: round(f.bytes / 1024, 1),
                sample: f.sample,
                firstMs: f.firstMs,
              })),
          }
        : {}),
    }),
  };
}

async function throttle(cdp, { cache }) {
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: !cache });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: rtt,
    downloadThroughput: (downKbps * 1000) / 8,
    uploadThroughput: (upKbps * 1000) / 8,
    connectionType: "cellular3g",
  });
}

async function waitQuiet(proxy, startAt) {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (performance.now() - proxy.meter.lastByteAt >= QUIET_MS) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return proxy.meter.lastByteAt - startAt;
}

async function journey(page, proxy, watcher, mark, start) {
  const m0 = { down: proxy.meter.down, up: proxy.meter.up };
  const wallStart = performance.now();
  watcher.reset();
  await start();
  await page.waitForFunction((name) => window.__perf?.marks[name] !== undefined, mark, {
    timeout: 120_000,
    polling: 50,
  });
  const visible = performance.now() - wallStart;
  const visibleWireKB = round((proxy.meter.down - m0.down + proxy.meter.up - m0.up) / 1024, 1);
  const settled = await waitQuiet(proxy, wallStart);
  // The probe's own marks (page clock: ms since that page's navigation, so
  // only comparable with visibleMs for full loads such as cold and reconnect).
  const pageMarks = await page
    .evaluate(() => Object.fromEntries(Object.entries(window.__perf?.marks ?? {})))
    .catch(() => ({}));
  return {
    visibleMs: round(visible),
    settledMs: round(Math.max(settled, visible)),
    visibleWireKB,
    wireKB: round((proxy.meter.down - m0.down + proxy.meter.up - m0.up) / 1024, 1),
    downKB: round((proxy.meter.down - m0.down) / 1024, 1),
    upKB: round((proxy.meter.up - m0.up) / 1024, 1),
    ...watcher.read(),
    pageMarks: Object.fromEntries(
      Object.entries(pageMarks).map(([name, at]) => [name, round(Number(at))]),
    ),
  };
}

async function launch(profile, proxy) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: resolveBraveExecutable(),
    ...PHONE,
  });
  await context.addCookies(cookies.map((c) => ({ ...c, domain: new URL(proxy.origin).hostname })));
  await context.addInitScript(probeSource);
  await context.addInitScript((find) => {
    // eslint-disable-next-line no-eval
    const add = () => window.__perf?.watchers.push(["messages", (0, eval)(find)]);
    if (window.__perf) add();
  }, MESSAGE_WATCHER);
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp };
}

async function oneRun(index) {
  const proxy = await startProxy();
  const profile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-slow3g-"));
  const result = { run: index };
  try {
    // Cold: fresh profile, no cache, no service worker.
    let b = await launch(profile, proxy);
    let watcher = watchJson(b.cdp, proxy.origin);
    await throttle(b.cdp, { cache: false });
    await b.cdp.send("Network.setBypassServiceWorker", { bypass: true });
    result.cold = await journey(b.page, proxy, watcher, "messages", () =>
      b.page.goto(`${proxy.origin}${args.biggest}`, { waitUntil: "commit", timeout: 120_000 }),
    );
    // Let the service worker install and cache the assets (unthrottled), as a
    // phone that used the app before would have them.
    await b.cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await b.cdp.send("Network.setBypassServiceWorker", { bypass: false });
    await b.page.goto(`${proxy.origin}/bots`, { waitUntil: "load", timeout: 120_000 });
    await b.page
      .evaluate(async () => {
        if ("serviceWorker" in navigator) await navigator.serviceWorker.ready;
      })
      .catch(() => {});
    await b.page.waitForTimeout(3000);
    await b.context.close();
    proxy.dropAll();

    // Reconnect: relaunch on the same profile, new connections, cached assets.
    b = await launch(profile, proxy);
    watcher = watchJson(b.cdp, proxy.origin);
    await throttle(b.cdp, { cache: true });
    result.reconnect = await journey(b.page, proxy, watcher, "liveRows", () =>
      b.page.goto(`${proxy.origin}/bots`, { waitUntil: "commit", timeout: 120_000 }),
    );

    // Open each chat in that app, the way a tap would (client-side navigation).
    // Between chats, go back to the Bots list first, as a phone user does.
    const navigate = (to) =>
      b.page.evaluate((to) => {
        window.__perfExpect = to;
        window.history.pushState({}, "", to);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }, to);
    for (const [i, path] of chats.entries()) {
      const name = `open-${String.fromCharCode(65 + i)}`;
      await navigate("/bots");
      await b.page.waitForFunction(
        () => location.pathname === "/bots" && window.__perf?.marks.liveRows !== undefined,
        null,
        { timeout: 120_000 },
      );
      await waitQuiet(proxy, performance.now());
      await b.page.evaluate(() => window.__perf.reset());
      result[name] = await journey(b.page, proxy, watcher, "messages", () =>
        navigate(path.split("?")[0]),
      );
      result[name].path = path;
    }
    await b.context.close();
  } catch (error) {
    result.error = String(error?.message ?? error).split("\n")[0];
  } finally {
    proxy.dropAll();
    await proxy.close();
    NodeFS.rmSync(profile, { recursive: true, force: true });
  }
  return result;
}

const all = [];
for (let i = 1; i <= runs; i += 1) {
  const r = await oneRun(i);
  all.push(r);
  console.log(
    `run ${i}: ` +
      Object.entries(r)
        .filter(([, v]) => v && typeof v === "object")
        .map(
          ([k, v]) =>
            `${k} ${v.visibleMs}ms/${v.settledMs}ms ${v.wireKB}KB wire ${v.jsonKB}KB json`,
        )
        .join(" | ") +
      (r.error ? ` ERROR ${r.error}` : ""),
  );
}
const names = ["cold", "reconnect", ...chats.map((_, i) => `open-${String.fromCharCode(65 + i)}`)];
const summary = {};
for (const name of names) {
  const xs = all.map((r) => r[name]).filter(Boolean);
  if (xs.length === 0) continue;
  summary[name] = Object.fromEntries(
    [
      "visibleMs",
      "settledMs",
      "visibleWireKB",
      "wireKB",
      "downKB",
      "upKB",
      "jsonKB",
      "httpJsonKB",
      "wsJsonKB",
    ].map((k) => [k, round(median(xs.map((x) => x[k])), 1)]),
  );
  summary[name].runs = xs.length;
}
const report = {
  label,
  at: new Date().toISOString(),
  settings: {
    target: target.origin,
    runs,
    downKbps,
    upKbps,
    rtt,
    quietMs: QUIET_MS,
    biggest: args.biggest,
    chats,
  },
  summary,
  runs: all,
};
NodeFS.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`report: ${out}`);
process.exitCode = all.some((r) => r.error) ? 1 : 0;
