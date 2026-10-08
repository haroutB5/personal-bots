#!/usr/bin/env node
// Fake Claude Code CLI for throwaway hbots servers (QA's 1.65.0 fakes, shared by the whole team).
// Never touches a real account. Started by scripts/personal/throwaway-server.ps1, which copies this
// file into <root>/fake/fakeok and <root>/fake/fakelimit (the folder name picks the persona):
//   fakeok    answers every prompt; its usage reading is "Session 10%" (100% when <pidDir>/usage-full exists).
//   fakelimit the "home provider that hits its limit": while <pidDir>/limit-until holds a future epoch
//             in ms it answers every prompt with a rejected 5-hour window (the usage-limit shape).
// Prompt triggers (both personas):
//   QUIET  says one line, then sends NOTHING for QUIET_SECONDS (default 150), then answers.
//   ASKQ   asks the owner a question (AskUserQuestion) and waits for the answer.
//   BADCHOICES, CHOICESBUSY, CHOICES, CHOICES6, CHOICES7  replies that end with a choices block.
//   LONGMSG  a long multi-paragraph reply.   SLOW<n>  works for n seconds, then answers.
//   DELEGATE:<botId>  calls the delegate_task MCP tool.   TASKDONE  answers a delegated task.
//   MCPTOOL <name> <one-line json>  calls any MCP tool the bot has (update_bot, create_bot, ...) and
//     answers "MCPTOOL <name> ok|refused: <the tool's result>", so a test reads the outcome in the chat.
//     $ENV{NAME} inside the json becomes that environment variable's value (a bot typing a key it holds).
//   CATFILE <path>  tries to read a file the way a bot's Read tool would: refused (and says which rule) when
//     the server's --settings permissions.deny covers the path, else reads it and reports the size.
//   PRINTENV <VARNAME>  runs a real shell command that echoes that environment variable (what a bot's
//     Bash does), shows it as a tool call and result, then says it in a streamed reply split into small
//     pieces. A key saved as an environment variable (PB_SECRET_<NAME>) must come out masked; a brokered
//     key is not in the process, so the shell prints nothing.
//   MCPONCE <name> <one-line json>  as MCPTOOL, but not repeated when its own task resumes after a delegated result.
//   WHATWORD  answers "The codeword was <word>." from an earlier prompt of THIS provider session that said
//     "the codeword is <word>" (the fake keeps each session's prompts in <pidDir>/sessions), else "I have no
//     codeword in this session." Proves a turn ran in the session an earlier talk happened in (1.66.12).
//   anything else  "Got it." plus the reply quote it received, if any.
// Usage-probe flags (files in <pidDir>, so a test flips them while the server runs; all off by default):
//   usage-weekly  adds a seven_day window (31%, resets in 3 days) beside the five-hour one.
//   usage-fail    get_usage answers with an error: the SDK probe cannot read usage.
//   version-hang  `--version` takes 15 s (the server gives up after 4 s: the 7 Oct boot-probe failure).
// State and log: FAKE_CLAUDE_PID_DIR (set by the script; default the OS temp folder).
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";

const pidDir = process.env.FAKE_CLAUDE_PID_DIR ?? `${NodeOS.tmpdir()}/fake-claude-pids`;
const flag = (name) => {
  try {
    return NodeFS.readFileSync(`${pidDir}/${name}`, "utf8").trim();
  } catch {
    return "";
  }
};
const NAME = process.argv[1].includes("fakelimit") ? "fakelimit" : "fakeok";
NodeFS.mkdirSync(pidDir, { recursive: true });
const log = (line) =>
  NodeFS.appendFileSync(
    `${pidDir}/fake-claude.log`,
    `${new Date().toISOString()} ${process.pid} ${line}\n`,
  );
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  if (flag("version-hang") !== "") await new Promise((resolve) => setTimeout(resolve, 15000));
  console.log("2.1.290 (Claude Code)");
  process.exit(0);
}
const sessionIndex = args.findIndex((a) => a === "--session-id");
const resumeArg = args.find((a) => a.startsWith("--resume="));
const sessionId =
  sessionIndex >= 0
    ? args[sessionIndex + 1]
    : resumeArg
      ? resumeArg.slice(9)
      : NodeCrypto.randomUUID();
log(`start session=${sessionId}`);

// The permission rules the server handed this session (`--settings`, JSON text or a file path).
const denyRules = (() => {
  const index = args.findIndex((a) => a === "--settings");
  if (index < 0) return [];
  try {
    const raw = args[index + 1] ?? "";
    const parsed = JSON.parse(raw.trim().startsWith("{") ? raw : NodeFS.readFileSync(raw, "utf8"));
    return Array.isArray(parsed?.permissions?.deny) ? parsed.permissions.deny : [];
  } catch {
    return [];
  }
})();
log(
  `settings deny rules=${denyRules.length} secretsRule=${denyRules.some((r) => /^Read\(.*\/secrets/.test(r))}`,
);
// A stand-in for the CLI's Read deny rule: a `Read(//c/Users/x)` anchor denies that path and everything
// under it. It proves the rules arrive in a bot's session and that a read of the secrets folder is
// refused when the CLI honours them; real enforcement is the Claude CLI's own (measured separately).
const readDeniedBy = (path) => {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`)
    .toLowerCase();
  for (const rule of denyRules) {
    const match = /^Read\(\/\/(.*?)(\/\*\*)?\)$/.exec(rule);
    if (!match || match[1].includes("*")) continue;
    const anchor = `/${match[1]}`.toLowerCase();
    if (normalized === anchor || normalized.startsWith(`${anchor}/`)) return rule;
  }
  return null;
};

const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const respond = (request, response) =>
  out({
    type: "control_response",
    response: { subtype: "success", request_id: request.request_id, response },
  });
let initSent = false;
const init = () => {
  if (initSent) return;
  initSent = true;
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: NodeCrypto.randomUUID(),
    model: "claude-sonnet-5-5",
    tools: ["Bash"],
    mcp_servers: [],
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    apiKeySource: "none",
    slash_commands: [],
    output_style: "default",
  });
};
const assistant = (text, stop = "end_turn") =>
  out({
    type: "assistant",
    session_id: sessionId,
    uuid: NodeCrypto.randomUUID(),
    parent_tool_use_id: null,
    message: {
      id: `msg_${NodeCrypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text }],
      stop_reason: stop,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
const finish = (text, isError) =>
  out({
    type: "result",
    subtype: "success",
    is_error: isError,
    ...(isError ? { terminal_reason: "api_error" } : {}),
    result: text,
    num_turns: 1,
    duration_ms: 5,
    duration_api_ms: 5,
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 5 },
    session_id: sessionId,
    uuid: NodeCrypto.randomUUID(),
  });

let askRequest = null;
const mcpConfigArg = (() => {
  const i = args.indexOf("--mcp-config");
  if (i < 0) return null;
  const raw = args[i + 1];
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(NodeFS.readFileSync(raw, "utf8"));
    } catch {
      return null;
    }
  }
})();
async function mcpCall(name, toolArgs) {
  const server = mcpConfigArg?.mcpServers?.["t3-code"];
  if (!server) throw new Error("no t3-code MCP server in --mcp-config");
  let sessionHeader = null;
  const post = async (body) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        ...Object.fromEntries(
          Object.entries(server.headers ?? {}).map(([k, v]) => [
            k,
            String(v)
              .split("$" + "{T3_MCP_TOKEN}")
              .join(process.env.T3_MCP_TOKEN ?? ""),
          ]),
        ),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(sessionHeader ? { "mcp-session-id": sessionHeader } : {}),
      },
      body: JSON.stringify(body),
    });
    sessionHeader = response.headers.get("mcp-session-id") ?? sessionHeader;
    const text = await response.text();
    log(`mcp ${body.method} -> ${response.status} ${text.slice(0, 300).replace(/\s+/g, " ")}`);
    const data = text.includes("data:")
      ? text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .join("")
      : text;
    return data ? JSON.parse(data) : null;
  };
  await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-claude", version: "1" },
    },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: toolArgs },
  });
}
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "control_request") {
    const subtype = message.request?.subtype;
    if (subtype === "initialize") {
      return respond(message, {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: [],
        account: { email: "fake@example.com", subscriptionType: "max", tokenSource: "oauth" },
      });
    }
    if (subtype === "get_usage") {
      if (flag("usage-fail") !== "") {
        return out({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: message.request_id,
            error: "usage is not available right now",
          },
        });
      }
      return respond(message, {
        session: {},
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: flag("usage-full") !== "" && NAME === "fakeok" ? 100 : 10,
            resets_at: new Date(Date.now() + 3600e3).toISOString(),
          },
          ...(flag("usage-weekly") !== ""
            ? {
                seven_day: {
                  utilization: 31,
                  resets_at: new Date(Date.now() + 3 * 86400e3).toISOString(),
                },
              }
            : {}),
        },
        behaviors: null,
      });
    }
    if (subtype === "interrupt") {
      log("interrupt");
      respond(message, {});
      finish("Interrupted", true);
      return;
    }
    return respond(message, {});
  }
  if (
    message.type === "control_response" &&
    askRequest !== null &&
    message.response?.request_id === askRequest
  ) {
    askRequest = null;
    log(`ask answered ${JSON.stringify(message.response).slice(0, 600)}`);
    assistant(
      `Thanks, I got your answer: ${JSON.stringify(message.response?.response?.updatedInput?.answers ?? message.response)}`,
    );
    finish("ok", false);
    return;
  }
  if (message.type !== "user") return;
  const content = message.message?.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? []).map((part) => part.text ?? "").join(" ");
  log(`prompt ${JSON.stringify(text.slice(0, 6000))}`);
  // What this session was told before this prompt (the fake's only memory; see WHATWORD).
  const memoryFile = `${pidDir}/sessions/${sessionId}.jsonl`;
  NodeFS.mkdirSync(`${pidDir}/sessions`, { recursive: true });
  const earlierPrompts = (() => {
    try {
      return NodeFS.readFileSync(memoryFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((entry) => JSON.parse(entry));
    } catch {
      return [];
    }
  })();
  NodeFS.appendFileSync(memoryFile, JSON.stringify(text) + "\n");
  init();
  // Home provider simulation: until the time in the limit-until file, every prompt is refused
  // with a rejected 5-hour usage window (what the real adapter turns into a usage-limit pause).
  const until = Number(flag("limit-until") || 0);
  if (NAME === "fakelimit" && Date.now() < until) {
    log(`LIMITED until ${new Date(until).toISOString()}`);
    out({
      type: "rate_limit_event",
      uuid: NodeCrypto.randomUUID(),
      session_id: sessionId,
      rate_limit_info: {
        status: "rejected",
        resetsAt: Math.floor(until / 1000),
        rateLimitType: "five_hour",
      },
    });
    finish("Claude usage limit reached.", true);
    return;
  }
  const quote = text.match(/\[Replying to [^\]]*\]/)?.[0];
  const fence = "```";
  log(`${NAME} handles prompt`);
  // A prompt that is itself an MCPTOOL/MCPONCE call may quote the trigger word in its arguments.
  if (text.includes("WHATWORD") && !/MCP(?:TOOL|ONCE) /.test(text)) {
    const word = earlierPrompts
      .map((earlier) => /codeword is (\w+)/i.exec(earlier)?.[1])
      .filter((found) => found !== undefined)
      .at(-1);
    const reply =
      word === undefined ? "I have no codeword in this session." : `The codeword was ${word}.`;
    log(`whatword ${reply}`);
    assistant(reply);
    finish(reply, false);
    return;
  }
  if (text.includes("CHOICES6")) {
    assistant(
      `Which area should I look at first?\n\n${fence}choices\nLogin page\nBilling and invoices, including the refund flow that failed last week for two customers\nSearch\nNotifications\nSettings\nNone of these\n${fence}`,
    );
    finish("ok", false);
    return;
  }
  if (text.includes("CHOICES7")) {
    assistant(
      `Too many to pick from:\n\n${fence}choices\nOne\nTwo\nThree\nFour\nFive\nSix\nSeven\n${fence}`,
    );
    finish("ok", false);
    return;
  }
  if (text.includes("LONGMSG")) {
    const para =
      "The quarterly report shows revenue grew in every region, with the strongest gains in the north where the new warehouse opened in March. ";
    assistant(
      `Summary line for the long report.\n\n${para.repeat(4)}\n\n${para.repeat(3)}\n\nEnd of the long report.`,
    );
    finish("ok", false);
    return;
  }
  const slow = text.match(/SLOW(\d+)/);
  if (slow) {
    assistant("Working on the slow job.");
    setTimeout(
      () => {
        assistant("Slow job finished.");
        finish("ok", false);
      },
      Number(slow[1]) * 1000,
    );
    return;
  }
  const printenv = text.match(/PRINTENV (\w+)/);
  if (printenv) {
    const variable = printenv[1];
    // The platform shell, started with this process's own environment: exactly what a bot's Bash sees.
    const [shell, shellArgs] =
      NodeOS.type() === "Windows_NT"
        ? ["cmd.exe", ["/d", "/s", "/c", `echo %${variable}%`]]
        : ["sh", ["-c", `echo "$${variable}"`]];
    const printed = NodeChildProcess.spawnSync(shell, shellArgs, {
      env: process.env,
      encoding: "utf8",
    }).stdout.trim();
    const command = NodeOS.type() === "Windows_NT" ? `echo %${variable}%` : `echo "$${variable}"`;
    const toolId = `toolu_${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const stream = (event) =>
      out({
        type: "stream_event",
        event,
        parent_tool_use_id: null,
        uuid: NodeCrypto.randomUUID(),
        session_id: sessionId,
      });
    const full = (id, content, stop) =>
      out({
        type: "assistant",
        session_id: sessionId,
        uuid: NodeCrypto.randomUUID(),
        parent_tool_use_id: null,
        message: {
          id,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content,
          stop_reason: stop,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
    const start = (id) =>
      stream({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-5-5",
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
    const first = `msg_${NodeCrypto.randomUUID()}`;
    start(first);
    full(
      first,
      [{ type: "tool_use", id: toolId, name: "Bash", input: { command, description: "Print it" } }],
      "tool_use",
    );
    out({
      type: "user",
      session_id: sessionId,
      uuid: NodeCrypto.randomUUID(),
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: printed, is_error: false }],
      },
    });
    const second = `msg_${NodeCrypto.randomUUID()}`;
    const reply = `The value of ${variable} is: ${printed || "(empty)"}`;
    start(second);
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (let at = 0; at < reply.length; at += 6) {
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: reply.slice(at, at + 6) },
      });
    }
    stream({ type: "content_block_stop", index: 0 });
    full(second, [{ type: "text", text: reply }], "end_turn");
    log(`printenv ${variable} printed ${printed.length} chars`);
    finish(reply, false);
    return;
  }
  // MCPONCE is MCPTOOL that does not run again when its own task resumes: a delegating chat's
  // continuation turn quotes the request, and a fake that repeated the call would delegate again.
  const tool =
    text.includes("MCPONCE ") && text.startsWith("[Task continuation]")
      ? null
      : text.match(/MCP(?:TOOL|ONCE) (\w+) (\{.*\})/);
  if (tool) {
    let toolArgs;
    try {
      // $ENV{NAME} becomes that environment variable's value, so a test can make the bot "type" a key
      // it holds (an env-mode key) into a tool call without the value ever being in the prompt.
      toolArgs = JSON.parse(
        tool[2].replace(/\$ENV\{(\w+)\}/g, (_match, name) =>
          JSON.stringify(process.env[name] ?? "").slice(1, -1),
        ),
      );
    } catch (err) {
      assistant(`MCPTOOL ${tool[1]} has bad JSON: ${err}`);
      finish("failed", false);
      return;
    }
    mcpCall(tool[1], toolArgs).then(
      (res) => {
        const body = JSON.stringify(res?.result ?? res?.error ?? res).slice(0, 1500);
        log(`mcptool ${tool[1]} ${body}`);
        assistant(`MCPTOOL ${tool[1]} ${res?.result?.isError ? "refused" : "ok"}: ${body}`);
        finish("ok", false);
      },
      (err) => {
        log(`mcptool ${tool[1]} failed ${err}`);
        assistant(`MCPTOOL ${tool[1]} failed: ${err}`);
        finish("failed", false);
      },
    );
    return;
  }
  const catFile = text.match(/CATFILE (\S+)/);
  if (catFile) {
    const denied = readDeniedBy(catFile[1]);
    if (denied !== null) {
      log(`catfile denied by ${denied}`);
      assistant(`CATFILE denied by ${denied}`);
    } else {
      let size = -1;
      try {
        size = NodeFS.readFileSync(catFile[1]).length;
      } catch {
        // unreadable: reported below
      }
      log(`catfile read ${size} bytes`);
      assistant(`CATFILE read ${size} bytes`);
    }
    finish("ok", false);
    return;
  }
  const delegate = text.match(/DELEGATE:([\w-]+)/);
  if (delegate) {
    mcpCall("delegate_task", {
      targetBot: delegate[1],
      title: "QA 1650 task for " + delegate[1],
      objective: "Reply with the word TASKDONE.",
    }).then(
      (res) => {
        log(`delegate ok ${JSON.stringify(res).slice(0, 300)}`);
        assistant(`Delegated to ${delegate[1]}.`);
        finish("delegated", false);
      },
      (err) => {
        log(`delegate failed ${err}`);
        assistant(`Delegate failed: ${err}`);
        finish("failed", false);
      },
    );
    return;
  }
  if (text.includes("TASKDONE")) {
    assistant("TASKDONE");
    finish("TASKDONE", false);
    return;
  }
  if (text.includes("BADCHOICES")) {
    assistant(`Pick one:\n\n${fence}choices\nOnly one option\n${fence}`);
    finish("ok", false);
    return;
  }
  if (text.includes("CHOICESBUSY")) {
    assistant(`Deploy now or wait?

${fence}choices
Deploy now
Wait for QA
${fence}`);
    setTimeout(() => finish("ok", false), Number(process.env.BUSY_SECONDS ?? 12) * 1000);
    return;
  }
  if (text.includes("CHOICES")) {
    assistant(
      `Ready to ship the release?\n\n${fence}choices\nYes, ship it\nNot yet\nShow me the diff first\n${fence}`,
    );
    finish("ok", false);
    return;
  }
  if (text.includes("QUIET")) {
    const seconds = Number(process.env.QUIET_SECONDS ?? 150);
    const stream = (event) =>
      out({
        type: "stream_event",
        event,
        parent_tool_use_id: null,
        uuid: NodeCrypto.randomUUID(),
        session_id: sessionId,
      });
    const full = (id, content, stop) =>
      out({
        type: "assistant",
        session_id: sessionId,
        uuid: NodeCrypto.randomUUID(),
        parent_tool_use_id: null,
        message: {
          id,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content,
          stop_reason: stop,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
    const start = (id) =>
      stream({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-5-5",
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
    // Like the real SDK: the text streams in, then the whole message lands.
    const first = `msg_${NodeCrypto.randomUUID()}`;
    start(first);
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Starting a long step." },
    });
    stream({ type: "content_block_stop", index: 0 });
    full(first, [{ type: "text", text: "Starting a long step." }], null);
    log(`quiet for ${seconds}s`);
    // Then nothing at all for QUIET_SECONDS. After it the provider works again (a tool step), keeps going, then answers.
    setTimeout(() => {
      const second = `msg_${NodeCrypto.randomUUID()}`;
      const toolId = `toolu_${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
      start(second);
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolId, name: "Bash", input: {} },
      });
      stream({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ command: "echo still here", description: "Check in" }),
        },
      });
      stream({ type: "content_block_stop", index: 0 });
      full(
        second,
        [
          {
            type: "tool_use",
            id: toolId,
            name: "Bash",
            input: { command: "echo still here", description: "Check in" },
          },
        ],
        "tool_use",
      );
      setTimeout(() => {
        const third = `msg_${NodeCrypto.randomUUID()}`;
        start(third);
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Back again. The long step is done." },
        });
        stream({ type: "content_block_stop", index: 0 });
        full(third, [{ type: "text", text: "Back again. The long step is done." }], "end_turn");
        finish("ok", false);
      }, 25_000);
    }, seconds * 1000);
    return;
  }
  if (text.includes("ASKQ")) {
    askRequest = `ask-${NodeCrypto.randomUUID()}`;
    out({
      type: "control_request",
      request_id: askRequest,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: `toolu_${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        input: {
          questions: [
            {
              question: "Which environment should I deploy to?",
              header: "Deploy",
              multiSelect: false,
              options: [
                { label: "Staging", description: "The safe one" },
                { label: "Production", description: "The real one" },
              ],
            },
          ],
        },
      },
    });
    return;
  }
  assistant(`Got it.${quote ? `\nI received this quote with your message: ${quote}` : ""}`);
  finish("ok", false);
});
setInterval(() => {}, 60_000);
