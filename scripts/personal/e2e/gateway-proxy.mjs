// Disposable local origin failure fixture for the collaborative browser.
// Config file: { upstream: "http://127.0.0.1:port", mode: "ok"|"502"|"504",
// target: "auth"|"descriptor" }. Change the file to recover without reloading.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
const [configFile, portText] = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
const server = http.createServer((req, res) => {
  const cfg = read(),
    target = new URL(cfg.upstream);
  if (target.hostname !== "127.0.0.1") {
    res.writeHead(500).end();
    return;
  }
  const failing =
    cfg.target === "descriptor"
      ? req.url.startsWith("/.well-known/t3/environment")
      : req.url.startsWith("/api/auth/session");
  if (cfg.mode !== "ok" && failing) {
    res.writeHead(Number(cfg.mode), { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("Unable to reach the origin service");
    return;
  }
  if (
    cfg.webDist &&
    req.method === "GET" &&
    !/^\/(api|oauth|\.well-known)(\/|$)/.test(req.url) &&
    req.url !== "/version.txt"
  ) {
    const base = path.resolve(cfg.webDist);
    let file = path.resolve(base, "." + new URL(req.url, cfg.upstream).pathname);
    if (!file.startsWith(base + path.sep)) file = path.join(base, "index.html");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(base, "index.html");
    const type =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
        ".woff2": "font/woff2",
      }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const upstream = http.request(
    new URL(req.url, cfg.upstream),
    { method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => res.writeHead(502).end("origin unavailable"));
  req.pipe(upstream);
});
server.on("upgrade", (req, socket, head) => {
  const target = new URL(read().upstream);
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((s, x, i, a) => (i % 2 === 0 ? s + `${x}: ${a[i + 1]}\r\n` : s), "")}\r\n`,
    );
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(Number(portText), "127.0.0.1", () =>
  console.log(`gateway fixture http://127.0.0.1:${portText}`),
);
