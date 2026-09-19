import type { JSX } from "react";
import { useId, useState } from "react";

import { Check, KeyRound, X } from "lucide-react";

import { cn } from "~/lib/utils";

import type { SecretRequestCardItem } from "./secretRequestCards";

const CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5";
const SETTLED_CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5";
const BUTTON_CLASS =
  "h-11 rounded-[var(--personal-radius-button)] px-3.5 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

/**
 * A secret the bot asked for, answered here in the chat.
 *
 * Without this card `request_secret` is a dead end: the server parks the task
 * on the user and nothing on the phone can see the ask, so the task waits for
 * ever and the Tasks screen shows a "Needs you" row with no way in.
 */
export function SecretRequestCard({
  card,
  botName,
  responding,
  onProvide,
  onDecline,
}: {
  card: SecretRequestCardItem;
  botName: string;
  responding: boolean;
  onProvide: (requestId: string, value: string) => void;
  onDecline: (requestId: string) => void;
}): JSX.Element {
  if (card.kind === "pending") {
    return (
      <PendingSecretRequestCard
        card={card}
        botName={botName}
        responding={responding}
        onProvide={onProvide}
        onDecline={onDecline}
      />
    );
  }

  if (card.kind === "provided") {
    return (
      <section aria-label={`You gave ${botName} a secret`} className={SETTLED_CARD_CLASS}>
        <p className="flex items-start gap-1.5 text-[15px] break-words text-[var(--personal-text)]">
          <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
          <span>
            You saved {card.label}. {botName} can use it without ever seeing it here.
          </span>
        </p>
      </section>
    );
  }

  if (card.kind === "declined") {
    return (
      <section aria-label={`You declined ${botName}'s request`} className={SETTLED_CARD_CLASS}>
        <p className="flex items-start gap-1.5 text-[15px] break-words text-[var(--personal-text-secondary)]">
          <X aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
          <span>You did not provide {card.label}, so this task stopped.</span>
        </p>
      </section>
    );
  }

  return (
    <section aria-label={`${botName}'s secret request closed`} className={SETTLED_CARD_CLASS}>
      <p className="text-[15px] break-words text-[var(--personal-text-secondary)]">
        This request for {card.label} is no longer waiting.
      </p>
    </section>
  );
}

function PendingSecretRequestCard({
  card,
  botName,
  responding,
  onProvide,
  onDecline,
}: {
  card: Extract<SecretRequestCardItem, { kind: "pending" }>;
  botName: string;
  responding: boolean;
  onProvide: (requestId: string, value: string) => void;
  onDecline: (requestId: string) => void;
}): JSX.Element {
  // Component state, nowhere else. The composer draft store is per-device and
  // unencrypted, so a secret must never reach it; this string lives only until
  // the card unmounts or the value is sent.
  const [value, setValue] = useState("");
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const declineId = `${fieldId}-decline`;
  const request = card.request;
  const purpose = request.purpose.trim();
  const ready = value.length > 0 && !responding;

  return (
    <section aria-label={`${botName} needs a secret`} className={CARD_CLASS}>
      <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--personal-text-secondary)]">
        <KeyRound aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
        <span className="min-w-0 break-words">{botName} needs a secret</span>
      </p>
      <p className="mt-1.5 text-[15px] leading-[1.4] break-words text-[var(--personal-text)]">
        {request.label}
      </p>
      {purpose.length > 0 ? (
        <p className="mt-1 text-[13px] leading-[1.4] break-words text-[var(--personal-text-secondary)]">
          {purpose}
        </p>
      ) : null}

      <label htmlFor={fieldId} className="mt-3 block text-[13px] text-[var(--personal-text)]">
        {request.name}
      </label>
      <input
        id={fieldId}
        type="password"
        value={value}
        disabled={responding}
        // No autofill, no suggestions, no spellcheck upload: this value belongs
        // to the laptop's secret store, not to the phone's keychain.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-describedby={helpId}
        onChange={(event) => setValue(event.target.value)}
        className="mt-1 h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 text-[16px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
      />
      <p id={helpId} className="mt-1.5 text-[13px] text-[var(--personal-text-secondary)]">
        Saved to your computer's secret store as {request.name}. It is never shown in this chat and
        never sent to {botName} as text.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Not "Not now": declining is not a deferral. The server cancels the
            request and fails the task, so the button says what it does. */}
        <button
          type="button"
          disabled={responding}
          aria-describedby={declineId}
          onClick={() => onDecline(card.requestId)}
          className={cn(BUTTON_CLASS, "text-[var(--personal-text-secondary)]")}
        >
          Decline
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            if (!ready) return;
            const provided = value;
            // Cleared before the send so the field never holds the value while
            // the request is in flight.
            setValue("");
            onProvide(card.requestId, provided);
          }}
          className={cn(
            BUTTON_CLASS,
            "ms-auto min-w-24 bg-[var(--personal-primary)] text-[var(--personal-primary-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]",
          )}
        >
          Save secret
        </button>
      </div>
      <p id={declineId} className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">
        Declining stops this task. You can retry it from Tasks later.
      </p>
      {responding ? (
        <p className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">Saving</p>
      ) : null}
    </section>
  );
}
