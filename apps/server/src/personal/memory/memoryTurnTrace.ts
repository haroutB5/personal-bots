import * as Schema from "effect/Schema";

/**
 * What one turn's memory block held and why: built when the turn starts,
 * stored beside the turn's usage row (`personal_memory_usage.trace_json`) for
 * 14 days, and read back by the "Context used" view. Plain strings and numbers
 * only, so it round-trips as JSON.
 */
export const MemoryTurnTrace = Schema.Struct({
  /** The apps the turn was about, and where each was found. */
  activeApps: Schema.Array(
    Schema.Struct({ slug: Schema.String, via: Schema.Array(Schema.String) }),
  ),
  /** Rules listed in full this turn: global, and of an active app. */
  rules: Schema.Struct({ global: Schema.Number, scoped: Schema.Number }),
  /** Rule groups of other apps counted in the index line. */
  appIndex: Schema.Array(Schema.Struct({ slug: Schema.String, count: Schema.Number })),
  /** The index line as the bot read it, or null. */
  appIndexLine: Schema.NullOr(Schema.String),
  /** Rules of an active app that did not fit the caps. */
  rulesLeftOut: Schema.Array(Schema.String),
  /** Every rule that applied this turn, global and of an active app. */
  rulesListed: Schema.Array(Schema.String),
  /** False on a reminder turn: the list was sent earlier in the session. */
  rulesSent: Schema.Boolean,
  /** Rules sent on top of an earlier list (a chat that started covering another app). */
  rulesAdded: Schema.Array(Schema.String),
  /** The words searched, and whether the message alone was too thin so the chat led. */
  query: Schema.Struct({ terms: Schema.Array(Schema.String), followUp: Schema.Boolean }),
  picked: Schema.Array(
    Schema.Struct({
      memoryId: Schema.String,
      kind: Schema.String,
      score: Schema.Number,
      why: Schema.Array(Schema.String),
      /** The opening of the entry as it was given. */
      snippet: Schema.String,
      provenance: Schema.optional(Schema.String),
    }),
  ),
  leftOut: Schema.Array(
    Schema.Struct({
      memoryId: Schema.String,
      kind: Schema.String,
      reason: Schema.String,
      snippet: Schema.String,
      provenance: Schema.optional(Schema.String),
    }),
  ),
});
export type MemoryTurnTrace = typeof MemoryTurnTrace.Type;

/** Longest snippet kept for a picked entry, and for one left out. */
export const TRACE_PICKED_SNIPPET_CHARS = 160;
export const TRACE_LEFT_OUT_SNIPPET_CHARS = 90;
/** Most left-out entries a trace names; the rest are only counted by the cap. */
export const TRACE_LEFT_OUT_MAX = 12;
/** How long a turn's trace is kept (its usage row stays). */
export const TRACE_KEEP_DAYS = 14;

export const encodeTraceJson = Schema.encodeEffect(Schema.fromJsonString(MemoryTurnTrace));
export const decodeTraceJson = Schema.decodeUnknownOption(Schema.fromJsonString(MemoryTurnTrace));

/** A snippet: one line, cut at a word. */
export function snippetOf(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}â€¦`;
}
