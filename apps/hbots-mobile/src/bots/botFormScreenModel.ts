import {
  botTeam,
  personalBotTeams,
  type PersonalBot,
  type PersonalBotId,
  type PersonalBotTeam,
} from "@t3tools/contracts";
import { botNameProblem, type BotDraft } from "@hbots/personal-client/bots/botDraft";

export type BotFormTarget =
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly botId: string };

export interface BotListSnapshot {
  readonly bots: ReadonlyArray<PersonalBot> | null;
  readonly error: string | null;
}

export type BotFormScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "notFound" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly bot: PersonalBot | null };

export function botFormScreenState(
  target: BotFormTarget,
  list: BotListSnapshot,
): BotFormScreenState {
  switch (target.kind) {
    case "new":
      return { kind: "ready", bot: null };
    case "edit": {
      const bot = list.bots?.find((candidate) => candidate.botId === target.botId);
      if (bot !== undefined) return { kind: "ready", bot };
      if (list.bots !== null) return { kind: "notFound" };
      if (list.error !== null) return { kind: "error", message: list.error };
      return { kind: "loading" };
    }
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

export function botFormTitle(state: BotFormScreenState, target: BotFormTarget): string {
  switch (target.kind) {
    case "new":
      return "New bot";
    case "edit":
      return state.kind === "ready" && state.bot !== null ? `Edit ${state.bot.name}` : "Edit bot";
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

export function botTeamChoices(
  customTeams: ReadonlyArray<PersonalBotTeam>,
  bots: ReadonlyArray<PersonalBot>,
  bot: PersonalBot | null,
): ReadonlyArray<PersonalBotTeam> {
  return personalBotTeams([
    ...customTeams,
    ...bots.map(botTeam),
    ...(bot === null ? [] : [botTeam(bot)]),
  ]);
}

export type BotSubmitDecision =
  | { readonly kind: "nameProblem"; readonly message: string }
  | { readonly kind: "blocked" }
  | { readonly kind: "save" };

export function botSubmitDecision(input: {
  readonly draft: BotDraft;
  readonly botId: PersonalBotId;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly canSave: boolean;
}): BotSubmitDecision {
  const problem = botNameProblem(input.draft.name, input.botId, input.bots);
  if (problem !== null) return { kind: "nameProblem", message: problem };
  return input.canSave ? { kind: "save" } : { kind: "blocked" };
}

export const BOT_GONE_MESSAGE = "This bot no longer exists.";
export const BOT_SAVE_FAILED_MESSAGE = "The bot could not be saved.";
