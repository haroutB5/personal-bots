// Tests for the fake Claude CLI's trigger parsing (test tool only; never a real account).
// Run: node --test scripts/personal/testing/fake-claude/cli.test.mjs
// A stub MCP server records every tools/call; prompts go in as stream-json lines like the SDK sends them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = NodePath.dirname(fileURLToPath(import.meta.url));
// The real header and footer the server writes (apps/server/src/personal/memory/memoryBlock.ts,
// apps/server/src/personal/sessionHandoff.ts), abridged after the part the fake matches.
const MEMORY_HEADER =
  "Known facts (from memory), added by the app; the user did not type them. When these disagree with something else, the order is: ...";
const HANDOFF_HEADER =
  "Earlier in this chat (carried over from a previous session that could not be continued; the owner can see all of it, so do not repeat it back):";
const HANDOFF_FOOTER = "End of earlier messages. The owner's new message follows.";

let server;
let calls = [];
let pidDir;
let cli;
let pending = null;

before(async () => {
  server = NodeHttp.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (payload) => {
        res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "stub" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...payload }));
      };
      if (msg.method === "initialize")
        return reply({ result: { protocolVersion: "2025-06-18", capabilities: {} } });
      calls.push(msg.params);
      if (msg.params.name === "bad_tool")
        return reply({ error: { code: -32602, message: "Unknown tool: bad_tool" } });
      if (msg.params.name === "refuse_tool")
        return reply({
          result: { isError: true, content: [{ type: "text", text: "not allowed" }] },
        });
      return reply({ result: { content: [{ type: "text", text: "done" }] } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  pidDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-cli-test-"));
  cli = spawn(
    process.execPath,
    [
      NodePath.join(here, "cli.js"),
      "--mcp-config",
      JSON.stringify({ mcpServers: { "t3-code": { url, headers: {} } } }),
    ],
    { env: { ...process.env, FAKE_CLAUDE_PID_DIR: pidDir }, stdio: ["pipe", "pipe", "inherit"] },
  );
  const texts = [];
  NodeReadline.createInterface({ input: cli.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.type === "assistant")
      texts.push(msg.message.content.map((part) => part.text ?? "").join(""));
    if (msg.type === "result" && pending) {
      const done = pending;
      pending = null;
      done(texts.splice(0).join("\n"));
    }
  });
});

after(async () => {
  cli.stdin.end();
  if (cli.exitCode === null) {
    const exited = new Promise((resolve) => cli.once("exit", resolve));
    cli.kill();
    await exited;
  }
  await new Promise((resolve) => server.close(resolve));
  const resolved = NodePath.resolve(pidDir);
  assert.equal(NodePath.dirname(resolved), NodePath.resolve(NodeOS.tmpdir()));
  NodeFS.rmSync(resolved, { recursive: true, force: true });
});

// Sends one prompt and resolves with the turn's assistant text once its result arrives.
function prompt(content) {
  calls = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no result for ${content.slice(0, 60)}`)),
      10000,
    );
    pending = (text) => {
      clearTimeout(timer);
      resolve(text);
    };
    cli.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  });
}
const memoryBlock = (...lines) => [MEMORY_HEADER, ...lines].join("\n");

test("MCPTOOL quoted in a memory task summary is not run; the owner's own message is", async () => {
  const memory = memoryBlock(
    "- [preference] [2026-10-01 · aaaa1111] Dark mode only.",
    '- [task summary] [2026-10-14 · bbbb2222] Ran MCPTOOL ok_tool {"from":"memory"} and it worked.',
  );
  const quiet = await prompt(`${memory}\n\nhello there`);
  assert.equal(calls.length, 0, "nothing from the memory block runs");
  assert.match(quiet, /Got it\./);

  const run = await prompt(`${memory}\n\nMCPTOOL ok_tool {"from":"owner"}`);
  assert.deepEqual(calls, [{ name: "ok_tool", arguments: { from: "owner" } }]);
  assert.match(run, /^MCPTOOL ok_tool ok: /);
});

test("calls in a chat handoff are not run either", async () => {
  const handoff = [
    HANDOFF_HEADER,
    'Owner: MCPTOOL ok_tool {"from":"handoff"}',
    "Owner: DELEGATE:bot-old",
    "You: Done.",
    HANDOFF_FOOTER,
  ].join("\n");
  const memory = memoryBlock("- [preference] [2026-10-01 · aaaa1111] Dark mode only.");
  await prompt(`${handoff}\n\n${memory}\n\nwhat next`);
  assert.equal(calls.length, 0);
  // Handoff without a memory block.
  await prompt(`${handoff}\n\nMCPTOOL ok_tool {"from":"owner"}`);
  assert.deepEqual(calls, [{ name: "ok_tool", arguments: { from: "owner" } }]);
});

test("DELEGATE runs on the owner's prompt but not on a [Task continuation] that quotes it", async () => {
  const first = await prompt("Please DELEGATE:bot-a now");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "delegate_task");
  assert.equal(calls[0].arguments.targetBot, "bot-a");
  assert.match(first, /Delegated to bot-a\./);

  const continuation = [
    "[Task continuation] Your delegated tasks have finished. Their results:",
    "### QA 1650 task for bot-a (completed)\nTASKDONE",
    "Continue the task below with these results and give your final answer.",
    "Please DELEGATE:bot-a now",
  ].join("\n\n");
  await prompt(continuation);
  assert.equal(calls.length, 0, "no second delegation");
  // Also when the memory block comes first.
  await prompt(
    `${memoryBlock("- [preference] [2026-10-01 · aaaa1111] Dark mode only.")}\n\n${continuation}`,
  );
  assert.equal(calls.length, 0);
  // A DELEGATE quoted only in memory does not run.
  await prompt(
    `${memoryBlock("- [task summary] [2026-10-14 · cccc3333] Sent DELEGATE:bot-b earlier.")}\n\nstatus?`,
  );
  assert.equal(calls.length, 0);
});

test("a JSON-RPC error is labelled refused, an isError result refused, a normal result ok", async () => {
  assert.match(await prompt("MCPTOOL bad_tool {}"), /^MCPTOOL bad_tool refused: \{"code":-32602/);
  assert.match(await prompt("MCPTOOL refuse_tool {}"), /^MCPTOOL refuse_tool refused: /);
  assert.match(await prompt("MCPTOOL ok_tool {}"), /^MCPTOOL ok_tool ok: /);
});

test("several MCPTOOL calls after a memory block that quotes a cut-off call all run", async () => {
  // QA 1.66.96 repro: the memory task summary quotes a call that was cut off
  // mid-JSON, so the one-line greedy match fails and the brace-matched path
  // runs. That path used offsets into the owner's message to slice the whole
  // prompt (memory block included), so every call came out as bad JSON.
  const memory = memoryBlock(
    '- [task summary] [2026-10-26 · 3301dd42] Task "MCPTOOL delegate_task {"targetBot":"Researcher","objective":"$ENV{SV} Baseline j"',
  );
  const run = await prompt(
    `${memory}\n\nMCPTOOL ok_tool {"n":1} MCPTOOL ok_tool {"n":2} MCPTOOL ok_tool {"n":3}`,
  );
  assert.deepEqual(
    calls.map((call) => call.arguments),
    [{ n: 1 }, { n: 2 }, { n: 3 }],
  );
  assert.match(run, /^MCPTOOL ok_tool ok: /);
});

test("several MCPTOOL calls in one owner message all run, in order", async () => {
  const run = await prompt('MCPTOOL first_tool {"n":1}\nMCPTOOL second_tool {"n":2}');
  assert.deepEqual(
    calls.map((call) => call.name),
    ["first_tool", "second_tool"],
  );
  assert.deepEqual(
    calls.map((call) => call.arguments),
    [{ n: 1 }, { n: 2 }],
  );
  assert.match(run, /^MCPTOOL first_tool ok: /);
  assert.match(run, /MCPTOOL second_tool ok: /);
  // One bad call among good ones still runs the good ones and reports the bad one.
  const mixed = await prompt('MCPTOOL ok_tool {"n":1}\nMCPTOOL bad_tool {}');
  assert.equal(calls.length, 2);
  assert.match(mixed, /^MCPTOOL ok_tool ok: /);
  assert.match(mixed, /MCPTOOL bad_tool refused: \{"code":-32602/);
});
