import * as NodeCrypto from "node:crypto";
import {
  PersonalLoginId,
  PersonalLoginsError,
  PERSONAL_SECRET_MAX_VALUE_BYTES,
  type PersonalBotId,
  type PersonalLoginRequest,
  type PersonalLoginRequestsSubmitInput,
  type PersonalTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalLoginService from "./PersonalLoginService.ts";
import * as Repository from "./PersonalLoginRequestRepository.ts";

interface RequestInput {
  readonly taskId: PersonalTaskId;
  readonly threadId: ThreadId;
  readonly botId: PersonalBotId;
  readonly origin: string;
  readonly reason?: string | undefined;
  readonly label?: string | undefined;
}
export class PersonalLoginRequestService extends Context.Service<
  PersonalLoginRequestService,
  {
    readonly request: (
      input: RequestInput,
    ) => Effect.Effect<PersonalLoginRequest, PersonalLoginsError>;
    readonly list: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      { readonly requests: ReadonlyArray<PersonalLoginRequest> },
      PersonalLoginsError
    >;
    readonly submit: (
      input: PersonalLoginRequestsSubmitInput,
    ) => Effect.Effect<PersonalLoginRequest, PersonalLoginsError>;
    readonly cancel: (input: {
      readonly requestId: string;
    }) => Effect.Effect<PersonalLoginRequest, PersonalLoginsError>;
  }
>()("t3/personal/secrets/PersonalLoginRequestService") {}

export const layer = Layer.effect(
  PersonalLoginRequestService,
  Effect.gen(function* () {
    const repository = yield* Repository.PersonalLoginRequestRepository;
    const browser = yield* PersonalBrowser.PersonalBrowser;
    const logins = yield* PersonalLoginService.PersonalLoginService;
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const lock = yield* Semaphore.make(1);
    const fail = (message: string) => new PersonalLoginsError({ message });
    const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const resume = (row: PersonalLoginRequest) =>
      tasks
        .resumeFromUser({
          taskId: row.taskId,
          noteId: `login:${row.requestId}`,
          restartSession: false,
          note: `Login request result: ${row.status}; saved: ${row.saved}. Credentials were not sent to you. ${
            row.status === "filled"
              ? "The form is filled. Submit with a known button or Enter, then report in chat whether sign-in worked after checking the result. For 2FA, OTP or passkeys, call request_browser_help."
              : row.status === "fill-failed"
                ? "The form could not be completely filled. Use request_browser_help for the user to finish."
                : ""
          }`,
        })
        .pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        );
    const finish = Effect.fnUntraced(function* (
      row: PersonalLoginRequest,
      status: PersonalLoginRequest["status"],
      saved = row.saved,
    ) {
      const next = { ...row, status, saved };
      if (!(yield* repository.transition(next, row.status)))
        return yield* fail("Login request is already closed.");
      yield* resume(next);
      return next;
    });
    const invalid = Effect.fnUntraced(function* (row: PersonalLoginRequest) {
      if ((yield* now) >= Date.parse(row.expiresAt)) return "expired" as const;
      const page = yield* browser.loginPage(row.threadId);
      return page?.origin !== row.origin || page.tabId !== row.tabId
        ? ("origin-mismatch" as const)
        : null;
    });
    const sweep = Effect.fnUntraced(function* () {
      for (const row of yield* repository.list()) {
        if (row.status !== "pending") continue;
        const status = yield* invalid(row);
        if (status !== null) yield* finish(row, status);
      }
    });
    // A process stopped mid-fill cannot replay credentials, and metadata survives restart.
    for (const row of yield* repository.list()) {
      if (row.status === "filling") yield* finish(row, "fill-failed");
    }
    yield* lock.withPermit(sweep()).pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced("10 seconds")),
      Effect.forkScoped,
    );
    const request: PersonalLoginRequestService["Service"]["request"] = Effect.fnUntraced(
      function* (input) {
        const origin = PersonalLoginService.normalizePersonalLoginOrigin(input.origin);
        if (origin === null) return yield* fail("Login origin must be an exact HTTPS origin.");
        const page = yield* browser.loginPage(input.threadId);
        if (page === null || page.origin !== origin)
          return yield* fail("Login origin mismatch. Open the matching sign-in page first.");
        if ((yield* logins.list()).logins.some((login) => login.origin === origin)) {
          return yield* fail("A saved login already matches this origin. Call use_login instead.");
        }
        yield* sweep();
        const existing = (yield* repository.list(input.threadId)).find(
          (row) =>
            row.status === "pending" && row.taskId === input.taskId && row.tabId === page.tabId,
        );
        const time = yield* now;
        const row: PersonalLoginRequest = existing ?? {
          requestId: NodeCrypto.randomUUID(),
          taskId: input.taskId,
          threadId: input.threadId,
          botId: input.botId,
          origin,
          label: input.label?.replace(/\s+/g, " ").trim().slice(0, 120) || new URL(origin).hostname,
          reason: input.reason?.replace(/\s+/g, " ").trim().slice(0, 240) ?? "",
          tabId: page.tabId,
          status: "pending",
          saved: false,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(time)),
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(time + 10 * 60_000)),
        };
        if (existing === undefined) yield* repository.insert(row);
        yield* tasks
          .waitForUser({ taskId: input.taskId })
          .pipe(Effect.mapError(() => fail("Could not pause the login request's task.")));
        return row;
      },
    );
    const requirePending = Effect.fnUntraced(function* (requestId: string) {
      const row = (yield* repository.list()).find((row) => row.requestId === requestId);
      if (row === undefined || row.status !== "pending")
        return yield* fail("Login request is already closed or unavailable.");
      return row;
    });
    // Untraced generator and generic errors: driver/store causes can contain a credential.
    const submit: PersonalLoginRequestService["Service"]["submit"] = Effect.fnUntraced(
      function* (input) {
        const row = yield* requirePending(input.requestId);
        const status = yield* invalid(row);
        if (status !== null) return yield* finish(row, status);
        const username = Redacted.value(input.username);
        const password = Redacted.value(input.password);
        if (
          !username ||
          username.length > 4096 ||
          !password ||
          new TextEncoder().encode(password).length > PERSONAL_SECRET_MAX_VALUE_BYTES
        ) {
          return yield* fail("A username and password of a supported length are required.");
        }
        const claimed = { ...row, status: "filling" as const };
        if (!(yield* repository.transition(claimed, "pending")))
          return yield* fail("Login request is already closed.");
        const filled = yield* browser
          .fillLogin({
            threadId: row.threadId,
            label: row.label,
            expectedOrigin: row.origin,
            expectedTabId: row.tabId,
            username,
            password,
          })
          .pipe(
            Effect.map((fields) => fields.includes("password")),
            Effect.catch(() => Effect.succeed(false)),
          );
        let saved = false;
        if (filled && (input.save ?? true)) {
          saved = yield* logins
            .create({
              loginId: PersonalLoginId.make(NodeCrypto.randomUUID()),
              label: row.label,
              origin: row.origin,
              username,
              password: input.password,
            })
            .pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
        }
        return yield* finish(claimed, filled ? "filled" : "fill-failed", saved);
      },
    );
    const cancel: PersonalLoginRequestService["Service"]["cancel"] = Effect.fnUntraced(
      function* (input) {
        const row = yield* requirePending(input.requestId);
        return yield* finish(row, (yield* invalid(row)) ?? "cancelled");
      },
    );
    const list: PersonalLoginRequestService["Service"]["list"] = Effect.fnUntraced(
      function* (input) {
        yield* sweep();
        return { requests: yield* repository.list(input.threadId) };
      },
    );
    return PersonalLoginRequestService.of({
      request: (input) => lock.withPermit(request(input)),
      list: (input) => lock.withPermit(list(input)),
      submit: (input) => lock.withPermit(submit(input)),
      cancel: (input) => lock.withPermit(cancel(input)),
    });
  }),
);
export const layerLive = layer.pipe(Layer.provideMerge(Repository.layer));
