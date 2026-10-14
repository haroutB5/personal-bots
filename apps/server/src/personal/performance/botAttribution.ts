/**
 * Which bot each live provider process belongs to, for the Performance tab.
 *
 * Two rules, in this order:
 *
 * 1. **The command line.** A Claude CLI names the session it runs
 *    (`--session-id=<uuid>` for a chat that started one, `--resume=<uuid>` for
 *    a chat that continues one). The chat that resumes that session is the bot
 *    (`provider_session_runtime.resume_cursor_json`, `$.resume`). Claude and
 *    DeepSeek bots both run this CLI, and their ids do not collide.
 * 2. **The recorded PID.** A Codex app-server names nothing on its command
 *    line, so its spawn site recorded the PID under the chat
 *    (`provider/botProviderProcesses`). That PID, and every descendant of it,
 *    is the bot.
 *
 * A process neither rule claims is left out: the caller then shows it under
 * its own name (`Windows`, an app, or the server itself). Chrome roots are
 * decided by the caller too, so a bot's browser is never the shared one.
 */
import type { HelperChild } from "./counterSample.ts";
import type { BotProviderProcess } from "../../provider/botProviderProcesses.ts";
import type { PersonalBotProviderSession } from "../PersonalBotRepository.ts";
import { sessionIdFromResumeCursor, usageProviderOf } from "../botTokenUsage.ts";
import { childSessionIds } from "./runtime.ts";
import type { BotOwner } from "./processGroups.ts";

export interface AttributionInput {
  /** The server's direct children, with their command lines. */
  readonly children: ReadonlyArray<HelperChild>;
  /** The unarchived bot chats that have a provider session row. */
  readonly sessions: ReadonlyArray<PersonalBotProviderSession>;
  /** The provider processes the spawn sites recorded, by chat. */
  readonly providerProcesses: ReadonlyArray<BotProviderProcess>;
}

/**
 * `pid -> bot` for the processes the server spawns for a bot. Only the roots
 * are needed: `attributeTree` walks each one down to its descendants (a bot's
 * shell commands, builds and test suites).
 */
export function attributeBotProcesses(input: AttributionInput): Map<number, BotOwner> {
  const byThread = new Map<string, BotOwner>();
  const bySessionId = new Map<string, BotOwner>();
  for (const session of input.sessions) {
    // The provider is the row's own, so a Codex or DeepSeek bot's process is
    // never labelled with another provider's name on the Performance tab.
    const owner: BotOwner = {
      botId: String(session.botId),
      name: session.botName,
      provider: session.providerName,
    };
    byThread.set(session.threadId, owner);
    const provider = usageProviderOf(session.providerName);
    const sessionId =
      provider === null ? null : sessionIdFromResumeCursor(provider, session.resumeCursorJson);
    if (sessionId !== null) bySessionId.set(sessionId.toLowerCase(), owner);
  }

  const owners = new Map<number, BotOwner>();
  for (const pair of childSessionIds(input.children)) {
    const owner = bySessionId.get(pair.sessionId);
    if (owner !== undefined) owners.set(pair.pid, owner);
  }
  for (const process of input.providerProcesses) {
    // A command line that already named its chat wins: the recorded PID is the
    // fallback for the providers that name nothing.
    if (owners.has(process.pid)) continue;
    const owner = byThread.get(process.threadId);
    if (owner !== undefined) owners.set(process.pid, owner);
  }
  return owners;
}
