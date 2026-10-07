import type { JSX } from "react";
import { useId, useState } from "react";

import {
  PERSONAL_SECRET_BROKER_METHODS,
  PERSONAL_SECRET_MAX_ORIGINS,
  normalizePersonalSecretOrigins,
  normalizePersonalSecretPlacement,
  type PersonalSecretBrokerMethod,
  type PersonalSecretMode,
  type PersonalSecretPlacement,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";

/** What the owner chose for how a bot may use a key. */
export interface SecretAccessChoice {
  readonly mode: PersonalSecretMode;
  /** Canonical origins; empty for an environment variable. */
  readonly origins: ReadonlyArray<string>;
  /** Where the key's placeholder may go; `{}` is the Authorization header only. */
  readonly placement: PersonalSecretPlacement;
}

/** The "where may the key go" boxes as typed, before they are checked. */
export interface SecretPlacementState {
  readonly header: string;
  readonly anywhere: boolean;
  readonly pathPrefix: string;
  /** None ticked means every method. */
  readonly methods: ReadonlyArray<PersonalSecretBrokerMethod>;
}

export interface SecretAccessState {
  readonly mode: PersonalSecretMode;
  /** What is typed in the address box: one address, or several separated by spaces or commas. */
  readonly originsText: string;
  readonly placement: SecretPlacementState;
}

/** The boxes for a key's saved placement (all empty when it has none: the strictest default). */
export const placementStateOf = (
  placement: PersonalSecretPlacement | undefined,
): SecretPlacementState => ({
  header: placement?.header ?? "",
  anywhere: placement?.anywhere === true,
  pathPrefix: placement?.pathPrefix ?? "",
  methods: placement?.methods ?? [],
});

/** The state for a saved key's access panel. */
export const secretAccessStateOf = (secret: {
  readonly mode: PersonalSecretMode;
  readonly origins: ReadonlyArray<string>;
  readonly placement?: PersonalSecretPlacement | undefined;
}): SecretAccessState => ({
  mode: secret.mode === "brokered" ? "brokered" : "env",
  originsText: secret.origins.join(", "),
  placement: placementStateOf(secret.placement),
});

const placementOf = (state: SecretPlacementState): PersonalSecretPlacement | null =>
  normalizePersonalSecretPlacement({
    header: state.header,
    anywhere: state.anywhere,
    pathPrefix: state.pathPrefix,
    methods: state.methods,
  });

/** One line saying where a saved key may go, for the keys list. */
export function describeSecretPlacement(placement: PersonalSecretPlacement | undefined): string {
  const parts: Array<string> = [
    placement?.header === undefined
      ? "Sent in the Authorization header only"
      : `Sent in the Authorization or ${placement.header} header`,
  ];
  if (placement?.anywhere === true)
    parts[0] = `${parts[0]!.replace(" only", "")}, the URL and the body`;
  if (placement?.pathPrefix !== undefined) parts.push(`paths under ${placement.pathPrefix}`);
  if (placement?.methods !== undefined) parts.push(`${placement.methods.join(", ")} only`);
  return parts.join("; ");
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
  placement: placementStateOf(undefined),
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
  if (placementOf(state.placement) === null) {
    return "Check where the key may go: a plain header name, and a path that starts with / with no .. or ?.";
  }
  return null;
}

/** The choice to send to the server; call only when {@link secretAccessProblem} is null. */
export function secretAccessChoice(state: SecretAccessState): SecretAccessChoice {
  if (state.mode === "env") return { mode: "env", origins: [], placement: {} };
  return {
    mode: "brokered",
    origins: normalizePersonalSecretOrigins(splitOrigins(state.originsText)) ?? [],
    placement: placementOf(state.placement) ?? {},
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
  showPlacement = false,
}: {
  state: SecretAccessState;
  onChange: (next: SecretAccessState) => void;
  /** Settings only: the "where may the key go" controls. The request card keeps the default. */
  showPlacement?: boolean;
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
          {showPlacement ? (
            <PlacementFields
              state={state.placement}
              disabled={disabled}
              onChange={(placement) => onChange({ ...state, placement })}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where on a request a brokered key may be put. The default is the
 * Authorization header only: a key in a URL or a body ends up in access logs
 * and in anything an API echoes back, so each key opts in for that.
 */
function PlacementFields({
  state,
  onChange,
  disabled,
}: {
  state: SecretPlacementState;
  onChange: (next: SecretPlacementState) => void;
  disabled: boolean;
}): JSX.Element {
  const id = useId();
  // Open at first when the key already has a custom placement; after that the
  // owner's own toggling decides (clearing a box must not fold the panel).
  const [open, setOpen] = useState(
    state.header !== "" || state.anywhere || state.pathPrefix !== "" || state.methods.length > 0,
  );
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="mt-3 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] px-3 py-2"
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-[var(--personal-text)]">
        Where the key may go (advanced)
      </summary>
      <p className="text-[13px] leading-snug text-[var(--personal-text-secondary)]">
        By default a bot can put the key only in the Authorization header. Allow more only if the
        API needs it.
      </p>
      <label
        htmlFor={`${id}-header`}
        className="mt-3 mb-1.5 block text-sm font-medium text-[var(--personal-text)]"
      >
        Another header it may go in
      </label>
      <input
        id={`${id}-header`}
        value={state.header}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="x-api-key"
        onChange={(event) => onChange({ ...state, header: event.target.value })}
        className={FIELD_CLASS}
      />
      <label className="mt-3 flex min-h-11 items-start gap-3 text-[15px] text-[var(--personal-text)]">
        <input
          type="checkbox"
          checked={state.anywhere}
          disabled={disabled}
          onChange={(event) => onChange({ ...state, anywhere: event.target.checked })}
          className="mt-1.5"
        />
        <span>
          Also allow it in the web address and the request body
          <span className="block text-[13px] leading-snug text-[var(--personal-text-secondary)]">
            A key there can end up in the API's logs.
          </span>
        </span>
      </label>
      <label
        htmlFor={`${id}-prefix`}
        className="mt-3 mb-1.5 block text-sm font-medium text-[var(--personal-text)]"
      >
        Only for paths starting with (optional)
      </label>
      <input
        id={`${id}-prefix`}
        value={state.pathPrefix}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="/v1"
        onChange={(event) => onChange({ ...state, pathPrefix: event.target.value })}
        className={FIELD_CLASS}
      />
      <fieldset className="mt-3">
        <legend className="mb-1 text-sm font-medium text-[var(--personal-text)]">
          Only these methods (none ticked means all)
        </legend>
        <div className="flex flex-wrap gap-x-4">
          {PERSONAL_SECRET_BROKER_METHODS.map((method) => (
            <label
              key={method}
              className="flex min-h-11 items-center gap-2 text-[15px] text-[var(--personal-text)]"
            >
              <input
                type="checkbox"
                checked={state.methods.includes(method)}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...state,
                    methods: event.target.checked
                      ? [...state.methods, method]
                      : state.methods.filter((entry) => entry !== method),
                  })
                }
              />
              {method}
            </label>
          ))}
        </div>
      </fieldset>
    </details>
  );
}
