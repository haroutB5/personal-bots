import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type {
  PersonalBotId,
  PersonalMemoryEntry,
  PersonalMemoryError,
  PersonalMemoryFeedbackInput,
  PersonalMemoryFeedbackResult,
  PersonalMemoryId,
  PersonalMemoryListInput,
  PersonalMemoryNoteOrigin,
  PersonalMemoryRulesUsage,
  PersonalMemorySearchInput,
  PersonalMemoryTurnContext,
  PersonalMemoryTurnContextInput,
  PersonalMemoryUpdateInput,
  PersonalTask,
  ThreadId,
} from "@t3tools/contracts";

import { makeMemoryCore } from "./memoryCore.ts";
import { makeMemoryPersistence } from "./memoryPersistence.ts";
import { makeMemoryProvenance } from "./memoryProvenance.ts";
import { makeMemoryRetrieval } from "./memoryRetrievalService.ts";
import type {
  PersonalMemoryMatch,
  PersonalMemoryProposal,
  PersonalMemorySaved,
  PersonalMemorySaveInput,
  PersonalMemoryScopeFilter,
} from "./memoryShared.ts";
import type { MemoryTurnTrace } from "./memoryTurnTrace.ts";

// The service was one file until 1.66.2. Its parts moved out unchanged: memoryShared (limits, row decoding, types),
// memoryBlock (the block a bot is shown), memoryCore (dependencies, scope filters, full-text helpers, in-memory
// state), memoryPersistence (writes, undo, proposals, usage, task summaries), memoryRetrievalService (search, what a
// turn is given, usage views), memoryProvenance (where a turn came from) and the pure policies (memoryScopePolicy,
// memoryProvenancePolicy, memoryContextPolicy, memoryAgeingPolicy). Everything this file exported still is.
export {
  PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT,
  PERSONAL_MEMORY_CONTEXT_RELEVANT_LIMIT,
  PERSONAL_MEMORY_CONTEXT_SUMMARY_LIMIT,
  PERSONAL_MEMORY_MAX_PENDING_PER_BOT,
  PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
  PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
  PERSONAL_MEMORY_QUERY_MAX_CHARS,
  PERSONAL_MEMORY_RESEND_EVERY_TURNS,
  PERSONAL_MEMORY_RETRIEVAL_LIMIT,
  PERSONAL_MEMORY_SCORE_FLOOR,
  NOTE_FORGOTTEN_REASON,
  RULE_FORGOTTEN_REASON,
  errorTagOf,
} from "./memoryShared.ts";
export type {
  PersonalMemoryMatch,
  PersonalMemoryProposal,
  PersonalMemorySaved,
  PersonalMemorySaveInput,
  PersonalMemoryScopeFilter,
} from "./memoryShared.ts";
export {
  buildMemoryMatchQuery,
  clipAtSentence,
  formatMemoryBlock,
  MEMORY_BLOCK_HEADER,
  memoryDay,
  memoryRef,
} from "./memoryBlock.ts";
export { capPreferences } from "./memoryScopePolicy.ts";
export { memoryQueryTerms } from "./memoryRetrieval.ts";
export { looksLikeSecret, redactSecrets } from "../secretText.ts";
export type { MemoryTurnTrace };

export class PersonalMemoryService extends Context.Service<
  PersonalMemoryService,
  {
    readonly list: (
      input: PersonalMemoryListInput,
    ) => Effect.Effect<ReadonlyArray<PersonalMemoryEntry>, PersonalMemoryError>;
    /** `list` plus how many entries match in all, for a screen that shows a page at a time. */
    readonly listPage: (input: PersonalMemoryListInput) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<PersonalMemoryEntry>;
        readonly total: number;
      },
      PersonalMemoryError
    >;
    readonly search: (
      input: PersonalMemorySearchInput & PersonalMemoryScopeFilter,
    ) => Effect.Effect<ReadonlyArray<PersonalMemoryEntry>, PersonalMemoryError>;
    /** `created`: false when the same text was already saved and that entry came back. */
    readonly save: (
      input: PersonalMemorySaveInput,
    ) => Effect.Effect<PersonalMemorySaved, PersonalMemoryError>;
    readonly update: (
      input: PersonalMemoryUpdateInput,
    ) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    readonly remove: (input: {
      readonly memoryId: PersonalMemoryId;
    }) => Effect.Effect<void, PersonalMemoryError>;
    /**
     * A bot was asked to forget an entry: it is archived (superseded with no
     * successor), so bots stop receiving it and the owner can still restore it.
     */
    readonly forget: (input: {
      readonly memoryId: PersonalMemoryId;
      readonly actorBotId: PersonalBotId;
      /** Shown on the archived entry; default: at the user's request. */
      readonly reason?: string | undefined;
    }) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    /**
     * The full id for one a bot quoted: a full id, or the short id from its
     * memory block, among entries that bot can see. Fails when unknown or
     * ambiguous.
     */
    readonly resolveRef: (input: {
      readonly ref: string;
      readonly botId: PersonalBotId;
    }) => Effect.Effect<PersonalMemoryId, PersonalMemoryError>;
    /**
     * The owner's own recent messages in a thread (not task briefs, routine
     * prompts, group relays or server notices, which are all written by the
     * app or a bot), newest first, and whether the owner started the thread.
     * save_memory checks a bot's quoted userRequest against these.
     */
    readonly ownerMessages: (threadId: ThreadId) => Effect.Effect<{
      readonly startedByOwner: boolean;
      readonly texts: ReadonlyArray<string>;
      /** The user-role message that started the current turn, and whether the owner wrote it. */
      readonly current: { readonly text: string; readonly byOwner: boolean } | null;
    }>;
    /**
     * Where the turn running now came from (the owner's message, a task, a
     * routine, another bot, an app notice) and whether it used a web or
     * browser tool before this point: a bot-saved note records both.
     */
    readonly noteOrigin: (threadId: ThreadId) => Effect.Effect<{
      readonly origin: PersonalMemoryNoteOrigin;
      readonly readWeb: boolean;
      /** The same for any turn of the thread: a page read earlier can still steer what a bot writes now. */
      readonly threadReadWeb: boolean;
    }>;
    /** One entry, current or archived (not deleted). */
    readonly get: (
      memoryId: PersonalMemoryId,
    ) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    /**
     * Puts a bot's save or forget on the owner's approval list instead of
     * applying it. Returns the change id.
     */
    readonly propose: (input: PersonalMemoryProposal) => Effect.Effect<number, PersonalMemoryError>;
    /** The team a bot is on, for team-scoped saves. */
    readonly teamOfBot: (botId: PersonalBotId) => Effect.Effect<string | null>;
    /** Brings a superseded entry back: bots receive it again. */
    readonly restore: (input: {
      readonly memoryId: PersonalMemoryId;
    }) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    /**
     * Undo on a note's chat line. archive ("Saved a note", the default):
     * archives the note and brings back the notes its save replaced.
     * restore ("Forgot a note"): brings the note back, only if it is still a
     * note archived by a forget. Only ever a note, checked in the same
     * transaction as the change; a second tap changes nothing.
     */
    readonly undoNote: (input: {
      readonly memoryId: PersonalMemoryId;
      readonly undo?: "archive" | "restore" | undefined;
    }) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    /**
     * Current notes and preferences a bot can see that read like the same
     * subject as `content`, closest first: save_memory hands them back so the
     * bot can replace one instead of adding a twin.
     */
    readonly similar: (input: {
      readonly content: string;
      readonly botId: PersonalBotId;
      readonly excludeIds?: ReadonlyArray<PersonalMemoryId> | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<ReadonlyArray<PersonalMemoryMatch>, PersonalMemoryError>;
    /** The bot of a personal-bot thread, or none for ordinary T3 threads. */
    readonly botForThread: (threadId: ThreadId) => Effect.Effect<Option.Option<PersonalBotId>>;
    /**
     * Memory for a turn on a personal-bot thread (shared + that bot, + the
     * project when given), formatted as context for that turn: every
     * preference (capped), then the notes and task summaries relevant to it.
     * `record` logs the ids against the thread's active task attempt.
     * `excludeTaskSummaries` is set for task and routine turns: a task's
     * objective must not carry the bot's summaries of unrelated past tasks.
     */
    readonly contextForThread: (input: {
      readonly threadId: ThreadId;
      readonly query: string;
      readonly projectId?: string | undefined;
      readonly record: boolean;
      readonly excludeTaskSummaries?: boolean | undefined;
      /** The message that starts this turn: left out of the recent turns read for context. */
      readonly messageId?: string | undefined;
      /**
       * The provider session this turn runs in. Given: the full preference
       * list is sent once per session and again only when it changed, after
       * the chat was compacted, or every few turns. Absent: always in full.
       */
      readonly session?: { readonly key: string; readonly fresh: boolean } | undefined;
    }) => Effect.Effect<{
      readonly block: string | null;
      /**
       * The same block without its notes and task summaries: the header and the
       * preferences (or the one-line reminder). Set only when it differs from
       * `block`, i.e. when there are preferences and relevant entries; it is
       * what a turn falls back to when the whole block would not fit.
       */
      readonly preferencesBlock?: string | null;
      readonly memoryIds: ReadonlyArray<PersonalMemoryId>;
      /** What the turn was about and why each entry was picked or left out. */
      readonly trace?: MemoryTurnTrace | undefined;
    }>;
    /**
     * Every current rule a bot can see that is scoped to any of `apps`: what a
     * search that names an app must bring, whatever its words match.
     */
    /**
     * What one turn's memory block held and why (the "Context used" view): the
     * trace recorded when the message `messageId` started its turn, rules as
     * they read now. Null when none was recorded (older than 14 days, or no
     * memory in that turn).
     */
    readonly turnContext: (
      input: PersonalMemoryTurnContextInput,
    ) => Effect.Effect<PersonalMemoryTurnContext | null, PersonalMemoryError>;
    /**
     * The owner marks a note or task summary outdated or not relevant (ranked
     * lower from now on, never deleted), or clears the mark. Rules are not
     * marked: they change only through an approval.
     */
    readonly setFeedback: (
      input: PersonalMemoryFeedbackInput,
    ) => Effect.Effect<PersonalMemoryFeedbackResult, PersonalMemoryError>;
    readonly rulesForApps: (input: {
      readonly botId: PersonalBotId;
      readonly apps: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<PersonalMemoryEntry>, PersonalMemoryError>;
    /**
     * How full the most rules any bot can receive at once are against the
     * per-turn caps (every app counted as active), for the Memory screen.
     */
    readonly rulesUsage: () => Effect.Effect<PersonalMemoryRulesUsage, PersonalMemoryError>;
    /**
     * The provider accepted the turn contextForThread last built for this
     * thread, with its preferences in front of the prompt: only now does that
     * session count as having the preference list (or one more reminder turn).
     * A send that failed, or that went without the block, leaves the full list
     * due.
     */
    readonly confirmPreferencesSent: (threadId: ThreadId) => Effect.Effect<void>;
    /** Stores a labelled summary of a completed task (idempotent per task). */
    readonly saveTaskSummary: (task: PersonalTask) => Effect.Effect<void>;
    /** Saves task summaries as tasks complete. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/personal/memory/PersonalMemoryService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const core = yield* makeMemoryCore();
  const provenance = makeMemoryProvenance(core);
  const persistence = makeMemoryPersistence(core);
  const retrieval = makeMemoryRetrieval(core, persistence);

  return {
    list: persistence.list,
    listPage: persistence.listPage,
    search: retrieval.search,
    save: persistence.save,
    update: persistence.update,
    remove: persistence.remove,
    forget: persistence.forget,
    resolveRef: persistence.resolveRef,
    ownerMessages: provenance.ownerMessages,
    noteOrigin: provenance.noteOrigin,
    undoNote: persistence.undoNote,
    get: persistence.get,
    propose: persistence.propose,
    teamOfBot: core.teamOfBot,
    restore: persistence.restore,
    similar: retrieval.similar,
    botForThread: core.botForThread,
    contextForThread: retrieval.contextForThread,
    turnContext: retrieval.turnContext,
    setFeedback: persistence.setFeedback,
    rulesForApps: retrieval.rulesForApps,
    rulesUsage: retrieval.rulesUsage,
    confirmPreferencesSent: retrieval.confirmPreferencesSent,
    saveTaskSummary: persistence.saveTaskSummary,
    start: persistence.start,
  } satisfies PersonalMemoryService["Service"];
});

export const layer = Layer.effect(PersonalMemoryService, make);
