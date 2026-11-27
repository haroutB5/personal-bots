import {
  type BotAvatarShape,
  botFallback,
  botTeam,
  DEFAULT_PERSONAL_BOT_TEAM,
  hidesBotPreviews,
  isBotPinned,
  isTeamLead,
  type ModelSelection,
  type PersonalBot,
  type PersonalBotCreateInput,
  type PersonalBotId,
  type PersonalBotNotificationMute,
  type PersonalBotTeam,
  type PersonalBotUpdateInput,
  savesMemoryWithoutAsking,
  type ServerProvider,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import {
  agentModeOfSelection,
  botInstructionSupportWarning,
  buildModelSelection,
  CONTEXT_WINDOW_OPTION_ID,
  defaultModelFor,
  type FallbackDraft,
  fallbackDraftFromBot,
  fallbackInput,
  isBotProviderSelectable,
  isFallbackDraftValid,
  type ScheduleDraft,
  scheduleDraftFromBot,
  scheduleDraftProblem,
  scheduleDraftSelection,
  scheduleInput,
} from "./botFormModel.ts";
import { EFFORT_OPTION_IDS } from "./botModelLabel.ts";
import {
  type BotNotificationsChoice,
  initialNotificationsChoice,
  muteForChoice,
} from "./botMuteModel.ts";

export const BOT_NAME_MAX = 60;
export const BOT_TITLE_MAX = 60;

export const NAME_REQUIRED_MESSAGE = "Give your bot a name.";

export const DISCARD_BOT_EDITS_MESSAGE =
  "Discard your changes?\nYou haven't saved your edits to this bot.";
export const DISCARD_BOT_EDITS_LABEL = "Discard";

export const DELETE_BOT_CONFIRM_LABEL = "Delete bot";

export function deleteBotConfirmMessage(name: string): string {
  return `Delete ${name} completely?\nIts chats, routines and memories are removed too. This can't be undone.`;
}

export function nameTakenMessage(existingName: string): string {
  return `You already have a bot called ${existingName}.`;
}

/** Everything the bot form holds, flat so a field-by-field compare tells whether anything changed. */
export interface BotDraft {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly avatarShape: BotAvatarShape;
  readonly avatarColor: string;
  readonly instanceId: string;
  readonly model: string;
  /** Reasoning effort option id; "" keeps the model's default. */
  readonly effort: string;
  /** Context window option id (e.g. "1m"); "" keeps the model's default. */
  readonly contextWindow: string;
  /** Agent mode option id (DeepSeek Harness only); "standard" is the default. */
  readonly agentMode: string;
  /** The usage-limit fallback: on/off and its model, effort and context window. */
  readonly fallbackEnabled: boolean;
  readonly fallbackInstanceId: string;
  readonly fallbackModel: string;
  readonly fallbackEffort: string;
  readonly fallbackContextWindow: string;
  /** The model schedule: on/off, From and To ("HH:MM") and its model, effort and context window. */
  readonly scheduleEnabled: boolean;
  readonly scheduleFrom: string;
  readonly scheduleTo: string;
  readonly scheduleInstanceId: string;
  readonly scheduleModel: string;
  readonly scheduleEffort: string;
  readonly scheduleContextWindow: string;
  readonly team: PersonalBotTeam;
  readonly lead: boolean;
  readonly pinned: boolean;
  readonly memoryAutoSave: boolean;
  readonly hidePreviews: boolean;
  readonly notifications: BotNotificationsChoice;
}

function fallbackFields(
  fallback: FallbackDraft,
): Pick<
  BotDraft,
  | "fallbackEnabled"
  | "fallbackInstanceId"
  | "fallbackModel"
  | "fallbackEffort"
  | "fallbackContextWindow"
> {
  return {
    fallbackEnabled: fallback.enabled,
    fallbackInstanceId: fallback.instanceId,
    fallbackModel: fallback.model,
    fallbackEffort: fallback.effort,
    fallbackContextWindow: fallback.contextWindow,
  };
}

function scheduleFields(
  schedule: ScheduleDraft,
): Pick<
  BotDraft,
  | "scheduleEnabled"
  | "scheduleFrom"
  | "scheduleTo"
  | "scheduleInstanceId"
  | "scheduleModel"
  | "scheduleEffort"
  | "scheduleContextWindow"
> {
  return {
    scheduleEnabled: schedule.enabled,
    scheduleFrom: schedule.from,
    scheduleTo: schedule.to,
    scheduleInstanceId: schedule.instanceId,
    scheduleModel: schedule.model,
    scheduleEffort: schedule.effort,
    scheduleContextWindow: schedule.contextWindow,
  };
}

export function scheduleDraftOf(draft: BotDraft): ScheduleDraft {
  return {
    enabled: draft.scheduleEnabled,
    from: draft.scheduleFrom,
    to: draft.scheduleTo,
    instanceId: draft.scheduleInstanceId,
    model: draft.scheduleModel,
    effort: draft.scheduleEffort,
    contextWindow: draft.scheduleContextWindow,
    // The scheduled model runs on its own provider; the mode belongs to the bot's own model.
    agentMode: "",
  };
}

export function fallbackDraftOf(draft: BotDraft): FallbackDraft {
  return {
    enabled: draft.fallbackEnabled,
    instanceId: draft.fallbackInstanceId,
    model: draft.fallbackModel,
    effort: draft.fallbackEffort,
    contextWindow: draft.fallbackContextWindow,
    // The fallback runs on its own provider; the mode belongs to the bot's own
    // model, never to the model it falls back to.
    agentMode: "",
  };
}

/** Field-by-field: has the owner changed anything since the form opened? */
export function botDraftsEqual(left: BotDraft, right: BotDraft): boolean {
  return (Object.keys(left) as Array<keyof BotDraft>).every((key) => left[key] === right[key]);
}

/** The draft an existing bot opens the editor with. */
export function draftFromBot(bot: PersonalBot, nowMs: number): BotDraft {
  return {
    ...fallbackFields(fallbackDraftFromBot(bot)),
    ...scheduleFields(scheduleDraftFromBot(bot)),
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    avatarShape: bot.avatarShape,
    avatarColor: bot.avatarColor,
    instanceId: bot.modelSelection.instanceId,
    model: bot.modelSelection.model,
    team: botTeam(bot),
    lead: isTeamLead(bot),
    pinned: isBotPinned(bot),
    memoryAutoSave: savesMemoryWithoutAsking(bot),
    hidePreviews: hidesBotPreviews(bot),
    notifications: initialNotificationsChoice(bot, nowMs),
    effort:
      EFFORT_OPTION_IDS.map((id) =>
        getModelSelectionStringOptionValue(bot.modelSelection, id),
      ).find((value) => value !== undefined) ?? "",
    contextWindow:
      getModelSelectionStringOptionValue(bot.modelSelection, CONTEXT_WINDOW_OPTION_ID) ?? "",
    agentMode: agentModeOfSelection(bot.modelSelection),
  };
}

/** Providers the form offers for a new bot, and the one it starts on (Claude Code when ready). */
export function selectableProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(isBotProviderSelectable);
}

export function firstSelectableProvider(
  selectable: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined {
  return selectable.find((provider) => provider.driver === "claudeAgent") ?? selectable[0];
}

/** The draft a new bot opens with. */
export function newBotDraft(selectable: ReadonlyArray<ServerProvider>): BotDraft {
  const first = firstSelectableProvider(selectable);
  return {
    name: "",
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    instanceId: first?.instanceId ?? "",
    model: defaultModelFor(first),
    effort: "",
    contextWindow: "",
    agentMode: "",
    ...fallbackFields(fallbackDraftFromBot(null)),
    ...scheduleFields(scheduleDraftFromBot(null)),
    team: DEFAULT_PERSONAL_BOT_TEAM,
    lead: false,
    pinned: false,
    memoryAutoSave: true,
    hidePreviews: false,
    notifications: "on",
  };
}

/**
 * A cold open of a new bot renders before the providers load: once one is
 * ready, the draft that still has no provider starts on it, so "Create bot" is
 * not stuck disabled.
 */
export function withStartingProvider(
  draft: BotDraft,
  isNew: boolean,
  selectable: ReadonlyArray<ServerProvider>,
): BotDraft {
  if (!isNew || draft.instanceId !== "") return draft;
  const first = firstSelectableProvider(selectable);
  if (first === undefined) return draft;
  return { ...draft, instanceId: first.instanceId, model: defaultModelFor(first) };
}

/**
 * The providers a picker lists: the ready ones, plus the one the bot already
 * has even when it went unavailable, so a select never silently shows a
 * different provider than the saved one.
 */
export function providerOptionsFor(
  instanceId: string,
  providers: ReadonlyArray<ServerProvider>,
  selectable: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  const options = [...selectable];
  const current = providers.find((provider) => provider.instanceId === instanceId);
  if (current !== undefined && !options.includes(current)) options.unshift(current);
  return options;
}

/** What the owner has to fix before the form saves, or null. */
export type BotNameProblem = string | null;

/**
 * Two bots with one name are two identical rows everywhere a bot is picked
 * (the list, the strip, groups, @mentions, delegation), with no way to tell
 * them apart.
 */
export function botNameProblem(
  rawName: string,
  botId: PersonalBotId,
  bots: ReadonlyArray<Pick<PersonalBot, "botId" | "name">>,
): BotNameProblem {
  const name = rawName.trim();
  if (name.length === 0) return NAME_REQUIRED_MESSAGE;
  const clash = bots.find(
    (other) => other.botId !== botId && other.name.trim().toLowerCase() === name.toLowerCase(),
  );
  return clash === undefined ? null : nameTakenMessage(clash.name);
}

/** The bot's own model as the form would save it. */
export function draftModelSelection(
  draft: BotDraft,
  providers: ReadonlyArray<ServerProvider>,
  saved: PersonalBot | null,
): ModelSelection {
  return buildModelSelection(
    draft,
    providers.find((provider) => provider.instanceId === draft.instanceId),
    saved?.modelSelection ?? null,
  );
}

/** What the form needs to know to render its save state and its schedule line. */
export interface BotDraftAssessment {
  readonly mainModelSelection: ModelSelection;
  readonly scheduleSelection: ModelSelection | null;
  readonly scheduleProblem: string | null;
  readonly canSave: boolean;
}

export function assessBotDraft(
  draft: BotDraft,
  providers: ReadonlyArray<ServerProvider>,
  saved: PersonalBot | null,
  busy: boolean,
): BotDraftAssessment {
  const mainModelSelection = draftModelSelection(draft, providers, saved);
  const scheduleSelection = scheduleDraftSelection(
    scheduleDraftOf(draft),
    providers,
    saved?.schedule ?? null,
  );
  const scheduleProblem = scheduleDraftProblem(
    scheduleDraftOf(draft),
    mainModelSelection,
    scheduleSelection,
  );
  const canSave =
    draft.instanceId !== "" &&
    draft.model !== "" &&
    isFallbackDraftValid(fallbackDraftOf(draft)) &&
    scheduleProblem === null &&
    !busy;
  return { mainModelSelection, scheduleSelection, scheduleProblem, canSave };
}

/** The line shown when a saved bot sits on a provider that drops its persona. */
export function draftInstructionWarning(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  providerLabel: string | null,
): string | null {
  return botInstructionSupportWarning(
    providers.find((provider) => provider.instanceId === instanceId),
    providerLabel ?? "This provider",
  );
}

/** What one save sends: the create, plus the follow-up update a new bot needs for its mute and privacy. */
export type BotSavePlan =
  | {
      readonly kind: "create";
      readonly create: PersonalBotCreateInput;
      readonly followUp: PersonalBotUpdateInput | null;
    }
  | { readonly kind: "update"; readonly update: PersonalBotUpdateInput };

export function planBotSave(options: {
  readonly botId: PersonalBotId;
  readonly saved: PersonalBot | null;
  readonly draft: BotDraft;
  readonly baselineNotifications: BotNotificationsChoice;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly assessment: BotDraftAssessment;
}): BotSavePlan {
  const { botId, saved, draft, baselineNotifications, providers, assessment } = options;
  const fields = {
    name: draft.name.trim(),
    title: draft.title.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
    avatarShape: draft.avatarShape,
    avatarColor: draft.avatarColor,
    modelSelection: assessment.mainModelSelection,
    team: draft.team,
    lead: draft.lead,
    pinned: draft.pinned,
    memoryAutoSave: draft.memoryAutoSave,
  };
  // Create sends the whole fallback; edit only what changed.
  const fallback = fallbackInput(
    saved === null ? null : botFallback(saved),
    fallbackDraftOf(draft),
    providers,
  );
  // Create sends the whole schedule when it is on; edit only what changed.
  const schedule = scheduleInput(
    saved?.schedule ?? null,
    scheduleDraftOf(draft),
    assessment.scheduleSelection,
  );
  const notificationsMute: PersonalBotNotificationMute | undefined = muteForChoice(
    draft.notifications,
    baselineNotifications,
  );
  const shared = {
    ...fields,
    ...(fallback === undefined ? {} : { fallback }),
    ...(schedule === undefined ? {} : { schedule }),
  };
  if (saved !== null) {
    return {
      kind: "update",
      update: {
        botId,
        ...shared,
        hidePreviews: draft.hidePreviews,
        ...(notificationsMute === undefined ? {} : { notificationsMute }),
      },
    };
  }
  // Create takes no mute and no privacy switch: a new bot created with either
  // gets it right after.
  const followUp: PersonalBotUpdateInput | null =
    notificationsMute !== undefined || draft.hidePreviews
      ? {
          botId,
          ...(notificationsMute === undefined ? {} : { notificationsMute }),
          ...(draft.hidePreviews ? { hidePreviews: true } : {}),
        }
      : null;
  return { kind: "create", create: { botId, ...shared }, followUp };
}
