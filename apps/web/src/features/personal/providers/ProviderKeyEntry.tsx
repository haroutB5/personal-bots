import type { JSX } from "react";
import { useState } from "react";

import type {
  ProviderInstanceEnvironmentVariable,
  ServerProviderUsageBalance,
} from "@t3tools/contracts";
import { ExternalLink } from "lucide-react";

import {
  hasSavedProviderApiKey,
  providerApiKeyCheckLine,
  withProviderApiKey,
  withoutProviderApiKey,
  type ProviderApiKeyField,
} from "~/components/settings/providerApiKeys";

import {
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  BUTTON_QUIET,
  CardRow,
  FIELD,
  ProviderNote,
} from "./providerUi";

/**
 * A provider's API key, typed into this field only. Saving writes the same
 * sensitive entry the desktop key field writes: the server encrypts it, never
 * sends it back, and bots never see it. Once saved the row says so and offers
 * Replace and Remove (the Voice calls key pattern). No value is kept anywhere
 * but this component's own state, and that is cleared on save.
 */
export function ProviderKeyEntry({
  field,
  environment,
  enabled,
  balance,
  readOnly = false,
  mode,
  onChange,
  onSaved,
}: {
  readonly field: ProviderApiKeyField;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly enabled: boolean;
  readonly balance: ServerProviderUsageBalance | undefined;
  readonly readOnly?: boolean;
  /** `setup`: step 2 of the setup card. `account`: the Account card of an installed page. */
  readonly mode: "setup" | "account";
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
  /** After a key was saved: the page asks the provider to check it. */
  readonly onSaved?: () => void;
}): JSX.Element {
  const saved = hasSavedProviderApiKey(environment, field);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [savedAtMs, setSavedAtMs] = useState<number | null>(null);
  const editing = replacing || !saved;
  const check = providerApiKeyCheckLine({ field, balance, savedAtMs, enabled });

  const save = () => {
    const value = draft.trim();
    if (value.length === 0 || readOnly) return;
    onChange(withProviderApiKey(environment, field, value));
    setDraft("");
    setRevealed(false);
    setReplacing(false);
    setSavedAtMs(Date.now());
    onSaved?.();
  };
  const remove = () => {
    if (readOnly) return;
    onChange(withoutProviderApiKey(environment, field));
    setDraft("");
    setReplacing(false);
    setSavedAtMs(null);
  };

  const rejected = check?.tone === "rejected";

  if (!editing) {
    return (
      <div data-key-state="saved">
        {rejected ? (
          <div className="px-4 pt-3">
            <ProviderNote
              tone="danger"
              title={`${field.displayName} didn't accept this key`}
              actions={
                <button type="button" onClick={() => setReplacing(true)} className={BUTTON_PRIMARY}>
                  Replace key
                </button>
              }
            >
              Check you copied all of it, or make a new one at {field.keysUrlLabel}.
            </ProviderNote>
          </div>
        ) : null}
        <CardRow
          title={field.label}
          hint="Saved · never shown again"
          control={
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                disabled={readOnly}
                onClick={() => setReplacing(true)}
                className={BUTTON_OUTLINE}
              >
                Replace
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={remove}
                className={`${BUTTON_QUIET} text-[var(--personal-error)]`}
              >
                Remove
              </button>
            </div>
          }
        />
        {check !== null ? (
          <p
            role="status"
            data-tone={check.tone}
            className={`px-4 pb-3 text-[13px] leading-[18px] ${
              check.tone === "ok"
                ? "text-[var(--personal-live)]"
                : check.tone === "empty"
                  ? "text-[var(--personal-review-text)]"
                  : "text-[var(--personal-text-secondary)]"
            }`}
          >
            {check.text}
            {check.topUpUrl !== undefined ? (
              <>
                {" "}
                <a
                  href={check.topUpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-2"
                >
                  Top up
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={mode === "account" ? "px-4 py-3" : ""} data-key-state="editing">
      <p className="text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
        Make a key at {field.keysUrlLabel} under API keys, then paste it here.
      </p>
      <a
        href={field.keysUrl}
        target="_blank"
        rel="noreferrer"
        className={`${BUTTON_OUTLINE} mt-3 w-full gap-2`}
      >
        <ExternalLink aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
        Open {field.keysUrlLabel}
      </a>
      <label
        htmlFor="provider-key-field"
        className="mt-4 mb-1.5 block text-sm font-medium text-[var(--personal-text)]"
      >
        {field.label}
      </label>
      <div className="flex gap-2">
        <input
          id="provider-key-field"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            save();
          }}
          type={revealed ? "text" : "password"}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={field.placeholder}
          disabled={readOnly}
          className={`${FIELD} flex-1 font-mono text-[14px]`}
        />
        <button
          type="button"
          aria-pressed={revealed}
          aria-label={revealed ? `Hide ${field.label}` : `Show ${field.label}`}
          onClick={() => setRevealed((previous) => !previous)}
          className={BUTTON_OUTLINE}
        >
          {revealed ? "Hide" : "Show"}
        </button>
      </div>
      <p className="mt-2 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
        Saved encrypted on your laptop and never shown again. Bots never see it.
      </p>
      {check !== null && check.tone === "pending" ? (
        <p role="status" className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">
          {check.text}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={readOnly || draft.trim().length === 0}
          className={`${BUTTON_PRIMARY} flex-1`}
        >
          Save key
        </button>
        {saved ? (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setReplacing(false);
            }}
            className={BUTTON_OUTLINE}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
