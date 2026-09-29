import {
  botTeam,
  isBotOnTeam,
  isTeamLead,
  personalBotTeamLabel,
  type PersonalBot,
  type PersonalBotTeam,
} from "@t3tools/contracts";

/**
 * What a team lead may do to the bots on its own team, and nothing else.
 * `authorizeLeadBotAction` below is the ONLY place the rules live; the service
 * calls it once per action with facts it has just read from the database, and
 * acts only on an `allowed` verdict. Read this file top to bottom to audit them.
 */

/** Most bots one lead may create in any rolling 24 hours. */
export const LEAD_BOT_CREATES_PER_DAY = 5;
/** The window {@link LEAD_BOT_CREATES_PER_DAY} is counted over. */
export const LEAD_BOT_CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Fields a lead can name in a call but never set: each is refused, not ignored. */
export const LEAD_BOT_FORBIDDEN_FIELDS = ["team", "lead", "pinned"] as const;
export type LeadBotForbiddenField = (typeof LEAD_BOT_FORBIDDEN_FIELDS)[number];

/** The most expensive tiers. Only Harout puts a bot on one; a lead never does. */
export const isLeadForbiddenModel = (slug: string): boolean => /fable|mythos/i.test(slug);

export type LeadBotAction = "create" | "update" | "remove";

/**
 * Bots no lead may edit or remove, whatever team they sit on: the seeded system
 * bots (ids `personal-seed-*`), the Updates bot (`personal-claude-code-updates`)
 * and the maintenance reporter "Sync reports" (an ordinary random id, so by name).
 * Every app-owned bot id starts with `personal-`; bots people make (the app's
 * form, a lead) get a UUID or `bot-<uuid>`.
 */
const PROTECTED_BOT_ID_PREFIX = "personal-";
const PROTECTED_BOT_NAMES: ReadonlySet<string> = new Set(["sync reports", "updates"]);

/**
 * Bot names are compared in one normal form so two names that look the same are
 * the same: Unicode NFKC, invisible format characters (\p{Cf}) dropped, runs of
 * whitespace collapsed, trimmed, lower-cased.
 */
export const normalizeBotNameKey = (name: string): string =>
  name
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * The name as submitted, compared without any normalisation beyond case and
 * spacing: two bots whose raw names are the same word must not coexist even if
 * NFKC ever treated them differently. Uniqueness is checked on this key AND on
 * {@link normalizeBotNameKey}.
 */
export const rawBotNameKey = (name: string): string =>
  name.replace(/\s+/gu, " ").trim().toLowerCase();

export const isProtectedBot = (bot: { readonly botId: string; readonly name: string }): boolean =>
  bot.botId.startsWith(PROTECTED_BOT_ID_PREFIX) ||
  PROTECTED_BOT_NAMES.has(normalizeBotNameKey(bot.name));

/**
 * The fields whose change on a bot no lead created needs the user's say-so:
 * what the bot is (name), what it does (instructions, description) and what it
 * costs (model, provider, effort: one "model" change). Title, avatar, mute and
 * memory auto-save are cosmetic and stay open.
 */
export const LEAD_BOT_SENSITIVE_FIELDS = ["name", "instructions", "description", "model"] as const;
export type LeadBotSensitiveField = (typeof LEAD_BOT_SENSITIVE_FIELDS)[number];

/**
 * Whether the user's own words in the calling chat name the target: `named`
 * (the latest real message from the user names it), `not_named` (it does not)
 * or `no_user_message` (routine and task turns, where the user wrote nothing).
 */
export type LeadBotOwnerRequest = "named" | "not_named" | "no_user_message";

export type LeadBotRefusalCode =
  | "caller_gone"
  | "not_a_lead"
  | "forbidden_field"
  | "forbidden_model"
  | "rate_limit"
  | "no_such_bot"
  | "self"
  | "other_lead"
  | "other_team"
  | "protected"
  | "needs_owner"
  | "running_task"
  | "active_routines";

/** Everything the rules look at, read fresh for this one call. */
export interface LeadBotFacts {
  readonly action: LeadBotAction;
  /** The calling bot's row as it is right now; null when it no longer exists. */
  readonly caller: PersonalBot | null;
  /** Update and remove: the bot named, as it is right now; null when there is none. */
  readonly target: PersonalBot | null;
  /** Which of team, lead and pinned the call carried. */
  readonly forbiddenFields: ReadonlyArray<LeadBotForbiddenField>;
  /** The model the call asks for (create or update), when it names one. */
  readonly requestedModel: {
    readonly instanceId: string;
    readonly model: string;
    /** True when instance, model or effort differs from what the target has now (always for create). */
    readonly changed: boolean;
  } | null;
  /** Bots this lead created in the last {@link LEAD_BOT_CREATE_WINDOW_MS}. */
  readonly createsInWindow: number;
  /** Update: which sensitive fields this call would actually change on the target. */
  readonly sensitiveChanges: ReadonlyArray<LeadBotSensitiveField>;
  /** Some lead created the target (a `create` row in the audit table). */
  readonly targetCreatedByLead: boolean;
  /** Whether the user's own message in this chat names the target. */
  readonly ownerRequest: LeadBotOwnerRequest;
  /** Remove: the target's tasks that are not finished (running, queued or waiting). */
  readonly targetOpenTasks: number;
  /** Remove: the target's chat sessions that have a turn in progress. */
  readonly targetActiveSessions: number;
  /** Remove: the target's routines that are switched on. */
  readonly targetActiveRoutines: number;
}

export type LeadBotVerdict =
  | { readonly allowed: true; readonly team: PersonalBotTeam }
  | {
      readonly allowed: false;
      readonly code: LeadBotRefusalCode;
      /** Written for the calling model to read and act on. */
      readonly reason: string;
    };

const refuse = (code: LeadBotRefusalCode, reason: string): LeadBotVerdict => ({
  allowed: false,
  code,
  reason,
});

/**
 * The single permission decision. Order matters only for which reason a
 * caller sees; every rule is independent and any one of them refuses.
 *
 *  1. The caller must still exist and be a team lead RIGHT NOW (a lead demoted
 *     a moment ago is refused: the flag is read from the row, never remembered).
 *  2. It never sets a team, a lead flag or a pinned flag, and never puts a bot
 *     on a Fable or Mythos model unless that is the model the bot already has
 *     (Harout's own choice, left as it is).
 *  3. Create: a bot lands on the caller's own team, at most
 *     {@link LEAD_BOT_CREATES_PER_DAY} per rolling day.
 *  4. Update and remove: never a protected bot (Updates, Sync reports, any
 *     seeded system bot), wherever it sits. Otherwise the target must be a bot on
 *     the caller's own team that is not the caller and not a lead.
 *  5. A bot no lead created (the user made it) is the user's to change: remove,
 *     and an edit of its name, instructions, description or model/effort, need
 *     the user's own latest message in this chat to name it. Routine and task
 *     turns have no such message and are refused. Cosmetic edits stay open.
 *  6. Remove: refused while the target has unfinished tasks, a turn in progress
 *     or switched-on routines, so nothing is orphaned. (The service repeats the
 *     task and turn test inside the transaction that deletes, see `busyRefusal`.)
 */
export function authorizeLeadBotAction(facts: LeadBotFacts): LeadBotVerdict {
  const { caller, target } = facts;
  if (caller === null) {
    return refuse("caller_gone", "Your bot no longer exists, so this cannot be done.");
  }
  if (!isTeamLead(caller)) {
    return refuse(
      "not_a_lead",
      "Only a team lead can create, edit or remove bots, and you are not a lead. Ask the user to do it.",
    );
  }
  const team = botTeam(caller);

  if (facts.forbiddenFields.length > 0) {
    return refuse(
      "forbidden_field",
      `A lead cannot set ${facts.forbiddenFields.join(", ")}. A new bot always joins your own team as a member; only the user changes teams, leads or pins.`,
    );
  }

  if (facts.requestedModel !== null && isLeadForbiddenModel(facts.requestedModel.model)) {
    const unchanged =
      facts.action === "update" &&
      target !== null &&
      target.modelSelection.instanceId === facts.requestedModel.instanceId &&
      target.modelSelection.model === facts.requestedModel.model &&
      // Effort counts too: a bot the user put on Fable keeps its effort, or a
      // lead could raise the cost of a model it may not choose.
      !facts.requestedModel.changed;
    if (!unchanged) {
      return refuse(
        "forbidden_model",
        `'${facts.requestedModel.model}' is one of the most expensive models and only the user can choose it. Pick another model.`,
      );
    }
  }

  if (facts.action === "create") {
    if (facts.createsInWindow >= LEAD_BOT_CREATES_PER_DAY) {
      return refuse(
        "rate_limit",
        `You have already created ${LEAD_BOT_CREATES_PER_DAY} bots in the last 24 hours, which is the limit. Ask the user if you need more.`,
      );
    }
    return { allowed: true, team };
  }

  if (target === null) {
    return refuse(
      "no_such_bot",
      "No bot on your team has that id. Call list_bots for the current roster.",
    );
  }
  if (target.botId === caller.botId) {
    return refuse("self", "You cannot edit or remove yourself. Ask the user.");
  }
  if (isProtectedBot(target)) {
    return refuse(
      "protected",
      `${target.name} is a built-in system bot. Only the user changes or removes it.`,
    );
  }
  if (!isBotOnTeam(target, team)) {
    return refuse(
      "other_team",
      `${target.name} is on the ${personalBotTeamLabel(botTeam(target))}, not yours (${personalBotTeamLabel(team)}). You can only change bots on your own team.`,
    );
  }
  if (isTeamLead(target)) {
    return refuse("other_lead", `${target.name} is a team lead. Only the user changes a lead.`);
  }

  if (
    !facts.targetCreatedByLead &&
    (facts.action === "remove" || facts.sensitiveChanges.length > 0) &&
    facts.ownerRequest !== "named"
  ) {
    const what =
      facts.action === "remove" ? "remove it" : `change its ${facts.sensitiveChanges.join(", ")}`;
    return refuse(
      "needs_owner",
      facts.ownerRequest === "no_user_message"
        ? `${target.name} was set up by the user, not by a lead, so you may only ${what} when the user asks for it in chat by name. This turn has no message from the user (a routine or task run). Ask Harout to request this in chat.`
        : `${target.name} was set up by the user, not by a lead, so you may only ${what} when the user's own latest message names ${target.name}. It does not. Ask Harout to request this in chat, naming ${target.name}.`,
    );
  }

  if (facts.action === "remove") {
    const busy = busyRefusal(target, facts.targetOpenTasks, facts.targetActiveSessions);
    if (busy !== null) return busy;
    if (facts.targetActiveRoutines > 0) {
      return refuse(
        "active_routines",
        `${target.name} has ${facts.targetActiveRoutines} routine${facts.targetActiveRoutines === 1 ? "" : "s"} switched on. Ask the user to pause or delete them first.`,
      );
    }
  }
  return { allowed: true, team };
}

/**
 * The refusal for a target that is mid-work, or null. The service asks it again
 * inside the transaction that soft-deletes, so a task or turn that started
 * after the first check still stops the removal.
 */
export function busyRefusal(
  target: { readonly name: string },
  openTasks: number,
  activeSessions: number,
): LeadBotVerdict | null {
  if (openTasks > 0) {
    return refuse(
      "running_task",
      `${target.name} has ${openTasks} unfinished task${openTasks === 1 ? "" : "s"}. Wait for them to finish, or stop them with stop_task, then try again.`,
    );
  }
  if (activeSessions > 0) {
    return refuse(
      "running_task",
      `${target.name} is in the middle of a turn. Wait for it to finish, then try again.`,
    );
  }
  return null;
}

const LETTER_SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Armenian",
  "Georgian",
  "Hebrew",
  "Arabic",
  "Devanagari",
  "Thai",
  "Hangul",
  "Han",
  "Hiragana",
  "Katakana",
] as const;
const SCRIPT_TESTS: ReadonlyArray<readonly [string, RegExp]> = LETTER_SCRIPTS.map((script) => [
  script,
  new RegExp(`\\p{Script=${script}}`, "u"),
]);

const scriptOf = (char: string): string => {
  const script = SCRIPT_TESTS.find(([, test]) => test.test(char))?.[0] ?? "Other";
  return script === "Hiragana" || script === "Katakana" ? "Han" : script;
};

/** The reason one form of a name (raw or normal) is not acceptable, or null. */
const nameFormProblem = (name: string, form: "raw" | "normal"): string | null => {
  if (/\p{Cf}/u.test(name)) {
    return "The name contains an invisible formatting character. Use plain visible characters only.";
  }
  const collapsed = name.replace(/\s+/gu, " ").trim();
  if ([...collapsed].length < 3 || !/\p{L}/u.test(collapsed)) {
    return "The name must be at least 3 characters and include a letter.";
  }
  const scripts = new Set<string>();
  for (const char of collapsed) {
    if (/\p{L}/u.test(char)) scripts.add(scriptOf(char));
  }
  if (scripts.size > 1) {
    return form === "raw"
      ? "The name mixes letters from different alphabets or styled look-alike letters (for example Latin next to Cyrillic, or maths-italic capitals), which can pass one bot off as another. Use one alphabet and plain letters."
      : "The name mixes letters from different alphabets (for example Latin and Cyrillic), which can pass one bot off as another. Use one alphabet.";
  }
  return null;
};

/**
 * A name a lead may give a bot, or the reason it may not. The name as submitted
 * (raw) AND its NFKC-normalised form must each pass: no invisible format
 * characters, at least three characters with a letter among them, letters from
 * one script only (Latin next to Cyrillic is how one name is made to look like
 * another). Checking only the normal form let a name through that merely
 * normalises to something valid (a ligature that expands to three letters, a
 * run of styled capitals next to plain letters). Japanese mixes Han, Hiragana
 * and Katakana on purpose, so those three count as one script. Returns the
 * normal form.
 */
export function checkBotName(
  raw: string,
): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string } {
  const rawProblem = nameFormProblem(raw, "raw");
  if (rawProblem !== null) return { ok: false, reason: rawProblem };
  const normalized = raw.normalize("NFKC");
  const normalProblem = nameFormProblem(normalized, "normal");
  if (normalProblem !== null) return { ok: false, reason: normalProblem };
  return { ok: true, name: normalized.replace(/\s+/gu, " ").trim() };
}

/**
 * Text a lead writes into a bot (instructions, description) must not carry a
 * credential: a secret pasted there would be readable by every later session
 * of that bot and by anyone who opens its settings. A best-effort catch of
 * the common shapes and of the app's own secret variable names; it is a
 * guard rail, not a scanner.
 */
const SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /PB_SECRET_[A-Z0-9_]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export const looksLikeSecret = (text: string): boolean =>
  SECRET_SHAPES.some((shape) => shape.test(text));
