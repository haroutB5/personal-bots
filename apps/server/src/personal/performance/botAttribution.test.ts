import { describe, expect, it } from "@effect/vitest";
import { PersonalBotId } from "@t3tools/contracts";

import type { BotProviderProcess } from "../../provider/botProviderProcesses.ts";
import type { PersonalBotProviderSession } from "../PersonalBotRepository.ts";
import { attributeBotProcesses } from "./botAttribution.ts";
import type { HelperChild } from "./counterSample.ts";

/**
 * The shapes below are the ones a real data root holds (read off the live
 * machine on 13 Oct 2026, read-only): the command lines the server's own
 * children carry, and the resume cursors `provider_session_runtime` stores
 * per provider. The fake CLI a throwaway root uses has none of this, which is
 * how the 1.66.37 bug reached live QA.
 */
const CLAUDE_MODEL_ARGS =
  "--output-format stream-json --verbose --input-format stream-json --thinking adaptive --thinking-display summarized --effort high --model claude-opus-5-5 --permission-prompt-tool stdio";
const CLAUDE_TAIL =
  '--mcp-config "{\\"mcpServers\\":{\\"t3-code\\":{\\"type\\":\\"http\\",\\"url\\":\\"http://127.0.0.1:38472/mcp\\"}}}" --setting-sources= --permission-mode bypassPermissions --add-dir C:\\Users\\Ht\\.personal-bots\\dev\\personal-workspace --thinking-display summarized';

const claudeStarted = (pid: number, sessionId: string): HelperChild => ({
  pid,
  name: "claude.exe",
  cpu100ns: 0,
  wsBytes: 0,
  cmd: `C:\\Users\\Ht\\.local\\bin\\claude.EXE ${CLAUDE_MODEL_ARGS} --session-id=${sessionId} ${CLAUDE_TAIL}`,
});

const claudeResumed = (pid: number, sessionId: string): HelperChild => ({
  pid,
  name: "claude.exe",
  cpu100ns: 0,
  wsBytes: 0,
  cmd: `C:\\Users\\Ht\\.local\\bin\\claude.EXE ${CLAUDE_MODEL_ARGS} --resume=${sessionId} ${CLAUDE_TAIL}`,
});

const CODEX_ARGS =
  'C:\\Users\\Ht\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.EXE app-server -c mcp_servers.t3-code.url=http://127.0.0.1:38472/mcp -c "mcp_servers.t3-code.bearer_token_env_var=\\"T3_MCP_BEARER_TOKEN\\"" -c features.apps=false -c features.memories=false';

const codexAppServer = (pid: number): HelperChild => ({
  pid,
  name: "codex.exe",
  cpu100ns: 0,
  wsBytes: 0,
  cmd: CODEX_ARGS,
});

const session = (
  threadId: string,
  botId: string,
  botName: string,
  providerName: string,
  resumeCursorJson: string,
): PersonalBotProviderSession => ({
  threadId,
  botId: PersonalBotId.make(botId),
  botName,
  providerName,
  resumeCursorJson,
});

// The live cursors, one per provider (values shortened where the id is not
// what the row is matched by).
const CTO_RESUME = "d74b867f-dfb5-4e23-bb85-7deac41c86c4";
const CTO_THREAD = "cfa42940-60a6-419f-b488-613279d27de6";
const DEEPSEEK_SESSION = "995cad0b-4bb6-4ee8-8c61-2606a2afa290";
const DEEPSEEK_THREAD = "992dfff3-cbac-4bfc-a626-e4aa510bddda";

const liveSessions = (): ReadonlyArray<PersonalBotProviderSession> => [
  session(
    CTO_THREAD,
    "bot-cto",
    "CTO",
    "claudeAgent",
    `{"threadId":"${CTO_THREAD}","resume":"${CTO_RESUME}","resumeSessionAt":"1a874895-d0db-41d7-8b94-fa1ed16f35e3","turn":7}`,
  ),
  session(
    DEEPSEEK_THREAD,
    "bot-backend",
    "Backend",
    "deepseek",
    `{"threadId":"${DEEPSEEK_THREAD}","resume":"${DEEPSEEK_SESSION}","resumeSessionAt":"c16269e0-02f4-4a4d-8c0b-cf0d4df205d7"}`,
  ),
  session(
    "a43c05c0-fe34-4951-a4b4-062a203ce97c",
    "bot-it",
    "IT",
    "codex",
    '{"threadId":"01a13577-61ae-7c22-93fa-9c636f634c89"}',
  ),
  session(
    "5ccf1d68-6ee0-4093-8376-2d47aaf67a0c",
    "bot-scout",
    "Scout",
    "opencode",
    '{"schemaVersion":1,"sessionId":"ses_ed9e503a5ffeD1NAzDNtUimMiI"}',
  ),
];

const TUNNEL: HelperChild = {
  pid: 31_828,
  name: "cloudflared.exe",
  cpu100ns: 0,
  wsBytes: 0,
  cmd: "C:\\Users\\Ht\\.personal-bots\\dev\\tools\\cloudflared\\2026.5.2\\win32-x64\\cloudflared.exe tunnel --no-autoupdate --loglevel info --output default run",
};

describe("attributeBotProcesses", () => {
  it("matches a Claude CLI by the session on its command line, started or resumed", () => {
    const owners = attributeBotProcesses({
      children: [claudeStarted(12_296, CTO_RESUME), claudeResumed(19_344, CTO_RESUME), TUNNEL],
      sessions: liveSessions(),
      providerProcesses: [],
    });
    expect(owners.get(12_296)?.name).toBe("CTO");
    expect(owners.get(19_344)?.name).toBe("CTO");
    expect(owners.has(31_828)).toBe(false);
  });

  it("reads a DeepSeek bot's session id out of its own cursor field", () => {
    // A DeepSeek bot runs the same CLI, under its own provider row.
    const owners = attributeBotProcesses({
      children: [claudeStarted(18_148, DEEPSEEK_SESSION)],
      sessions: liveSessions(),
      providerProcesses: [],
    });
    expect(owners.get(18_148)?.botId).toBe("bot-backend");
  });

  it("names nothing for a Codex app-server on its command line, so its PID decides", () => {
    const children = [codexAppServer(25_184), claudeStarted(12_296, CTO_RESUME)];
    const registered: ReadonlyArray<BotProviderProcess> = [
      { threadId: "a43c05c0-fe34-4951-a4b4-062a203ce97c", provider: "codex", pid: 25_184 },
    ];
    const withPid = attributeBotProcesses({
      children,
      sessions: liveSessions(),
      providerProcesses: registered,
    });
    expect(withPid.get(25_184)?.name).toBe("IT");
    expect(withPid.get(12_296)?.name).toBe("CTO");

    // Without the record (a build where the spawn site did not register it)
    // the app-server belongs to nobody, and the tab shows it as an app.
    const withoutPid = attributeBotProcesses({
      children,
      sessions: liveSessions(),
      providerProcesses: [],
    });
    expect(withoutPid.has(25_184)).toBe(false);
  });

  it("drops a recorded PID whose chat no longer has a session row", () => {
    const owners = attributeBotProcesses({
      children: [codexAppServer(25_184)],
      sessions: [],
      providerProcesses: [
        { threadId: "a43c05c0-fe34-4951-a4b4-062a203ce97c", provider: "codex", pid: 25_184 },
      ],
    });
    expect(owners.size).toBe(0);
  });

  it("keeps a command-line match when a record names the same PID", () => {
    const owners = attributeBotProcesses({
      children: [claudeStarted(12_296, CTO_RESUME)],
      sessions: liveSessions(),
      providerProcesses: [
        // The record happens to name Backend for the same number: the CLI's own
        // command line is the stronger fact.
        { threadId: DEEPSEEK_THREAD, provider: "claudeAgent", pid: 12_296 },
      ],
    });
    expect(owners.get(12_296)?.name).toBe("CTO");
  });

  it("attributes nothing when there are no chats to match", () => {
    const owners = attributeBotProcesses({
      children: [claudeStarted(12_296, CTO_RESUME), TUNNEL],
      sessions: [],
      providerProcesses: [],
    });
    expect(owners.size).toBe(0);
  });
});
