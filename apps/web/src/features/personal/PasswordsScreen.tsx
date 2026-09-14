import type { FormEvent, JSX } from "react";
import { useMemo, useRef, useState } from "react";

import { PersonalLoginId, type PersonalBot, type PersonalLogin } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  emptyPasswordDraft,
  passwordDraftFromLogin,
  setPasswordBotGrant,
  validatePasswordDraft,
  type PasswordDraft,
  type PasswordDraftErrors,
} from "./passwordsModel";
import {
  personalLoginCreate,
  personalLoginDelete,
  personalLoginUpdate,
  usePersonalLogins,
} from "./usePersonalLogins";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";

const FIELD_CLASS =
  "h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-[var(--personal-text)]";

function PasswordForm({
  login,
  bots,
  onDone,
}: {
  login: PersonalLogin | null;
  bots: ReadonlyArray<Pick<PersonalBot, "botId" | "name">>;
  onDone: () => void;
}): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const createLogin = useAtomCommand(personalLoginCreate);
  const updateLogin = useAtomCommand(personalLoginUpdate);
  const [loginId] = useState(() => login?.loginId ?? PersonalLoginId.make(randomUUID()));
  const [draft, setDraft] = useState<PasswordDraft>(() =>
    login === null ? emptyPasswordDraft() : passwordDraftFromLogin(login),
  );
  const [errors, setErrors] = useState<PasswordDraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const originRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<PasswordDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setErrors((previous) => {
      const next = { ...previous };
      if (patch.label !== undefined) delete next.label;
      if (patch.origin !== undefined) delete next.origin;
      if (patch.password !== undefined) delete next.password;
      return next;
    });
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (environmentId === null || busy) return;
    const validation = validatePasswordDraft(draft);
    setErrors(validation);
    const firstError = validation.label
      ? labelRef.current
      : validation.origin
        ? originRef.current
        : validation.password
          ? passwordRef.current
          : null;
    if (firstError !== null) {
      firstError.focus();
      firstError.scrollIntoView({ block: "center" });
      return;
    }
    setSubmitError(null);
    setBusy(true);
    const input = {
      loginId,
      label: draft.label.trim(),
      origin: draft.origin.trim(),
      username: draft.username,
      password: Redacted.make(draft.password),
      botIds: bots.filter((bot) => draft.botIds.includes(bot.botId)).map((bot) => bot.botId),
    };
    const result = await (login === null
      ? createLogin({ environmentId, input })
      : updateLogin({ environmentId, input }));
    setBusy(false);
    const failure = commandFailureMessage(result, "The login could not be saved.");
    setSubmitError(failure);
    if (failure === null) onDone();
  };

  return (
    <form
      aria-label={login === null ? "Add login" : `Edit ${login.label}`}
      onSubmit={(event) => void onSubmit(event)}
      className="mt-5 flex flex-col gap-5 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4"
      noValidate
    >
      <h2 className="text-[17px] font-bold text-[var(--personal-text)]">
        {login === null ? "Add login" : `Edit ${login.label}`}
      </h2>

      <div>
        <label htmlFor="password-label" className={LABEL_CLASS}>
          Label
        </label>
        <input
          ref={labelRef}
          id="password-label"
          value={draft.label}
          onChange={(event) => update({ label: event.target.value })}
          placeholder="Work email"
          autoComplete="off"
          aria-invalid={errors.label !== undefined}
          aria-describedby={errors.label === undefined ? undefined : "password-label-error"}
          className={FIELD_CLASS}
        />
        {errors.label === undefined ? null : (
          <p id="password-label-error" role="alert" className="mt-1.5 text-sm text-[#b3261e]">
            {errors.label}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="password-origin" className={LABEL_CLASS}>
          Website origin
        </label>
        <input
          ref={originRef}
          id="password-origin"
          value={draft.origin}
          onChange={(event) => update({ origin: event.target.value })}
          placeholder="https://example.com"
          autoComplete="url"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={errors.origin !== undefined}
          aria-describedby={
            errors.origin === undefined
              ? "password-origin-help"
              : "password-origin-help password-origin-error"
          }
          className={FIELD_CLASS}
        />
        <p
          id="password-origin-help"
          className="mt-1.5 text-sm text-[var(--personal-text-secondary)]"
        >
          Bots can fill this login only when the browser is on this exact origin.
        </p>
        {errors.origin === undefined ? null : (
          <p id="password-origin-error" role="alert" className="mt-1.5 text-sm text-[#b3261e]">
            {errors.origin}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="password-username" className={LABEL_CLASS}>
          Username
        </label>
        <input
          id="password-username"
          value={draft.username}
          onChange={(event) => update({ username: event.target.value })}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          className={FIELD_CLASS}
        />
      </div>

      <div>
        <label htmlFor="password-value" className={LABEL_CLASS}>
          Password
        </label>
        <input
          ref={passwordRef}
          id="password-value"
          type="password"
          value={draft.password}
          onChange={(event) => update({ password: event.target.value })}
          autoComplete="new-password"
          aria-invalid={errors.password !== undefined}
          aria-describedby={
            errors.password === undefined
              ? "password-value-help"
              : "password-value-help password-value-error"
          }
          className={FIELD_CLASS}
        />
        <p
          id="password-value-help"
          className="mt-1.5 text-sm text-[var(--personal-text-secondary)]"
        >
          Write-only. Re-enter it whenever you edit this login.
        </p>
        {errors.password === undefined ? null : (
          <p id="password-value-error" role="alert" className="mt-1.5 text-sm text-[#b3261e]">
            {errors.password}
          </p>
        )}
      </div>

      <fieldset>
        <legend className={LABEL_CLASS}>Bots allowed to use this login</legend>
        <div className="overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] divide-y divide-[var(--personal-border)]">
          {bots.length === 0 ? (
            <p className="px-3.5 py-3 text-sm text-[var(--personal-text-secondary)]">
              No bots available.
            </p>
          ) : (
            bots.map((bot) => (
              <label
                key={bot.botId}
                className="flex min-h-11 items-center gap-3 px-3.5 text-[15px] text-[var(--personal-text)]"
              >
                <input
                  type="checkbox"
                  checked={draft.botIds.includes(bot.botId)}
                  onChange={(event) =>
                    update({
                      botIds: setPasswordBotGrant(draft.botIds, bot.botId, event.target.checked),
                    })
                  }
                  className="size-5 accent-[var(--personal-primary)]"
                />
                <span>{bot.name}</span>
              </label>
            ))
          )}
        </div>
        <p className="mt-1.5 text-sm text-[var(--personal-text-secondary)]">
          No bot has access by default. After a login is used, the site stays signed in for the
          shared browser, so keep it to bots you trust with that account.
        </p>
      </fieldset>

      {submitError === null ? null : (
        <p role="alert" className="text-sm text-[#b3261e]">
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
          Save login
        </button>
      </div>
    </form>
  );
}

/** /bots/settings/passwords: saved website logins and explicit per-bot grants. */
export function PasswordsScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const loginsQuery = usePersonalLogins(environmentId);
  const botsQuery = usePersonalBotsList(environmentId);
  const removeLogin = useAtomCommand(personalLoginDelete);
  const [editing, setEditing] = useState<PersonalLogin | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bots = useMemo(
    () => (botsQuery.data?.bots ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [botsQuery.data],
  );
  const logins = loginsQuery.data?.logins ?? [];

  const onDelete = async (login: PersonalLogin) => {
    if (environmentId === null) return;
    const message = `Delete ${login.label}?\nBots will no longer be able to use this login.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusyId(login.loginId);
    const result = await removeLogin({ environmentId, input: { loginId: login.loginId } });
    setBusyId(null);
    setError(commandFailureMessage(result, "Could not delete that login."));
    if (editing !== "new" && editing?.loginId === login.loginId) setEditing(null);
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
          Passwords
        </h1>
        <button
          type="button"
          onClick={() => setEditing("new")}
          aria-label="Add login"
          className="flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <Plus aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </button>
      </header>

      <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
        Passwords are encrypted on this computer, but bots run under your computer account and share
        signed-in browser sessions. Only save accounts you trust every bot to access.
      </p>

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-[#b3261e]">
          {error}
        </p>
      )}

      {loginsQuery.data === null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          {loginsQuery.error ?? "Loading..."}
        </p>
      ) : logins.length === 0 ? (
        <p className="mt-10 text-center text-[15px] text-[var(--personal-text-secondary)]">
          No logins saved yet.
        </p>
      ) : (
        <ul className="mt-4 overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] divide-y divide-[var(--personal-border)]">
          {logins.map((login) => (
            <li key={login.loginId} className="flex min-h-16 items-center">
              <button
                type="button"
                onClick={() => setEditing(login)}
                className="min-w-0 flex-1 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
              >
                <span className="block truncate text-[15px] font-semibold text-[var(--personal-text)]">
                  {login.label}
                </span>
                <span className="block truncate text-[13px] text-[var(--personal-text-secondary)]">
                  {login.origin}
                </span>
                <span className="block truncate text-[13px] text-[var(--personal-text-secondary)]">
                  {login.username}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${login.label}`}
                disabled={busyId === login.loginId}
                onClick={() => void onDelete(login)}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-danger)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
              >
                <Trash2 aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing === null ? null : (
        <PasswordForm
          key={editing === "new" ? "new" : editing.loginId}
          login={editing === "new" ? null : editing}
          bots={bots}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}
