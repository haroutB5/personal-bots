import {
  driverCarriesBotInstructions,
  isProviderAvailable,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { seedModelFor } from "../seedModel.ts";

/** Claude calls the effort option `effort`, Codex `reasoningEffort`, OpenCode `variant`. */
const EFFORT_OPTION_IDS: ReadonlyArray<string> = ["effort", "reasoningEffort", "variant"];
const DEFAULT_NEW_MODEL_EFFORT = "medium";

/** The providers a bot can run on: usable now and able to carry the bot's persona. */
export const selectableProviders = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  providers.filter(
    (snapshot) =>
      isProviderAvailable(snapshot) &&
      snapshot.enabled &&
      snapshot.installed &&
      driverCarriesBotInstructions(snapshot.driver),
  );

const effortDescriptor = (model: ServerProviderModel) =>
  model.capabilities?.optionDescriptors?.find(
    (descriptor) =>
      EFFORT_OPTION_IDS.includes(descriptor.id) &&
      descriptor.type === "select" &&
      descriptor.options.length > 0,
  );

export interface LeadModelRequest {
  /** A provider instance id; default is the provider the bot is on (or the lead is on). */
  readonly provider?: string | undefined;
  /** A model slug from that provider's list; default is the bot's current model. */
  readonly model?: string | undefined;
  /** An effort the chosen model offers (for example "low", "medium", "high"). */
  readonly effort?: string | undefined;
}

export type LeadModelResult =
  | { readonly ok: true; readonly selection: ModelSelection; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

const listModels = (provider: ServerProvider) =>
  provider.models.map((model) => model.slug).join(", ") || "none";

/**
 * Turns "provider, model, effort" into a stored selection, from the providers'
 * own lists only. `base` is what a bare request builds on: the bot's current
 * selection on update, the lead's own on create (with `seedFallback` true, so an
 * omitted model becomes the seed choice rather than the lead's own model, which
 * might be one only Harout may pick). Whether the model is allowed at all is not
 * decided here: see `authorizeLeadBotAction`.
 */
export function resolveLeadModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly base: ModelSelection;
  readonly seedFallback: boolean;
  readonly seedOverride?: string | undefined;
  readonly request: LeadModelRequest;
}): LeadModelResult {
  const { base, request } = input;
  const selectable = selectableProviders(input.providers);
  const instanceId = request.provider?.trim() || base.instanceId;
  const provider = selectable.find((candidate) => candidate.instanceId === instanceId);
  if (provider === undefined) {
    return {
      ok: false,
      reason: `Provider '${instanceId}' is not available. Available: ${selectable.map((candidate) => candidate.instanceId).join(", ") || "none"}.`,
    };
  }

  const requestedSlug = request.model?.trim();
  let slug = requestedSlug;
  if (slug === undefined || slug === "") {
    if (input.seedFallback) {
      slug = seedModelFor(provider, input.seedOverride)?.model;
    } else {
      slug = instanceId === base.instanceId ? base.model : undefined;
    }
  }
  if (slug === undefined || slug === "") {
    return {
      ok: false,
      reason: `Name a model for '${instanceId}'. Models: ${listModels(provider)}.`,
    };
  }
  const model = provider.models.find(
    (candidate) => candidate.slug === slug || candidate.aliases?.includes(slug) === true,
  );
  if (model === undefined) {
    return {
      ok: false,
      reason: `'${slug}' is not a model '${instanceId}' offers. Models: ${listModels(provider)}.`,
    };
  }

  const descriptor = effortDescriptor(model);
  const sameModel =
    !input.seedFallback && base.instanceId === instanceId && base.model === model.slug;
  let options: ReadonlyArray<ProviderOptionSelection> | undefined;
  const requestedEffort = request.effort?.trim();
  if (requestedEffort !== undefined && requestedEffort !== "") {
    if (descriptor === undefined || descriptor.type !== "select") {
      return { ok: false, reason: `'${model.slug}' has no effort setting to choose.` };
    }
    if (!descriptor.options.some((option) => option.id === requestedEffort)) {
      return {
        ok: false,
        reason: `'${requestedEffort}' is not an effort '${model.slug}' offers. Efforts: ${descriptor.options.map((option) => option.id).join(", ")}.`,
      };
    }
    options = [{ id: descriptor.id, value: requestedEffort }];
  } else if (sameModel) {
    options = base.options === undefined ? undefined : normalizeOptions(base);
  } else if (descriptor !== undefined && descriptor.type === "select") {
    // A new model with no effort named starts at medium when it offers it.
    options = descriptor.options.some((option) => option.id === DEFAULT_NEW_MODEL_EFFORT)
      ? [{ id: descriptor.id, value: DEFAULT_NEW_MODEL_EFFORT }]
      : undefined;
  }

  const selection = {
    instanceId: provider.instanceId,
    model: model.slug,
    ...(options === undefined || options.length === 0 ? {} : { options }),
  } as ModelSelection;
  return { ok: true, selection, changed: !sameSelection(base, selection) };
}

const normalizeOptions = (selection: ModelSelection): ReadonlyArray<ProviderOptionSelection> =>
  EFFORT_OPTION_IDS.flatMap((id) => {
    const value = getModelSelectionStringOptionValue(selection, id);
    return value === undefined ? [] : [{ id, value }];
  });

const effortOf = (selection: ModelSelection): string | undefined => {
  for (const id of EFFORT_OPTION_IDS) {
    const value = getModelSelectionStringOptionValue(selection, id);
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
};

const sameSelection = (left: ModelSelection, right: ModelSelection): boolean =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  effortOf(left) === effortOf(right);

const EFFORT_ABBREVIATIONS: Readonly<Record<string, string>> = {
  low: "L",
  medium: "M",
  high: "H",
  xhigh: "X",
  max: "Max",
};

/** The picker's name without the "Claude" prefix, a plan word or a context-window suffix. */
const shortModelName = (name: string): string =>
  name
    .replace(/^Claude\s+/, "")
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    .replace(/\b(?:free|preview|beta)\b/gi, "")
    .replace(/\s+\d+(?:\.\d+)?[km](?:\s+context)?\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * "Sonnet 5.5 · H": the same short form the Bots list shows (the web's
 * `botModelShortLabel`, which reads the same provider lists). A model the
 * provider does not list keeps its raw id.
 */
export function leadBotModelLabel(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const listed = provider?.models.find((candidate) => candidate.slug === selection.model);
  const name =
    listed === undefined ? selection.model : shortModelName(listed.name) || selection.model;
  const effort = effortOf(selection);
  const abbreviation = effort === undefined ? undefined : EFFORT_ABBREVIATIONS[effort];
  return abbreviation === undefined ? name : `${name} · ${abbreviation}`;
}
