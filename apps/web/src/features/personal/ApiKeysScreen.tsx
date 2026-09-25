import type { FormEvent, JSX } from "react";
import { useRef, useState } from "react";

import { Link } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { ChevronLeft, Plus } from "lucide-react";

import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { usePersonalEnvironmentId } from "./usePersonalBots";
import {
  personalSecretCreate,
  personalSecretSetSharing,
  useSavedSecrets,
} from "./useSecretRequests";

/** The shape a bot reads as `PB_SECRET_<NAME>`; anything else is a key nothing looks for. */
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function secretNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the key a name.";
  if (!SECRET_NAME_PATTERN.test(trimmed)) {
    return "Use capitals, digits and underscores, starting with a letter: OPENWEATHER_API_KEY.";
  }
  return null;
}

const FIELD_CLASS =
  "h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-[var(--personal-text)]";

function ApiKeyForm({ onDone }: { onDone: () => void }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const createSecret = useAtomCommand(personalSecretCreate, { reportFailure: false });
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  // Component state only. The composer draft store is per-device and
  // unencrypted, so the value never reaches it; this string lives until the
  // form closes or the key is saved.
  const [value, setValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (environmentId === null || busy) return;
    const problem = secretNameProblem(name);
    const missingValue = value.length === 0 ? "Paste the key's value." : null;
    setNameError(problem);
    setValueError(missingValue);
    const firstError =
      problem !== null ? nameRef.current : missingValue !== null ? valueRef.current : null;
    if (problem !== null || missingValue !== null) {
      firstError?.focus();
      firstError?.scrollIntoView({ block: "center" });
      return;
    }
    setSubmitError(null);
    setBusy(true);
    const result = await createSecret({
      environmentId,
      input: {
        name: name.trim(),
        label: label.trim(),
        value: Redacted.make(value),
        shared: true,
      },
    });
    setBusy(false);
    const failure = commandFailureMessage(result, "Could not save this key. Try again.");
    setSubmitError(failure);
    if (failure === null) onDone();
  };

  return (
    <form
      aria-label="Add API key"
      onSubmit={(event) => void onSubmit(event)}
      className="mt-5 flex flex-col gap-5 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4"
      noValidate
    >
      <h2 className="text-[17px] font-bold text-[var(--personal-text)]">Add API key</h2>

      <div>
        <label htmlFor="api-key-name" className={LABEL_CLASS}>
          Name
        </label>
        <input
          ref={nameRef}
          id="api-key-name"
          value={name}
          disabled={busy}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="OPENWEATHER_API_KEY"
          aria-invalid={nameError !== null}
          aria-describedby={
            nameError === null ? "api-key-name-help" : "api-key-name-help api-key-name-error"
          }
          onChange={(event) => {
            setName(event.target.value.toUpperCase());
            setNameError(null);
          }}
          className={FIELD_CLASS}
        />
        <p id="api-key-name-help" className="mt-1.5 text-sm text-[var(--personal-text-secondary)]">
          Bots read this key as PB_SECRET_{name.trim() || "NAME"}, so it has to match the name the
          bot looks for.
        </p>
        {nameError === null ? null : (
          <p
            id="api-key-name-error"
            role="alert"
            className="mt-1.5 text-sm text-[var(--personal-error)]"
          >
            {nameError}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="api-key-label" className={LABEL_CLASS}>
          Label (optional)
        </label>
        <input
          id="api-key-label"
          value={label}
          disabled={busy}
          autoComplete="off"
          placeholder="What you call it in this list"
          onChange={(event) => setLabel(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      <div>
        <label htmlFor="api-key-value" className={LABEL_CLASS}>
          Value
        </label>
        <input
          ref={valueRef}
          id="api-key-value"
          type="password"
          value={value}
          disabled={busy}
          // No autofill and no spellcheck upload: this belongs to the
          // laptop's secret store, not to the phone's keychain.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-invalid={valueError !== null}
          aria-describedby={
            valueError === null ? "api-key-value-help" : "api-key-value-help api-key-value-error"
          }
          onChange={(event) => {
            setValue(event.target.value);
            setValueError(null);
          }}
          className={FIELD_CLASS}
        />
        <p id="api-key-value-help" className="mt-1.5 text-sm text-[var(--personal-text-secondary)]">
          Saved on your computer and given to every bot as an environment variable. It is never
          shown in a chat.
        </p>
        {valueError === null ? null : (
          <p
            id="api-key-value-error"
            role="alert"
            className="mt-1.5 text-sm text-[var(--personal-error)]"
          >
            {valueError}
          </p>
        )}
      </div>

      {submitError === null ? null : (
        <p role="alert" className="text-sm text-[var(--personal-error)]">
          {submitError}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="h-11 flex-1 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[15px] font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="h-11 flex-1 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save key"}
        </button>
      </div>
    </form>
  );
}

/** /bots/settings/api-keys: saved API keys and which bots may use them. */
export function ApiKeysScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = useSavedSecrets(environmentId);
  const setSharing = useAtomCommand(personalSecretSetSharing, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const secrets = list.data?.secrets ?? [];

  const onToggleShared = async (name: string, shared: boolean) => {
    if (environmentId === null || busy !== null) return;
    setBusy(name);
    const result = await setSharing({ environmentId, input: { name, shared } });
    setBusy(null);
    setError(commandFailureMessage(result, "Could not change key access. Try again."));
  };

  const startAdding = () => {
    setError(null);
    setAdding(true);
  };

  return (
    <div className="flex flex-col px-5 pb-8">
      <header className="flex h-14 items-center gap-1">
        <Link
          to="/bots/settings"
          aria-label="Back to Settings"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1 className="min-w-0 flex-1 text-[19px] font-bold text-[var(--personal-text)]">
          API keys
        </h1>
        <button
          type="button"
          onClick={startAdding}
          disabled={environmentId === null}
          aria-label="Add API key"
          className="flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
        >
          <Plus aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </button>
      </header>

      <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
        Keys bots use for outside services, like Tavily and SerpApi. All bots lets every bot use a
        saved key, including bots in other teams; otherwise only the bots that requested it can.
      </p>
      <p className="mt-2 text-[14px] leading-snug text-[var(--personal-text-secondary)]">
        Turning sharing off applies to new sessions; running sessions may already have the key.
      </p>

      {(error ?? list.error) === null ? null : (
        <p role="alert" className="mt-3 text-sm text-[var(--personal-error)]">
          {error ?? String(list.error)}
        </p>
      )}

      {list.data === null ? (
        list.error === null ? (
          <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">Loading…</p>
        ) : null
      ) : secrets.length === 0 ? (
        adding ? null : (
          <div className="mt-10 flex flex-col items-center gap-3 text-center">
            <p className="text-lg font-semibold text-[var(--personal-text)]">No API keys yet</p>
            <p className="max-w-[300px] text-[15px] leading-snug text-[var(--personal-text-secondary)]">
              Add one here, or ask a bot to set one up when it needs it.
            </p>
            <button
              type="button"
              onClick={startAdding}
              className="mt-2 flex h-11 items-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]"
            >
              Add an API key
            </button>
          </div>
        )
      ) : (
        <ul className="mt-4 divide-y divide-[var(--personal-border)] overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]">
          {secrets.map((secret) => (
            <li key={secret.name} className="flex min-h-16 items-center">
              <div className="min-w-0 flex-1 px-4 py-3">
                <span className="block truncate text-[15px] font-semibold text-[var(--personal-text)]">
                  {secret.label}
                </span>
                <span className="block break-all text-[13px] text-[var(--personal-text-secondary)]">
                  {secret.name}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={secret.shared}
                aria-label={`Allow all bots to use ${secret.name}`}
                disabled={busy !== null}
                onClick={() => void onToggleShared(secret.name, !secret.shared)}
                className="mr-2 flex h-11 shrink-0 items-center gap-2 px-2 text-[13px] text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
              >
                <span aria-hidden="true">All bots</span>
                <span
                  aria-hidden="true"
                  className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-[var(--personal-border)] ${secret.shared ? "bg-[var(--personal-primary)]" : "bg-[var(--personal-fill-muted)]"}`}
                >
                  <span
                    className={`inline-block size-5 rounded-full bg-[var(--personal-surface)] shadow ${secret.shared ? "translate-x-[16px]" : "translate-x-0.5"}`}
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? <ApiKeyForm onDone={() => setAdding(false)} /> : null}
    </div>
  );
}
