import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

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
  type PersonalTask,
  type ThreadId,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalSecretRepository from "./PersonalSecretRepository.ts";

/** Server secret store key of a fulfilled secret. `name` is UPPER_SNAKE-validated. */
export const personalSecretStoreKey = (name: string) => `personal-secret-${name}`;

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

  const isStored = (name: string) =>
    store.get(personalSecretStoreKey(name)).pipe(
      Effect.map(Option.isSome),
      Effect.mapError((cause) => fail("Could not read the secret store.", cause)),
    );

  const request: PersonalSecretService["Service"]["request"] = Effect.fn(
    "PersonalSecretService.request",
  )(function* (input) {
    const fulfilled = yield* db("lookup", repository.listByStatus("fulfilled"));
    const answered = fulfilled.find(
      (entry) => entry.name === input.name && (entry.botId === input.botId || entry.shared),
    );
    if (answered !== undefined && (yield* isStored(input.name))) {
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
    yield* store
      .set(personalSecretStoreKey(pending.name), bytes)
      .pipe(Effect.mapError((cause) => fail("Could not store the secret.", cause)));
    const shared = input.shared ?? false;
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
    const stored = yield* isStored(input.name);
    yield* store
      .remove(personalSecretStoreKey(input.name))
      .pipe(Effect.mapError((cause) => fail("Could not delete the secret.", cause)));
    const rows = yield* db("delete", repository.deleteFulfilledByName(input.name));
    return { deleted: stored || rows > 0 };
  });

  return {
    request,
    listPending,
    fulfill,
    cancel,
    list,
    remove,
  } satisfies PersonalSecretService["Service"];
});

export const layer = Layer.effect(PersonalSecretService, make);

/** The service with its repository; needs SqlClient, the secret store and personal tasks. */
export const layerLive = layer.pipe(Layer.provideMerge(PersonalSecretRepository.layer));
