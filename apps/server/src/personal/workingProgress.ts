import { pickProgressNote, toolStepNoteText, type ThreadId, type TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PersonalEngine } from "./engine/PersonalEngine.ts";

/**
 * The latest progress note of each chat whose bot is working, for the Bots
 * list rows (an open chat derives the same note from its own thread). One row
 * per running thread:
 *
 * - the newest thinking / reasoning message written in the running turn
 *   (since the later of the owner's latest message and the latest turn's
 *   request: a turn the server starts on its own has no owner message), first
 *   400 characters;
 * - the newest tool step's TITLE since then (`payload.title`, else the
 *   summary), never its detail, arguments or output.
 *
 * `pickProgressNote` (shared with the client) picks the newer, trims it to one
 * line and blanks secret-looking runs. `toolStep` says the turn has started a
 * tool step, which the list's shells cannot see: it turns a bot from thinking
 * to working (the comet) before its first line of text. Each note carries the id of the turn it
 * was read from (the thread's latest turn, the one its shell reports), so a
 * client holding a note from an earlier turn can tell it is not this turn's. A thread whose session is not running
 * has no row, so a note never outlives its turn.
 */
export const personalWorkingProgress = (
  engine: Pick<PersonalEngine["Service"], "workingSnapshot">,
  threadIds: ReadonlyArray<ThreadId>,
) =>
  Effect.gen(function* () {
    if (threadIds.length === 0) return [];
    const rows = yield* engine.workingSnapshot(threadIds);
    const notes: Array<{
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly note: string;
      readonly toolStep: boolean;
    }> = [];
    for (const row of rows) {
      const toolText = toolStepNoteText(row.toolTitle, row.toolSummary);
      const note = pickProgressNote({
        reasoning:
          row.reasoningText === null
            ? null
            : { text: row.reasoningText, at: row.reasoningAt ?? "" },
        tool: toolText === null ? null : { text: toolText, at: row.toolAt ?? "" },
      });
      if (note !== null) {
        notes.push({
          threadId: row.threadId,
          turnId: row.turnId,
          note,
          toolStep: row.toolAt !== null,
        });
      }
    }
    return notes;
  });
