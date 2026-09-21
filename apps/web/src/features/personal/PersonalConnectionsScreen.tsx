import type { FormEvent, JSX } from "react";
import { useState } from "react";

import { WHATSAPP_MAX_DAILY_SEND_CAP } from "@t3tools/contracts";
import type {
  PersonalConnection,
  PersonalConnectionImportResult,
  PersonalConnectionVendorId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { ChevronLeft, ExternalLink, Laptop } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  connectionActionLabel,
  connectionActions,
  connectionRows,
  dailySendCap,
  describeConnection,
  disconnectWarning,
  describeImportSource,
  emptyTokenDraft,
  fieldLabel,
  validateTokenDraft,
  type ConnectionAction,
  type ConnectionTone,
  type ConnectionVendorInfo,
  type TokenDraft,
} from "./connectionsModel";
import {
  personalConnectionBrowserConnect,
  personalConnectionConnect,
  personalConnectionDisable,
  personalConnectionDisconnect,
  personalConnectionImportAdopt,
  personalConnectionImportProbe,
  personalConnectionReconnect,
  personalConnectionRotate,
  personalConnectionSetSettings,
  personalConnectionValidate,
  usePersonalConnections,
} from "./usePersonalConnections";
import { usePersonalEnvironmentId } from "./usePersonalBots";

const FIELD_CLASS =
  "h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-[var(--personal-text)]";
const CARD =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]";
// 44px, the tap target the rest of the personal shell uses.
const ACTION_CLASS =
  "h-11 rounded-full border border-[var(--personal-border-strong)] px-3.5 text-[13px] font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

const TONE_DOT: Readonly<Record<ConnectionTone, string>> = {
  ok: "bg-[var(--personal-success,#22A559)]",
  pending: "bg-[var(--personal-text-secondary)]",
  attention: "bg-[var(--personal-danger)]",
  off: "bg-[var(--personal-border-strong)]",
};

/**
 * The paste form.
 *
 * The token lives in this component's state for exactly as long as the form is
 * open and is dropped the moment it is submitted or closed. It is never put in
 * a query cache, a URL, a log or an analytics event, and the field is a
 * password input with autocomplete off so the browser does not keep it either.
 */
function TokenForm({
  vendor,
  connection,
  onDone,
}: {
  vendor: ConnectionVendorInfo;
  /** Present when this is a replacement for a token that stopped working. */
  connection: PersonalConnection | null;
  onDone: () => void;
}): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const connect = useAtomCommand(personalConnectionConnect);
  const rotate = useAtomCommand(personalConnectionRotate);
  const [draft, setDraft] = useState<TokenDraft>(() => emptyTokenDraft(vendor.vendorId));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (environmentId === null || busy) return;
    const validation = validateTokenDraft(vendor.vendorId, draft);
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;
    setSubmitError(null);
    setBusy(true);
    const credentials = Object.fromEntries(
      vendor.requiredCredentialFields.map((field) => [
        field,
        // Trimmed: a copied token almost always brings whitespace with it.
        Redacted.make((draft[field] ?? "").trim()),
      ]),
    );
    const result = await (connection === null
      ? connect({ environmentId, input: { vendorId: vendor.vendorId, credentials } })
      : rotate({ environmentId, input: { connectionId: connection.connectionId, credentials } }));
    setBusy(false);
    // Whatever happens, the pasted value does not outlive this call.
    setDraft(emptyTokenDraft(vendor.vendorId));
    const failure = commandFailureMessage(result, `${vendor.displayName} could not be connected.`);
    setSubmitError(failure);
    if (failure === null) onDone();
  };

  return (
    <form
      aria-label={`Connect ${vendor.displayName}`}
      onSubmit={(event) => void onSubmit(event)}
      className={`mt-3 flex flex-col gap-4 ${CARD} p-4`}
      noValidate
    >
      <div>
        <h3 className="text-[15px] font-bold text-[var(--personal-text)]">
          {connection === null
            ? `Connect ${vendor.displayName}`
            : `New ${vendor.displayName} token`}
        </h3>
        <p className="mt-1 text-[13px] leading-snug text-[var(--personal-text-secondary)]">
          {vendor.requiredScopes.length === 0
            ? `Create a token on ${vendor.displayName} and paste it here.`
            : `Create a token with ${vendor.requiredScopes.join(" and ")} ticked, then paste it here. hbots checks it against ${vendor.displayName} before saving and tells you if a box is missing.`}
        </p>
        <a
          href={vendor.tokenPageUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex h-9 items-center gap-1.5 text-[14px] font-medium text-[var(--personal-primary,#1A73E8)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          Open the {vendor.displayName} token page
          <ExternalLink aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </a>
      </div>

      {vendor.requiredCredentialFields.map((field) => (
        <div key={field}>
          <label htmlFor={`connection-${vendor.vendorId}-${field}`} className={LABEL_CLASS}>
            {fieldLabel(field).charAt(0).toUpperCase() + fieldLabel(field).slice(1)}
          </label>
          <input
            id={`connection-${vendor.vendorId}-${field}`}
            type={field === "email" ? "email" : "password"}
            value={draft[field] ?? ""}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, [field]: event.target.value }))
            }
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={errors[field] !== undefined}
            className={FIELD_CLASS}
          />
          {errors[field] === undefined ? null : (
            <p role="alert" className="mt-1.5 text-sm text-[var(--personal-error)]">
              {errors[field]}
            </p>
          )}
        </div>
      ))}

      {submitError === null ? null : (
        <p role="alert" className="text-sm text-[var(--personal-error)]">
          {submitError}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="h-11 flex-1 rounded-[var(--personal-radius-button)] bg-[var(--personal-text)] text-[15px] font-semibold text-[var(--personal-surface)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
        >
          {busy ? "Checking..." : "Save and check"}
        </button>
        <button type="button" onClick={onDone} className={`${ACTION_CLASS} px-5`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What the owner's own CLIs already hold, offered without showing any of it. */
function ImportPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const probe = useAtomCommand(personalConnectionImportProbe);
  const adopt = useAtomCommand(personalConnectionImportAdopt);
  const [result, setResult] = useState<PersonalConnectionImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const scan = async () => {
    if (environmentId === null) return;
    setBusy("scan");
    setError(null);
    const outcome = await probe({ environmentId, input: {} });
    setBusy(null);
    const failure = commandFailureMessage(outcome, "This machine could not be checked.");
    setError(failure);
    setResult(outcome._tag === "Success" ? outcome.value : null);
  };

  const use = async (candidateId: string) => {
    if (environmentId === null) return;
    setBusy(candidateId);
    const outcome = await adopt({ environmentId, input: { candidateId } });
    setBusy(null);
    const failure = commandFailureMessage(
      outcome,
      "That login could not be used. It may not have the access hbots needs.",
    );
    setError(failure);
    if (failure === null) onClose();
  };

  return (
    <section className={`mt-3 ${CARD} p-4`} aria-label="Import from this machine">
      <p className="text-[13px] leading-snug text-[var(--personal-text-secondary)]">
        hbots can use the GitHub and Vercel logins the command-line tools on this computer already
        hold. It checks them with the provider before using them, and never shows you or a bot the
        value.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy !== null}
          className={ACTION_CLASS}
        >
          {busy === "scan" ? "Checking..." : "Check this computer"}
        </button>
        <button type="button" onClick={onClose} className={ACTION_CLASS}>
          Close
        </button>
      </div>

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-[var(--personal-error)]">
          {error}
        </p>
      )}

      {result === null ? null : (
        <div className="mt-3 flex flex-col gap-2">
          {result.candidates.map((candidate) => (
            <div key={candidate.candidateId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[14px] text-[var(--personal-text)]">
                <span className="font-semibold">{candidate.sourceLabel}</span>
                {candidate.identifier === null ? null : (
                  <span className="text-[var(--personal-text-secondary)]">
                    {" "}
                    - {candidate.identifier}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => void use(candidate.candidateId)}
                disabled={busy !== null}
                className={ACTION_CLASS}
              >
                {busy === candidate.candidateId ? "Checking..." : "Use this"}
              </button>
            </div>
          ))}
          {result.sources
            .filter((source) => source.state !== "found")
            .map((source) => {
              const described = describeImportSource(source);
              return (
                <p
                  key={source.sourceId}
                  className={`text-[13px] ${described.tone === "attention" ? "text-[var(--personal-error)]" : "text-[var(--personal-text-secondary)]"}`}
                >
                  {described.text}
                </p>
              );
            })}
        </div>
      )}
    </section>
  );
}

/**
 * The one setting a WhatsApp connection has, on the row that owns it.
 *
 * It is here rather than behind a screen of its own because it is the number
 * the owner is trusting: how many messages a day this can send in their name.
 * Bounded by the contract, so a typo cannot become an unlimited connection.
 */
function SendCapField({ connection }: { connection: PersonalConnection }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const setSettings = useAtomCommand(personalConnectionSetSettings);
  const [draft, setDraft] = useState(String(dailySendCap(connection)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (environmentId === null) return;
    const value = Number.parseInt(draft, 10);
    if (!Number.isInteger(value) || value < 1 || value > WHATSAPP_MAX_DAILY_SEND_CAP) {
      setError(`Choose a number between 1 and ${WHATSAPP_MAX_DAILY_SEND_CAP}.`);
      return;
    }
    setError(null);
    setBusy(true);
    const result = await setSettings({
      environmentId,
      input: {
        connectionId: connection.connectionId,
        settings: { whatsappDailySendCap: value },
      },
    });
    setBusy(false);
    setError(commandFailureMessage(result, "The daily limit could not be changed."));
  };

  return (
    <div className="mt-3">
      <label htmlFor="whatsapp-daily-cap" className={LABEL_CLASS}>
        Messages a day
      </label>
      <div className="flex gap-2">
        <input
          id="whatsapp-daily-cap"
          type="number"
          inputMode="numeric"
          min={1}
          max={WHATSAPP_MAX_DAILY_SEND_CAP}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className={`${FIELD_CLASS} w-24`}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className={`${ACTION_CLASS} px-5`}
        >
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-[var(--personal-text-secondary)]">
        hbots refuses to send past this rather than saving it for tomorrow, and leaves a gap between
        messages so your account does not look automated.
      </p>
      {error === null ? null : (
        <p role="alert" className="mt-1.5 text-sm text-[var(--personal-error)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** /bots/settings/connections: the accounts every bot can act on. */
export function PersonalConnectionsScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const connectionsQuery = usePersonalConnections(environmentId);
  const validate = useAtomCommand(personalConnectionValidate);
  const disable = useAtomCommand(personalConnectionDisable);
  const reconnect = useAtomCommand(personalConnectionReconnect);
  const disconnect = useAtomCommand(personalConnectionDisconnect);
  const browserConnect = useAtomCommand(personalConnectionBrowserConnect);
  const [pasting, setPasting] = useState<PersonalConnectionVendorId | null>(null);
  const [importing, setImporting] = useState(false);
  const [busyVendor, setBusyVendor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = connectionRows(connectionsQuery.data?.connections ?? []);

  const act = async (
    action: ConnectionAction,
    vendor: ConnectionVendorInfo,
    connection: PersonalConnection | null,
  ) => {
    if (action === "connect" || action === "reconnect") {
      setImporting(false);
      if (vendor.authKind !== "browser-session") {
        setPasting(vendor.vendorId);
        return;
      }
      // Nothing to type: the server opens the site and hands over control, and
      // what comes back is what the owner should do next.
      if (environmentId === null) return;
      setPasting(null);
      setBusyVendor(vendor.vendorId);
      setNotice(null);
      const started = await browserConnect({
        environmentId,
        input: { vendorId: vendor.vendorId },
      });
      setBusyVendor(null);
      const failure = commandFailureMessage(
        started,
        `${vendor.displayName} could not be opened in the shared browser.`,
      );
      setError(failure);
      if (started._tag === "Success") setNotice(started.value.instruction);
      return;
    }
    if (environmentId === null || connection === null) return;
    const input = { connectionId: connection.connectionId };
    if (action === "disconnect") {
      const message = disconnectWarning(vendor.vendorId);
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusyVendor(vendor.vendorId);
    setNotice(null);
    if (action === "validate") {
      const checked = await validate({ environmentId, input });
      setBusyVendor(null);
      const failure = commandFailureMessage(checked, `${vendor.displayName} could not be checked.`);
      setError(failure);
      // A check that ran and found a problem is not a failed command: the
      // server says what is wrong with the token, and that belongs on screen.
      if (checked._tag === "Success") {
        setNotice(checked.value.problem ?? `${vendor.displayName} is working.`);
      }
      return;
    }
    const result = await (action === "disable"
      ? disable({ environmentId, input })
      : action === "enable"
        ? reconnect({ environmentId, input })
        : disconnect({ environmentId, input }));
    setBusyVendor(null);
    setError(commandFailureMessage(result, `${vendor.displayName} could not be changed.`));
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
          Connections
        </h1>
        <button
          type="button"
          onClick={() => {
            setPasting(null);
            setImporting((open) => !open);
          }}
          aria-label="Import from this machine"
          aria-expanded={importing}
          className="flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <Laptop aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </button>
      </header>

      <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
        Accounts your bots can act on. Every bot can use every connection you turn on, the same way
        saved logins work. hbots holds the token and does the work itself, so a bot never sees it,
        and anything that changes your account or ships something asks you first.
      </p>

      {importing ? <ImportPanel onClose={() => setImporting(false)} /> : null}

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-[var(--personal-error)]">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className="mt-3 text-sm text-[var(--personal-text-secondary)]">
          {notice}
        </p>
      )}

      {connectionsQuery.data === null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          {connectionsQuery.error ?? "Loading..."}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((row) => {
            const described = row.connection === null ? null : describeConnection(row.connection);
            return (
              <li key={row.vendorId} className={`${CARD} p-4`}>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      {described === null ? null : (
                        <span
                          aria-hidden="true"
                          className={`size-2 shrink-0 rounded-full ${TONE_DOT[described.tone]}`}
                        />
                      )}
                      <span className="text-[16px] font-bold text-[var(--personal-text)]">
                        {row.vendor.displayName}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[14px] text-[var(--personal-text)]">
                      {described === null ? "Not connected" : described.headline}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-[var(--personal-text-secondary)]">
                      {described === null ? row.vendor.purpose : described.detail}
                    </span>
                    {row.connection === null ||
                    row.connection.verifiedCapabilities.length === 0 ? null : (
                      <span className="mt-1.5 block text-[13px] leading-snug text-[var(--personal-text-secondary)]">
                        Can: {row.connection.verifiedCapabilities.join(", ")}
                      </span>
                    )}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {connectionActions(row.connection).map((action) => (
                    <button
                      key={action}
                      type="button"
                      disabled={busyVendor === row.vendorId}
                      onClick={() => void act(action, row.vendor, row.connection)}
                      className={
                        action === "disconnect"
                          ? `${ACTION_CLASS} text-[var(--personal-danger)]`
                          : ACTION_CLASS
                      }
                    >
                      {connectionActionLabel(action, row.vendorId)}
                    </button>
                  ))}
                </div>

                {row.connection !== null && row.vendorId === "whatsapp" ? (
                  <SendCapField connection={row.connection} />
                ) : null}

                {pasting === row.vendorId && row.vendor.authKind !== "browser-session" ? (
                  <TokenForm
                    vendor={row.vendor}
                    connection={row.connection}
                    onDone={() => setPasting(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
