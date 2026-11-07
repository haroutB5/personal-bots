import type {
  SecretRequestHistoryEntry,
  SecretRequestOutcome,
} from "@hbots/personal-client/conversation/secretRequestCards";

/** Newest first. Old entries beyond this fall off; the card is a receipt, not a log. */
export const MAX_SECRET_OUTCOME_RECORDS = 200;

const outcomeOf = (value: unknown): SecretRequestOutcome | null =>
  value === "provided" || value === "declined" ? value : null;

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Rebuilds one record from named fields, so an extra property can never ride along. */
export function cleanSecretOutcome(entry: SecretRequestHistoryEntry): SecretRequestHistoryEntry {
  return {
    requestId: entry.requestId,
    threadId: entry.threadId,
    createdAtMs: entry.createdAtMs,
    name: entry.name,
    label: entry.label,
    outcome: entry.outcome,
  };
}

export function appendSecretOutcome(
  history: ReadonlyArray<SecretRequestHistoryEntry>,
  entry: SecretRequestHistoryEntry,
): SecretRequestHistoryEntry[] {
  const next = cleanSecretOutcome(entry);
  return [next, ...history.filter((record) => record.requestId !== next.requestId)].slice(
    0,
    MAX_SECRET_OUTCOME_RECORDS,
  );
}

export function encodeSecretOutcomeHistory(
  history: ReadonlyArray<SecretRequestHistoryEntry>,
): string {
  return JSON.stringify({
    version: 1,
    records: history.slice(0, MAX_SECRET_OUTCOME_RECORDS).map(cleanSecretOutcome),
  });
}

/** Reads the file leniently: one bad record is dropped, the rest still render. */
export function decodeSecretOutcomeHistory(raw: unknown): SecretRequestHistoryEntry[] {
  const records =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { records?: unknown }).records)
      ? (raw as { records: unknown[] }).records
      : [];
  const history: SecretRequestHistoryEntry[] = [];
  for (const value of records) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const requestId = stringOf(entry.requestId);
    const threadId = stringOf(entry.threadId);
    const name = stringOf(entry.name);
    const label = stringOf(entry.label);
    const outcome = outcomeOf(entry.outcome);
    const createdAtMs = entry.createdAtMs;
    if (
      requestId === null ||
      threadId === null ||
      name === null ||
      label === null ||
      outcome === null ||
      typeof createdAtMs !== "number" ||
      !Number.isFinite(createdAtMs) ||
      createdAtMs < 0
    ) {
      continue;
    }
    history.push({ requestId, threadId, createdAtMs, name, label, outcome });
    if (history.length === MAX_SECRET_OUTCOME_RECORDS) break;
  }
  return history;
}
