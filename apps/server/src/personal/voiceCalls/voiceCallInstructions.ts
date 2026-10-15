/**
 * The words the Gemini Live session is given at the start of a call.
 *
 * Two of Harout's decisions live here and nowhere else:
 *
 * 1. **The voice speaks as the bot itself.** It is CTO on the line, in the
 *    first person ("Sure, I'll look at that"), not an assistant relaying to
 *    CTO. Nothing in the app says otherwise.
 * 2. **It never invents work.** The voice may only report what the bot's real
 *    replies and status say. When something has to actually happen, it says it
 *    is sending it, and the app posts the words into the chat where the real
 *    bot does the work. It never claims a result it has not been given.
 *
 * The context below the persona is the same material the client gets back as
 * `context`: the last messages of the chat, the bot's live status, and any
 * login or secret card said in one line and never in full.
 */
import type { VoiceCallContextMessage } from "@t3tools/contracts";
import { VOICE_CALL_CONTEXT_MESSAGES } from "@t3tools/contracts";

/** Longest the recent-message block is allowed to get, in characters. */
export const VOICE_CALL_INSTRUCTION_CONTEXT_CHARS = 6_000;

export interface VoiceCallInstructionInput {
  readonly botName: string;
  /** Empty when the bot has no title. */
  readonly botTitle: string;
  /** The bot's own saved one-liner ("What this bot is for"). */
  readonly botDescription: string;
  /** The bot's own saved instructions: its real personality text, before the app's rules. */
  readonly botInstructions: string;
  /** The owner's standing rules for this bot, newest first, already capped. */
  readonly preferences: ReadonlyArray<string>;
  /** The owner's display name; "the owner" when unset. */
  readonly displayName: string;
  /** "Working", "Idle", "Waiting on you". */
  readonly statusLabel: string;
  /** The bot's current step line; empty when it is not working. */
  readonly statusDetail: string;
  readonly recentMessages: ReadonlyArray<VoiceCallContextMessage>;
  /** One line each, e.g. "CTO needs a login for vercel.com". */
  readonly callouts: ReadonlyArray<string>;
  readonly voiceName: string;
}

/** Longest the bot's own instructions are quoted at, in characters. */
export const VOICE_CALL_INSTRUCTION_PERSONA_CHARS = 2_000;
/** Longest the owner's standing-rules block is allowed to get, in characters. */
export const VOICE_CALL_INSTRUCTION_RULES_CHARS = 2_000;

const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The bot's own saved words, kept whole in meaning and cut only at the cap:
 * this is the personality the owner wrote for it, which the voice must carry.
 */
const personaBlock = (input: VoiceCallInstructionInput): string => {
  const parts: Array<string> = [];
  const description = clean(input.botDescription);
  const instructions = input.botInstructions.trim();
  if (description !== "") parts.push(`What you are for: ${description}`);
  if (instructions !== "") parts.push(instructions.slice(0, VOICE_CALL_INSTRUCTION_PERSONA_CHARS));
  return parts.join("\n");
};

/** The owner's standing rules, newest first, cut at the cap. */
const rulesBlock = (preferences: ReadonlyArray<string>): string => {
  const kept: Array<string> = [];
  let used = 0;
  for (const preference of preferences) {
    const line = `- ${clean(preference)}`;
    if (line === "- ") continue;
    if (used + line.length > VOICE_CALL_INSTRUCTION_RULES_CHARS) break;
    used += line.length;
    kept.push(line);
  }
  return kept.join("\n");
};

/** One recent message, flattened to one line so the block stays readable. */
const messageLine = (message: VoiceCallContextMessage): string =>
  `${message.role === "user" ? "Owner" : "Bot"}: ${clean(message.text)}`;

const contextBlock = (input: VoiceCallInstructionInput): string => {
  const lines: Array<string> = [];
  for (const message of input.recentMessages.slice(-VOICE_CALL_CONTEXT_MESSAGES)) {
    const line = messageLine(message);
    if (line.length === 0) continue;
    lines.push(line);
  }
  // Oldest first, then drop from the front until it fits: the newest words are
  // the ones the call is about.
  const kept: Array<string> = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (used + line.length > VOICE_CALL_INSTRUCTION_CONTEXT_CHARS) break;
    used += line.length;
    kept.unshift(line);
  }
  return kept.join("\n");
};

export const voiceCallSystemInstruction = (input: VoiceCallInstructionInput): string => {
  const who = input.displayName.trim() === "" ? "the owner" : input.displayName.trim();
  const title = clean(input.botTitle);
  const self = title === "" ? input.botName : `${input.botName} (${title})`;
  const context = contextBlock(input);
  const callouts = input.callouts.map(clean).filter((line) => line.length > 0);
  const persona = personaBlock(input);
  const rules = rulesBlock(input.preferences);

  return [
    `You are on a live phone call with ${who}. You ARE ${self}, speaking in the first person:`,
    `say "I'll look at that", never "I've sent that to ${input.botName}".`,
    persona === ""
      ? ""
      : [
          "",
          "Who you are (your own saved instructions, the same ones you work from in the chat;",
          "keep their substance and their tone, but say it, do not read it out):",
          persona,
        ].join("\n"),
    rules === ""
      ? ""
      : ["", `Standing rules ${who} has saved for you. They still hold on a call:`, rules].join(
          "\n",
        ),
    "",
    "How you talk:",
    "- Short, plain spoken sentences. One or two at a time, then let them answer.",
    "- No lists, no headings, no markdown, no code, no file paths, no links.",
    "- Reply in the language they speak to you in.",
    `- Your voice is ${input.voiceName}.`,
    "",
    "What you may say:",
    "- Report only what the chat and the status below actually say. If you were not told",
    "  a result, you do not have one: say you will have to check.",
    "- Never invent work, a file, a number, a decision or a promise. Never say something",
    "  is done when the status below does not say so.",
    "- Never read out a password, a key, a token or a long path.",
    "",
    "Which tool for what:",
    "- Let the call's built-in Google Search handle public, current facts: weather, news,",
    "  sport, opening times, a quick definition. Answer those directly, do not send them.",
    "  Their words become a Google search, so keep them to the fact being asked about.",
    "- Use lookup_memory for anything about the owner's own life, his things, his choices,",
    "  or a fact you saved earlier. It reads your own saved notes and rules. If it has",
    "  nothing, say you do not have it saved and ask him.",
    "- Use the real bot only for real work (files, apps, repos, tasks, a decision, code):",
    "  say you are sending it, and the app posts your words into the chat so you can do it",
    "  properly. Then say you will tell them when it is done. Do not pretend it already is.",
    "- A login or a key has to go in the chat, not on a call. Say so plainly.",
    "- If they ask you to stop, or to hang up, agree and let the call end.",
    "",
    `Right now: ${input.statusLabel}.`,
    input.statusDetail.trim() === "" ? "" : `Latest step: ${clean(input.statusDetail)}`,
    callouts.length === 0 ? "" : `Waiting in the chat: ${callouts.join("; ")}`,
    context === ""
      ? ""
      : [
          "",
          "The last messages in this chat (oldest first, for your own reference only):",
          context,
        ].join("\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");
};
