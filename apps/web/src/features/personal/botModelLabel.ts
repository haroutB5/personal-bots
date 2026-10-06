import {
  botEffectiveModelSelection,
  botFallbackActive,
  type ModelSelection,
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
  return { slug, provider, listedName, effortId, effort };
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
  const { slug, provider, listedName, effortId, effort } = resolved;
  const name = (listedName ?? slug).replace(/^Claude\s+/, "");
  if (effort === undefined) return name;
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
  return `${name} ${(optionLabel ?? effort).toLocaleLowerCase()}`;
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
  const abbreviation =
    resolved.effort === undefined ? undefined : EFFORT_ABBREVIATIONS[resolved.effort];
  return abbreviation === undefined ? name : `${name} · ${abbreviation}`;
}

/** The word the short label ends with while a bot runs on its fallback model. */
export const FALLBACK_LABEL_MARKER = "fallback";

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
 * "on fallback until about 14:30 (Codex usage limit)". The time is in the
 * device's own zone and is left out when the provider gave no reset time.
 * Null while the bot is on its own model.
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
 * "· fallback" while that is its fallback ("Sonnet 5.5 · H · fallback").
 */
export function botActiveModelShortLabel(
  bot: BotWithFallback,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  const label = botModelShortLabel(botEffectiveModelSelection(bot), providers);
  if (label === null) return null;
  return botFallbackActive(bot) === null ? label : `${label} · ${FALLBACK_LABEL_MARKER}`;
}
