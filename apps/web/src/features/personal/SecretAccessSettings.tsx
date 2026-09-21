import { useId, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { Plus } from "lucide-react";
import { useAtomCommand } from "~/state/use-atom-command";
import { commandFailureMessage } from "./commandFeedback";
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
  "mt-1 h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 text-[16px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";
const FORM_BUTTON_CLASS =
  "h-11 rounded-[var(--personal-radius-button)] px-3.5 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

export function SecretAccessSettings({ environmentId }: { environmentId: EnvironmentId | null }) {
  const list = useSavedSecrets(environmentId);
  const setSharing = useAtomCommand(personalSecretSetSharing, { reportFailure: false });
  const createSecret = useAtomCommand(personalSecretCreate, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  // Component state only. The composer draft store is per-device and
  // unencrypted, so the value never reaches it; this string lives until the
  // form closes or the key is saved.
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const nameFieldId = useId();
  const valueFieldId = `${nameFieldId}-value`;
  const labelFieldId = `${nameFieldId}-label`;
  const nameHelpId = `${nameFieldId}-help`;

  const closeForm = () => {
    setAdding(false);
    setName("");
    setLabel("");
    setValue("");
  };

  const save = async () => {
    if (environmentId === null || saving) return;
    const problem = secretNameProblem(name);
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (value.length === 0) {
      setError("Paste the key's value.");
      return;
    }
    setSaving(true);
    const result = await createSecret({
      environmentId,
      input: {
        name: name.trim(),
        label: label.trim(),
        value: Redacted.make(value),
        shared: true,
      },
    });
    const failure = commandFailureMessage(result, "Could not save this key. Try again.");
    setError(failure);
    setSaving(false);
    if (failure === null) closeForm();
  };
  const change = async (name: string, shared: boolean) => {
    if (environmentId === null || busy !== null) return;
    setBusy(name);
    const result = await setSharing({ environmentId, input: { name, shared } });
    setError(commandFailureMessage(result, "Could not change key access. Try again."));
    setBusy(null);
  };
  return (
    <section aria-labelledby="settings-api-keys">
      <h2
        id="settings-api-keys"
        className="mb-2 px-1 text-[13px] font-semibold tracking-wide text-[var(--personal-section-label)] uppercase"
      >
        API keys
      </h2>
      <p className="mb-2 text-[13px] text-[var(--personal-text-secondary)]">
        Allow all bots to use a saved key, including bots in other teams. Turning sharing off
        applies to new sessions; running sessions may already have the key.
      </p>
      <div className="divide-y divide-[var(--personal-border)] overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]">
        {(list.data?.secrets ?? []).map((secret) => (
          <label key={secret.name} className="flex min-h-16 items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block break-words text-[15px] font-semibold text-[var(--personal-text)]">
                {secret.label}
              </span>
              <span className="block break-all text-[13px] text-[var(--personal-text-secondary)]">
                {secret.name}
              </span>
              <span className="block text-[13px] text-[var(--personal-text-secondary)]">
                {secret.shared ? "All bots" : "Requesting bots only"}
              </span>
            </span>
            <input
              type="checkbox"
              aria-label={`Allow all bots to use ${secret.name}`}
              checked={secret.shared}
              disabled={busy !== null}
              onChange={(event) => void change(secret.name, event.target.checked)}
              className="size-5"
            />
          </label>
        ))}
        {list.data?.secrets.length === 0 && !adding ? (
          <p className="p-4 text-sm text-[var(--personal-text-secondary)]">
            No saved API keys yet. Add one here, or ask a bot to set one up when it needs it.
          </p>
        ) : null}
        {adding ? (
          <div className="flex flex-col gap-3 p-4">
            <div>
              <label
                htmlFor={nameFieldId}
                className="block text-[13px] text-[var(--personal-text)]"
              >
                Name
              </label>
              <input
                id={nameFieldId}
                value={name}
                disabled={saving}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="OPENWEATHER_API_KEY"
                aria-describedby={nameHelpId}
                onChange={(event) => setName(event.target.value.toUpperCase())}
                className={FIELD_CLASS}
              />
              <p id={nameHelpId} className="mt-1 text-[13px] text-[var(--personal-text-secondary)]">
                Bots read this key as PB_SECRET_{name.trim() || "NAME"}, so it has to match the name
                the bot looks for.
              </p>
            </div>
            <div>
              <label
                htmlFor={labelFieldId}
                className="block text-[13px] text-[var(--personal-text)]"
              >
                Label (optional)
              </label>
              <input
                id={labelFieldId}
                value={label}
                disabled={saving}
                placeholder="What you call it in this list"
                onChange={(event) => setLabel(event.target.value)}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label
                htmlFor={valueFieldId}
                className="block text-[13px] text-[var(--personal-text)]"
              >
                Value
              </label>
              <input
                id={valueFieldId}
                type="password"
                value={value}
                disabled={saving}
                // No autofill and no spellcheck upload: this belongs to the
                // laptop's secret store, not to the phone's keychain.
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(event) => setValue(event.target.value)}
                className={FIELD_CLASS}
              />
              <p className="mt-1 text-[13px] text-[var(--personal-text-secondary)]">
                Saved on your computer and given to every bot as an environment variable. It is
                never shown in a chat.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={closeForm}
                className={`${FORM_BUTTON_CLASS} text-[var(--personal-text-secondary)]`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className={`${FORM_BUTTON_CLASS} bg-[var(--personal-text)] text-[var(--personal-surface)]`}
              >
                {saving ? "Saving…" : "Save key"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={environmentId === null}
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
            className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left text-[15px] font-medium text-[var(--personal-text)] disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="size-5 shrink-0" strokeWidth={2} />
            Add API key
          </button>
        )}
        {list.data === null && list.error === null ? (
          <p className="p-4 text-sm text-[var(--personal-text-secondary)]">Loading saved keys…</p>
        ) : null}
      </div>
      {(error ?? list.error) ? (
        <p role="alert" className="mt-2 text-sm text-[var(--personal-error)]">
          {error ?? String(list.error)}
        </p>
      ) : null}
    </section>
  );
}
