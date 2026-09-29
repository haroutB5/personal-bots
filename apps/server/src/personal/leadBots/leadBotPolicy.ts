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
  } | null;
  /** Bots this lead created in the last {@link LEAD_BOT_CREATE_WINDOW_MS}. */
  readonly createsInWindow: number;
  /** Remove: the target's tasks that are not finished (running, queued or waiting). */
  readonly targetOpenTasks: number;
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
 *  4. Update and remove: the target must be a bot on the caller's own team that
 *     is not the caller and not a lead. Anything on another team (including the
 *     seeded system bots) is out of reach unless it sits on this team.
 *  5. Remove: refused while the target has unfinished tasks or switched-on
 *     routines, so nothing is orphaned.
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
      target.modelSelection.model === facts.requestedModel.model;
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
  if (!isBotOnTeam(target, team)) {
    return refuse(
      "other_team",
      `${target.name} is on the ${personalBotTeamLabel(botTeam(target))}, not yours (${personalBotTeamLabel(team)}). You can only change bots on your own team.`,
    );
  }
  if (isTeamLead(target)) {
    return refuse("other_lead", `${target.name} is a team lead. Only the user changes a lead.`);
  }

  if (facts.action === "remove") {
    if (facts.targetOpenTasks > 0) {
      return refuse(
        "running_task",
        `${target.name} has ${facts.targetOpenTasks} unfinished task${facts.targetOpenTasks === 1 ? "" : "s"}. Wait for them to finish, or stop them with stop_task, then try again.`,
      );
    }
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
