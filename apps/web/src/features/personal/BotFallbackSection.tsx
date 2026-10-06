import type { JSX } from "react";

import type { ServerProvider } from "@t3tools/contracts";

import { FIELD_CLASS, LABEL_CLASS, ModelSearchField } from "./BotModelFields";
import {
  botContextWindowDescriptor,
  botEffortDescriptor,
  defaultModelFor,
  type FallbackDraft,
  modelOptionLabel,
  sameFamilyFallbackHint,
  usesModelSearch,
} from "./botFormModel";
import { providerLine, resolveBotProvider } from "./botSummaries";

const HELP_CLASS = "mt-1.5 text-sm text-[var(--personal-text-secondary)]";

/**
 * "If the usage limit is hit, switch to: model, effort, context window", with
 * an on/off switch. The pickers follow the main model's rules: the same model
 * list per provider, and the effort and context window the chosen model offers.
 */
export function BotFallbackSection({
  draft,
  onChange,
  providers,
  providerOptions,
  main,
}: {
  readonly draft: FallbackDraft;
  readonly onChange: (patch: Partial<FallbackDraft>) => void;
  /** Every provider the client knows, to tell whether the fallback's one can run. */
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The providers the fallback may be on (the saved one stays listed). */
  readonly providerOptions: ReadonlyArray<ServerProvider>;
  /** The bot's main model, to tell a fallback on the same model family. */
  readonly main: { readonly instanceId: string; readonly model: string };
}): JSX.Element {
  const provider = providers.find((candidate) => candidate.instanceId === draft.instanceId);
  const providerStatus =
    draft.instanceId === "" ? null : resolveBotProvider(draft.instanceId, providers);
  const models = provider?.models ?? [];
  const effortDescriptor = botEffortDescriptor(provider, draft.model);
  const effortValue =
    effortDescriptor?.options.some((option) => option.id === draft.effort) === true
      ? draft.effort
      : "";
  const contextDescriptor = botContextWindowDescriptor(provider, draft.model);
  const contextValue =
    contextDescriptor?.options.some((option) => option.id === draft.contextWindow) === true
      ? draft.contextWindow
      : "";
  const sameFamilyHint = draft.enabled ? sameFamilyFallbackHint(main, draft) : null;

  return (
    <div
      role="group"
      aria-label="Usage limit fallback"
      data-testid="bot-fallback"
      className="flex flex-col gap-5 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4"
    >
      <label className="flex min-h-11 items-center gap-3 text-[15px] text-[var(--personal-text)]">
        <input
          type="checkbox"
          role="switch"
          checked={draft.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
          className="size-5 shrink-0"
        />
        <span className="min-w-0">
          Switch model when the usage limit is hit
          <span className="block text-sm text-[var(--personal-text-secondary)]">
            The bot keeps replying on this model until its own limit resets, then goes back.
          </span>
        </span>
      </label>

      {draft.enabled ? (
        <>
          <div>
            <label htmlFor="bot-fallback-provider" className={LABEL_CLASS}>
              Fallback provider
            </label>
            <select
              id="bot-fallback-provider"
              value={draft.instanceId}
              onChange={(event) => {
                const next = providers.find(
                  (candidate) => candidate.instanceId === event.target.value,
                );
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
              {providerOptions.map((candidate) => (
                <option key={candidate.instanceId} value={candidate.instanceId}>
                  {providerLine(resolveBotProvider(candidate.instanceId, providers))}
                </option>
              ))}
            </select>
            {providerStatus !== null && !providerStatus.available ? (
              <p className={HELP_CLASS}>
                {providerStatus.label} can't run right now, so the bot can't switch to it.
              </p>
            ) : null}
          </div>

          {models.length > 0 ? (
            <div>
              <label htmlFor="bot-fallback-model" className={LABEL_CLASS}>
                Fallback model
              </label>
              {usesModelSearch(models) ? (
                <ModelSearchField
                  id="bot-fallback-model"
                  models={models}
                  value={draft.model}
                  onChange={(slug) => onChange({ model: slug })}
                />
              ) : (
                <select
                  id="bot-fallback-model"
                  value={draft.model}
                  onChange={(event) => onChange({ model: event.target.value })}
                  className={`${FIELD_CLASS} h-11`}
                >
                  {models.some((model) => model.slug === draft.model) ? null : (
                    <option value={draft.model}>{draft.model}</option>
                  )}
                  {models.map((model) => (
                    <option key={model.slug} value={model.slug}>
                      {modelOptionLabel(model)}
                    </option>
                  ))}
                </select>
              )}
              {sameFamilyHint !== null ? (
                <p data-testid="bot-fallback-same-family" className={HELP_CLASS}>
                  {sameFamilyHint}
                </p>
              ) : null}
            </div>
          ) : (
            <p className={HELP_CLASS}>
              {draft.model === ""
                ? "This provider lists no models yet."
                : `Fallback model: ${draft.model}`}
            </p>
          )}

          {effortDescriptor !== null ? (
            <div>
              <label htmlFor="bot-fallback-effort" className={LABEL_CLASS}>
                Fallback effort
              </label>
              <select
                id="bot-fallback-effort"
                value={effortValue}
                onChange={(event) => onChange({ effort: event.target.value })}
                className={`${FIELD_CLASS} h-11`}
              >
                <option value="">
                  Default
                  {(() => {
                    const standard = effortDescriptor.options.find((option) => option.isDefault);
                    return standard === undefined ? "" : ` (${standard.label})`;
                  })()}
                </option>
                {effortDescriptor.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {contextDescriptor !== null ? (
            <div>
              <label htmlFor="bot-fallback-context-window" className={LABEL_CLASS}>
                Fallback context window
              </label>
              <select
                id="bot-fallback-context-window"
                value={contextValue}
                onChange={(event) => onChange({ contextWindow: event.target.value })}
                className={`${FIELD_CLASS} h-11`}
              >
                <option value="">
                  Default
                  {(() => {
                    const standard = contextDescriptor.options.find((option) => option.isDefault);
                    return standard === undefined ? "" : ` (${standard.label})`;
                  })()}
                </option>
                {contextDescriptor.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
