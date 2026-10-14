/**
 * One provider's API key, as a real settings field.
 *
 * The owner sees a labelled, masked input instead of a `VARIABLE_NAME=value`
 * row: saving writes the same sensitive environment entry the hand-typed setup
 * used, so the server keeps redacting it and the encrypted secret store keeps
 * the value. Once saved the row says only that a key is saved — never the
 * value, nor any part of it — with Replace and Remove beside it.
 *
 * @module components/settings/ProviderApiKeyRow
 */
import type {
  ProviderInstanceEnvironmentVariable,
  ServerProviderUsageBalance,
} from "@t3tools/contracts";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import {
  hasSavedProviderApiKey,
  providerApiKeyCheckLine,
  providerApiKeyEntry,
  providerApiKeyField,
  withProviderApiKey,
  withoutProviderApiKey,
  type ProviderApiKeyField,
} from "./providerApiKeys";

export interface ProviderApiKeyRowProps {
  /** The instance's driver kind; only drivers with a field render anything. */
  readonly driver: string;
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  /** The instance's balance reading, when the provider publishes one. */
  readonly balance: ServerProviderUsageBalance | undefined;
  readonly readOnly: boolean;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}

/**
 * A provider whose key is the only way in opens the field by itself, so a
 * first-time setup is one paste rather than a hunt through Variables. A
 * provider that also accepts a login (Grok) keeps it closed until asked.
 */
export function ProviderApiKeyRow(props: ProviderApiKeyRowProps): ReactElement | null {
  const field = providerApiKeyField(props.driver);
  if (field === undefined) return null;
  return <ProviderApiKeyRowInner {...props} field={field} />;
}

function ProviderApiKeyRowInner(
  props: ProviderApiKeyRowProps & { readonly field: ProviderApiKeyField },
) {
  const { field } = props;
  const saved = hasSavedProviderApiKey(props.environment, field);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [savedAtMs, setSavedAtMs] = useState<number | null>(null);

  // A key typed into the Variables row before this field existed may sit in
  // settings.json in plain text (not sensitive). Move it into the secret store
  // once, silently: the same value goes back marked sensitive, the server
  // encrypts it and the file keeps only the redacted marker. It converges —
  // after the write the entry is redacted, so its value is empty here.
  const plainEntry = providerApiKeyEntry(props.environment, field);
  const plainValue =
    plainEntry !== undefined && plainEntry.sensitive !== true ? plainEntry.value : "";
  const { onChange, readOnly, environment } = props;
  useEffect(() => {
    if (readOnly || plainValue.length === 0) return;
    onChange(withProviderApiKey(environment, field, plainValue));
  }, [environment, field, onChange, plainValue, readOnly]);

  // A required key opens by itself: that is the first-time flow, and the input
  // takes focus. An optional one (a provider that also accepts a login) stays
  // closed behind Add key until the owner asks for it.
  const editing = replacing || (!saved && field.required);
  const inputId = `provider-api-key-${props.instanceId}`;

  const save = () => {
    const value = draft.trim();
    if (value.length === 0 || props.readOnly) return;
    props.onChange(withProviderApiKey(props.environment, field, value));
    setDraft("");
    setRevealed(false);
    setReplacing(false);
    setSavedAtMs(Date.now());
  };

  const remove = () => {
    if (props.readOnly) return;
    props.onChange(withoutProviderApiKey(props.environment, field));
    setDraft("");
    setRevealed(false);
    setReplacing(false);
    setSavedAtMs(null);
  };

  const keysLink = (
    <a
      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
      href={field.keysUrl}
      rel="noreferrer"
      target="_blank"
    >
      {field.keysUrlLabel}
    </a>
  );

  const keysFrom = <>Keys come from {keysLink}.</>;
  const description = !saved ? (
    <>
      {field.emptyDescription} {keysFrom}
    </>
  ) : editing ? (
    <>Enter a new key to replace the saved one. {keysFrom}</>
  ) : (
    <>Saved. The value stays on the server and is never shown again.</>
  );

  const check = providerApiKeyCheckLine({
    field,
    balance: props.balance,
    savedAtMs,
    enabled: props.enabled,
  });
  const checkClassName =
    check?.tone === "ok"
      ? "text-success"
      : check?.tone === "rejected"
        ? "text-destructive"
        : check?.tone === "empty"
          ? "text-warning"
          : undefined;

  const control = editing ? (
    <div className="flex w-full min-w-0 flex-col gap-2 @min-[32rem]/settings-row:w-72">
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          id={inputId}
          aria-label={field.label}
          autoComplete="new-password"
          autoFocus={field.required}
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            save();
          }}
          placeholder={field.placeholder}
          size="sm"
          spellCheck={false}
          type={revealed ? "text" : "password"}
          value={draft}
        />
        <Button
          aria-label={revealed ? `Hide ${field.label}` : `Show ${field.label}`}
          aria-pressed={revealed}
          onClick={() => setRevealed((previous) => !previous)}
          size="sm"
          type="button"
          variant="ghost-muted"
        >
          {revealed ? "Hide" : "Show"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          disabled={props.readOnly || draft.trim().length === 0}
          onClick={save}
          size="sm"
          type="button"
          variant="outline"
        >
          Save key
        </Button>
        {saved ? (
          <Button
            onClick={() => {
              setDraft("");
              setRevealed(false);
              setReplacing(false);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  ) : saved ? (
    <div className="flex items-center gap-1.5">
      <Button
        disabled={props.readOnly}
        onClick={() => setReplacing(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        Replace
      </Button>
      <Button
        disabled={props.readOnly}
        onClick={remove}
        size="sm"
        type="button"
        variant="ghost-destructive"
      >
        Remove
      </Button>
    </div>
  ) : (
    <Button
      disabled={props.readOnly}
      onClick={() => setReplacing(true)}
      size="sm"
      type="button"
      variant="outline"
    >
      Add key
    </Button>
  );

  return (
    <SettingsRow
      title={field.label}
      description={description}
      status={
        check ? (
          <span role="status" className={checkClassName} data-tone={check.tone}>
            {check.text}
            {check.topUpUrl !== undefined ? (
              <>
                {" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href={check.topUpUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Top up
                </a>
              </>
            ) : null}
          </span>
        ) : undefined
      }
      control={control}
    />
  );
}
