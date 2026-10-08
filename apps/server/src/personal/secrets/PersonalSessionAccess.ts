import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  personalSecretEnvVar,
  type PersonalBotId,
  type PersonalSecretMode,
  type PersonalSecretPlacement,
  type ThreadId,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { personalBotSystemInstructions } from "../personalBotInstructions.ts";
import * as PersonalSecretRepository from "./PersonalSecretRepository.ts";
import { personalSecretStoreKey } from "./PersonalSecretService.ts";
import { secretAccessLock } from "./secretAccessLock.ts";

/** What a provider session on one thread gets for being a personal bot's thread. */
export interface PersonalSessionGrant {
  /** The bot the thread belongs to; null for every non-personal thread. */
  readonly botId: PersonalBotId | null;
  /**
   * `PB_SECRET_<NAME>` for each fulfilled `env`-mode secret the bot requested,
   * plus every shared one. Read from the secret store when the session
   * starts. A brokered secret is never here: its value does not enter a
   * provider process (see `secretsForThread`).
   */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * The bot's own instructions followed by the app rules, built exactly as
   * the orchestration reactor builds them. ProviderService passes it when it
   * resumes a session outside the reactor (recovery after a restart); fresh
   * starts keep the reactor's own. Null for non-personal threads, a deleted
   * bot, or a failed lookup.
   */
  readonly systemInstructions: string | null;
}

/** One secret a bot can use, with how it may be used. Server-side only. */
export interface PersonalSessionSecret {
  readonly name: string;
  readonly mode: PersonalSecretMode;
  readonly origins: ReadonlyArray<string>;
  /** Where the placeholder may go; absent or `{}` is the Authorization header only. */
  readonly placement?: PersonalSecretPlacement | undefined;
  readonly value: string;
}

const NONE: PersonalSessionGrant = { botId: null, environment: {}, systemInstructions: null };

/**
 * The narrow hook ProviderService consults when it starts a provider session:
 * whether the thread is a personal bot's (the "bots" MCP capability), which
 * secrets reach its process environment, and the bot's session instructions.
 * Never fails: a lookup error grants nothing.
 */
export class PersonalSessionAccess extends Context.Service<
  PersonalSessionAccess,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<PersonalSessionGrant>;
    /**
     * Every secret the thread's bot can use, whatever its mode, with its
     * value: for the server's own tools (the research keys, the
     * `secret_request` broker). Never put in a provider process or a
     * response. Empty for a non-personal thread or a failed lookup.
     */
    readonly secretsForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PersonalSessionSecret>>;
    /**
     * Just the bot's session instructions (no secret reads), for turns sent
     * outside the reactor such as the post-restart continuation. Null for
     * non-personal threads or a failed lookup.
     */
    readonly instructionsForThread: (threadId: ThreadId) => Effect.Effect<string | null>;
  }
>()("t3/personal/secrets/PersonalSessionAccess") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const secrets = yield* PersonalSecretRepository.PersonalSecretRepository;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const decoder = new TextDecoder();

  /** Isolated so a failed instructions read never costs the thread its secrets or grant. */
  const instructionsForThread = (threadId: ThreadId) =>
    bots.getInstructionsForThread({ threadId }).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: personalBotSystemInstructions,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("personal bot instructions lookup failed; starting without them", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );

  /**
   * The secrets a bot can use: its own and every shared one, read from the
   * store. Each secret is the bytes of one physical storage slot together with
   * one access policy: rows that address the same slot (every shared row of a
   * name, a bot's private rows of a name, or a pre-scoping row that falls back
   * to the shared slot) are read as a group. If they disagree (rows saved before
   * the save paths refused that), a brokered row decides over an env one, and
   * the newest brokered row decides among them, so the bytes are never put in
   * a process environment or sent to an origin a row only allowed brokered.
   * Held under the access lock: a save writes bytes and policy in two steps.
   */
  const readSecrets = (botId: PersonalBotId) =>
    secretAccessLock.withPermit(
      Effect.gen(function* () {
        const fulfilled = yield* secrets.listByStatus("fulfilled");
        type Row = (typeof fulfilled)[number];
        const fulfilledMs = (row: Row) =>
          row.fulfilledAt === null ? 0 : DateTime.toEpochMillis(row.fulfilledAt);
        const accessibleNames = new Set(
          fulfilled.filter((row) => row.shared || row.botId === botId).map((row) => row.name),
        );
        const reads = new Map<string, Option.Option<Uint8Array>>();
        const readKey = (key: string) =>
          Effect.gen(function* () {
            const known = reads.get(key);
            if (known !== undefined) return known;
            const found = yield* store.get(key).pipe(
              Effect.catch(() =>
                // The key name only: the value is never logged.
                Effect.logWarning("personal secret unreadable; starting the session without it", {
                  key,
                }).pipe(Effect.as(Option.none<Uint8Array>())),
              ),
            );
            reads.set(key, found);
            return found;
          });
        /** The slot a row's bytes live in: its own key, else (fulfilled before scoping) the name-only key. */
        const slotOf = (row: Row) =>
          Effect.gen(function* () {
            const own = personalSecretStoreKey({
              name: row.name,
              botId: row.botId,
              shared: row.shared,
            });
            const found = yield* readKey(own);
            if (Option.isSome(found)) return { slot: own, bytes: found.value };
            const legacy = personalSecretStoreKey(row.name);
            const fallback = legacy === own ? found : yield* readKey(legacy);
            return Option.isSome(fallback) ? { slot: legacy, bytes: fallback.value } : null;
          });
        const rowSlots = new Map<Row, { slot: string; bytes: Uint8Array } | null>();
        const slotRows = new Map<string, Array<Row>>();
        for (const row of fulfilled) {
          if (!accessibleNames.has(row.name)) continue;
          const resolved = yield* slotOf(row);
          rowSlots.set(row, resolved);
          if (resolved === null) continue;
          slotRows.set(resolved.slot, [...(slotRows.get(resolved.slot) ?? []), row]);
        }
        /** The one row whose policy governs a slot's bytes. */
        const governing = (rows: ReadonlyArray<Row>) => {
          const brokered = rows.filter((row) => row.mode === "brokered");
          const pool = brokered.length > 0 ? brokered : rows;
          return pool.reduce((best, row) => (fulfilledMs(row) >= fulfilledMs(best) ? row : best));
        };
        // One value per name: the bot's own unshared row wins over a shared one
        // when both exist, so an unshared value is never shadowed by a shared one.
        const chosen = new Map<string, Row>();
        for (const row of fulfilled) {
          if (!row.shared && row.botId === botId && !chosen.has(row.name))
            chosen.set(row.name, row);
        }
        for (const row of fulfilled) {
          if (row.shared && !chosen.has(row.name)) chosen.set(row.name, row);
        }
        const accessible: Array<PersonalSessionSecret> = [];
        for (const [name, row] of chosen) {
          const resolved = rowSlots.get(row);
          if (resolved === null || resolved === undefined) continue;
          const policy = governing(slotRows.get(resolved.slot) ?? [row]);
          accessible.push({
            name,
            mode: policy.mode ?? "env",
            origins: policy.origins ?? [],
            placement: policy.placement ?? {},
            value: decoder.decode(resolved.bytes),
          });
        }
        return accessible;
      }),
    );

  const forThread: PersonalSessionAccess["Service"]["forThread"] = (threadId) =>
    Effect.gen(function* () {
      const link = yield* bots.getThreadLink({ threadId });
      if (Option.isNone(link)) {
        return NONE;
      }
      const botId = link.value.botId;
      const environment: Record<string, string> = {};
      for (const secret of yield* readSecrets(botId)) {
        // Brokered values stay on the server; only env-mode keys reach the shell.
        if (secret.mode === "env") environment[personalSecretEnvVar(secret.name)] = secret.value;
      }
      const systemInstructions = yield* instructionsForThread(threadId);
      return { botId, environment, systemInstructions } satisfies PersonalSessionGrant;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("personal session access lookup failed; granting nothing", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(NONE)),
      ),
    );

  const secretsForThread: PersonalSessionAccess["Service"]["secretsForThread"] = (threadId) =>
    Effect.gen(function* () {
      const link = yield* bots.getThreadLink({ threadId });
      return Option.isNone(link) ? [] : yield* readSecrets(link.value.botId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("personal secret lookup failed; granting nothing", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<PersonalSessionSecret>)),
      ),
    );

  return {
    forThread,
    secretsForThread,
    instructionsForThread,
  } satisfies PersonalSessionAccess["Service"];
});

export const layer = Layer.effect(PersonalSessionAccess, make);

/** Self-contained: brings its own (stateless, SQL/file-backed) repositories and store. */
export const layerLive = layer.pipe(
  Layer.provide(PersonalBotRepository.layer),
  Layer.provide(PersonalSecretRepository.layer),
  Layer.provide(ServerSecretStore.layer),
);
