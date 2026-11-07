import type { PersonalTaskWorkRecord } from "@t3tools/contracts";

/** Whether the record holds anything the bot or the server added beyond the objective. */
export function workRecordIsEmpty(record: PersonalTaskWorkRecord): boolean {
  return (
    record.decisions.length === 0 &&
    record.evidence.length === 0 &&
    record.outstanding.length === 0 &&
    record.nextStep.length === 0 &&
    record.lastResult.length === 0 &&
    record.updates.length === 0
  );
}
