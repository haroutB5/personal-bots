import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { PersonalMemoryEntry } from "@t3tools/contracts";
import { isStatusLike } from "./memoryRetrieval.ts";

const evidenceDecoder = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
export function parseEvidence(value: string | null): ReadonlyArray<string> {
  if (value === null) return [];
  const parsed = evidenceDecoder(value);
  return parsed._tag === "Some" ? parsed.value : [];
}

/** Labels uncertainty explicitly; legacy rows are never rewritten or silently verified. */
export function memoryProvenanceLabel(entry: PersonalMemoryEntry): string {
  if (entry.kind === "preference") {
    return `source: ${entry.source}${entry.originMessageId ? ` | origin: ${entry.originThreadId}/${entry.originMessageId}` : " | originating message not recorded"}`;
  }
  const kind =
    entry.temporalKind ??
    (entry.kind === "task_summary"
      ? "historical"
      : isStatusLike(entry)
        ? "changing"
        : "unclassified fact");
  const parts = [`source: ${entry.source}`, kind];
  if (entry.demoted === "outdated") parts.push("OUTDATED: do not rely on this claim");
  if (entry.conflict) parts.push(`UNRESOLVED CONFLICT: ${entry.conflict}`);
  parts.push(entry.observedAt ? `observed: ${entry.observedAt}` : "observation date unknown");
  parts.push(
    entry.verifiedAt
      ? `verification reported: ${entry.verifiedAt} (not independently certified)`
      : "verification not recorded",
  );
  if (kind === "historical") parts.push("past event, not current state");
  if (kind === "changing") parts.push("recheck the source before stating what is true now");
  if (entry.evidence?.length) parts.push(`evidence: ${entry.evidence.join("; ")}`);
  else parts.push("evidence not recorded");
  if (entry.originMessageId) parts.push(`origin: ${entry.originThreadId}/${entry.originMessageId}`);
  parts.push(`saved: ${DateTime.formatIso(entry.createdAt)}`);
  return parts.join(" | ");
}
