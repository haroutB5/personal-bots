import type { JSX } from "react";
import { useState } from "react";

import { plainMemoryText } from "./memoryPresentation";

/** Past this many characters an entry is folded to five lines. */
const MEMORY_FOLD_CHARS = 280;

/**
 * One entry's text. A wrap-up summary runs to 30 lines, and unfolded it
 * filled the phone screen on its own, so long entries open folded with a
 * "Show more" to read the rest in place.
 */
export function MemoryContent({ content }: { readonly content: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = content.length > MEMORY_FOLD_CHARS;
  return (
    <>
      <p
        className={`mt-1.5 text-[15px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)] ${
          long && !open ? "line-clamp-5" : ""
        }`}
      >
        {plainMemoryText(content)}
      </p>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="-my-2 min-h-11 rounded-[var(--personal-radius-button)] text-[14px] font-medium text-[var(--personal-text)] underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}
