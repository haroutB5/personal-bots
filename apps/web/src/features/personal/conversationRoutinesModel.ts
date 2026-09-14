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
