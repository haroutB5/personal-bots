import * as NodeCrypto from "node:crypto";

import {
  PersonalConnectionApprovalId,
  PersonalConnectionsError,
  type ConnectionId,
  type PersonalBotId,
  type PersonalConnectionApproval,
  type PersonalConnectionApprovalDecideInput,
  type PersonalConnectionApprovalIdInput,
  type PersonalConnectionApprovalListResult,
  type PersonalConnectionExecutionOutcome,
  type PersonalConnectionRiskReason,
  type PersonalConnectionVendorId,
  type PersonalTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as ApprovalRepository from "./approvalRepository.ts";

/**
 * How long the owner has to answer, and how long a denial stands for the same
 * action. Short enough that a card the owner never saw stops mattering, long
 * enough to walk to the phone. A denial that expired is not a standing ban:
 * the bot may ask again, and the owner sees a fresh card.
 */
export const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long after a card times out the bot still gets "it timed out" rather
 * than a fresh card. Without it a bot calling straight after the sweep would
 * raise a new card the owner never asked to see again.
 */
const RECENT_EXPIRY_MS = 60 * 1000;

export interface ConnectionApprovalRequest {
  readonly actionDigest: string;
  readonly connectionId: ConnectionId;
  readonly vendorId: PersonalConnectionVendorId;
  readonly operationId: string;
  readonly riskReason: PersonalConnectionRiskReason;
  /** Server-authored. Never a word the model supplied. */
  readonly summary: string;
  readonly targetResources: ReadonlyArray<string>;
  readonly credentialVersion: number;
  readonly threadId: ThreadId;
  readonly botId: PersonalBotId;
  /** Null in a chat that has no task to park; the bot then simply cannot proceed. */
  readonly taskId: PersonalTaskId | null;
}

export type ConnectionApprovalOutcome =
  | { readonly _tag: "approved"; readonly approval: PersonalConnectionApproval }
  | { readonly _tag: "pending"; readonly approval: PersonalConnectionApproval }
  | { readonly _tag: "denied"; readonly approval: PersonalConnectionApproval }
  | { readonly _tag: "expired"; readonly approval: PersonalConnectionApproval };

export class PersonalConnectionApprovalService extends Context.Service<
  PersonalConnectionApprovalService,
  {
    /** The decision for this exact action: an existing one, or a new card. */
    readonly require: (
      request: ConnectionApprovalRequest,
    ) => Effect.Effect<ConnectionApprovalOutcome, PersonalConnectionsError>;
    /**
     * One decision by id, whatever its status. The `create_app` runner reads
     * its plan approval back through this on every step, so a decision
     * withdrawn or spent between steps stops the run rather than being assumed
     * to still hold from when it started.
     */
    readonly get: (
      approvalId: PersonalConnectionApprovalId,
    ) => Effect.Effect<Option.Option<PersonalConnectionApproval>, PersonalConnectionsError>;
    readonly listPending: () => Effect.Effect<
      PersonalConnectionApprovalListResult,
      PersonalConnectionsError
    >;
    readonly decide: (
      input: PersonalConnectionApprovalDecideInput,
    ) => Effect.Effect<PersonalConnectionApproval, PersonalConnectionsError>;
    readonly cancel: (
      input: PersonalConnectionApprovalIdInput,
    ) => Effect.Effect<PersonalConnectionApproval, PersonalConnectionsError>;
    /** Spends the approval. False means another dispatch already spent it. */
    readonly recordExecution: (input: {
      readonly approvalId: PersonalConnectionApprovalId;
      readonly outcome: typeof PersonalConnectionExecutionOutcome.Type;
    }) => Effect.Effect<boolean, PersonalConnectionsError>;
  }
>()("t3/personal/connections/approvalService/PersonalConnectionApprovalService") {}

/** What the bot is told when the owner answers. Server text, like the card. */
export const approvalResumeNote = (approval: PersonalConnectionApproval): string =>
  `The user approved this connection action: ${approval.summary} Call the same operation again with exactly the same arguments to run it once. Anything else needs a new approval.`;

export const denialResumeNote = (approval: PersonalConnectionApproval): string =>
  `The user declined this connection action: ${approval.summary} Do not retry it or work around it. Tell them what you were trying to do and ask what they want instead.`;

export const expiryResumeNote = (approval: PersonalConnectionApproval): string =>
  `This connection action was never answered and has timed out: ${approval.summary} Ask the user whether they still want it before requesting it again.`;

export const make = Effect.gen(function* () {
  const repository = yield* ApprovalRepository.PersonalConnectionApprovalRepository;
  const tasks = yield* PersonalTaskService.PersonalTaskService;
  // Two calls deciding the same action at once would otherwise both see "no
  // pending row" and raise two cards for one action.
  const lock = yield* Semaphore.make(1);

  // Causes are dropped: a vendor failure can carry credential material and
  // this error is read by the model and the client.
  const fail = (message: string) => new PersonalConnectionsError({ message });
  const db = <A>(
    operation: string,
    effect: Effect.Effect<A, ApprovalRepository.PersonalConnectionApprovalRepositoryError>,
  ) => effect.pipe(Effect.mapError(() => fail(`Connection approvals ${operation} failed.`)));

  /**
   * The one place a waiting task is released.
   *
   * Every terminal transition goes through here, because the failure mode of
   * a parked task is silence: the chat reads idle while the task waits for a
   * card nobody will ever answer again.
   */
  const release = Effect.fn("PersonalConnectionApprovalService.release")(function* (
    approval: PersonalConnectionApproval,
    status: "approved" | "denied" | "expired" | "cancelled",
  ) {
    if (approval.taskId === null) return;
    const resume = (note: string) =>
      tasks.resumeFromUser({
        taskId: approval.taskId!,
        noteId: `connection-approval:${approval.approvalId}`,
        note,
        // Nothing about the provider's environment changed, unlike a fulfilled
        // secret: the credential never went near the session.
        restartSession: false,
      });
    yield* (
      status === "cancelled"
        ? // The owner dismissed the card rather than answering it, so the work
          // it was for does not continue.
          tasks.failWaitingForUser({
            taskId: approval.taskId,
            message: `The user dismissed the approval for: ${approval.summary}`,
          })
        : resume(
            status === "approved"
              ? approvalResumeNote(approval)
              : status === "denied"
                ? denialResumeNote(approval)
                : expiryResumeNote(approval),
          )
    ).pipe(
      // A task that is no longer waiting (its thread was deleted, it was
      // cancelled elsewhere) is not an error here: the decision is recorded
      // either way, and there is nobody left to tell.
      Effect.catch((error) =>
        Effect.logInfo("connection approval decided; its task was not waiting", {
          approvalId: approval.approvalId,
          status,
          reason: error.message,
        }),
      ),
    );
  });

  /**
   * Closes every pending card whose window has passed and releases its task.
   * Lazy on purpose: there is no timer to lose across a restart, and both
   * entry points (a bot asking, the client listing) run it.
   */
  const sweepExpired = Effect.fn("PersonalConnectionApprovalService.sweepExpired")(function* () {
    const now = yield* DateTime.now;
    const pastDue = yield* db("sweep", repository.listPastDue(now));
    for (const approval of pastDue) {
      const written = yield* db(
        "sweep",
        repository.writeStatus({
          approvalId: approval.approvalId,
          expectedStatus: "pending",
          status: "expired",
          decidedAt: now,
        }),
      );
      if (written) yield* release({ ...approval, status: "expired" }, "expired");
    }
  });

  const requireUnlocked = Effect.fn("PersonalConnectionApprovalService.require")(function* (
    request: ConnectionApprovalRequest,
  ) {
    yield* sweepExpired();
    const history = yield* db("lookup", repository.listByDigest(request.actionDigest));

    // Single use: an approval with a receipt has already been spent, so the
    // next identical call asks again rather than replaying it.
    const usable = history.find(
      (entry) => entry.status === "approved" && entry.executedAt === null,
    );
    if (usable !== undefined) return { _tag: "approved" as const, approval: usable };

    const now = yield* DateTime.now;
    const pending = history.find((entry) => entry.status === "pending");
    if (pending !== undefined) {
      yield* park(pending);
      return { _tag: "pending" as const, approval: pending };
    }

    // A denial stands for its own window, so a bot cannot answer "no" by
    // calling again immediately; after that the owner gets a fresh card.
    const denied = history.findLast(
      (entry) =>
        entry.status === "denied" &&
        DateTime.toEpochMillis(entry.expiresAt) > DateTime.toEpochMillis(now),
    );
    if (denied !== undefined) return { _tag: "denied" as const, approval: denied };

    const expired = history.findLast(
      (entry) =>
        entry.status === "expired" &&
        DateTime.toEpochMillis(entry.expiresAt) + RECENT_EXPIRY_MS > DateTime.toEpochMillis(now),
    );
    if (expired !== undefined) return { _tag: "expired" as const, approval: expired };

    const approval: PersonalConnectionApproval = {
      approvalId: PersonalConnectionApprovalId.make(NodeCrypto.randomUUID()),
      connectionId: request.connectionId,
      vendorId: request.vendorId,
      operationId: request.operationId,
      actionDigest: request.actionDigest,
      riskReason: request.riskReason,
      summary: request.summary,
      targetResources: [...request.targetResources],
      credentialVersion: request.credentialVersion,
      threadId: request.threadId,
      botId: request.botId,
      taskId: request.taskId,
      status: "pending",
      createdAt: now,
      expiresAt: DateTime.addDuration(now, Duration.millis(APPROVAL_WINDOW_MS)),
      decidedAt: null,
      executedAt: null,
      executionOutcome: null,
    };
    yield* db("create", repository.insert(approval));
    yield* park(approval);
    return { _tag: "pending" as const, approval };
  });

  /** Parks the asking task, if it is not already parked on this same card. */
  const park = (approval: PersonalConnectionApproval) =>
    approval.taskId === null
      ? Effect.void
      : tasks.waitForUser({ taskId: approval.taskId }).pipe(
          Effect.asVoid,
          // A second call in the same turn finds the task already waiting.
          // That is the same card, not a second one, so it is not an error.
          Effect.catch(() => Effect.void),
        );

  const requirePending = Effect.fn("PersonalConnectionApprovalService.requirePending")(function* (
    approvalId: PersonalConnectionApprovalId,
  ) {
    const found = yield* db("lookup", repository.get(approvalId));
    if (Option.isNone(found)) return yield* fail("That approval was not found.");
    if (found.value.status !== "pending") {
      return yield* fail(`That approval is already ${found.value.status}.`);
    }
    return found.value;
  });

  const settle = Effect.fn("PersonalConnectionApprovalService.settle")(function* (
    approvalId: PersonalConnectionApprovalId,
    status: "approved" | "denied" | "cancelled",
  ) {
    const pending = yield* requirePending(approvalId);
    const decidedAt = yield* DateTime.now;
    const written = yield* db(
      "decide",
      repository.writeStatus({
        approvalId,
        expectedStatus: "pending",
        status,
        decidedAt,
      }),
    );
    // Two devices, one card: the slower click finds the decision already made.
    if (!written) return yield* fail("That approval was already answered.");
    const settled: PersonalConnectionApproval = { ...pending, status, decidedAt };
    yield* release(settled, status);
    return settled;
  });

  return PersonalConnectionApprovalService.of({
    require: (request) => lock.withPermit(requireUnlocked(request)),
    get: (approvalId) => db("lookup", repository.get(approvalId)),
    listPending: () =>
      Effect.gen(function* () {
        yield* sweepExpired();
        const approvals = yield* db("listPending", repository.listByStatus("pending"));
        return { approvals: [...approvals] };
      }),
    decide: (input) => lock.withPermit(settle(input.approvalId, input.decision)),
    cancel: (input) => lock.withPermit(settle(input.approvalId, "cancelled")),
    recordExecution: (input) =>
      Effect.gen(function* () {
        const executedAt = yield* DateTime.now;
        return yield* db(
          "receipt",
          repository.writeReceipt({
            approvalId: input.approvalId,
            executedAt,
            outcome: input.outcome,
          }),
        );
      }),
  });
});

export const layer = Layer.effect(PersonalConnectionApprovalService, make);
export const layerLive = layer.pipe(Layer.provideMerge(ApprovalRepository.layer));
