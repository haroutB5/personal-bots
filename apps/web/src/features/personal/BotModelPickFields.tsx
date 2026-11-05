import type { JSX, ReactNode } from "react";

import type { ServerProvider } from "@t3tools/contracts";

import { FIELD_CLASS, LABEL_CLASS, ModelSearchField } from "./BotModelFields";
import {
  descriptorChoices,
  descriptorValue,
  modelChoices,
  providerChoices,
} from "@hbots/personal-client/bots/botFormFields";

import {
  botContextWindowDescriptor,
  botEffortDescriptor,
  defaultModelFor,
  type ModelDraft,
  usesModelSearch,
} from "./botFormModel";
import { resolveBotProvider } from "./botSummaries";

export const MODEL_PICK_HELP_CLASS = "mt-1.5 text-sm text-[var(--personal-text-secondary)]";

/**
 * The provider, model, effort and context window pickers of a secondary model
 * choice: the usage-limit fallback and the model schedule use the same ones, so
 * both follow the main model's rules (the model list per provider, and the
 * effort and context window the chosen model offers). Ids read
 * `<idPrefix>-provider`, `-model`, `-effort` and `-context-window`; labels
 * `<labelPrefix> provider` and so on.
 */
export function BotModelPickFields({
  idPrefix,
  labelPrefix,
  draft,
  onChange,
  providers,
  providerOptions,
  unavailableNote,
  modelNote,
}: {
  readonly idPrefix: string;
  readonly labelPrefix: string;
  readonly draft: Pick<ModelDraft, "instanceId" | "model" | "effort" | "contextWindow">;
  readonly onChange: (
    patch: Partial<Pick<ModelDraft, "instanceId" | "model" | "effort" | "contextWindow">>,
  ) => void;
  /** Every provider the client knows, to tell whether the chosen one can run. */
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The providers that may be picked (the saved one stays listed). */
  readonly providerOptions: ReadonlyArray<ServerProvider>;
  /** What to say when the chosen provider cannot run right now. */
  readonly unavailableNote: (providerLabel: string) => string;
  /** A muted hint under the model picker, e.g. the same-family one. */
  readonly modelNote?: ReactNode;
}): JSX.Element {
  const provider = providers.find((candidate) => candidate.instanceId === draft.instanceId);
  const providerStatus =
    draft.instanceId === "" ? null : resolveBotProvider(draft.instanceId, providers);
  const models = provider?.models ?? [];
  const effortDescriptor = botEffortDescriptor(provider, draft.model);
  const effortValue = descriptorValue(effortDescriptor, draft.effort);
  const contextDescriptor = botContextWindowDescriptor(provider, draft.model);
  const contextValue = descriptorValue(contextDescriptor, draft.contextWindow);

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-provider`} className={LABEL_CLASS}>
          {labelPrefix} provider
        </label>
        <select
          id={`${idPrefix}-provider`}
          value={draft.instanceId}
          onChange={(event) => {
            const next = providers.find((candidate) => candidate.instanceId === event.target.value);
            onChange({
              instanceId: event.target.value,
              model: defaultModelFor(next),
              effort: "",
              contextWindow: "",
            });
          }}
          className={`${FIELD_CLASS} h-11`}
        >
          {draft.instanceId === "" ? <option value="">Pick a provider</option> : null}
          {providerChoices(providerOptions, providers).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {providerStatus !== null && !providerStatus.available ? (
          <p className={MODEL_PICK_HELP_CLASS}>{unavailableNote(providerStatus.label)}</p>
        ) : null}
      </div>

      {models.length > 0 ? (
        <div>
          <label htmlFor={`${idPrefix}-model`} className={LABEL_CLASS}>
            {labelPrefix} model
          </label>
          {usesModelSearch(models) ? (
            <ModelSearchField
              id={`${idPrefix}-model`}
              models={models}
              value={draft.model}
              onChange={(slug) => onChange({ model: slug })}
            />
          ) : (
            <select
              id={`${idPrefix}-model`}
              value={draft.model}
              onChange={(event) => onChange({ model: event.target.value })}
              className={`${FIELD_CLASS} h-11`}
            >
              {modelChoices(models, draft.model).map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          )}
          {modelNote}
        </div>
      ) : (
        <p className={MODEL_PICK_HELP_CLASS}>
          {draft.model === ""
            ? "This provider lists no models yet."
            : `${labelPrefix} model: ${draft.model}`}
        </p>
      )}

      {effortDescriptor !== null ? (
        <div>
          <label htmlFor={`${idPrefix}-effort`} className={LABEL_CLASS}>
            {labelPrefix} effort
          </label>
          <select
            id={`${idPrefix}-effort`}
            value={effortValue}
            onChange={(event) => onChange({ effort: event.target.value })}
            className={`${FIELD_CLASS} h-11`}
          >
            {descriptorChoices(effortDescriptor).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {contextDescriptor !== null ? (
        <div>
          <label htmlFor={`${idPrefix}-context-window`} className={LABEL_CLASS}>
            {labelPrefix} context window
          </label>
          <select
            id={`${idPrefix}-context-window`}
            value={contextValue}
            onChange={(event) => onChange({ contextWindow: event.target.value })}
            className={`${FIELD_CLASS} h-11`}
          >
            {descriptorChoices(contextDescriptor).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </>
  );
}
