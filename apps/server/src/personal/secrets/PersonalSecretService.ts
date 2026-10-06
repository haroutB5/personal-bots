import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import {
  personalSecretPlaceholder,
  PERSONAL_SECRET_MAX_VALUE_BYTES,
  PersonalSecretRequestId,
  normalizePersonalSecretOrigins,
  type PersonalSecretMode,
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
        ? `Secret ${name} is now saved. Use it only through the secret_request tool by writing ${personalSecretPlaceholder(name)} where its value goes (a header, the URL or the body); the server adds it and never shows it to you.`
        : `Secret ${name} is now available as the environment variable ${personalSecretEnvVar(name)} in new shell commands. Do not print it.`;
    })
    .join("\n");

/** Origins that are well known for the keys the app's own tools use; a bot's own hint wins. */
const WELL_KNOWN_ORIGINS: Readonly<Record<string, ReadonlyArray<string>>> = {
  TAVILY_API_KEY: ["https://api.tavily.com"],
  SERPAPI_API_KEY: ["https://serpapi.com"],
  VERCEL_TOKEN: ["https://api.vercel.com"],
  GITHUB_TOKEN: ["https://api.github.com"],
  GH_TOKEN: ["https://api.github.com"],
};

/** The origins a bot named for a key it asks for; anything unusable is dropped, never an error. */
const hintedOrigins = (
  name: string,
  origins: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  const named = origins === undefined ? [] : (normalizePersonalSecretOrigins(origins) ?? []);
  return named.length > 0 ? named : (WELL_KNOWN_ORIGINS[name] ?? []);
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
  const mutationLock = yield* Semaphore.make(1);

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
   * The mode and origins a key is saved with. A brokered key must name at
   * least one public HTTPS origin; an env key has none. Omitting the mode
   * means the default (brokered, unless PERSONAL_SECRET_DEFAULT_MODE=env).
   */
  const resolveAccess = Effect.fn("PersonalSecretService.resolveAccess")(function* (input: {
    readonly mode: PersonalSecretMode | undefined;
    readonly origins: ReadonlyArray<string> | undefined;
  }) {
    const mode = input.mode ?? defaultNewSecretMode();
    if (mode === "env") return { mode, origins: [] as ReadonlyArray<string> };
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
    return { mode, origins };
  });

  /** Every row of one name carries the same mode and origins, whichever bot's value it is. */
  const alignNameAccess = (
    name: string,
    access: { readonly mode: PersonalSecretMode; readonly origins: ReadonlyArray<string> },
  ) => db("mode", repository.setMode({ name, ...access }));

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
    return { request: stored, status: "pending" as const };
  });

  const listPending: PersonalSecretService["Service"]["listPending"] = () =>
    db("listPending", repository.listByStatus("pending")).pipe(
      Effect.map((requests) => ({ requests: [...requests] })),
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

  const fulfill: PersonalSecretService["Service"]["fulfill"] = Effect.fn(
    "PersonalSecretService.fulfill",
  )(function* (input) {
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
    });
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
      fulfilledAt,
    };
    secretRedactor.set(
      pending.name,
      Redacted.value(input.value),
      personalSecretStoreKey({ name: pending.name, botId: pending.botId, shared }),
    );
    yield* alignNameAccess(pending.name, access);
    yield* resumeTaskIfReady(fulfilled);
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
    const access = yield* resolveAccess({
      mode: input.mode,
      origins: input.origins ?? (known.length > 0 ? known : undefined),
    });
    yield* alignNameAccess(input.name, access);
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
    const access = yield* resolveAccess({ mode: input.mode, origins: input.origins });
    const storeKey = personalSecretStoreKey({
      name: input.name,
      botId: OWNER_SAVED_BOT_ID,
      shared,
    });
    yield* store
      .set(storeKey, bytes)
      .pipe(Effect.mapError((cause) => fail("Could not store the secret.", cause)));
    secretRedactor.set(input.name, Redacted.value(input.value), storeKey);

    const existing = (yield* db("lookup", repository.listByStatus("fulfilled"))).find(
      (entry) => entry.name === input.name && entry.shared === shared,
    );
    if (existing !== undefined) {
      yield* alignNameAccess(input.name, access);
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
      createdAt,
      fulfilledAt: createdAt,
    };
    yield* db("create", repository.insertRequest(row));
    yield* alignNameAccess(input.name, access);
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
    fulfill: (input) => mutationLock.withPermit(fulfill(input)),
    cancel,
    list,
    create: (input) => mutationLock.withPermit(create(input)),
    remove: (input) => mutationLock.withPermit(remove(input)),
    setSharing: (input) => mutationLock.withPermit(setSharing(input)),
    setMode: (input) => mutationLock.withPermit(setMode(input)),
  } satisfies PersonalSecretService["Service"];
});

export const layer = Layer.effect(PersonalSecretService, make);

/** The service with its repository; needs SqlClient, the secret store and personal tasks. */
export const layerLive = layer.pipe(Layer.provideMerge(PersonalSecretRepository.layer));
