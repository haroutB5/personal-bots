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

/** Bound and flatten untrusted stored fields before placing them in a prompt. */
export const safeMemoryField = (value: string, limit = 500): string =>
  value
    .replace(/\s+/g, " ")
    .replace(/[\[\]\x00-\x1f\x7f-\x9f]/g, "")
    .trim()
    .slice(0, limit);

/** Labels uncertainty explicitly; legacy rows are never rewritten or silently verified. */
export function memoryProvenanceLabel(entry: PersonalMemoryEntry, ownerView = false): string {
  if (entry.kind === "preference") {
    return ownerView && entry.originMessageId
      ? `origin: ${safeMemoryField(entry.originThreadId ?? "", 100)}/${safeMemoryField(entry.originMessageId, 100)}`
      : "";
  }
  const kind =
    entry.temporalKind ??
    (entry.kind === "task_summary"
      ? "historical"
      : isStatusLike(entry)
        ? "changing"
        : "unclassified fact");
  const parts = [`source: ${safeMemoryField(entry.source, 160)}`, safeMemoryField(kind, 40)];
  if (entry.demoted === "outdated") parts.push("OUTDATED: do not rely on this claim");
  if (entry.conflict) parts.push(`UNRESOLVED CONFLICT: ${safeMemoryField(entry.conflict, 300)}`);
  parts.push(
    entry.observedAt
      ? `observed: ${safeMemoryField(entry.observedAt, 40)}`
      : "observation date unknown",
  );
  parts.push(
    entry.verifiedAt
      ? `verification reported: ${safeMemoryField(entry.verifiedAt, 40)} (not independently certified)`
      : "verification not recorded",
  );
  if (kind === "historical") parts.push("past event, not current state");
  if (kind === "changing") parts.push("recheck the source before stating what is true now");
  if (entry.evidence?.length)
    parts.push(
      `evidence: ${entry.evidence
        .slice(0, 8)
        .map((ref) => safeMemoryField(ref))
        .join("; ")}`,
    );
  else parts.push("evidence not recorded");
  if (ownerView && entry.originMessageId)
    parts.push(
      `origin: ${safeMemoryField(entry.originThreadId ?? "", 100)}/${safeMemoryField(entry.originMessageId, 100)}`,
    );
  parts.push(`saved: ${DateTime.formatIso(entry.createdAt)}`);
  return parts.join(" | ");
}
