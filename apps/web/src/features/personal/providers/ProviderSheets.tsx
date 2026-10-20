import type { JSX, ReactNode, RefObject } from "react";
import { useRef, useState } from "react";

import type { PersonalBot, ServerProvider } from "@t3tools/contracts";

import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { botsNamed } from "../providerRows";
import { BIG_DOWNLOAD_BYTES, downloadLine, type ProviderFacts, licenceLine } from "./providerFacts";
import { BUTTON_BIG, ProviderTile } from "./providerUi";

/** The floating bottom sheet the app uses (SnoozeSheet shape). Mount it while it is open. */
export function ProviderSheet({
  title,
  onClose,
  children,
  initialFocus,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly initialFocus?: RefObject<HTMLElement | null>;
}): JSX.Element {
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetPopup
        side="bottom"
        role="dialog"
        showCloseButton={false}
        forceBackdrop
        {...(initialFocus === undefined ? {} : { initialFocus })}
        backdropClassName="bg-black/[0.32] backdrop-blur-none dark:bg-black/[0.55]"
        className="personal-app mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] max-h-[90dvh] w-auto overflow-y-auto rounded-[20px] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 pt-4 pb-3 text-[var(--personal-text)]"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
      </SheetPopup>
    </Sheet>
  );
}

/** The head of a sheet: tile, a 17/700 title and one quiet line. */
function SheetHead({
  driver,
  label,
  iconUrl,
  title,
  subtitle,
}: {
  readonly driver: ServerProvider["driver"] | null;
  readonly label: string;
  readonly iconUrl?: string | null | undefined;
  readonly title: string;
  readonly subtitle: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 px-1">
      <ProviderTile driver={driver} label={label} iconUrl={iconUrl} />
      <div className="min-w-0">
        <p className="text-[17px] leading-6 font-bold text-[var(--personal-text)]">{title}</p>
        <p className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

/** One question with a destructive or plain confirm and Cancel (Remove, Turn off, Sign out). */
export function ConfirmSheet({
  driver,
  label,
  iconUrl,
  title,
  subtitle,
  body,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  readonly driver: ServerProvider["driver"] | null;
  readonly label: string;
  readonly iconUrl?: string | null | undefined;
  readonly title: string;
  readonly subtitle: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly destructive?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ProviderSheet title={title} onClose={onCancel} initialFocus={cancelRef}>
      <SheetHead
        driver={driver}
        label={label}
        iconUrl={iconUrl}
        title={title}
        subtitle={subtitle}
      />
      <div className="mt-3 px-1 text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
        {body}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
          className={`${BUTTON_BIG} ${
            destructive
              ? "bg-[var(--personal-danger-bg)] text-[var(--personal-danger)] shadow-[inset_0_0_0_1px_var(--personal-danger-border)]"
              : "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
          }`}
        >
          {confirmLabel}
        </button>
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className={`${BUTTON_BIG} bg-[var(--personal-fill-muted)] text-[var(--personal-text)]`}
        >
          Cancel
        </button>
      </div>
    </ProviderSheet>
  );
}

/**
 * "Install X?" (SPEC 5.2): the facts, one warning, Install and Cancel. Shown
 * for every install, built-ins included, with the lighter built-in line.
 */
export function InstallConfirmSheet({
  driver,
  label,
  iconUrl,
  facts,
  version,
  totalBytes,
  builtIn,
  busy,
  error = null,
  onConfirm,
  onCancel,
}: {
  readonly driver: ServerProvider["driver"] | null;
  readonly label: string;
  readonly iconUrl?: string | null | undefined;
  readonly facts: ProviderFacts | null;
  readonly version: string | null;
  readonly totalBytes: number | null;
  readonly builtIn: boolean;
  readonly busy: boolean;
  readonly error?: string | null | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const big = totalBytes !== null && totalBytes > BIG_DOWNLOAD_BYTES;
  const licence = licenceLine(facts);
  const rows: ReadonlyArray<{ key: string; value: string; review?: boolean }> = [
    ...(facts !== null ? [{ key: "Publisher", value: facts.publisher }] : []),
    ...(version !== null ? [{ key: "Version", value: version }] : []),
    ...(totalBytes !== null
      ? [{ key: "Download", value: downloadLine(totalBytes), ...(big ? { review: true } : {}) }]
      : []),
    ...(facts?.from != null ? [{ key: "From", value: facts.from }] : []),
    ...(licence !== null ? [{ key: "Licence", value: licence }] : []),
    ...(facts?.sha256Checked === true
      ? [{ key: "Checked", value: "Checked against the registry's fingerprint before it runs" }]
      : []),
  ];
  const warning =
    "Once installed it can do what your bots can: read and change files, run commands and use the internet. Install only publishers you trust.";
  const lead = builtIn
    ? "Built into hbots and tested by the team."
    : facts !== null && facts.openSource === false
      ? `Closed source: nobody outside ${facts.publisher} can check what it does.`
      : "This is software from another company.";
  return (
    <ProviderSheet title={`Install ${label}?`} onClose={onCancel} initialFocus={cancelRef}>
      <SheetHead
        driver={driver}
        label={label}
        iconUrl={iconUrl}
        title={`Install ${label}?`}
        subtitle="On your laptop, for your bots"
      />
      <dl className="mt-3 rounded-[12px] bg-[var(--personal-fill-muted)] px-3.5 py-1">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex min-h-11 items-center justify-between gap-4 border-b border-[var(--personal-border)] py-1.5 text-[14px] leading-4.75 last:border-b-0"
          >
            <dt className="shrink-0 text-[var(--personal-text-secondary)]">{row.key}</dt>
            <dd
              className={`min-w-0 text-right break-words ${row.review ? "text-[var(--personal-review-text)]" : "text-[var(--personal-text)]"}`}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 px-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
        {lead} {warning}
      </p>
      {error !== null ? (
        <p role="alert" className="mt-2 px-1 text-sm text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
      {big ? (
        <p className="mt-2 px-1 text-[13px] leading-[18px] text-[var(--personal-review-text)]">
          Big download. It may take a few minutes.
        </p>
      ) : null}
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
          className={`${BUTTON_BIG} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
        >
          Install
        </button>
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className={`${BUTTON_BIG} bg-[var(--personal-fill-muted)] text-[var(--personal-text)]`}
        >
          Cancel
        </button>
      </div>
    </ProviderSheet>
  );
}

/**
 * "New model for Watcher and Musey" (SPEC 5.5): up to three of the provider's
 * own models (default first), applied to every affected bot at once. The bots
 * switch once their current reply ends.
 */
export function RemapSheet({
  snapshot,
  label,
  bots,
  busy,
  error,
  onApply,
  onCancel,
}: {
  readonly snapshot: ServerProvider;
  readonly label: string;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onApply: (model: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const suggestions = snapshot.models
    .toSorted((left, right) => Number(right.isDefault === true) - Number(left.isDefault === true))
    .slice(0, 3);
  const [picked, setPicked] = useState<string | null>(suggestions[0]?.slug ?? null);
  const names = bots.map((bot) => bot.name);
  const both =
    names.length === 2 ? "Both bots switch" : names.length === 1 ? "It switches" : "They switch";
  return (
    <ProviderSheet title={`New model for ${botsNamed(names)}`} onClose={onCancel}>
      <div className="px-1">
        <p className="text-[17px] leading-6 font-bold text-[var(--personal-text)]">
          New model for {botsNamed(names)}
        </p>
        <p className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
          {both} once their current reply ends.
        </p>
      </div>
      <div role="radiogroup" aria-label={`Models on ${label}`} className="mt-3 flex flex-col gap-2">
        {suggestions.length === 0 ? (
          <p className="px-1 text-[14px] text-[var(--personal-text-secondary)]">
            {label} lists no models right now. Check it again in a moment.
          </p>
        ) : null}
        {suggestions.map((model) => {
          const selected = picked === model.slug;
          return (
            <button
              key={model.slug}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPicked(model.slug)}
              className={`flex min-h-[60px] items-center gap-3 rounded-[12px] px-3.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] ${selected ? "shadow-[inset_0_0_0_2px_var(--personal-text)]" : "shadow-[inset_0_0_0_1px_var(--personal-border-strong)]"}`}
            >
              <span
                aria-hidden="true"
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${selected ? "border-[var(--personal-text)]" : "border-[var(--personal-border-strong)]"}`}
              >
                {selected ? (
                  <span className="size-2.5 rounded-full bg-[var(--personal-text)]" />
                ) : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                  {model.name}
                </span>
                {model.isDefault === true ? (
                  <span className="text-[13px] text-[var(--personal-text-secondary)]">
                    The default
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 px-1 text-sm text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          disabled={busy || picked === null}
          aria-busy={busy}
          onClick={() => picked !== null && onApply(picked)}
          className={`${BUTTON_BIG} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
        >
          {names.length === 2
            ? "Use for both bots"
            : names.length === 1
              ? `Use for ${names[0]}`
              : "Use for these bots"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`${BUTTON_BIG} bg-[var(--personal-fill-muted)] text-[var(--personal-text)]`}
        >
          Cancel
        </button>
      </div>
    </ProviderSheet>
  );
}
