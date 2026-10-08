import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import {
  personalSecretPlaceholder,
  PERSONAL_SECRET_MAX_VALUE_BYTES,
  PersonalSecretRequestId,
  normalizePersonalSecretOrigins,
  normalizePersonalSecretPlacement,
  PERSONAL_SECRET_WELL_KNOWN_ORIGINS,
  unverifiedPersonalSecretOrigins,
  type PersonalSecretMode,
  type PersonalSecretPlacement,
  type PersonalSecretModeInput,
  PersonalSecretsError,
  personalSecretEnvVar,
  PersonalBotId,
  type PersonalSecretCreateInput,
  type PersonalSecretFulfillInput,
  type PersonalSecretRequest,
  type PersonalSecretsListPendingResult,
  type PersonalSecretsListResult,
  type PersonalSecretSummary,
  type PersonalSecretSharingInput,
  type PersonalTask,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalSecretRepository from "./PersonalSecretRepository.ts";
import { secretAccessLock } from "./secretAccessLock.ts";
import { secretRedactor } from "./secretRedaction.ts";

/**
 * Server secret store key of a fulfilled secret. `name` is UPPER_SNAKE-validated.
 *
 * Unshared secrets are scoped by owning bot so one bot's value can never
 * overwrite another bot's value of the same name. Shared secrets keep the
 * legacy name-only key, so values fulfilled before scoping still resolve.
 */
export const personalSecretStoreKey = (
  input:
    | string
    | { readonly name: string; readonly botId: PersonalBotId; readonly shared?: boolean },
): string => {
  if (typeof input === "string" || input.shared === true) {
    return `personal-secret-${typeof input === "string" ? input : input.name}`;
  }
  return `personal-secret-${input.botId}-${input.name}`;
};

/**
 * The owner is not a bot, but a row needs an id. These are reserved and match
 * no real bot or thread, so a key the owner saved is never attributed to one.
 */
export const OWNER_SAVED_BOT_ID = PersonalBotId.make("owner-saved");
const OWNER_SAVED_THREAD_ID = ThreadId.make("owner-saved");

/** Request rows carry the owner scope; the store key is derived from them. */
interface SecretOwnerScope {
  readonly name: string;
  readonly botId: PersonalBotId;
  readonly shared: boolean;
}

/**
 * The continuation a task resumes with once its secrets are in; names only,
 * never values. A brokered key is used through `secret_request` and has no
 * environment variable, so the note says which way each name goes.
 */
export const secretAvailableNote = (
  names: ReadonlyArray<string | { readonly name: string; readonly mode: PersonalSecretMode }>,
) =>
  names
    .map((entry) => {
      const { name, mode } = typeof entry === "string" ? { name: entry, mode: "env" } : entry;
      return mode === "brokered"
        ? `Secret ${name} is now saved. Use it only through the secret_request tool by writing ${personalSecretPlaceholder(name)} in the Authorization header (the URL or body only if the owner allowed that for this key); the server adds it and never shows it to you.`
        : `Secret ${name} is now available as the environment variable ${personalSecretEnvVar(name)} in new shell commands. Do not print it.`;
    })
    .join("\n");

/** The origins a bot named for a key it asks for; anything unusable is dropped, never an error. */
const hintedOrigins = (
  name: string,
  origins: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  const named = origins === undefined ? [] : (normalizePersonalSecretOrigins(origins) ?? []);
  return named.length > 0 ? named : (PERSONAL_SECRET_WELL_KNOWN_ORIGINS[name] ?? []);
};

/**
 * One placement to show for several rows of one name: the widest of them, so
 * the Settings list never reads stricter than a row really is. A header or
 * `anywhere` any row has counts; a path prefix or method list shows only when
 * every row has the same one.
 */
const widestPlacement = (
  previous: PersonalSecretPlacement | undefined,
  next: PersonalSecretPlacement,
): PersonalSecretPlacement => {
  if (previous === undefined) return next;
  const header = previous.header ?? next.header;
  const pathPrefix = previous.pathPrefix === next.pathPrefix ? next.pathPrefix : undefined;
  const sameMethods =
    (previous.methods ?? []).join(",") === (next.methods ?? []).join(",")
      ? next.methods
      : undefined;
  return {
    ...(header === undefined ? {} : { header }),
    ...(previous.anywhere === true || next.anywhere === true ? { anywhere: true } : {}),
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    ...(sameMethods === undefined ? {} : { methods: sameMethods }),
  };
};

/**
 * Whether two rows grant the same access: mode, origins (as a set) and placement.
 * Rows that share one stored value must agree, so the value is only ever
 * reachable the way its own save allowed.
 */
const samePolicy = (
  left: {
    readonly mode?: PersonalSecretMode | undefined;
    readonly origins?: ReadonlyArray<string> | undefined;
    readonly placement?: PersonalSecretPlacement | undefined;
  },
  right: {
    readonly mode?: PersonalSecretMode | undefined;
    readonly origins?: ReadonlyArray<string> | undefined;
    readonly placement?: PersonalSecretPlacement | undefined;
  },
): boolean => {
  const key = (access: typeof left) =>
    JSON.stringify([
      access.mode ?? "env",
      [...new Set(access.origins ?? [])].toSorted(),
      access.placement?.header ?? null,
      access.placement?.anywhere === true,
      access.placement?.pathPrefix ?? null,
      [...(access.placement?.methods ?? [])].toSorted(),
    ]);
  return key(left) === key(right);
};

/** Switch for the 1.66.0 default; `PERSONAL_SECRET_DEFAULT_MODE=env` restores the old default. */
export const defaultNewSecretMode = (env: NodeJS.ProcessEnv = process.env): PersonalSecretMode =>
  (env.PERSONAL_SECRET_DEFAULT_MODE ?? env.T3CODE_PERSONAL_SECRET_DEFAULT_MODE)
    ?.trim()
    .toLowerCase() === "env"
    ? "env"
    : "brokered";

export interface PersonalSecretRequestResult {
  readonly request: PersonalSecretRequest;
  /** "fulfilled" when a stored secret already answers the request; the task keeps running. */
  readonly status: "pending" | "fulfilled";
}

export class PersonalSecretService extends Context.Service<
  PersonalSecretService,
  {
    /** Records a bot's request and parks its task until the user answers. */
    readonly request: (input: {
      readonly task: PersonalTask;
      readonly threadId: ThreadId;
      readonly botId: PersonalBotId;
      readonly name: string;
      readonly label: string;
      readonly purpose: string;
      /** The HTTPS origins the key is for, as the bot names them; shown to the owner to confirm. */
      readonly origins?: ReadonlyArray<string>;
    }) => Effect.Effect<PersonalSecretRequestResult, PersonalSecretsError>;
    readonly listPending: () => Effect.Effect<
      PersonalSecretsListPendingResult,
      PersonalSecretsError
    >;
    /** Stores the value (secret store only), then resumes the task in a fresh session. */
    readonly fulfill: (
      input: PersonalSecretFulfillInput,
    ) => Effect.Effect<PersonalSecretRequest, PersonalSecretsError>;
    /** Cancels a pending request and fails the task that asked. */
    readonly cancel: (input: {
      readonly requestId: PersonalSecretRequestId;
    }) => Effect.Effect<PersonalSecretRequest, PersonalSecretsError>;
    /** Saves a key the owner typed themselves, with no bot having asked. */
    readonly create: (
      input: PersonalSecretCreateInput,
    ) => Effect.Effect<PersonalSecretRequest, PersonalSecretsError>;
    readonly list: () => Effect.Effect<PersonalSecretsListResult, PersonalSecretsError>;
    readonly setSharing: (
      input: PersonalSecretSharingInput,
    ) => Effect.Effect<PersonalSecretsListResult, PersonalSecretsError>;
    /** Moves a saved key between `env` and `brokered`, binding it to origins. */
    readonly setMode: (
      input: PersonalSecretModeInput,
    ) => Effect.Effect<PersonalSecretsListResult, PersonalSecretsError>;
    readonly remove: (input: {
      readonly name: string;
    }) => Effect.Effect<{ readonly deleted: boolean }, PersonalSecretsError>;
  }
>()("t3/personal/secrets/PersonalSecretService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalSecretRepository.PersonalSecretRepository;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const tasks = yield* PersonalTaskService.PersonalTaskService;

  // Causes are kept for server-side diagnostics; none of them can hold a
  // value (store errors carry the key and a platform error, SQL never sees it).
  const fail = (message: string, cause?: unknown) =>
    new PersonalSecretsError({ message, ...(cause === undefined ? {} : { cause }) });

  const db = <A>(
    operation: string,
    effect: Effect.Effect<A, PersonalSecretRepository.PersonalSecretRepositoryError>,
  ) =>
    effect.pipe(Effect.mapError((cause) => fail(`Personal secrets ${operation} failed.`, cause)));

  /**
   * The mode, origins and placement a key is saved with. A brokered key must
   * name at least one public HTTPS origin; an env key has none (and no
   * placement, which only a broker call reads). Omitting the mode means the
   * default (brokered, unless PERSONAL_SECRET_DEFAULT_MODE=env). Omitting the
   * placement means the default: the Authorization header only.
   */
  const resolveAccess = Effect.fn("PersonalSecretService.resolveAccess")(function* (input: {
    readonly mode: PersonalSecretMode | undefined;
    readonly origins: ReadonlyArray<string> | undefined;
    readonly placement?: PersonalSecretPlacement | undefined;
  }) {
    const mode = input.mode ?? defaultNewSecretMode();
    if (mode === "env") {
      return {
        mode,
        origins: [] as ReadonlyArray<string>,
        placement: {} as PersonalSecretPlacement,
      };
    }
    const origins = normalizePersonalSecretOrigins(input.origins ?? []);
    if (origins === null) {
      return yield* fail(
        "Use public HTTPS origins such as https://api.vercel.com (at most 8, no IP addresses, no localhost).",
      );
    }
    if (origins.length === 0) {
      return yield* fail(
        "Add the HTTPS origin this key may be sent to, such as https://api.vercel.com, or save it as an environment variable.",
      );
    }
    const placement = normalizePersonalSecretPlacement(input.placement);
    if (placement === null) {
      return yield* fail(
        "The key placement is not usable: use a plain header name, a path starting with / and no .. or ?, and real request methods.",
      );
    }
    return { mode, origins, placement };
  });

  /**
   * The owner's Settings action: every fulfilled row of one name takes the same
   * access. A bot's request card never calls this (see `fulfill`): approving one
   * bot's request must not rebind or downgrade another row of the same name.
   */
  const setNameAccess = (
    name: string,
    access: {
      readonly mode: PersonalSecretMode;
      readonly origins: ReadonlyArray<string>;
      readonly placement: PersonalSecretPlacement;
    },
  ) => db("mode", repository.setMode({ name, ...access }));

  /**
   * Fails when another fulfilled row addressing the same stored value (the
   * shared slot of `name`, or the private slot of `name` for `botId`) grants
   * different access than `access`. Rows on one slot read the same bytes, so
   * they must agree: a new save must never inherit an older row's broader
   * mode or origins, nor leave its bytes under them. Nothing is written first.
   * The owner's own saved row is rotated in place by `create`, so `create`
   * passes `ignoreOwnerSaved`.
   */
  const requireSlotAccessMatch = Effect.fn("PersonalSecretService.requireSlotAccessMatch")(
    function* (
      slot: { readonly name: string; readonly botId: PersonalBotId; readonly shared: boolean },
      access: {
        readonly mode: PersonalSecretMode;
        readonly origins: ReadonlyArray<string>;
        readonly placement: PersonalSecretPlacement;
      },
      options?: { readonly ignoreOwnerSaved?: boolean },
    ) {
      const rows = (yield* db("lookup", repository.listByStatus("fulfilled"))).filter(
        (row) =>
          row.name === slot.name &&
          (slot.shared ? row.shared : !row.shared && row.botId === slot.botId) &&
          !(options?.ignoreOwnerSaved === true && row.botId === OWNER_SAVED_BOT_ID),
      );
      if (rows.some((row) => !samePolicy(row, access))) {
        return yield* fail(
          slot.shared
            ? `A shared key called ${slot.name} is already saved with different access. Save this one with the same mode and origins, or change the saved key's access in Settings > API keys first, so one value never has two sets of permissions.`
            : `This bot already has a key called ${slot.name} saved with different access. Save this one with the same mode and origins, or change the saved key's access in Settings > API keys first, so one value never has two sets of permissions.`,
        );
      }
    },
  );

  /** A pending request as the owner's card shows it: the origins the app cannot vouch for are flagged. */
  const withUnverifiedOrigins = (row: PersonalSecretRequest): PersonalSecretRequest => {
    if (row.status !== "pending") return row;
    const unverified = unverifiedPersonalSecretOrigins(row.name, row.origins ?? []);
    return unverified.length === 0 ? row : { ...row, unverifiedOrigins: unverified };
  };

  const requirePending = Effect.fn("PersonalSecretService.requirePending")(function* (
    requestId: PersonalSecretRequestId,
  ) {
    const request = yield* db("lookup", repository.getRequest(requestId));
    if (Option.isNone(request)) {
      return yield* fail("Secret request was not found.");
    }
    if (request.value.status !== "pending") {
      return yield* fail(`Secret request is already ${request.value.status}.`);
    }
    return request.value;
  });

  const getStored = (row: SecretOwnerScope) =>
    store
      .get(personalSecretStoreKey({ name: row.name, botId: row.botId, shared: row.shared }))
      .pipe(
        Effect.flatMap((found) =>
          // Secrets fulfilled before scoping live at the legacy name-only key.
          Option.isSome(found)
            ? Effect.succeed(found)
            : store.get(personalSecretStoreKey(row.name)),
        ),
        Effect.mapError((cause) => fail("Could not read the secret store.", cause)),
      );

  const isStored = (row: SecretOwnerScope) => getStored(row).pipe(Effect.map(Option.isSome));

  const hydrateRedactor = Effect.gen(function* () {
    const fulfilled = yield* db("hydrate", repository.listByStatus("fulfilled"));
    const decoder = new TextDecoder();
    const entries: Array<{ name: string; value: string; id: string }> = [];
    for (const row of fulfilled) {
      const value = yield* getStored(row).pipe(Effect.option);
      if (Option.isSome(value) && Option.isSome(value.value)) {
        entries.push({
          name: row.name,
          value: decoder.decode(value.value.value),
          id: personalSecretStoreKey({ name: row.name, botId: row.botId, shared: row.shared }),
        });
      }
    }
    secretRedactor.replaceAll(entries);
  });

  const request: PersonalSecretService["Service"]["request"] = Effect.fn(
    "PersonalSecretService.request",
  )(function* (input) {
    const fulfilled = yield* db("lookup", repository.listByStatus("fulfilled"));
    const answered = fulfilled.find(
      (entry) => entry.name === input.name && (entry.botId === input.botId || entry.shared),
    );
    if (answered !== undefined && (yield* isStored(answered))) {
      return { request: answered, status: "fulfilled" as const };
    }
    const pending = yield* db("lookup", repository.listByTask(input.task.taskId));
    const existing = pending.find(
      (entry) => entry.status === "pending" && entry.name === input.name,
    );
    const stored =
      existing ??
      ({
        requestId: PersonalSecretRequestId.make(NodeCrypto.randomUUID()),
        taskId: input.task.taskId,
        rootTaskId: input.task.rootTaskId,
        threadId: input.threadId,
        botId: input.botId,
        name: input.name,
        label: input.label,
        purpose: input.purpose,
        status: "pending",
        shared: false,
        mode: "env",
        origins: hintedOrigins(input.name, input.origins),
        createdAt: yield* DateTime.now,
        fulfilledAt: null,
      } satisfies PersonalSecretRequest);
    if (existing === undefined) {
      yield* db("request", repository.insertRequest(stored));
    }
    yield* tasks
      .waitForUser({ taskId: input.task.taskId })
      .pipe(Effect.mapError((error) => fail(error.message, error)));
    return { request: withUnverifiedOrigins(stored), status: "pending" as const };
  });

  const listPending: PersonalSecretService["Service"]["listPending"] = () =>
    db("listPending", repository.listByStatus("pending")).pipe(
      Effect.map((requests) => ({ requests: requests.map(withUnverifiedOrigins) })),
    );

  // The task resumes once, when its last pending request is answered, with
  // every secret it was given in one continuation.
  const resumeTaskIfReady = Effect.fn("PersonalSecretService.resumeTaskIfReady")(function* (
    answered: PersonalSecretRequest,
  ) {
    if (answered.taskId === null) {
      return;
    }
    const taskRequests = yield* db("lookup", repository.listByTask(answered.taskId));
    if (taskRequests.some((entry) => entry.status === "pending")) {
      return;
    }
    const names = [
      ...new Map(
        taskRequests
          .filter((entry) => entry.status === "fulfilled")
          .map((entry) => [entry.name, { name: entry.name, mode: entry.mode ?? "env" }] as const),
      ).values(),
    ];
    yield* tasks
      .resumeFromUser({
        taskId: answered.taskId,
        noteId: `secret:${answered.requestId}`,
        note: secretAvailableNote(names),
        restartSession: true,
      })
      .pipe(
        // The secret is stored either way; a task that is no longer waiting
        // (cancelled meanwhile) simply is not resumed.
        Effect.catch((error) =>
          Effect.logInfo("personal secret stored; its task was not resumed", {
            requestId: answered.requestId,
            reason: error.message,
          }),
        ),
      );
  });

  /** The locked part of a fulfilment: check, bytes, row. The task is resumed after the lock is released. */
  const saveFulfilment = Effect.fn("PersonalSecretService.fulfill")(function* (
    input: PersonalSecretFulfillInput,
  ) {
    const pending = yield* requirePending(input.requestId);
    const bytes = new TextEncoder().encode(Redacted.value(input.value));
    if (bytes.byteLength === 0) {
      return yield* fail("Secret value is empty.");
    }
    if (bytes.byteLength > PERSONAL_SECRET_MAX_VALUE_BYTES) {
      return yield* fail(`Secret value must be at most ${PERSONAL_SECRET_MAX_VALUE_BYTES} bytes.`);
    }
    const shared = input.shared ?? false;
    const access = yield* resolveAccess({
      mode: input.mode,
      origins: input.origins ?? (pending.origins?.length ? pending.origins : undefined),
      placement: input.placement,
    });
    // A stored value lives in one slot (every bot's for a shared key, one bot's
    // otherwise) and so carries one access policy. A second save with different
    // access would overwrite the bytes while an older row kept its (maybe
    // broader) mode and origins, so it is refused before anything is written;
    // the request stays pending.
    yield* requireSlotAccessMatch({ name: pending.name, botId: pending.botId, shared }, access);
    yield* store
      .set(personalSecretStoreKey({ name: pending.name, botId: pending.botId, shared }), bytes)
      .pipe(Effect.mapError((cause) => fail("Could not store the secret.", cause)));
    const fulfilledAt = yield* DateTime.now;
    const written = yield* db(
      "fulfill",
      repository.writeStatus({
        requestId: pending.requestId,
        expectedStatus: "pending",
        status: "fulfilled",
        shared,
        fulfilledAt,
        mode: access.mode,
        origins: access.origins,
        placement: access.placement,
      }),
    );
    if (!written) {
      return yield* fail("Secret request changed while it was being fulfilled.");
    }
    const fulfilled: PersonalSecretRequest = {
      ...pending,
      status: "fulfilled",
      shared,
      mode: access.mode,
      origins: access.origins,
      placement: access.placement,
      fulfilledAt,
    };
    secretRedactor.set(
      pending.name,
      Redacted.value(input.value),
      personalSecretStoreKey({ name: pending.name, botId: pending.botId, shared }),
    );
    // Only this row carries the access the owner chose: another bot's row (or
    // the owner's own saved key) of the same name keeps its mode and origins.
    return fulfilled;
  });

  const cancel: PersonalSecretService["Service"]["cancel"] = Effect.fn(
    "PersonalSecretService.cancel",
  )(function* (input) {
    const pending = yield* requirePending(input.requestId);
    const written = yield* db(
      "cancel",
      repository.writeStatus({
        requestId: pending.requestId,
        expectedStatus: "pending",
        status: "cancelled",
        shared: pending.shared,
        fulfilledAt: null,
      }),
    );
    if (!written) {
      return yield* fail("Secret request changed while it was being cancelled.");
    }
    if (pending.taskId !== null) {
      yield* tasks
        .failWaitingForUser({
          taskId: pending.taskId,
          message: `The user declined to provide the secret ${pending.name} (${pending.label}).`,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logInfo("personal secret request cancelled; its task was not waiting", {
              requestId: pending.requestId,
              reason: error.message,
            }),
          ),
        );
    }
    return { ...pending, status: "cancelled" as const };
  });

  const list: PersonalSecretService["Service"]["list"] = () =>
    db("list", repository.listByStatus("fulfilled")).pipe(
      Effect.map((requests) => {
        const byName = new Map<string, PersonalSecretSummary>();
        for (const entry of requests) {
          if (entry.fulfilledAt === null) continue;
          const previous = byName.get(entry.name);
          const mode = entry.mode ?? "env";
          byName.set(entry.name, {
            name: entry.name,
            // Rows arrive oldest first, so the newest label and date win.
            label: entry.label,
            botIds: [...new Set([...(previous?.botIds ?? []), entry.botId])],
            shared: (previous?.shared ?? false) || entry.shared,
            // One row in env mode makes the whole name read env: the safer sign to show.
            mode: previous?.mode === "env" ? "env" : mode,
            origins: [...new Set([...(previous?.origins ?? []), ...(entry.origins ?? [])])],
            placement: widestPlacement(previous?.placement, entry.placement ?? {}),
            fulfilledAt: entry.fulfilledAt,
          });
        }
        return { secrets: [...byName.values()] };
      }),
    );

  const remove: PersonalSecretService["Service"]["remove"] = Effect.fn(
    "PersonalSecretService.remove",
  )(function* (input) {
    // `remove` is per name, but values are per owner: drop the scoped key of
    // every fulfilled row of that name, plus the legacy name-only key (shared
    // secrets and values fulfilled before scoping live there).
    const fulfilled = yield* db("lookup", repository.listByStatus("fulfilled"));
    const keys = new Set<string>([personalSecretStoreKey(input.name)]);
    for (const entry of fulfilled) {
      if (entry.name !== input.name) continue;
      keys.add(
        personalSecretStoreKey({ name: entry.name, botId: entry.botId, shared: entry.shared }),
      );
      keys.add(personalSecretStoreKey({ name: entry.name, botId: entry.botId, shared: false }));
    }
    let stored = false;
    for (const key of keys) {
      const existed = yield* store.get(key).pipe(
        Effect.map(Option.isSome),
        Effect.mapError((cause) => fail("Could not read the secret store.", cause)),
      );
      stored = stored || existed;
      yield* store
        .remove(key)
        .pipe(Effect.mapError((cause) => fail("Could not delete the secret.", cause)));
    }
    const rows = yield* db("delete", repository.deleteFulfilledByName(input.name));
    secretRedactor.remove(input.name);
    return { deleted: stored || rows > 0 };
  });

  const setSharing = Effect.fn("PersonalSecretService.setSharing")(function* (
    input: PersonalSecretSharingInput,
  ) {
    const rows = (yield* db("lookup", repository.listByStatus("fulfilled"))).filter(
      (row) => row.name === input.name,
    );
    if (rows.length === 0) return yield* fail("Saved secret not found.");
    if (rows.every((row) => row.shared === input.shared)) return yield* list();
    // Sharing joins every row into one slot; unsharing copies the shared slot's
    // bytes into one slot per bot. Either way the rows that end up reading the
    // same bytes must already agree on access, or one of them would gain bytes
    // it was not approved for (an env row reading a brokered-only save).
    const disagree = (group: ReadonlyArray<(typeof rows)[number]>) =>
      group.some((row) => !samePolicy(row, group[0]!));
    const afterSplit = Map.groupBy(rows, (row) => row.botId);
    if (
      input.shared
        ? disagree(rows)
        : disagree(rows.filter((row) => row.shared)) ||
          [...afterSplit.values()].some((group) => disagree(group))
    )
      return yield* fail(
        "Bots have different access (mode or origins) for this key. Set the same access for it in Settings > API keys before changing which bots can use it.",
      );
    const values = yield* Effect.forEach(rows, (row) => getStored(row));
    if (values.some(Option.isNone))
      return yield* fail("A saved key could not be read. Save it again before changing access.");
    const bytes = Option.getOrThrow(values[0]!);
    if (
      input.shared &&
      values.some((value) => {
        const candidate = Option.getOrThrow(value);
        return (
          candidate.length !== bytes.length ||
          candidate.some((byte, index) => byte !== bytes[index])
        );
      })
    )
      return yield* fail(
        "Bots have different values for this key. Remove it and save the intended shared key before enabling access for all bots.",
      );
    // Copy first, then change access metadata. Secret bytes never enter SQL or responses.
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      yield* store
        .set(
          personalSecretStoreKey({ name: row.name, botId: row.botId, shared: input.shared }),
          Option.getOrThrow(values[index]!),
        )
        .pipe(Effect.mapError((cause) => fail("Could not update the secret store.", cause)));
    }
    yield* db("sharing", repository.setSharing(input.name, input.shared));
    if (!input.shared)
      yield* store
        .remove(personalSecretStoreKey(input.name))
        .pipe(
          Effect.mapError((cause) =>
            fail("Access changed, but the old shared copy could not be removed.", cause),
          ),
        );
    return yield* list();
  });

  const setMode = Effect.fn("PersonalSecretService.setMode")(function* (
    input: PersonalSecretModeInput,
  ) {
    const rows = (yield* db("lookup", repository.listByStatus("fulfilled"))).filter(
      (row) => row.name === input.name,
    );
    if (rows.length === 0) return yield* fail("Saved secret not found.");
    // Moving to brokered with no new origins keeps the ones the key already has.
    const known = [...new Set(rows.flatMap((row) => row.origins ?? []))];
    const current = rows.map((row) => row.placement ?? {}).reduce(widestPlacement);
    const access = yield* resolveAccess({
      mode: input.mode,
      origins: input.origins ?? (known.length > 0 ? known : undefined),
      placement: input.placement ?? current,
    });
    yield* setNameAccess(input.name, access);
    return yield* list();
  });

  /**
   * A key the owner saved themselves.
   *
   * There is no bot and no task behind it, so the row records a reserved
   * owner id rather than pretending some bot asked: the list only ever renders
   * `shared`, and inventing a real bot's id here would put a key in that bot's
   * name. Saving over an existing name replaces the value, because the owner
   * typing a key they already have means they are rotating it.
   */
  const create: PersonalSecretService["Service"]["create"] = Effect.fn(
    "PersonalSecretService.create",
  )(function* (input) {
    const bytes = new TextEncoder().encode(Redacted.value(input.value));
    if (bytes.byteLength === 0) {
      return yield* fail("Secret value is empty.");
    }
    if (bytes.byteLength > PERSONAL_SECRET_MAX_VALUE_BYTES) {
      return yield* fail(`Secret value must be at most ${PERSONAL_SECRET_MAX_VALUE_BYTES} bytes.`);
    }
    const shared = input.shared ?? true;
    const label = (input.label ?? "").trim() || input.name;
    const access = yield* resolveAccess({
      mode: input.mode,
      origins: input.origins,
      placement: input.placement,
    });
    // The owner's own saved row is rotated in place, but a bot's row on the same
    // slot reads the same bytes: refuse before writing when it grants different access.
    yield* requireSlotAccessMatch({ name: input.name, botId: OWNER_SAVED_BOT_ID, shared }, access, {
      ignoreOwnerSaved: true,
    });
    const storeKey = personalSecretStoreKey({
      name: input.name,
      botId: OWNER_SAVED_BOT_ID,
      shared,
    });
    // The owner's own row is the one rotated. Without it, a shared save may take
    // over a bot's shared row (one slot); an unshared one never touches a bot's.
    const sameScope = (yield* db("lookup", repository.listByStatus("fulfilled"))).filter(
      (entry) => entry.name === input.name && entry.shared === shared,
    );
    const existing =
      sameScope.find((entry) => entry.botId === OWNER_SAVED_BOT_ID) ??
      (shared ? sameScope[0] : undefined);
    const previous =
      existing === undefined
        ? Option.none<Uint8Array>()
        : yield* store
            .get(storeKey)
            .pipe(Effect.mapError((cause) => fail("Could not read the secret store.", cause)));
    yield* store
      .set(storeKey, bytes)
      .pipe(Effect.mapError((cause) => fail("Could not store the secret.", cause)));
    secretRedactor.set(input.name, Redacted.value(input.value), storeKey);

    if (existing !== undefined) {
      // Rotating this row's value: its own access changes, no other row's. The
      // lock keeps readers from seeing the new bytes before the new access;
      // if the access cannot be written, the old bytes go back (or the value is
      // removed), so new bytes are never left under the old policy.
      yield* db("mode", repository.setRowAccess({ requestId: existing.requestId, ...access })).pipe(
        Effect.tapError(() =>
          (Option.isSome(previous)
            ? store.set(storeKey, previous.value)
            : store.remove(storeKey)
          ).pipe(
            Effect.catch(() => store.remove(storeKey)),
            Effect.ignore,
          ),
        ),
      );
      return { ...existing, ...access };
    }

    const createdAt = yield* DateTime.now;
    const row: PersonalSecretRequest = {
      requestId: PersonalSecretRequestId.make(NodeCrypto.randomUUID()),
      taskId: null,
      rootTaskId: null,
      threadId: OWNER_SAVED_THREAD_ID,
      botId: OWNER_SAVED_BOT_ID,
      name: input.name,
      label,
      purpose: "Saved by you in Settings.",
      status: "fulfilled",
      shared,
      mode: access.mode,
      origins: access.origins,
      placement: access.placement,
      createdAt,
      fulfilledAt: createdAt,
    };
    yield* db("create", repository.insertRequest(row));
    return row;
  });

  // The redactor learns every saved value at startup (and from then on from
  // fulfil / create / remove above). A value that cannot be read is simply not
  // masked; the name is logged, never the value.
  yield* hydrateRedactor.pipe(
    Effect.catch((error) =>
      Effect.logWarning("personal secret redactor could not load every saved key", {
        reason: error.message,
      }),
    ),
  );

  return {
    request,
    listPending,
    fulfill: (input) =>
      Effect.gen(function* () {
        const fulfilled = yield* secretAccessLock.withPermit(saveFulfilment(input));
        // Resuming restarts the task's session, which reads secrets: not under the lock.
        yield* resumeTaskIfReady(fulfilled);
        return fulfilled;
      }),
    cancel,
    list,
    create: (input) => secretAccessLock.withPermit(create(input)),
    remove: (input) => secretAccessLock.withPermit(remove(input)),
    setSharing: (input) => secretAccessLock.withPermit(setSharing(input)),
    setMode: (input) => secretAccessLock.withPermit(setMode(input)),
  } satisfies PersonalSecretService["Service"];
});

export const layer = Layer.effect(PersonalSecretService, make);

/** The service with its repository; needs SqlClient, the secret store and personal tasks. */
export const layerLive = layer.pipe(Layer.provideMerge(PersonalSecretRepository.layer));
