import {
  CLAUDE_TEXT_GENERATION_FALLBACK_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

import { parseClaudeModelSlug } from "./ClaudeModelCatalog.ts";

/**
 * Small, fast Claude work runs on Haiku 5.5 (1.66.5), each piece with its own
 * kill switch and effort, read from the server environment on every use so a
 * restart with a new value is all it takes:
 *
 * - Background text jobs (chat titles, branch names, commit and PR text, the
 *   memory tidy judge when pinned to Haiku) use the Claude default text model.
 *   `PERSONAL_TEXTGEN_MODEL=claude-haiku-4-5` forces the old model;
 *   `PERSONAL_TEXTGEN_EFFORT` (default `low`; `off` sends none) is the effort
 *   a job runs at when it names none, because a title must not lag.
 * - Claude Code's read-only search subagent (Explore) in Claude bots that run
 *   on Opus or Sonnet runs on Haiku 5.5 at medium effort.
 *   `PERSONAL_EXPLORE_MODEL=off` leaves it on the bot's own model (any other
 *   Claude model id picks that one); `PERSONAL_EXPLORE_EFFORT` (default
 *   `medium`; `off` sends none) is its effort. General-purpose, Plan and the
 *   bot's own model are never touched.
 */
export const PERSONAL_TEXTGEN_MODEL_ENV = "PERSONAL_TEXTGEN_MODEL";
export const PERSONAL_TEXTGEN_EFFORT_ENV = "PERSONAL_TEXTGEN_EFFORT";
export const PERSONAL_EXPLORE_MODEL_ENV = "PERSONAL_EXPLORE_MODEL";
export const PERSONAL_EXPLORE_EFFORT_ENV = "PERSONAL_EXPLORE_EFFORT";

/** The Claude model background text jobs run on unless the kill switch names another. */
export const CLAUDE_TEXT_GENERATION_DEFAULT_MODEL =
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] ??
  "claude-haiku-5-5";
export const CLAUDE_TEXTGEN_DEFAULT_EFFORT = "low";
export const EXPLORE_SUBAGENT_DEFAULT_MODEL = "claude-haiku-5-5";
export const EXPLORE_SUBAGENT_DEFAULT_EFFORT = "medium";

type Env = Readonly<Record<string, string | undefined>>;

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const OFF_WORDS = new Set(["off", "0", "false", "no", "none"]);

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** The effort for a knob: a level, `null` for "send none", or the default when unset or unknown. */
function effortSetting(value: string | undefined, fallback: string): string | null {
  const setting = clean(value)?.toLowerCase();
  if (setting === undefined) return fallback;
  if (OFF_WORDS.has(setting)) return null;
  return EFFORT_LEVELS.has(setting) ? setting : fallback;
}

/** The effort background text jobs run at when they name none (`null` = no flag). */
export function textGenerationBackgroundEffort(env: Env = process.env): string | null {
  return effortSetting(env[PERSONAL_TEXTGEN_EFFORT_ENV], CLAUDE_TEXTGEN_DEFAULT_EFFORT);
}

/**
 * The model a request for the Claude default text model really uses: the
 * default itself, or the one the kill switch pins. Any other model (one the
 * owner chose) is returned as it is.
 */
export function resolveTextGenerationModel(requested: string, env: Env = process.env): string {
  if (requested !== CLAUDE_TEXT_GENERATION_DEFAULT_MODEL) return requested;
  const pinned = clean(env[PERSONAL_TEXTGEN_MODEL_ENV]);
  return pinned !== undefined && parseClaudeModelSlug(pinned) !== undefined ? pinned : requested;
}

/**
 * Where a failed default-model call retries once: the previous Haiku. Only the
 * default itself has one, and only while the kill switch has not pinned a
 * model already.
 */
export function textGenerationFallbackModel(model: string): string | undefined {
  return model === CLAUDE_TEXT_GENERATION_DEFAULT_MODEL &&
    model !== CLAUDE_TEXT_GENERATION_FALLBACK_MODEL
    ? CLAUDE_TEXT_GENERATION_FALLBACK_MODEL
    : undefined;
}

/** The model the Explore subagent runs on, or `undefined` when the override is off. */
export function exploreSubagentModel(env: Env = process.env): string | undefined {
  const setting = clean(env[PERSONAL_EXPLORE_MODEL_ENV]);
  if (setting === undefined) return EXPLORE_SUBAGENT_DEFAULT_MODEL;
  if (OFF_WORDS.has(setting.toLowerCase())) return undefined;
  return parseClaudeModelSlug(setting) !== undefined ? setting : EXPLORE_SUBAGENT_DEFAULT_MODEL;
}

const EXPLORE_DESCRIPTION =
  "Read-only search agent for broad fan-out searches: when answering means sweeping many files, " +
  "directories or naming conventions and you only need the conclusion, not the file dumps. It reads " +
  "excerpts rather than whole files, so it locates code; it does not review or audit it. Specify the " +
  'search breadth: "quick" for a basic search, "medium" for moderate exploration, "very thorough" for ' +
  "several locations and naming conventions.";

const EXPLORE_PROMPT = [
  "You are a file search specialist. You find things and report them; you never change anything.",
  "",
  "Rules:",
  "- Read only. Do not create, edit, move or delete files, and do not run commands that change state.",
  "- Start broad (Glob for names, Grep for contents), then narrow. Read the few files that matter, and only the part of each you need.",
  "- Run independent searches together. Try other spellings, plural forms and naming conventions before saying something is not there.",
  "- Match the depth the caller asked for (quick, medium or very thorough); with none given, search moderately.",
  "- Report with absolute file paths, line numbers where you have them, and short quoted excerpts. Say plainly when you found nothing and where you looked.",
  "- Keep the answer short: the conclusion first, then the evidence. No file dumps.",
].join("\n");

/** Claude Code's own list of tools Explore cannot use: everything but the tools that change files or hand work on. */
const EXPLORE_DISALLOWED_TOOLS = [
  "Agent",
  "Task",
  "ExitPlanMode",
  "Edit",
  "Write",
  "NotebookEdit",
] as const;

/**
 * The `agents` option that runs Claude Code's Explore subagent on Haiku 5.5
 * for a Claude bot, or `undefined` to leave it as it is. Only a bot whose own
 * model is Opus or Sonnet gets it (a Haiku bot already is one; Fable is never
 * moved without being asked), and only when the model catalog knows the
 * Explore model: an older CLI keeps Explore on the bot's model.
 */
export function exploreSubagentAgents(input: {
  readonly personalBot: boolean;
  readonly mainModel: string | undefined;
  readonly modelKnown: (slug: string) => boolean;
  readonly env?: Env;
}): Readonly<Record<string, AgentDefinition>> | undefined {
  if (!input.personalBot || input.mainModel === undefined) return undefined;
  const env = input.env ?? process.env;
  const family = parseClaudeModelSlug(input.mainModel.replace(/\[[^\]]*\]$/, ""))?.family;
  if (family !== "opus" && family !== "sonnet") return undefined;
  const model = exploreSubagentModel(env);
  if (model === undefined || !input.modelKnown(model)) return undefined;
  const effort = effortSetting(env[PERSONAL_EXPLORE_EFFORT_ENV], EXPLORE_SUBAGENT_DEFAULT_EFFORT);
  return {
    Explore: {
      description: EXPLORE_DESCRIPTION,
      prompt: EXPLORE_PROMPT,
      disallowedTools: [...EXPLORE_DISALLOWED_TOOLS],
      model,
      ...(effort === null ? {} : { effort: effort as NonNullable<AgentDefinition["effort"]> }),
    },
  };
}
