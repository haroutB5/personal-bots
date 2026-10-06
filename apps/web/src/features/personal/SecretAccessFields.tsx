import type { JSX } from "react";
import { useId } from "react";

import {
  PERSONAL_SECRET_MAX_ORIGINS,
  normalizePersonalSecretOrigins,
  type PersonalSecretMode,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";

/** What the owner chose for how a bot may use a key. */
export interface SecretAccessChoice {
  readonly mode: PersonalSecretMode;
  /** Canonical origins; empty for an environment variable. */
  readonly origins: ReadonlyArray<string>;
}

export interface SecretAccessState {
  readonly mode: PersonalSecretMode;
  /** What is typed in the address box: one address, or several separated by spaces or commas. */
  readonly originsText: string;
}

const splitOrigins = (text: string): ReadonlyArray<string> =>
  text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/** The state a form starts in: brokered, with the address a bot asked for (if any). */
export const initialSecretAccess = (origins: ReadonlyArray<string> = []): SecretAccessState => ({
  mode: "brokered",
  originsText: origins.join(", "),
});

/** Why the choice cannot be saved yet, or null when it can. */
export function secretAccessProblem(state: SecretAccessState): string | null {
  if (state.mode === "env") return null;
  const entries = splitOrigins(state.originsText);
  if (entries.length === 0) {
    return "Enter the address this key may be sent to, like https://api.vercel.com.";
  }
  if (entries.length > PERSONAL_SECRET_MAX_ORIGINS) {
    return `At most ${PERSONAL_SECRET_MAX_ORIGINS} addresses.`;
  }
  if (normalizePersonalSecretOrigins(entries) === null) {
    return "Use a public https:// address such as https://api.vercel.com (no IP addresses or localhost).";
  }
  return null;
}

/** The choice to send to the server; call only when {@link secretAccessProblem} is null. */
export function secretAccessChoice(state: SecretAccessState): SecretAccessChoice {
  if (state.mode === "env") return { mode: "env", origins: [] };
  return {
    mode: "brokered",
    origins: normalizePersonalSecretOrigins(splitOrigins(state.originsText)) ?? [],
  };
}

const OPTION_CLASS =
  "flex min-h-11 w-full items-start gap-3 rounded-[var(--personal-radius-button)] border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";
const FIELD_CLASS =
  "h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] px-3 text-[16px] text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

/**
 * How a bot may use a key: brokered (the default; the server sends the request
 * for the bot and the bot never sees the value) or as an environment variable
 * (the bot's shell can read, and so print, it). Used by the Add key form, the
 * secret request card and the key's own Access panel, so the wording is one.
 */
export function SecretAccessFields({
  state,
  onChange,
  disabled = false,
  showProblem = false,
  botName,
}: {
  state: SecretAccessState;
  onChange: (next: SecretAccessState) => void;
  disabled?: boolean;
  /** Show the validation message under the address box (after a failed save). */
  showProblem?: boolean;
  /** Names the bot in the wording; "bots" when the key is not for one bot. */
  botName?: string;
}): JSX.Element {
  const id = useId();
  const originsId = `${id}-origins`;
  const problem = secretAccessProblem(state);
  const who = botName ?? "bots";
  const options: ReadonlyArray<{
    readonly mode: PersonalSecretMode;
    readonly title: string;
    readonly body: string;
  }> = [
    {
      mode: "brokered",
      title: "Brokered (safer)",
      body: `${who === "bots" ? "Bots" : who} can use it only through the server, for the address below, and never see the key.`,
    },
    {
      mode: "env",
      title: "Environment variable",
      body: `${who === "bots" ? "Bots" : who} can read it in the shell and could print it into a chat.`,
    },
  ];
  return (
    <div>
      <div role="radiogroup" aria-label="How bots use this key" className="flex flex-col gap-2">
        {options.map((option) => {
          const selected = state.mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              data-mode={option.mode}
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange({ ...state, mode: option.mode })}
              className={cn(
                OPTION_CLASS,
                selected
                  ? "border-[var(--personal-text)] bg-[var(--personal-fill-muted)]"
                  : "border-[var(--personal-border)] bg-[var(--personal-surface)]",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  selected
                    ? "border-[var(--personal-text)]"
                    : "border-[var(--personal-border-strong)]",
                )}
              >
                {selected ? (
                  <span className="size-2 rounded-full bg-[var(--personal-text)]" />
                ) : null}
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium text-[var(--personal-text)]">
                  {option.title}
                </span>
                <span className="block text-[13px] leading-snug text-[var(--personal-text-secondary)]">
                  {option.body}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {state.mode === "brokered" ? (
        <div className="mt-3">
          <label
            htmlFor={originsId}
            className="mb-1.5 block text-sm font-medium text-[var(--personal-text)]"
          >
            Allowed address
          </label>
          <input
            id={originsId}
            value={state.originsText}
            disabled={disabled}
            inputMode="url"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://api.vercel.com"
            aria-invalid={showProblem && problem !== null}
            aria-describedby={`${originsId}-help`}
            onChange={(event) => onChange({ ...state, originsText: event.target.value })}
            className={FIELD_CLASS}
          />
          <p
            id={`${originsId}-help`}
            className="mt-1.5 text-[13px] text-[var(--personal-text-secondary)]"
          >
            The server adds the key only to requests sent here. Separate several addresses with a
            space.
          </p>
          {showProblem && problem !== null ? (
            <p role="alert" className="mt-1.5 text-[13px] text-[var(--personal-error)]">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
