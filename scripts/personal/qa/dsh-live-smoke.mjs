#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Live smoke for the DeepSeek Harness engine (hbots 1.67.1).
 *
 * Runs the REAL pinned dsh with the REAL generated launch patch and the REAL
 * child environment, then drives one ACP handshake and one prompt. With a
 * deliberately invalid key the model turn cannot succeed, which is exactly
 * what this proves: the harness boots from our patch (deny plugin row and
 * all), the session comes up, the failure comes back in dsh's words, and the
 * privacy rows hold — no session-log upload event, no credentials file, and
 * only api.deepseek.com contacted. Q1/Q5 answers and a successful turn need a
 * valid key.
 *
 * Usage: node dsh-live-smoke.mjs <evidenceDir> [--keep]
 */
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import {
  buildDshLaunchPatch,
  serializeDshLaunchPatch,
} from "../../../apps/server/src/provider/acp/DshAcpSupport.ts";

const evidenceDir = NodePath.resolve(process.argv[2] ?? ".");
const runtimeDir = NodePath.join(
  process.env.USERPROFILE ?? "",
  ".personal-bots",
  "runtimes",
  "dsh-0.2.0-rc.2",
);
const binJs = NodePath.join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const denyPlugin = NodePath.join(runtimeDir, "hbots-deny-plugin.mjs");
const dshHome = NodePath.join(evidenceDir, "dshhome");
const workDir = NodePath.join(evidenceDir, "work");
const patchFile = NodePath.join(dshHome, "launch", "smoke.json");
const framesLog = NodePath.join(evidenceDir, "frames.jsonl");
const proxyLog = NodePath.join(evidenceDir, "proxy-hosts.jsonl");
const resultFile = NodePath.join(evidenceDir, "result.json");

const results = {
  startedAt: new Date().toISOString(),
  runtime: { dir: runtimeDir, exists: false, version: null },
  sessionLogUploadEvents: null,
  credentialsFilePresent: null,
  hostsContacted: null,
  launchPatchRows: null,
  handshake: { initialized: false, sessionId: null, configOptions: null },
  prompt: { failed: false, errorText: null, stopReason: null },
  ok: false,
};

const record = (stream, entry) =>
  NodeFS.appendFileSync(framesLog, `${JSON.stringify({ t: Date.now(), stream, entry })}\n`);

function frameLines(file) {
  return decodeZstdFrames(NodeFS.readFileSync(file));
}

/** The same frame walk the server's ledger does, so this reads real bytes. */
function decodeZstdFrames(buffer) {
  const out = [];
  let offset = 0;
  for (;;) {
    const start = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), offset);
    if (start === -1) break;
    const descriptor = buffer[start + 4];
    const contentSizeFlag = (descriptor >> 6) & 0b11;
    const singleSegment = ((descriptor >> 5) & 0b1) === 1;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 0b11];
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [2, 4, 8][contentSizeFlag - 1];
    let cursor = start + 5;
    if (!singleSegment) cursor += 1;
    cursor += dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (cursor + 3 > buffer.length) return out;
      const value = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16);
      cursor += 3 + (((value >> 1) & 0b11) === 1 ? 1 : value >>> 3);
      if (cursor > buffer.length) return out;
      if ((value & 0b1) === 1) break;
    }
    try {
      out.push(
        ...NodeZlib.zstdDecompressSync(buffer.subarray(start, cursor)).toString("utf8").split("\n"),
      );
    } catch {
      return out;
    }
    offset = cursor;
  }
  return out;
}

async function freePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  NodeFS.rmSync(dshHome, { recursive: true, force: true });
  NodeFS.mkdirSync(workDir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(dshHome, "launch"), { recursive: true });

  results.runtime.exists = NodeFS.existsSync(binJs);
  if (!results.runtime.exists) throw new Error(`dsh runtime missing at ${binJs}`);
  results.runtime.version = NodeChild.execFileSync(process.execPath, [binJs, "--version"], {
    encoding: "utf8",
  }).trim();
  results.denyPluginPresent = NodeFS.existsSync(denyPlugin);

  // The patch exactly as the adapter builds it, deny row included.
  const patch = buildDshLaunchPatch({
    personaSuffix:
      'Your working directory is {{cwd}}.\n\n<bot_instructions name="Smoke Bot">Name: Smoke Bot. Say the codeword HERRING.</bot_instructions>',
    skillDirs: [],
    mode: "standard",
    deny: {
      pluginUrl: `file:///${denyPlugin.replace(/\\/g, "/")}`,
      denyReadWrite: [NodePath.join(evidenceDir, "secrets")],
      denyWrite: [NodePath.join(evidenceDir, "state.sqlite"), dshHome],
    },
  });
  results.launchPatchRows = patch.map((row) => row.id ?? "insert");
  NodeFS.writeFileSync(
    patchFile,
    serializeDshLaunchPatch({
      personaSuffix:
        'Your working directory is {{cwd}}.\n\n<bot_instructions name="Smoke Bot">Name: Smoke Bot. Say the codeword HERRING.</bot_instructions>',
      skillDirs: [],
      mode: "standard",
      deny: {
        pluginUrl: `file:///${denyPlugin.replace(/\\/g, "/")}`,
        denyReadWrite: [NodePath.join(evidenceDir, "secrets")],
        denyWrite: [NodePath.join(evidenceDir, "state.sqlite"), dshHome],
      },
    }),
  );

  // A CONNECT logging proxy: every host dsh reaches goes in the log, so
  // "only api.deepseek.com" is a measurement, not a claim.
  const proxyPort = await freePort();
  const proxy = NodeChild.spawn(
    process.execPath,
    [NodePath.join(import.meta.dirname, "connect-logger.mjs"), String(proxyPort), proxyLog],
    { stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 400));

  // The child environment the adapter builds, with a deliberately invalid key.
  const child = NodeChild.spawn(
    process.execPath,
    [binJs, "--profile", "acp", "--patch", patchFile],
    {
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        DEEPSEEK_API_KEY: "sk-invalid-smoke-key-not-a-real-credential",
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "",
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: "1",
        DSH_TELEMETRY_MODE: "DISABLED",
        DSH_PERMISSION_MODE: "danger-full-access",
        DSH_AGENTS_HOME: NodePath.join(dshHome, "agents-home"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  const notifications = [];
  const send = (method, params) => {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    record("out", payload);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => reject(new Error(`${method} timed out`)), 120_000).unref?.();
    });
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      record("in", message);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        continue;
      }
      notifications.push(message);
    }
  });
  child.stderr.on("data", (chunk) => record("stderr", chunk.toString("utf8").slice(0, 2000)));

  try {
    const initialized = await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "hbots-live-smoke", version: "0.0.0" },
    });
    results.handshake.initialized = true;
    results.handshake.agent = initialized.agentInfo ?? null;
    await send("authenticate", { methodId: "none" });
    const created = await send("session/new", { cwd: workDir, mcpServers: [] });
    results.handshake.sessionId = created.sessionId ?? null;
    results.handshake.configOptions = (created.configOptions ?? []).map((option) => option.id);
    await send("session/set_config_option", {
      sessionId: created.sessionId,
      configId: "reasoning_effort",
      value: "high",
    });
    try {
      const response = await send("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "Reply with the codeword only." }],
      });
      results.prompt.stopReason = response.stopReason ?? null;
    } catch (error) {
      results.prompt.failed = true;
      results.prompt.errorText = String(error.message).slice(0, 600);
    }
  } catch (error) {
    results.fatal = String(error.message).slice(0, 600);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (child.exitCode === null) child.kill();
    proxy.kill();
  }

  // The privacy checks, from what dsh wrote on disk.
  const sessionsRoot = NodePath.join(dshHome, "sessions");
  const sessionLogs = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child2 = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(child2);
      else if (entry.name.endsWith(".zstd")) sessionLogs.push(child2);
    }
  };
  walk(sessionsRoot);
  let deliveryAccepted = 0;
  let requestFields = [];
  for (const file of sessionLogs) {
    for (const line of frameLines(file)) {
      if (line.includes("session-log-deepseek/delivery-accepted")) deliveryAccepted += 1;
      if (line.includes("dsh_plugin_packages")) requestFields.push("dsh_plugin_packages");
      if (line.includes("dsh_session_log")) requestFields.push("dsh_session_log");
    }
  }
  results.sessionLogUploadEvents = deliveryAccepted;
  results.sessionLogFiles = sessionLogs.length;
  results.requestFieldsSeenInLog = requestFields;
  results.credentialsFilePresent = NodeFS.existsSync(NodePath.join(dshHome, ".credentials.yaml"));
  let hosts = [];
  try {
    hosts = NodeFS.readFileSync(proxyLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).host);
  } catch {
    hosts = [];
  }
  results.hostsContacted = hosts;

  results.ok =
    results.handshake.initialized &&
    results.sessionLogUploadEvents === 0 &&
    results.credentialsFilePresent === false &&
    (results.prompt.failed || results.prompt.stopReason !== null);
  results.finishedAt = new Date().toISOString();
  NodeFS.writeFileSync(resultFile, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

await main();
