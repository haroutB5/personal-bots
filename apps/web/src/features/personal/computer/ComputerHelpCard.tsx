import { Hand, MousePointer2, Shield } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { formatElapsed } from "./computerActivity";
import type { HelpKind } from "./computerContract";
import { ICON_STROKE } from "./ComputerSourceRow";

const CARD =
  "rounded-[14px] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5";
const BADGE =
  "flex size-9 shrink-0 items-center justify-center rounded-full bg-[rgb(227_184_85/.14)] text-[var(--personal-review)]";
const BUTTON =
  "flex h-11 items-center justify-center gap-2 rounded-[10px] px-4 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50";

function Bold({ children }: { readonly children: ReactNode }) {
  return <b className="font-semibold">{children}</b>;
}

/**
 * The line under "<bot> needs you", picked by kind. The server's own reason
 * is shown as written when the kind is unknown or there is no site to name.
 */
export function helpBody(input: {
  readonly kind: HelpKind | null;
  readonly botName: string;
  readonly origin: string | null;
  readonly reason: string;
}): ReactNode {
  const { kind, botName, origin, reason } = input;
  if (origin === null) return reason;
  switch (kind) {
    case "captcha":
      return (
        <>
          A human check is blocking <Bold>{origin}</Bold>. Solve it, then hand back and {botName}{" "}
          carries on.
        </>
      );
    case "code":
      return (
        <>
          <Bold>{origin}</Bold> wants a sign-in code. Enter it yourself on the page, then hand back.
        </>
      );
    case "login":
      return (
        <>
          {botName} needs you to sign in to <Bold>{origin}</Bold>. Sign in on the page, then hand
          back.
        </>
      );
    default:
      return reason;
  }
}

/** A bot is blocked on a CAPTCHA, a code or a sign-in and needs you. */
export function ComputerHelpCard(props: {
  readonly botName: string;
  readonly kind: HelpKind | null;
  readonly origin: string | null;
  readonly reason: string;
  /** ISO instant the bot asked. */
  readonly requestedAt: string;
  readonly now: number;
  readonly busy: boolean;
  readonly onTakeOver: () => void;
  readonly onOpenChat: () => void;
  readonly className?: string;
}): JSX.Element {
  const asked = Date.parse(props.requestedAt);
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={`${props.botName} needs you`}
      className={cn(CARD, props.className)}
    >
      <div className="flex items-center gap-3">
        <span className={BADGE}>
          <Hand className="size-[18px]" strokeWidth={ICON_STROKE} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[16px] leading-5 font-semibold">{props.botName} needs you</p>
          {Number.isFinite(asked) ? (
            <p className="text-[13px] text-[var(--personal-review)]">
              {formatElapsed(asked, props.now) === "just now"
                ? "Asked just now"
                : `Asked ${formatElapsed(asked, props.now)} ago`}
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-2.5 text-[14px] leading-5">{helpBody(props)}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onTakeOver}
          className={cn(
            BUTTON,
            "flex-1 bg-[var(--personal-primary)] text-[var(--personal-primary-text)]",
          )}
        >
          <MousePointer2 className="size-[18px]" strokeWidth={ICON_STROKE} aria-hidden />
          Take over
        </button>
        <button
          type="button"
          onClick={props.onOpenChat}
          className={cn(BUTTON, "border border-[var(--personal-border-strong)]")}
        >
          Open chat
        </button>
      </div>
    </section>
  );
}

/** A bot paused before taking what it saw on a sensitive site elsewhere. */
export function ComputerSensitiveCard(props: {
  readonly botName: string;
  readonly sources: string;
  readonly destination: string;
  /** False until the server has Allow once / Refuse: Take control stands in. */
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onAllow: () => void;
  readonly onRefuse: () => void;
  readonly onTakeControl: () => void;
  readonly className?: string;
}): JSX.Element {
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label="Allow this step?"
      className={cn(CARD, props.className)}
    >
      <div className="flex items-center gap-3">
        <span className={BADGE}>
          <Shield className="size-[18px]" strokeWidth={ICON_STROKE} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[16px] leading-5 font-semibold">Allow this step?</p>
          <p className="text-[13px] text-[var(--personal-review)]">{props.botName} is paused</p>
        </div>
      </div>
      <p className="mt-2.5 text-[14px] leading-5">
        {props.botName} had {props.sources ? <Bold>{props.sources}</Bold> : "a site"} open, a site
        you marked sensitive. Its next step would take what it saw there to{" "}
        <Bold>{props.destination}</Bold>.
      </p>
      {props.canDecide ? (
        <>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onAllow}
              className={cn(
                BUTTON,
                "flex-1 bg-[var(--personal-primary)] text-[var(--personal-primary-text)]",
              )}
            >
              Allow once
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onRefuse}
              className={cn(
                BUTTON,
                "flex-1 border border-[var(--personal-danger-border)] text-[var(--personal-danger)]",
              )}
            >
              Refuse
            </button>
          </div>
          <p className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">
            Refuse stops this step only. {props.botName} is told and carries on without it.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">
            Take control, then hand back to allow. Close the browser to refuse.
          </p>
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onTakeControl}
            className={cn(
              BUTTON,
              "mt-3 w-full bg-[var(--personal-primary)] text-[var(--personal-primary-text)]",
            )}
          >
            Take control
          </button>
        </>
      )}
      {props.error === null ? null : (
        <p role="alert" className="mt-2 text-[13px] text-[var(--personal-danger)]">
          {props.error}
        </p>
      )}
    </section>
  );
}
