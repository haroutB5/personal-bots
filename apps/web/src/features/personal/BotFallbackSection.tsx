import type { JSX } from "react";

import type { ServerProvider } from "@t3tools/contracts";

import { BotModelPickFields, MODEL_PICK_HELP_CLASS } from "./BotModelPickFields";
import { type FallbackDraft, sameFamilyFallbackHint } from "./botFormModel";

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
        <BotModelPickFields
          idPrefix="bot-fallback"
          labelPrefix="Fallback"
          draft={draft}
          onChange={onChange}
          providers={providers}
          providerOptions={providerOptions}
          unavailableNote={(label) =>
            `${label} can't run right now, so the bot can't switch to it.`
          }
          modelNote={
            sameFamilyHint === null ? null : (
              <p data-testid="bot-fallback-same-family" className={MODEL_PICK_HELP_CLASS}>
                {sameFamilyHint}
              </p>
            )
          }
        />
      ) : null}
    </div>
  );
}
