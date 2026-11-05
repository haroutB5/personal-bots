import type { JSX } from "react";
import { useId, useState } from "react";

import type { PersonalSecretMode } from "@t3tools/contracts";
import {
  PERSONAL_SECRET_BROKER_METHODS,
  secretAccessProblem,
  type SecretAccessState,
  type SecretPlacementState,
} from "@hbots/personal-client/settings/secretAccess";

import { cn } from "~/lib/utils";

export {
  describeSecretPlacement,
  initialSecretAccess,
  placementStateOf,
  secretAccessChoice,
  secretAccessProblem,
  secretAccessStateOf,
  type SecretAccessChoice,
  type SecretAccessState,
  type SecretPlacementState,
} from "@hbots/personal-client/settings/secretAccess";

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
