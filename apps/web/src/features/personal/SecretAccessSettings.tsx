import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";
import { commandFailureMessage } from "./commandFeedback";
import { personalSecretSetSharing, useSavedSecrets } from "./useSecretRequests";

export function SecretAccessSettings({ environmentId }: { environmentId: EnvironmentId | null }) {
  const list = useSavedSecrets(environmentId);
  const setSharing = useAtomCommand(personalSecretSetSharing, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        {list.data?.secrets.length === 0 ? (
          <p className="p-4 text-sm text-[var(--personal-text-secondary)]">
            No saved API keys. Ask a bot to set one up through a secure form.
          </p>
        ) : null}
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
