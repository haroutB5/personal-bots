// Stand-in for the hbots server on a loopback port: /version.txt from the current release's VERSION file,
// /sw.js with the worker-list revision, POST /api/personal/push/sent -> 401 (200 with the push-open flag),
// environment descriptor 200. Usage: node fake-server.cjs <home> <port>
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const home = process.argv[2];
const port = Number(process.argv[3]);
const flags = path.join(home, 'run', 'flags');
http.createServer((req, res) => {
  const cur = fs.readFileSync(path.join(home, 'releases', 'current.txt'), 'utf8').trim();
  if (req.url === '/version.txt') {
    res.setHeader('content-type', 'text/plain');
    res.end(fs.readFileSync(path.join(home, 'releases', cur, 'VERSION'), 'utf8'));
  } else if (req.url === '/sw.js') {
    res.setHeader('content-type', 'application/javascript');
    res.end('const SW_REVISION = "2026-09-30-worker-list";');
  } else if (req.url === '/api/personal/push/sent' && req.method === 'POST') {
    res.statusCode = fs.existsSync(path.join(flags, 'push-open')) ? 200 : 401;
    res.end('{}');
  } else if (req.url.startsWith('/.well-known/t3/environment')) {
    res.setHeader('content-type', 'application/json');
    res.end('{"serverVersion":"stub"}');
  } else {
    res.statusCode = 404;
    res.end('no');
  }
}).listen(port, '127.0.0.1');
