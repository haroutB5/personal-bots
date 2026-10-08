import type { JSX } from "react";
import { useState } from "react";

import {
  type EnvironmentId,
  isBotRuleSource,
  type PersonalMemoryEntry,
  PersonalMemoryId,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { personalMemoryUndoNote, usePersonalMemoryEntry } from "./usePersonalAutomation";

type UndoState = "idle" | "busy" | "done";

/** The server's archive reason for a note taken back from its chat line. */
const UNDONE_REASON = "Undone from the chat.";
/** The server's archive reasons for a forgotten entry: only these can a "Forgot a note" Undo bring back. */
const FORGOTTEN_REASONS: ReadonlySet<string> = new Set([
  "Forgotten at the user's request.",
  "Forgotten by a bot (a note it found out of date).",
]);

/** The server's reason for an entry a save into an existing entry replaced (1.66.7): only this is brought back by "Replaced a note". */
const REPLACED_REASON = "Replaced by a newer save.";

/** The server's reason for a rule a bot forgot at the owner's word (1.60.42): only this brings a rule back. */
const RULE_FORGOTTEN_REASON = "Forgotten by a bot at the user's word.";

/**
 * What the line says instead of Undo once there is nothing to undo, from the
 * entry as it is now (so a reload still shows a used Undo as done), or null
 * while Undo still applies or the entry is not loaded. A "Saved a rule" line
 * (1.60.42) is for a preference the server saved with a rule source; a "Forgot
 * a rule" line is for a preference archived with the rule-forgotten reason,
 * whatever its source (most live rules predate rule sources). A note that
 * became a rule since, or a rule saved another way, has no such Undo.
 */
export function noteUndoSettled(
  undo: "archive" | "restore" | "unreplace",
  entry:
    | (Pick<PersonalMemoryEntry, "kind" | "supersededAt" | "supersededReason"> & {
        readonly source?: string;
      })
    | null,
  line: "note" | "rule" = "note",
): string | null {
  if (entry === null) return null;
  if (undo === "unreplace") {
    // "Replaced a note/rule" (1.66.7): Undo brings back the entry a save archived, only while a replacement still holds it.
    if (entry.kind !== (line === "rule" ? "preference" : "note")) {
      return line === "rule" ? "No longer a rule" : "No longer a note";
    }
    if (entry.supersededAt == null) return "Restored";
    return entry.supersededReason === REPLACED_REASON ? null : "Archived";
  }
  if (line === "rule") {
    if (entry.kind !== "preference") return "No longer a rule";
    const archived = entry.supersededAt != null;
    if (undo === "restore") {
      if (!archived) return "Restored";
      return entry.supersededReason === RULE_FORGOTTEN_REASON ? null : "Archived";
    }
    if (!isBotRuleSource(entry.source ?? "")) return "No longer a saved rule";
    if (!archived) return null;
    return entry.supersededReason === UNDONE_REASON ? "Undone" : "Archived";
  }
  // Made a rule since: a note's Undo never touches it.
  if (entry.kind !== "note") return "No longer a note";
  const archived = entry.supersededAt != null;
  if (undo === "restore") {
    if (!archived) return "Restored";
    return FORGOTTEN_REASONS.has(entry.supersededReason ?? "") ? null : "Archived";
  }
  if (!archived) return null;
  return entry.supersededReason === UNDONE_REASON ? "Undone" : "Archived";
}

/**
 * "Saved a note: ..." / "Forgot a note: ..." in a bot chat, with Undo: a
 * saved note is archived (what it replaced comes back), a forgotten one is
 * restored. Tapping again after a reload changes nothing.
 */
export function NoteNoticeRow({
  environmentId,
  label,
  memoryId,
  undo,
  readOnly = false,
}: {
  environmentId: EnvironmentId;
  label: string;
  memoryId: string;
  undo: "archive" | "restore" | "unreplace";
  /** An archived chat: the line reads as it did, with no Undo (like its cards). */
  readOnly?: boolean;
}): JSX.Element {
  const undoNote = useAtomCommand(personalMemoryUndoNote);
  const [state, setState] = useState<UndoState>("idle");
  const [error, setError] = useState<string | null>(null);
  const current = usePersonalMemoryEntry(environmentId, memoryId);
  // "Saved a rule: ..." / "Forgot a rule: ..." (1.60.42) read the entry as a rule; a note line never does.
  const what = /^(?:Saved|Forgot|Replaced) a rule\b/.test(label) ? "rule" : "note";
  const settled = noteUndoSettled(undo, current.data ?? null, what);

  const onUndo = async () => {
    if (state !== "idle" || readOnly) return;
    setState("busy");
    setError(null);
    // Both directions go through the note-only Undo, never the generic restore.
    const result = await undoNote({
      environmentId,
      input: { memoryId: PersonalMemoryId.make(memoryId), undo },
    });
    const message = commandFailureMessage(result, "Could not undo that.");
    setState(message === null ? "done" : "idle");
    setError(message);
  };

  return (
    <div
      data-testid="chat-notice"
      className="mx-auto max-w-[90%] text-center text-[13px] leading-[18px] text-[var(--personal-text-secondary)]"
    >
      <span className="break-words">{label}</span>{" "}
      {readOnly ? null : state === "done" || settled !== null ? (
        <span className="font-medium">
          · {state === "done" ? (undo === "archive" ? "Undone" : "Restored") : settled}
        </span>
      ) : (
        <button
          type="button"
          disabled={state === "busy"}
          aria-busy={state === "busy"}
          aria-label={`${undo === "archive" ? "Undo: archive" : "Undo: restore"} this ${what}`}
          onClick={() => void onUndo()}
          className={cn(
            "-my-3 inline-flex min-h-11 items-center rounded-[var(--personal-radius-button)] px-1.5 font-semibold text-[var(--personal-text)] underline underline-offset-2 disabled:opacity-60",
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
          )}
        >
          {state === "busy" ? "Undoing…" : "Undo"}
        </button>
      )}
      {error !== null ? (
        <span role="alert" className="mt-1 block text-[var(--personal-error)]">
          {error}
        </span>
      ) : null}
    </div>
  );
}
