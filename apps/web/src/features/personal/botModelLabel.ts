import {
  botEffectiveModelSelection,
  botFallbackActive,
  DEEPSEEK_AGENT_MODE_OPTION_ID,
  type ModelSelection,
  PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
  type PersonalBot,
  type SelectProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "~/providerModels";

/** Claude calls the effort option `effort`, Codex `reasoningEffort`, OpenCode `variant`. */
export const EFFORT_OPTION_IDS: ReadonlyArray<string> = ["effort", "reasoningEffort", "variant"];

/** The option id the DeepSeek Harness engine uses for a bot's agent mode. */
const AGENT_MODE_OPTION_ID = DEEPSEEK_AGENT_MODE_OPTION_ID;

/**
 * The agent mode suffix a label carries, or null for the default (Standard).
 * Only a DeepSeek bot on the DeepSeek Harness engine has the option at all, so
 * every other bot's label is unchanged.
 *
 * The descriptor is read here rather than through `botFormModel`, which
 * re-exports this module's effort ids: importing it back would make a cycle.
 */
function agentModeSuffix(
  selection: ModelSelection,
  provider: ServerProvider | undefined,
  slug: string,
): string | null {
  // A provider this client cannot see (not loaded, or gone) says nothing
  // about the model, so no suffix is invented for it.
  if (provider?.models === undefined) return null;
  const descriptor =
    getProviderOptionDescriptors({
      caps: getProviderModelCapabilities(provider.models, slug, provider.driver),
    }).find(
      (candidate): candidate is SelectProviderOptionDescriptor =>
        candidate.type === "select" && candidate.id === AGENT_MODE_OPTION_ID,
    ) ?? null;
  if (descriptor === null) return null;
  const value = getModelSelectionStringOptionValue(selection, AGENT_MODE_OPTION_ID);
  if (value === undefined || value.trim() === "") return null;
  const option = descriptor.options.find((entry) => entry.id === value);
  if (option?.isDefault === true) return null;
  const label = option?.label ?? value;
  return ` · ${label}`;
}

/** The model as picked and the effort chosen for it, shared by both label forms. */
function resolveSelection(selection: ModelSelection, providers: ReadonlyArray<ServerProvider>) {
  const slug = selection.model.trim();
  if (slug === "") return null;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models?.find((candidate) => candidate.slug === slug);
  const listedName = model?.name.trim() || undefined;
  const effortId = EFFORT_OPTION_IDS.find(
    (id) => getModelSelectionStringOptionValue(selection, id) !== undefined,
  );
  const value =
    effortId === undefined ? undefined : getModelSelectionStringOptionValue(selection, effortId);
  const effort = value === undefined || value.trim() === "" ? undefined : value;
  return {
    slug,
    provider,
    listedName,
    effortId,
    effort,
    agentMode: agentModeSuffix(selection, provider, slug),
  };
}

/**
 * The short model line beside a bot's name: "Opus 5.5 medium", "Sonnet 5",
 * "GPT-6 Astra medium". The model's name as the picker shows it, without the
 * "Claude" every Claude model repeats, plus the chosen effort (or OpenCode
 * variant) when one is set; a bot on the model's default effort shows none.
 * A model the provider does not list (not loaded yet, or retired) falls back
 * to its id, the only name there is. Null without a model.
 */
export function botModelLabel(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  const resolved = resolveSelection(selection, providers);
  if (resolved === null) return null;
  const { slug, provider, listedName, effortId, effort, agentMode } = resolved;
  const mode = agentMode ?? "";
  const name = (listedName ?? slug).replace(/^Claude\s+/, "");
  if (effort === undefined) return `${name}${mode}`;
  const optionLabel =
    provider?.models === undefined
      ? undefined
      : getProviderOptionDescriptors({
          caps: getProviderModelCapabilities(provider.models, slug, provider.driver),
        })
          .find(
            (descriptor): descriptor is SelectProviderOptionDescriptor =>
              descriptor.type === "select" && descriptor.id === effortId,
          )
          ?.options.find((option) => option.id === effort)?.label;
  return `${name} ${(optionLabel ?? effort).toLocaleLowerCase()}${mode}`;
}

/** One or two characters per effort, so the label fits the pinned tile. */
const EFFORT_ABBREVIATIONS: Readonly<Record<string, string>> = {
  low: "L",
  medium: "M",
  high: "H",
  xhigh: "X",
  max: "Max",
};

/**
 * The picker name without what the pinned tile has no room for: the "Claude"
 * prefix, a plan word ("Free", "Preview", "Beta") and a context-window suffix
 * ("(1M context)", "[1m]", "200k").
 */
function shortModelName(name: string): string {
  return name
    .replace(/^Claude\s+/, "")
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    .replace(/\b(?:free|preview|beta)\b/gi, "")
    .replace(/\s+\d+(?:\.\d+)?[km](?:\s+context)?\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The label for a pinned tile, 72px wide: "Opus 5.5 · M", "Sonnet 5.5 · H",
 * "GPT-6 Astra · M", "Haiku 4.5" (no effort set). The effort is L, M, H, X or
 * Max; an effort with no abbreviation (an OpenCode variant such as "minimal")
 * is left out rather than guessed. A model the provider does not list keeps
 * its raw id, which the tile then shrinks or cuts. Null without a model.
 */
export function botModelShortLabel(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  const resolved = resolveSelection(selection, providers);
  if (resolved === null) return null;
  const name =
    resolved.listedName === undefined
      ? resolved.slug
      : shortModelName(resolved.listedName) || resolved.slug;
  const effort = resolved.effort;
  const mode = resolved.agentMode ?? "";
  if (effort === undefined) return `${name}${mode}`;
  const abbreviation = EFFORT_ABBREVIATIONS[effort];
  if (abbreviation === undefined) return `${name}${mode}`;
  return `${name} · ${abbreviation}${mode}`;
}

/** The word the short label ends with while a bot runs on its fallback model. */
export const FALLBACK_LABEL_MARKER = "fallback";

/** "DeepSeek peak until 11:00": why the DeepSeek peak switch moved the bot. */
export const DEEPSEEK_PEAK_LABEL = "DeepSeek peak";

/**
 * The peak note's form for a line with no room: "Sonnet 5.5 · H · peak" on the
 * Bots rows, the chat header, task cards, pinned tiles and Team. The full
 * wording ("DeepSeek peak until 11:00") is what the accessible label carries at
 * those widths, and it stays visible wherever there is room.
 */
export const DEEPSEEK_PEAK_SHORT_LABEL = "peak";

/** The bot is on the DeepSeek peak switch (1.66.44), not a usage-limit fallback. */
function onDeepSeekPeak(bot: Pick<PersonalBot, "fallbackActive">): boolean {
  return botFallbackActive(bot)?.reason === PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK;
}

type BotWithFallback = Pick<PersonalBot, "modelSelection" | "fallbackActive">;

function formatLocalTime(atMs: number, nowMs: number, timeZone: string | undefined): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      ...(timeZone === undefined ? {} : { timeZone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(atMs);
  if (day(atMs) === day(nowMs)) return time;
  const weekday = new Intl.DateTimeFormat("en-GB", {
    ...(timeZone === undefined ? {} : { timeZone }),
    weekday: "short",
  }).format(atMs);
  return `${weekday} ${time}`;
}

/**
 * Why a bot is on its fallback model, for a title or an accessible name:
 * "on fallback until about 14:30 (Codex usage limit)", or "DeepSeek peak until
 * 11:00" while the DeepSeek peak switch has it. The time is in the device's own
 * zone and is left out when the provider gave no reset time. Null while the bot
 * is on its own model.
 */
export function fallbackNoteLabel(
  bot: Pick<PersonalBot, "fallbackActive">,
  nowMs: number = Date.now(),
  timeZone?: string,
): string | null {
  const active = botFallbackActive(bot);
  if (active === null) return null;
  const resetMs =
    active.resetAt === undefined ? Number.NaN : DateTime.toEpochMillis(active.resetAt);
  const until = Number.isFinite(resetMs)
    ? ` until about ${formatLocalTime(resetMs, nowMs, timeZone)}`
    : "";
  if (active.reason === PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK) {
    const peakUntil = Number.isFinite(resetMs)
      ? ` until ${formatLocalTime(resetMs, nowMs, timeZone)}`
      : "";
    return `${DEEPSEEK_PEAK_LABEL}${peakUntil}`;
  }
  const provider = active.fromProvider.trim();
  return `on fallback${until}${provider === "" ? "" : ` (${provider} usage limit)`}`;
}

/**
 * The long model label for a bot: what it runs on right now, with the fallback
 * note when that is its fallback ("Sonnet 5.5 high, on fallback until about
 * 14:30 (Codex usage limit)").
 */
export function botActiveModelLabel(
  bot: BotWithFallback,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number = Date.now(),
  timeZone?: string,
): string | null {
  const label = botModelLabel(botEffectiveModelSelection(bot), providers);
  if (label === null) return null;
  const note = fallbackNoteLabel(bot, nowMs, timeZone);
  return note === null ? label : `${label}, ${note}`;
}

/**
 * The short model label for a bot: what it runs on right now, ending
 * "· fallback" while that is its fallback ("Sonnet 5.5 · H · fallback"), or
 * "· peak" while the DeepSeek peak switch has it ("Sonnet 5.5 · H · peak").
 *
 * The peak note is the short form on purpose: this label sits on the Bots rows,
 * the chat header, task cards and 72px pinned tiles, where "· DeepSeek peak
 * until 11:00" was cut at 390 px (1.66.44 QA). The full wording stays on
 * {@link fallbackNoteLabel}, which those places read out to assistive tech.
 */
export function botActiveModelShortLabel(
  bot: BotWithFallback,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  const label = botModelShortLabel(botEffectiveModelSelection(bot), providers);
  if (label === null) return null;
  if (onDeepSeekPeak(bot)) return `${label} · ${DEEPSEEK_PEAK_SHORT_LABEL}`;
  return botFallbackActive(bot) === null ? label : `${label} · ${FALLBACK_LABEL_MARKER}`;
}
