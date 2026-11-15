import * as Schema from "effect/Schema";

import { PersonalProjectHistoryEntry } from "./personalProjects.ts";
import { PersonalTask } from "./personalTasks.ts";

/** How many linked tasks a goal sheet's history read returns. */
export const PERSONAL_PROJECT_HISTORY_TASKS_MAX = 50;

/**
 * A goal's recorded plan changes and its linked tasks. Kept apart from
 * `personalProjects.ts` so the task contract can depend on the project id
 * without a schema cycle.
 */
export const PersonalProjectHistoryResult = Schema.Struct({
  history: Schema.Array(PersonalProjectHistoryEntry),
  /** Linked tasks, newest first. */
  tasks: Schema.Array(PersonalTask),
});
export type PersonalProjectHistoryResult = typeof PersonalProjectHistoryResult.Type;
