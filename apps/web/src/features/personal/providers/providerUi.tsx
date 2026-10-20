import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { AlertTriangle, Info } from "lucide-react";

import type { ProviderDriverKind } from "@t3tools/contracts";

import { PROVIDER_ICON_BY_PROVIDER } from "~/components/chat/providerIconUtils";

import type { ProviderRowDot } from "../providerRows";

/** The look of a provider screen: the same tokens and shapes as the rest of Settings. */
export const SECTION_TITLE =
  "mb-2 px-1 text-[13px] font-semibold tracking-wide text-[var(--personal-section-label)] uppercase";
export const CARD =
  "overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]";
export const CARD_ROW =
  "flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]";
export const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-0";
/** A 44 px outline button. */
export const BUTTON_OUTLINE = `inline-flex h-11 shrink-0 items-center justify-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] px-3.5 text-[14px] font-semibold text-[var(--personal-text)] ${FOCUS} disabled:opacity-40`;
/** A 44 px filled button. */
export const BUTTON_PRIMARY = `inline-flex h-11 shrink-0 items-center justify-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[14px] font-semibold text-[var(--personal-primary-text)] ${FOCUS} disabled:opacity-40`;
/** The big 50 px button of a sheet or a page's bottom bar. */
export const BUTTON_BIG =
  "flex h-[50px] w-full items-center justify-center rounded-[12px] text-[16px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";
export const BUTTON_QUIET = `inline-flex h-11 shrink-0 items-center justify-center rounded-[var(--personal-radius-button)] px-3 text-[14px] font-semibold text-[var(--personal-text-secondary)] ${FOCUS} disabled:opacity-40`;
export const FIELD =
  "h-11 w-full min-w-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

/** The 36 px (list) or 64 px (hero) provider tile: the driver's icon, else two letters. */
export function ProviderTile({
  driver,
  label,
  iconUrl,
  size = "row",
  pulse = false,
}: {
  readonly driver: ProviderDriverKind | null;
  readonly label: string;
  readonly iconUrl?: string | null | undefined;
  readonly size?: "row" | "hero";
  readonly pulse?: boolean | undefined;
}): JSX.Element {
  const [imgFailed, setImgFailed] = useState(false);
  const Icon = driver === null ? undefined : PROVIDER_ICON_BY_PROVIDER[driver];
  const hero = size === "hero";
  const showImg = !imgFailed && iconUrl != null && iconUrl.length > 0;
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center bg-[var(--personal-fill-muted)] text-[var(--personal-text)] shadow-[inset_0_0_0_1px_var(--personal-border)] ${hero ? "size-16 rounded-[var(--personal-radius-card)]" : "size-9 rounded-[10px]"} ${pulse ? "shadow-[0_0_0_8px_var(--personal-live)] transition-shadow duration-600 motion-reduce:transition-none" : ""}`}
    >
      {showImg ? (
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          className={`${hero ? "size-[34px]" : "size-5"} object-contain`}
          onError={() => setImgFailed(true)}
        />
      ) : Icon !== undefined ? (
        <Icon className={hero ? "size-[34px]" : "size-5"} />
      ) : (
        <span className={`${hero ? "text-xl" : "text-[13px]"} leading-none font-bold`}>
          {monogram(label)}
        </span>
      )}
    </span>
  );
}

/**
 * 6 skeleton rows (tile and two bars, --personal-fill-muted), no spinner (SPEC §4).
 */
export function ProviderCatalogueSkeleton(): JSX.Element {
  return (
    <ul
      className={`${CARD} divide-y divide-[var(--personal-border)]`}
      aria-label="Loading providers"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <li key={index} className="flex min-h-16 items-center gap-3 px-3.5 py-2.5">
          <span className="size-9 shrink-0 rounded-[10px] bg-[var(--personal-fill-muted)] opacity-70 animate-pulse" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="h-3.5 w-28 rounded bg-[var(--personal-fill-muted)] opacity-70 animate-pulse" />
            <span className="h-3 w-44 rounded bg-[var(--personal-fill-muted)] opacity-50 animate-pulse" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function monogram(label: string): string {
  const parts = label.split(/[\s_-]+/).filter((part) => part.length > 0);
  const first = parts[0] ?? "";
  const letters =
    parts.length >= 2
      ? `${first.charAt(0)}${parts[1]!.charAt(0)}`
      : first.length >= 2
        ? `${first.charAt(0)}${first.charAt(first.length > 4 ? 4 : first.length - 1)}`
        : first;
  return letters.toUpperCase();
}

const DOT_CLASS: Record<Exclude<ProviderRowDot, "none" | "spinner" | "off">, string> = {
  live: "bg-[var(--personal-live)]",
  review: "bg-[var(--personal-review)]",
  error: "bg-[var(--personal-error)]",
  waiting: "bg-[var(--personal-text-tertiary)]",
};

/** The 8 px status dot: a hollow ring when Off, a spinner while something runs, nothing for a bar. */
export function StatusDot({ dot }: { readonly dot: ProviderRowDot }): JSX.Element | null {
  if (dot === "none") return null;
  if (dot === "spinner") {
    return (
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-spin rounded-full border border-[var(--personal-text-secondary)] border-t-transparent motion-reduce:animate-none"
      />
    );
  }
  if (dot === "off") {
    return (
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full border-[1.5px] border-[var(--personal-text-tertiary)]"
      />
    );
  }
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT_CLASS[dot]}`} />;
}

/** A 4 px bar: determinate with a fraction, a sliding segment without one. */
export function ProgressBar({
  fraction,
  label,
  valueText,
}: {
  readonly fraction: number | null;
  readonly label: string;
  readonly valueText?: string | undefined;
}): JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(fraction === null
        ? {}
        : { "aria-valuenow": Math.round(fraction * 100), "aria-valuetext": valueText })}
      className="h-1 w-full overflow-hidden rounded-full bg-[var(--personal-track)]"
    >
      {fraction === null ? (
        <div className="prov-progress-slide h-full w-[34%] rounded-full bg-[var(--personal-primary)]" />
      ) : (
        <div
          className="h-full rounded-full bg-[var(--personal-primary)] transition-[width] duration-300 ease-linear motion-reduce:transition-none"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      )}
    </div>
  );
}

type NoteTone = "danger" | "review" | "info";

const NOTE_ICON_CLASS: Record<NoteTone, string> = {
  danger: "text-[var(--personal-danger)]",
  review: "text-[var(--personal-review-text)]",
  info: "text-[var(--personal-text-secondary)]",
};

const NOTE_CLASS: Record<NoteTone, string> = {
  danger: "bg-[var(--personal-danger-bg)] shadow-[inset_0_0_0_1px_var(--personal-danger-border)] ",
  review: "bg-[var(--personal-review-bg)] shadow-[inset_0_0_0_1px_var(--personal-review-border)] ",
  info: "bg-[var(--personal-fill-muted)] ",
};

/**
 * The note block of SPEC section 7: a title (what happened), one sentence, and
 * the buttons that are the next step, primary first.
 */
export function ProviderNote({
  tone,
  title,
  children,
  actions,
}: {
  readonly tone: NoteTone;
  readonly title: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}): JSX.Element {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-note-tone={tone}
      className={`rounded-[12px] px-4 py-3.5 ${NOTE_CLASS[tone]}`}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          aria-hidden="true"
          className={`mt-0.5 size-5 shrink-0 ${NOTE_ICON_CLASS[tone]}`}
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-5 font-semibold text-[var(--personal-text)]">{title}</p>
          {children !== undefined ? (
            <p className="mt-1 text-[14px] leading-5 break-words text-[var(--personal-text-secondary)]">
              {children}
            </p>
          ) : null}
        </div>
      </div>
      {actions !== undefined ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** The app's switch: a button with role="switch", 44 px tall. */
export function ProviderSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  busy = false,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-11 w-14 shrink-0 items-center justify-end rounded-full ${FOCUS} disabled:opacity-60`}
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-8 w-[52px] shrink-0 items-center rounded-full border border-[var(--personal-border)] transition-colors duration-150 motion-reduce:transition-none ${checked ? "bg-[var(--personal-live)]" : "bg-[var(--personal-fill-muted)]"}`}
      >
        <span
          className={`inline-block size-6 rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none ${checked ? "translate-x-[24px]" : "translate-x-1"}`}
        />
      </span>
    </button>
  );
}

/** A two-line card row: title and hint on the left, anything (switch, button) on the right. */
export function CardRow({
  title,
  hint,
  control,
  titleClassName = "text-[var(--personal-text)]",
}: {
  readonly title: ReactNode;
  readonly hint?: ReactNode;
  readonly control?: ReactNode;
  readonly titleClassName?: string;
}): JSX.Element {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`text-[15px] leading-5 font-semibold ${titleClassName}`}>{title}</span>
        {hint !== undefined ? (
          <span className="text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]">
            {hint}
          </span>
        ) : null}
      </span>
      {control}
    </div>
  );
}
