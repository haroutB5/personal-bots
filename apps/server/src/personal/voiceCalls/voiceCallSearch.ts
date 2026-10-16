/**
 * Pure helpers for the voice call's search fallback.
 *
 * Google's live Search tool runs on the same free-tier key as the voice model
 * and has its own daily quota. When it runs out the call must not fail: the
 * server remembers it (`personal_meta`) and answers searches itself through
 * the keyless web search the bots already use. Google resets its daily quotas
 * at midnight Pacific time, so the memory lapses then and Search is tried
 * again.
 */
import {
  VOICE_CALL_SEARCH_QUERY_CHARS,
  VOICE_CALL_SEARCH_RESULTS_MAX,
  VOICE_CALL_SEARCH_SNIPPET_CHARS,
  VOICE_CALL_SEARCH_TITLE_CHARS,
  VOICE_CALL_SEARCH_URL_CHARS,
  type VoiceCallSearchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  createResearchClient,
  type ResearchEvent,
  type ResearchProviderMode,
  type ResearchResult,
} from "../research/researchClient.ts";

/** `personal_meta` key: when Google Search was last seen out of quota (ISO). */
export const VOICE_SEARCH_QUOTA_META_KEY = "voice_call_google_search_quota_at";

const PACIFIC = "America/Los_Angeles";
const DAY_MS = 86_400_000;

const pacificParts = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** The Pacific wall clock at an instant, read back as if it were UTC. */
const pacificWallAsUtcMs = (atMs: number): number => {
  const fields: Record<string, number> = {};
  for (const part of pacificParts.formatToParts(atMs)) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return Date.UTC(
    fields.year ?? 1970,
    (fields.month ?? 1) - 1,
    fields.day ?? 1,
    fields.hour ?? 0,
    fields.minute ?? 0,
    fields.second ?? 0,
  );
};

/** Pacific's offset from UTC at an instant, ms (negative: Pacific is behind). */
const pacificOffsetMs = (atMs: number): number =>
  pacificWallAsUtcMs(Math.floor(atMs / 1000) * 1000) - Math.floor(atMs / 1000) * 1000;

/**
 * The first instant after `atMs` at which the Pacific clock reads 00:00, which
 * is when Google's daily quota resets. Daylight saving is handled by asking
 * the time zone for its offset at the target, not by assuming one.
 */
export const nextPacificMidnightMs = (atMs: number): number => {
  // Midnight that starts the next Pacific calendar day, as a wall-clock value
  // (the wall clock is read as if it were UTC, so days are whole multiples).
  const nextWall = (Math.floor(pacificWallAsUtcMs(atMs) / DAY_MS) + 1) * DAY_MS;
  // First guess with the offset now; correct it once if the offset differs at
  // the target (the day of a clock change).
  let candidate = nextWall - pacificOffsetMs(atMs);
  const corrected = nextWall - pacificOffsetMs(candidate);
  if (corrected !== candidate) candidate = corrected;
  return candidate;
};

/**
 * True while a remembered "Search is out of quota" still holds: it was noted
 * at `notedAtIso` and lapses at the next Pacific midnight after that moment.
 * An unreadable value counts as nothing remembered.
 */
export const searchQuotaStillHolds = (notedAtIso: string | null, nowMs: number): boolean => {
  if (notedAtIso === null) return false;
  const notedMs = Date.parse(notedAtIso);
  if (!Number.isFinite(notedMs)) return false;
  return nowMs < nextPacificMidnightMs(notedMs);
};

/** One provider row as the research client returns it. */
export interface RawSearchSource {
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly content?: string | undefined;
}

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

/** The query as the voice spoke it: one line, bounded, nothing else. */
export const cleanSearchQuery = (query: string): string =>
  oneLine(query, VOICE_CALL_SEARCH_QUERY_CHARS);

/**
 * A handful of short results the voice can say out loud. Capped in count and
 * per field so the whole tool reply stays small, and a row with no readable
 * text is dropped rather than read as silence.
 */
export const shapeSearchResults = (
  sources: ReadonlyArray<RawSearchSource>,
): ReadonlyArray<VoiceCallSearchResult> => {
  const rows: Array<VoiceCallSearchResult> = [];
  for (const source of sources) {
    const snippet = oneLine(source.content ?? "", VOICE_CALL_SEARCH_SNIPPET_CHARS);
    const title = oneLine(source.title ?? "", VOICE_CALL_SEARCH_TITLE_CHARS);
    if (snippet.length === 0 && title.length === 0) continue;
    rows.push({
      title,
      snippet,
      url: oneLine(source.url ?? "", VOICE_CALL_SEARCH_URL_CHARS),
    });
    if (rows.length >= VOICE_CALL_SEARCH_RESULTS_MAX) break;
  }
  return rows;
};

/**
 * The web search the voice answers `search_web` with: the very client the bots'
 * own `search_web` tool uses (Parallel's free search first, Tavily when a key is
 * saved). It is a service so a test supplies its own and never opens a socket.
 */
export class VoiceCallWebSearch extends Context.Service<
  VoiceCallWebSearch,
  {
    /** The provider switch as of now: Tavily-only needs a saved key. */
    readonly providerMode: () => ResearchProviderMode;
    readonly search: (input: {
      /** The bot the call belongs to; research dedupes in-flight work per scope. */
      readonly scope: string;
      /** The saved Tavily key, if any. */
      readonly key: string | undefined;
      readonly query: string;
      readonly signal: AbortSignal;
    }) => Promise<ResearchResult>;
  }
>()("t3/personal/voiceCalls/voiceCallSearch/VoiceCallWebSearch") {}

export const layerLive: Layer.Layer<VoiceCallWebSearch> = Layer.effect(
  VoiceCallWebSearch,
  Effect.gen(function* () {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    // One line per call: which provider served it, never the query or a URL.
    const logResearch = (event: ResearchEvent) =>
      (event.outcome === "failed" ? Effect.logWarning : Effect.logInfo)(
        "personal voice call research",
        event,
      );
    const research = createResearchClient(undefined, {
      onEvent: (event) => void runFork(logResearch(event)),
    });
    return VoiceCallWebSearch.of({
      providerMode: () => research.providerMode(),
      search: async ({ scope, key, query, signal }) => {
        const [result] = await research.search(scope, key, [query], {}, signal);
        return (
          result ?? {
            request: query,
            provider: "parallel",
            retrievedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            sources: [],
            error: "No answer.",
          }
        );
      },
    });
  }),
);
