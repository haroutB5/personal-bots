const fs = require("fs");
const path = require("path");
const home = process.env.HOME;
const mode = fs.readFileSync(path.join(home, "mode"), "utf8").trim();
const tools = JSON.parse(fs.readFileSync(path.join(__dirname, "tools-list-0.26.1.json"), "utf8"))
  .result.tools;
const accounts = [
  {
    id: "account1",
    name: "Gmail",
    type: "imap",
    identities: [{ id: "id1", email: "Harout@Gmail.com", name: "H", isDefault: true }],
  },
  {
    id: "account2",
    name: "Live",
    type: "imap",
    identities: [{ id: "id2", email: "h@live.com", name: "H", isDefault: true }],
  },
  {
    id: "account3",
    name: "Outlook",
    type: "ews",
    identities: [{ id: "id3", email: "h@outlook.com", name: "H", isDefault: true }],
  },
  { id: "account4", name: "Local Folders", type: "none", identities: [] },
];
const text = (value, isError) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
fs.appendFileSync(
  path.join(home, "seen.jsonl"),
  JSON.stringify({
    profile: process.env.COMMONPOST_MCP_PROFILE,
    tmp: process.env.TMPDIR,
    leaked: process.env.HBOTS_SECRET ?? null,
  }) + "\n",
);
if (mode === "exit") process.exit(3);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    fs.appendFileSync(
      path.join(home, "seen.jsonl"),
      JSON.stringify({ method: msg.method, params: msg.params }) + "\n",
    );
    if (msg.method === "initialize") {
      send(msg.id, {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "fake", version: "0" },
      });
      continue;
    }
    if (mode === "hang" && msg.method === "tools/call") continue;
    if (msg.method === "tools/list") {
      send(msg.id, {
        tools:
          mode === "drift"
            ? tools.map((t) =>
                t.name === "saveDraft"
                  ? { ...t, inputSchema: { type: "object", properties: {} } }
                  : t,
              )
            : tools,
      });
      continue;
    }
    if (msg.method === "tools/call") {
      const name = msg.params.name;
      if (mode === "closed") {
        send(
          msg.id,
          text(
            {
              error:
                "Connection discovery failed. Tried: none. Is Thunderbird running with the MCP extension?",
            },
            true,
          ),
        );
        continue;
      }
      if (mode === "notice") {
        const r = text(accounts);
        r.content.push({
          type: "text",
          text: "Commonpost notice (please tell the user): the Thunderbird add-on is version 0.9.0, older than 0.12.0",
        });
        send(msg.id, r);
        continue;
      }
      if (mode === "from-mismatch" && name === "saveDraft") {
        send(msg.id, text({ error: "from identity does not match any identity" }, true));
        continue;
      }
      if (name === "listAccounts") {
        send(msg.id, text(accounts));
        continue;
      }
      send(msg.id, text({ echoed: name, arguments: msg.params.arguments }));
    }
  }
});
