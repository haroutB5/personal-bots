import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import {
  PERSONAL_SECRET_MAX_VALUE_BYTES,
  PersonalSecretRequestId,
  PersonalSecretsError,
  personalSecretEnvVar,
  type PersonalBotId,
  type PersonalSecretFulfillInput,
  type PersonalSecretRequest,
  type PersonalSecretsListPendingResult,
  type PersonalSecretsListResult,
  type PersonalSecretSummary,
  type PersonalSecretSharingInput,
  type PersonalTask,
  type ThreadId,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalSecretRepository from "./PersonalSecretRepository.ts";

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

/** Request rows carry the owner scope; the store key is derived from them. */
interface SecretOwnerScope {
  readonly name: string;
  readonly botId: PersonalBotId;
  readonly shared: boolean;
}

/** The continuation a task resumes with once its secrets are in; names only, never values. */
export const secretAvailableNote = (names: ReadonlyArray<string>) =>
  names
    .map(
      (name) =>
        `Secret ${name} is now available as the environment variable ${personalSecretEnvVar(name)} in new shell commands. Do not print it.`,
    )
    .join("\n");

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
    readonly list: () => Effect.Effect<PersonalSecretsListResult, PersonalSecretsError>;
    readonly setSharing: (
      input: PersonalSecretSharingInput,
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
      ...new Set(
        taskRequests.filter((entry) => entry.status === "fulfilled").map((entry) => entry.name),
      ),
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
      }),
    );
    if (!written) {
      return yield* fail("Secret request changed while it was being fulfilled.");
    }
    const fulfilled: PersonalSecretRequest = {
      ...pending,
      status: "fulfilled",
      shared,
      fulfilledAt,
    };
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
          byName.set(entry.name, {
            name: entry.name,
            // Rows arrive oldest first, so the newest label and date win.
            label: entry.label,
            botIds: [...new Set([...(previous?.botIds ?? []), entry.botId])],
            shared: (previous?.shared ?? false) || entry.shared,
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

  return {
    request,
    listPending,
    fulfill: (input) => mutationLock.withPermit(fulfill(input)),
    cancel,
    list,
    remove: (input) => mutationLock.withPermit(remove(input)),
    setSharing: (input) => mutationLock.withPermit(setSharing(input)),
  } satisfies PersonalSecretService["Service"];
});

export const layer = Layer.effect(PersonalSecretService, make);

/** The service with its repository; needs SqlClient, the secret store and personal tasks. */
export const layerLive = layer.pipe(Layer.provideMerge(PersonalSecretRepository.layer));
