import type {
  PersonalBot,
  SelectProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";

import { modelOptionLabel, SCHEDULE_TIME_OPTIONS } from "./botFormModel.ts";
import {
  botMuteState,
  MUTE_CHOICES,
  mutedUntilLabel,
  type BotNotificationsChoice,
} from "./botMuteModel.ts";
import { providerLine, resolveBotProvider } from "./botSummaries.ts";

export interface FieldChoice {
  readonly value: string;
  readonly label: string;
}

/** A saved option the new model does not offer falls back to "" (the model's default). */
export function descriptorValue(
  descriptor: SelectProviderOptionDescriptor | null,
  value: string,
): string {
  return descriptor?.options.some((option) => option.id === value) === true ? value : "";
}

/** "Default (High)" first, then every option the model offers. */
export function descriptorChoices(
  descriptor: SelectProviderOptionDescriptor,
): ReadonlyArray<FieldChoice> {
  const standard = descriptor.options.find((option) => option.isDefault);
  return [
    { value: "", label: standard === undefined ? "Default" : `Default (${standard.label})` },
    ...descriptor.options.map((option) => ({ value: option.id, label: option.label })),
  ];
}

/** The models of a provider; a saved slug the provider no longer lists stays on top. */
export function modelChoices(
  models: ReadonlyArray<ServerProviderModel>,
  current: string,
): ReadonlyArray<FieldChoice> {
  const listed = models.map((model) => ({ value: model.slug, label: modelOptionLabel(model) }));
  return models.some((model) => model.slug === current) || current === ""
    ? listed
    : [{ value: current, label: current }, ...listed];
}

export function providerChoices(
  providerOptions: ReadonlyArray<ServerProvider>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<FieldChoice> {
  return providerOptions.map((provider) => ({
    value: provider.instanceId,
    label: providerLine(resolveBotProvider(provider.instanceId, providers)),
  }));
}

/** Every 15 minutes, plus a saved time that is off that grid. */
export function scheduleTimeChoices(current: string): ReadonlyArray<string> {
  return SCHEDULE_TIME_OPTIONS.includes(current) || current === ""
    ? SCHEDULE_TIME_OPTIONS
    : [...SCHEDULE_TIME_OPTIONS, current].toSorted();
}

/** The mute the bot had when the form opened; a bot muted until turned back on reads "Off". */
export function currentMuteLabelOf(bot: PersonalBot | null, nowMs: number): string | null {
  const state = bot === null ? null : botMuteState(bot, nowMs);
  if (state?.muted !== true) return null;
  return state.indefinite ? "Off" : mutedUntilLabel(state, nowMs);
}

export function notificationChoices(
  currentMuteLabel: string | null,
): ReadonlyArray<{ readonly value: BotNotificationsChoice; readonly label: string }> {
  return [
    ...(currentMuteLabel === null ? [] : [{ value: "keep" as const, label: currentMuteLabel }]),
    { value: "on" as const, label: "On" },
    ...MUTE_CHOICES.filter(
      (choice) => !(choice.key === "indefinitely" && currentMuteLabel === "Off"),
    ).map((choice) => ({
      value: choice.key,
      label:
        choice.key === "indefinitely"
          ? "Off"
          : `Mute ${choice.label.charAt(0).toLowerCase()}${choice.label.slice(1)}`,
    })),
  ];
}

export function voiceCallsLine(lead: boolean): string {
  return lead
    ? "On for team leads: this bot is one, so its chats show a call button."
    : "Off: only team leads can take calls. Make this bot a team lead to turn calls on.";
}
