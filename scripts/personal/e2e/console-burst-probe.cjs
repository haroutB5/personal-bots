// The 1.66.35 console/stall probe: preloaded with NODE_OPTIONS=--require into a
// THROWAWAY server only (scripts/personal/qa-16635.ps1 drives it). Does nothing
// unless this is the main thread of a process whose entry is bin.mjs and
// QA_PROBE_DIR is set.
//
// Requests are files the driver drops into that directory:
//   burst-<label>.json  { n, chunk }  writes n numbered lines alternately to
//     process.stdout / process.stderr (looked up at call time, so the server's
//     patched write is what runs). After every chunk it records the count
//     ACCEPTED so far in <label>.accepted (sync); <label>.done lands with
//     whether each stream's write was patched. The driver kills the server
//     mid-burst (taskkill /F, what restart/-Stop/rollback use) and compares the
//     lines in the log with the accepted count: the F1 check - with the batched
//     writer the loss is the write batch in flight, not the whole backlog.
//   stall-<label>.json  { ms }  holds the main thread in a busy loop for about
//     ms, so the stall recorder (1 s threshold) captures a stall. <label>.stalled
//     records when the loop ended. The F3 check reads where the capture landed:
//     a test server must write it under its own root, never the live stalls dir.
const fs = require("node:fs");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const dir = process.env.QA_PROBE_DIR;
if (dir && isMainThread && /bin\.mjs$/i.test(process.argv[1] || "")) {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const handled = new Set();
  let seq = 0;
  const pad = "x".repeat(60);

  const runBurst = (label, n, chunk) => {
    let i = 0;
    const step = () => {
      const end = Math.min(n, i + chunk);
      for (; i < end; i += 1) {
        seq += 1;
        const line = `QAPROBE ${label} ${i % 2 === 0 ? "out" : "err"} i=${i} seq=${seq} ${pad} END\n`;
        if (i % 2 === 0) process.stdout.write(line);
        else process.stderr.write(line);
      }
      fs.writeFileSync(path.join(dir, `${label}.accepted`), String(i));
      if (i < n) setImmediate(step);
      else
        fs.writeFileSync(
          path.join(dir, `${label}.done`),
          JSON.stringify({
            n,
            patchedOut: process.stdout.write !== origOut,
            patchedErr: process.stderr.write !== origErr,
            pid: process.pid,
          }),
        );
    };
    step();
  };

  const runStall = (label, ms) => {
    const endAt = Date.now() + ms;
    // No await, no timers: the main thread is simply busy until then.
    while (Date.now() < endAt) {
      // spin
    }
    fs.writeFileSync(
      path.join(dir, `${label}.stalled`),
      JSON.stringify({ ms, endedAt: new Date().toISOString(), pid: process.pid }),
    );
  };

  setInterval(() => {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      const burst = /^burst-(\w+)\.json$/.exec(file);
      if (burst && !handled.has(burst[1])) {
        handled.add(burst[1]);
        const request = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        runBurst(burst[1], request.n, request.chunk ?? 2000);
        continue;
      }
      const stall = /^stall-(\w+)\.json$/.exec(file);
      if (stall && !handled.has(stall[1])) {
        handled.add(stall[1]);
        const request = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        runStall(stall[1], request.ms ?? 1500);
      }
    }
  }, 200).unref();
}
