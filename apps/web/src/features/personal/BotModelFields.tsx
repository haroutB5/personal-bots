import type { JSX } from "react";
import { useRef, useState } from "react";

import type { ServerProvider } from "@t3tools/contracts";
import { Check } from "lucide-react";

import { modelOptionLabel, searchModels } from "./botFormModel";

export const FIELD_CLASS =
  "w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] aria-invalid:border-[var(--personal-error)]";
export const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-[var(--personal-text)]";

/**
 * Type-to-search model field for providers with long catalogues (OpenCode
 * lists hundreds): a native picker of that length is unusable on a phone.
 */
export function ModelSearchField({
  id = "bot-model",
  models,
  value,
  onChange,
}: {
  /** The input's id, so two pickers on one form keep their labels apart. */
  readonly id?: string;
  readonly models: ServerProvider["models"];
  readonly value: string;
  readonly onChange: (slug: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  // The list stays folded until the field is tapped, so the form below it
  // is not pushed a screen down by a catalogue nobody asked to browse.
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = models.find((model) => model.slug === value);
  const trimmed = query.trim();
  // Browsing shows every model; typing narrows the same list.
  const results = !open ? [] : trimmed.length === 0 ? models : searchModels(models, trimmed, 80);
  const pick = (slug: string) => {
    onChange(slug);
    setQuery("");
    setOpen(false);
  };
  return (
    <div
      ref={containerRef}
      onBlur={(event) => {
        // Moving focus into the list (tapping a model) keeps it open.
        if (containerRef.current?.contains(event.relatedTarget as Node | null)) return;
        setOpen(false);
        setQuery("");
      }}
    >
      <input
        id={id}
        type="search"
        value={query}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            setQuery("");
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          const first = trimmed.length > 0 ? results[0] : undefined;
          if (first !== undefined) pick(first.slug);
        }}
        placeholder={selected === undefined ? "Search models" : modelOptionLabel(selected)}
        aria-autocomplete="list"
        aria-controls={`${id}-results`}
        aria-expanded={results.length > 0}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        className={`${FIELD_CLASS} h-11`}
      />
      <p className="mt-1.5 text-sm text-[var(--personal-text-secondary)]">
        {trimmed.length > 0
          ? results.length === 0
            ? `No models match "${trimmed}".`
            : `${results.length} matching`
          : selected === undefined
            ? `${models.length} models. Pick one, or type to narrow the list.`
            : `Selected: ${modelOptionLabel(selected)}`}
      </p>
      {results.length > 0 ? (
        <ul
          id={`${id}-results`}
          role="listbox"
          aria-label="Models"
          // iOS never focuses a tapped button, so the field's blur would fold
          // the list before the tap lands; keep focus in the field instead.
          onMouseDown={(event) => event.preventDefault()}
          className="mt-1.5 max-h-[264px] divide-y divide-[var(--personal-border)] overflow-y-auto overscroll-contain rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)]"
        >
          {results.map((model) => {
            const isSelected = model.slug === value;
            return (
              <li key={model.slug} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => pick(model.slug)}
                  className={`flex min-h-11 w-full items-center gap-2 px-3.5 py-2 text-left text-[15px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)] ${isSelected ? "font-semibold" : ""}`}
                >
                  <span className="min-w-0 flex-1">{modelOptionLabel(model)}</span>
                  {isSelected ? (
                    <Check aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
