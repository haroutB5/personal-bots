import type { JSX } from "react";
import { useState } from "react";

import { type EnvironmentId, type PersonalMemoryEntry, PersonalMemoryId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  personalMemoryRestore,
  personalMemoryUndoNote,
  usePersonalMemoryEntry,
} from "./usePersonalAutomation";

type UndoState = "idle" | "busy" | "done";

/** The server's archive reason for a note taken back from its chat line. */
const UNDONE_REASON = "Undone from the chat.";

/**
 * What the line says instead of Undo once there is nothing to undo, from the
 * entry as it is now (so a reload still shows a used Undo as done), or null
 * while Undo still applies or the entry is not loaded.
 */
export function noteUndoSettled(
  undo: "archive" | "restore",
  entry: Pick<PersonalMemoryEntry, "supersededAt" | "supersededReason"> | null,
): string | null {
  if (entry === null) return null;
  const archived = entry.supersededAt != null;
  if (undo === "restore") return archived ? null : "Restored";
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
  undo: "archive" | "restore";
  /** An archived chat: the line reads as it did, with no Undo (like its cards). */
  readOnly?: boolean;
}): JSX.Element {
  const undoNote = useAtomCommand(personalMemoryUndoNote);
  const restore = useAtomCommand(personalMemoryRestore);
  const [state, setState] = useState<UndoState>("idle");
  const [error, setError] = useState<string | null>(null);
  const current = usePersonalMemoryEntry(environmentId, memoryId);
  const settled = noteUndoSettled(undo, current.data ?? null);

  const onUndo = async () => {
    if (state !== "idle" || readOnly) return;
    setState("busy");
    setError(null);
    const input = { memoryId: PersonalMemoryId.make(memoryId) };
    const result =
      undo === "archive"
        ? await undoNote({ environmentId, input })
        : await restore({ environmentId, input });
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
          aria-label={undo === "archive" ? "Undo: archive this note" : "Undo: restore this note"}
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
