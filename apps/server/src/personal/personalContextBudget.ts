/**
 * What a personal bot's coding session is not sent, per step (1.66.62, from
 * Fable's context-budget review of 17 Oct). A fresh Claude bot chat cost 33-38k
 * tokens before the bot did anything: 18k of tools, 4.9k of system prompt, 4k
 * of environment and skills list, 5-6k of memory. Three of those are trimmed
 * here, each with its own kill switch; memory is trimmed in `memory/`.
 *
 * - Built-in tools no bot has ever called: `Workflow`, `ReportFindings`,
 *   `ScheduleWakeup`, `AskUserQuestion` (0 calls each in the last 150 Claude
 *   sessions; `Agent` was 5 and `PowerShell` 1,042, so both stay). The SDK
 *   `disallowedTools` option removes them from the model's tool schemas, which
 *   is the per-step saving (about 5-6k chars of the 18k tool block).
 * - Bundled Claude Code skills bots never call: `skillOverrides` hides a
 *   bundled skill from the model's skills list while keeping `/name` typable,
 *   so nothing breaks hard when a bot or a command still asks for one.
 * - Whole-file `Read` of a large text file: refused with a short message
 *   instead of pulling 54k chars (the HANDBOOK) into a fresh chat.
 *
 * Each switch is read when it is used, so an idle restart applies a change.
 * The app sheet's "Kill switches and env vars" table lists all three.
 */

/** Turns `off` / `0` / `false` / `no` / `disabled` into false; anything else (or unset) is on. */
const switchOn = (raw: string | undefined): boolean => {
  const value = raw?.trim().toLowerCase();
  return value === undefined || !["off", "0", "false", "no", "disabled"].includes(value);
};

const readEnv = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  env[`PERSONAL_${name}`] ?? env[`T3CODE_PERSONAL_${name}`];

/**
 * Built-in tools a personal bot session does not get. All four took 0 calls in
 * the last 150 Claude transcripts; `AskUserQuestion` is also the one tool a bot
 * must not use (its questions go to the CTO in its result, never to Harout).
 */
export const PERSONAL_BOT_DISALLOWED_TOOLS = [
  "Workflow",
  "ReportFindings",
  "ScheduleWakeup",
  "AskUserQuestion",
] as const;

/** Kill switch `PERSONAL_BOT_TOOL_TRIM=off`: every built-in tool is offered, as before. */
export const personalBotToolTrimEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  switchOn(readEnv(env, "BOT_TOOL_TRIM"));

/** What to pass as the SDK's `disallowedTools` for a bot session, or undefined. */
export const personalBotDisallowedTools = (
  env: NodeJS.ProcessEnv = process.env,
): Array<string> | undefined =>
  personalBotToolTrimEnabled(env) ? [...PERSONAL_BOT_DISALLOWED_TOOLS] : undefined;

/**
 * Bundled Claude Code skills a personal bot never calls. `code-review`,
 * `simplify`, `loop` and the rest are hidden from the model's list only
 * (`user-invocable-only`), so `/code-review` and any skill a bot's own
 * instructions name still work.
 *
 * `statusline-setup` from the review's list is not a skill: it is a bundled
 * *agent type* offered to the Agent tool, and `skillOverrides` does not touch
 * agents, so it is left alone here.
 */
export const PERSONAL_BOT_HIDDEN_SKILLS = [
  "keybindings-help",
  "init",
  "plugin-authoring",
  "code-review",
  "simplify",
  "loop",
  "schedule",
  "fewer-permission-prompts",
] as const;

/** The `skills` override a bot session starts with, or undefined when switched off. */
export const personalBotSkillOverrides = (
  env: NodeJS.ProcessEnv = process.env,
): Record<string, "user-invocable-only"> | undefined => {
  if (!switchOn(readEnv(env, "BOT_SKILL_TRIM"))) return undefined;
  return Object.fromEntries(
    PERSONAL_BOT_HIDDEN_SKILLS.map((name) => [name, "user-invocable-only" as const]),
  );
};

/** Text files over this are refused without a range. */
export const LARGE_FILE_READ_MAX_CHARS = 20_000;
/** Above this many bytes the guard reports the byte size instead of reading the file to count. */
const LARGE_FILE_READ_STAT_ONLY_BYTES = 8_000_000;
/** The parameter a bot passes to override the guard for one Read. */
export const LARGE_FILE_READ_ESCAPE_PROPERTY = "allow_large";
/** How many characters of a path the refusal message quotes. */
const PATH_IN_MESSAGE_MAX_CHARS = 200;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
]);
/** Extensions the Read tool renders rather than returning as text. */
const NON_TEXT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".pdf", ".ipynb"]);

/** Kill switch `PERSONAL_READ_LARGE_GUARD=off`: whole-file reads are never refused. */
export const largeFileReadGuardEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  switchOn(readEnv(env, "READ_LARGE_GUARD"));

const extensionOf = (filePath: string): string => {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

/** Images, PDFs and notebooks are read as attachments, so the guard never applies to them. */
export const isExemptLargeReadPath = (filePath: string): boolean =>
  NON_TEXT_EXTENSIONS.has(extensionOf(filePath));

const hasValue = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  !(typeof value === "string" && value.trim().length === 0);

/**
 * Whether one `Read` tool call is a whole-file read of a large text file. Pure:
 * the caller supplies the file's size in characters (or bytes, for a file too
 * large to read to count). `sizeChars` of 0 means the size is unknown, and the
 * call is allowed.
 */
export function largeFileReadRefusal(input: {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly sizeChars: number;
  /** The unit `sizeChars` is counted in, for the message. */
  readonly unit?: "chars" | "bytes";
}): string | undefined {
  if (input.toolName !== "Read") return undefined;
  const toolInput = input.toolInput;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const record = toolInput as Record<string, unknown>;
  const filePath = record.file_path;
  if (typeof filePath !== "string" || filePath.trim().length === 0) return undefined;
  if (isExemptLargeReadPath(filePath)) return undefined;
  // A range is the behaviour the guard wants, and the escape hatch is explicit.
  if (hasValue(record.offset) || hasValue(record.limit)) return undefined;
  if (record[LARGE_FILE_READ_ESCAPE_PROPERTY] === true) return undefined;
  if (input.sizeChars <= LARGE_FILE_READ_MAX_CHARS) return undefined;
  const unit = input.unit ?? "chars";
  const shown =
    filePath.length > PATH_IN_MESSAGE_MAX_CHARS
      ? `${filePath.slice(0, PATH_IN_MESSAGE_MAX_CHARS)}...`
      : filePath;
  return `${shown} is ${input.sizeChars.toLocaleString("en-US")} ${unit}; grep first, then Read with offset/limit, or pass ${LARGE_FILE_READ_ESCAPE_PROPERTY}: true if you need it all.`;
}

/**
 * The guard's decision for a real file, reading it only when the byte size
 * leaves the answer open. `statBytes` is the file size the caller already has;
 * passing undefined means the caller could not size the file and the read goes
 * through. A directory, a missing file and any read error are allowed: the Read
 * tool's own error is the right message for those.
 */
export function largeFileReadRefusalForSize(input: {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly statBytes: number | undefined;
  readonly readText?: () => string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (!largeFileReadGuardEnabled(input.env)) return undefined;
  const bytes = input.statBytes;
  if (bytes === undefined || bytes < 0) return undefined;
  const unit: "chars" | "bytes" = bytes > LARGE_FILE_READ_STAT_ONLY_BYTES ? "bytes" : "chars";
  if (unit === "bytes") {
    return largeFileReadRefusal({
      toolName: input.toolName,
      toolInput: input.toolInput,
      sizeChars: bytes,
      unit: "bytes",
    });
  }
  let size = bytes;
  if (bytes >= LARGE_FILE_READ_MAX_CHARS) {
    const text = input.readText?.();
    if (text === undefined) return undefined;
    size = text.length;
  }
  return largeFileReadRefusal({
    toolName: input.toolName,
    toolInput: input.toolInput,
    sizeChars: size,
    unit: "chars",
  });
}
