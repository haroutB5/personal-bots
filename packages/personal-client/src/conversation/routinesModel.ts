import type { PersonalRoutine } from "@t3tools/contracts";

const CHAT_ROUTINE_LIMIT = 3;

/** Preserve the server's Scheduled ordering while limiting this bot's chat preview. */
export function routinesForBot(
  routines: ReadonlyArray<PersonalRoutine>,
  botId: string,
): ReadonlyArray<PersonalRoutine> {
  const matching: Array<PersonalRoutine> = [];
  for (const routine of routines) {
    if (routine.botId !== botId) continue;
    matching.push(routine);
    if (matching.length === CHAT_ROUTINE_LIMIT) break;
  }
  return matching;
}

/**
 * A bot's own routines for its settings page: every routine it runs, enabled
 * ones first (both groups in the server's Scheduled order), so the ones that
 * will actually fire are at the top and paused ones sink below them.
 */
export function botSettingsRoutines(
  routines: ReadonlyArray<PersonalRoutine>,
  botId: string,
): ReadonlyArray<PersonalRoutine> {
  const matching = routines.filter((routine) => routine.botId === botId);
  return [
    ...matching.filter((routine) => routine.enabled),
    ...matching.filter((routine) => !routine.enabled),
  ];
}
