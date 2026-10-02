import type { JSX } from "react";
import { useState } from "react";

import { type EnvironmentId, PersonalMemoryId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { personalMemoryRestore, personalMemoryUndoNote } from "./usePersonalAutomation";

type UndoState = "idle" | "busy" | "done";

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
}: {
  environmentId: EnvironmentId;
  label: string;
  memoryId: string;
  undo: "archive" | "restore";
}): JSX.Element {
  const undoNote = useAtomCommand(personalMemoryUndoNote);
  const restore = useAtomCommand(personalMemoryRestore);
  const [state, setState] = useState<UndoState>("idle");
  const [error, setError] = useState<string | null>(null);

  const onUndo = async () => {
    if (state !== "idle") return;
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
      {state === "done" ? (
        <span className="font-medium">{undo === "archive" ? "· Undone" : "· Restored"}</span>
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
