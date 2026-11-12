import type { JSX } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import {
  instructionsCollapsedHeight,
  instructionsExpandedAfter,
  instructionsFieldView,
} from "@hbots/personal-client/bots/instructionsField";

import { FIELD_CLASS, LABEL_CLASS } from "./BotModelFields";

interface Measure {
  readonly contentHeight: number;
  readonly collapsedHeight: number;
  readonly borderHeight: number;
}

/** Collapsed height used until the box is measured: six lines of the field's text. */
const FALLBACK_COLLAPSED_HEIGHT = instructionsCollapsedHeight(22, 20);

const px = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The bot's instructions. They run to pages, so the box opens on its first
 * lines; a click in the box or "Show all" opens it to its full text. The same
 * textarea stays mounted either way and the text lives in the form's draft, so
 * no edit is lost. The change is a plain layout step with no transition, which
 * is also the reduced motion behaviour.
 */
export function BotInstructionsField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [measure, setMeasure] = useState<Measure | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the textarea's DOM box (text height, line height, padding) after each render; equal measures keep the same state
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const style = getComputedStyle(element);
    const padding = px(style.paddingTop) + px(style.paddingBottom);
    const borderHeight = px(style.borderTopWidth) + px(style.borderBottomWidth);
    // scrollHeight never reads below the box's own height, so measure from zero.
    const previous = element.style.height;
    element.style.height = "0px";
    const contentHeight = element.scrollHeight;
    element.style.height = previous;
    const next = {
      contentHeight,
      collapsedHeight: instructionsCollapsedHeight(px(style.lineHeight) || 22, padding),
      borderHeight,
    };
    setMeasure((current) =>
      current !== null &&
      current.contentHeight === next.contentHeight &&
      current.collapsedHeight === next.collapsedHeight &&
      current.borderHeight === next.borderHeight
        ? current
        : next,
    );
  });

  const view = instructionsFieldView({
    expanded,
    contentHeight: measure?.contentHeight ?? null,
    collapsedHeight: measure?.collapsedHeight ?? FALLBACK_COLLAPSED_HEIGHT,
  });
  const border = measure?.borderHeight ?? 0;
  const height =
    view.clipHeight !== null
      ? Math.min(view.clipHeight, Math.max(measure?.contentHeight ?? view.clipHeight, 120)) + border
      : Math.max(measure?.contentHeight ?? 120, 120) + border;

  return (
    <div>
      <label htmlFor="bot-instructions" className={LABEL_CLASS}>
        Instructions
      </label>
      <div className="relative">
        <textarea
          ref={ref}
          id="bot-instructions"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setExpanded((current) => instructionsExpandedAfter(current, "focus"))}
          placeholder="How the bot should work and respond"
          aria-expanded={view.control === null ? undefined : expanded}
          style={{ height }}
          className={`${FIELD_CLASS} block resize-none overflow-hidden py-2.5 leading-snug`}
        />
        {view.fade ? (
          <div
            aria-hidden="true"
            data-instructions-fade=""
            className="pointer-events-none absolute inset-x-px bottom-px h-12 rounded-b-[var(--personal-radius-button)] bg-gradient-to-t from-[var(--personal-fill-muted)] to-transparent"
          />
        ) : null}
      </div>
      {view.control === null ? null : (
        <button
          type="button"
          aria-controls="bot-instructions"
          aria-expanded={expanded}
          onClick={() => {
            // "Show less" leaves the box, so the next click in it opens it again.
            if (expanded) ref.current?.blur();
            setExpanded((current) => instructionsExpandedAfter(current, "toggle"));
          }}
          className="inline-flex min-h-[44px] items-center text-[15px] font-medium text-[var(--personal-text)] underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
        >
          {view.control}
        </button>
      )}
    </div>
  );
}
