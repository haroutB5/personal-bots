/**
 * Source of the stall watchdog's worker thread, kept as plain JavaScript text so the
 * bundled server can start it with `new Worker(source, { eval: true })` (a worker
 * needs a file of its own otherwise, and the server ships as one bundle).
 *
 * The worker watches a heartbeat the main thread writes into shared memory. When the
 * beat is older than the threshold the main thread is blocked, whatever blocked it:
 * JavaScript, a synchronous SQLite or file call, garbage collection or the machine
 * itself. The worker then reads the main thread's CPU profile through the inspector
 * (V8's sampler thread keeps sampling while the main thread is blocked, even inside
 * a native call, and attributes the samples to the JavaScript frame that made the
 * call) and sends a small summary back: function names, file base names and line
 * numbers only.
 */

/** What the summarizer returns: names, file base names, line numbers and milliseconds. */
export interface ProfileSummary {
  readonly windowSamples: number;
  readonly windowMs: number;
  readonly idleMs: number;
  readonly programMs: number;
  readonly gcMs: number;
  readonly topSelf: ReadonlyArray<{ readonly frame: string; readonly ms: number }>;
  readonly topStacks: ReadonlyArray<{
    readonly ms: number;
    readonly frames: ReadonlyArray<string>;
  }>;
}

/** The part of a V8 `Profiler.stop` result the summarizer reads. */
export interface V8Profile {
  readonly nodes: ReadonlyArray<{
    readonly id: number;
    readonly callFrame: { functionName: string; url: string; lineNumber: number };
    readonly children?: ReadonlyArray<number>;
  }>;
  readonly startTime: number;
  readonly endTime: number;
  readonly samples?: ReadonlyArray<number>;
  readonly timeDeltas?: ReadonlyArray<number>;
}

/**
 * Turns a V8 CPU profile into a short summary of the part of it from `windowStartUs`
 * on: where the main thread's samples fell, by function (self time) and by call stack.
 * Plain JavaScript text, because it runs inside the worker and the tests evaluate the
 * same text.
 */
export const SUMMARIZER_SOURCE = String.raw`
function summarizeProfile(profile, windowStartUs, topN, maxDepth) {
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);
  const parent = new Map();
  for (const node of profile.nodes) {
    if (node.children) for (const child of node.children) parent.set(child, node.id);
  }
  const frameLabel = (node) => {
    const name = node.callFrame.functionName || "(anonymous)";
    const url = node.callFrame.url || "";
    if (url === "") return name;
    const file = url.split("?")[0].split("#")[0].split(/[\\/]/).pop() || url;
    return name + " (" + file + ":" + (node.callFrame.lineNumber + 1) + ")";
  };
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  const selfUsByNode = new Map();
  let windowUs = 0, idleUs = 0, programUs = 0, gcUs = 0, windowSamples = 0;
  let timeUs = profile.startTime;
  for (let i = 0; i < samples.length; i++) {
    timeUs += deltas[i] || 0;
    if (timeUs < windowStartUs) continue;
    // The delta after a sample is how long the sampled stack stayed current.
    const weightUs = deltas[i + 1] || 0;
    const node = byId.get(samples[i]);
    if (node === undefined) continue;
    windowSamples += 1;
    windowUs += weightUs;
    const name = node.callFrame.functionName;
    if (name === "(idle)") idleUs += weightUs;
    else if (name === "(program)") programUs += weightUs;
    else if (name === "(garbage collector)") gcUs += weightUs;
    selfUsByNode.set(node.id, (selfUsByNode.get(node.id) || 0) + weightUs);
  }
  const selfUsByFrame = new Map();
  for (const [id, us] of selfUsByNode) {
    const label = frameLabel(byId.get(id));
    selfUsByFrame.set(label, (selfUsByFrame.get(label) || 0) + us);
  }
  const toMs = (us) => Math.round(us / 100) / 10;
  const topSelf = [...selfUsByFrame.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map((entry) => ({ frame: entry[0], ms: toMs(entry[1]) }));
  const topStacks = [...selfUsByNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.min(topN, 5))
    .map((entry) => {
      const frames = [];
      let cursor = entry[0];
      while (cursor !== undefined && frames.length < maxDepth) {
        const node = byId.get(cursor);
        if (node === undefined) break;
        if (node.callFrame.functionName !== "(root)") frames.push(frameLabel(node));
        cursor = parent.get(cursor);
      }
      return { ms: toMs(entry[1]), frames };
    });
  return {
    windowSamples,
    windowMs: toMs(windowUs),
    idleMs: toMs(idleUs),
    programMs: toMs(programUs),
    gcMs: toMs(gcUs),
    topSelf,
    topStacks,
  };
}
`;

const WORKER_BODY = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const os = require("node:os");

const beat = new Int32Array(workerData.sab);
const thresholdMs = workerData.thresholdMs;
const pollMs = workerData.pollMs;
const heartbeatMs = workerData.heartbeatMs;
const profilerMode = workerData.profilerMode;
const sampleIntervalUs = workerData.sampleIntervalUs;
const rotateMs = workerData.rotateMs;
const topN = workerData.topN;
const maxDepth = workerData.maxDepth;
const healthyLagMs = Math.max(heartbeatMs * 2, 400);

let session = null;
let profilerRunning = false;
let profilerStartedAt = 0;
let profilerError = null;
let stopping = false;

const send = (message) => {
  try { parentPort.postMessage(message); } catch (error) { /* main thread is gone */ }
};

const post = (method, params, timeoutMs) =>
  new Promise((resolve, reject) => {
    if (session === null) { reject(new Error("no inspector session")); return; }
    const timer = setTimeout(() => reject(new Error(method + " timed out")), timeoutMs || 30000);
    session.post(method, params, (error, result) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    });
  });

const startProfiler = async () => {
  if (profilerMode === "off" || session === null || profilerRunning) return;
  try {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: sampleIntervalUs });
    await post("Profiler.start");
    profilerRunning = true;
    profilerStartedAt = Date.now();
  } catch (error) {
    profilerError = String(error && error.message ? error.message : error);
  }
};

const stopProfiler = async (timeoutMs) => {
  if (!profilerRunning) return null;
  profilerRunning = false;
  try {
    const result = await post("Profiler.stop", undefined, timeoutMs);
    return result.profile;
  } catch (error) {
    profilerError = String(error && error.message ? error.message : error);
    return null;
  }
};

const lagMs = () => (((Date.now() | 0) - Atomics.load(beat, 0)) | 0);

let state = "healthy";
let stall = null;
let busy = false;
let healthyCpu = process.cpuUsage();
let healthyAt = Date.now();

const collect = async () => {
  const endedAt = Date.now() - lagMs();
  const startedAt = stall.beatBeforeAt;
  const durationMs = Math.max(0, endedAt - startedAt - heartbeatMs);
  const cpu = process.cpuUsage(healthyCpu);
  const wallMs = Date.now() - healthyAt;
  const requestedAt = Date.now();
  let profile = null;
  if (stall.startPromise) { await stall.startPromise; }
  profile = await stopProfiler(30000);
  const serviceMs = Date.now() - requestedAt;
  let summary = null;
  if (profile) {
    try {
      summary = summarizeProfile(profile, profile.endTime - (durationMs + 300) * 1000, topN, maxDepth);
    } catch (error) {
      profilerError = String(error && error.message ? error.message : error);
    }
  }
  send({
    type: "stall",
    startedAt,
    endedAt,
    durationMs,
    profilerMode,
    profileStartLatencyMs: stall.startLatencyMs,
    profileStopLatencyMs: serviceMs,
    profilerError,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    cpuWallMs: wallMs,
    freeMemMb: Math.round(os.freemem() / 1048576),
    rssMb: Math.round(process.memoryUsage.rss() / 1048576),
    summary,
  });
  profilerError = null;
  if (profilerMode === "continuous") await startProfiler();
};

const poll = async () => {
  if (busy || stopping) return;
  busy = true;
  try {
    const now = Date.now();
    const lag = lagMs();
    if (state === "healthy") {
      if (lag >= thresholdMs) {
        state = "stalled";
        stall = { detectedAt: now, beatBeforeAt: now - lag, startPromise: null, startLatencyMs: null };
        if (profilerMode === "detect") {
          const begun = Date.now();
          stall.startPromise = startProfiler().then(() => { stall.startLatencyMs = Date.now() - begun; });
        }
      } else {
        healthyCpu = process.cpuUsage();
        healthyAt = now;
        if (profilerMode === "continuous") {
          if (!profilerRunning) await startProfiler();
          else if (now - profilerStartedAt > rotateMs) { await stopProfiler(30000); await startProfiler(); }
        }
      }
    } else if (state === "stalled" && lag < healthyLagMs) {
      await collect();
      state = "healthy";
      stall = null;
      healthyCpu = process.cpuUsage();
      healthyAt = Date.now();
    }
  } catch (error) {
    send({ type: "error", message: String(error && error.message ? error.message : error) });
    state = "healthy";
    stall = null;
  } finally {
    busy = false;
  }
};

try {
  session = new inspector.Session();
  session.connectToMainThread();
} catch (error) {
  session = null;
  profilerError = String(error && error.message ? error.message : error);
}

parentPort.on("message", (message) => {
  if (message && message.type === "stop") {
    stopping = true;
    try { if (session) session.disconnect(); } catch (error) { /* already gone */ }
    process.exit(0);
  }
});

send({ type: "ready", profilerMode: session === null ? "off" : profilerMode, profilerError });
if (session !== null && profilerMode === "continuous") startProfiler();
setInterval(poll, pollMs);
`;

export const STALL_WATCHDOG_WORKER_SOURCE = `${SUMMARIZER_SOURCE}\n${WORKER_BODY}`;
