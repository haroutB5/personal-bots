import { type PersonalBotId, type PersonalTaskId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { CreateAppPlan, PersonalConnectionApprovalId } from "@t3tools/contracts";

import { connectionDefinition, usesBrowserSession } from "./catalog.ts";
import { createAppPlanDigest, planCovers } from "./createApp/plan.ts";
import * as Adapters from "./adapters.ts";
import * as ApprovalService from "./approvalService.ts";
import * as CredentialStore from "./credentialStore.ts";
import * as Operations from "./operations.ts";
import * as ConnectionService from "./service.ts";
import { connectionEgressRefusal } from "../browser/egressGuard.ts";
import { PersonalBrowser } from "../browser/PersonalBrowser.ts";

/**
 * The one path from a bot to a provider.
 *
 * Everything a bot may reach at a vendor goes through here, in this order and
 * no other: resolve the connection as it is right now, validate the arguments,
 * classify the risk, refuse if the chat is carrying sensitive data, get the
 * owner's decision if one is needed, re-check that nothing moved while the
 * card was open, read the credential, call the adapter, and return only the
 * fields the operation was reviewed to return.
 *
 * The connection is re-read on every call, never cached across calls, so
 * disabling or rotating takes effect on the next call rather than the next
 * conversation.
 */

/** Any refusal or failure of a gateway call, worded for the model. */
export class PersonalConnectionGatewayError extends Schema.TaggedError<PersonalConnectionGatewayError>()(
  "PersonalConnectionGatewayError",
  {
    reason: Schema.String,
    /**
     * Set when the call reached the vendor and failed without a definite
     * answer (no reply, a 5xx, a defect): the vendor may have acted. Absent
     * means nothing ran, or the vendor refused it outright with a 4xx.
     */
    ambiguous: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface ConnectionGatewayCaller {
  readonly threadId: ThreadId;
  readonly botId: PersonalBotId;
  /** The task to park while the owner decides; null when this chat has none. */
  readonly taskId: PersonalTaskId | null;
}

/**
 * An approved `create_app` plan, offered instead of a per-call card.
 *
 * The plan is handed in whole and authenticated against the approval it claims
 * to come from: the approval's digest must be the hash of *this* plan, so a
 * doctored plan cannot borrow a real decision. The gateway then checks that
 * the plan covers this exact operation and every resource it touches. It is
 * not a bypass — validation, the drift check, the egress guard and the
 * pre-dispatch connection re-read all still run.
 *
 * Only server code sets this. The bot-facing toolkit never does, and nothing
 * in the model's channel can reach it.
 */
export interface ConnectionPlanAuthorization {
  readonly approvalId: PersonalConnectionApprovalId;
  readonly plan: CreateAppPlan;
}

export type ConnectionCallResult =
  | {
      readonly _tag: "completed";
      readonly operationId: string;
      readonly result: Readonly<Record<string, unknown>>;
      readonly approvalId: string | null;
    }
  | {
      readonly _tag: "awaiting_approval";
      readonly approvalId: string;
      /** The server's own description of the action, as the owner will read it. */
      readonly summary: string;
      readonly note: string;
    };

export const AWAITING_APPROVAL_NOTE =
  "The user has been asked to approve this action. Tell them in one sentence what you want to do and why, then end your turn. You continue automatically when they answer; do not ask them to tell you.";

export class PersonalConnectionGateway extends Context.Service<
  PersonalConnectionGateway,
  {
    readonly call: (input: {
      readonly operation: string;
      readonly arguments: unknown;
      readonly caller: ConnectionGatewayCaller;
      readonly planAuthorization?: ConnectionPlanAuthorization;
      /**
       * Secret values the caller is deliberately passing *as arguments* — a
       * data store's connection string on its way into a host environment.
       * They are scrubbed alongside the connection's own credentials, because
       * a vendor error quotes the request body back.
       */
      readonly scrub?: ReadonlyArray<Redacted.Redacted<string>>;
    }) => Effect.Effect<ConnectionCallResult, PersonalConnectionGatewayError>;
    /** Vendors a bot can actually use right now, with their operations. */
    readonly describe: () => Effect.Effect<
      ReadonlyArray<{
        readonly vendorId: string;
        readonly displayName: string;
        readonly operations: ReadonlyArray<{
          readonly operation: string;
          readonly description: string;
          readonly argumentsJsonSchema: string;
        }>;
      }>,
      PersonalConnectionGatewayError
    >;
  }
>()("t3/personal/connections/gateway/PersonalConnectionGateway") {}

export const make = Effect.gen(function* () {
  const connections = yield* ConnectionService.PersonalConnectionService;
  const credentials = yield* CredentialStore.PersonalConnectionCredentialStore;
  const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
  const adapters = yield* Adapters.ConnectionVendorAdapters;
  const browser = yield* PersonalBrowser;

  const refuse = (reason: string) => new PersonalConnectionGatewayError({ reason });

  const call = Effect.fn("PersonalConnectionGateway.call")(function* (input: {
    readonly operation: string;
    readonly arguments: unknown;
    readonly caller: ConnectionGatewayCaller;
    readonly planAuthorization?: ConnectionPlanAuthorization;
    readonly scrub?: ReadonlyArray<Redacted.Redacted<string>>;
  }) {
    // An operation we do not know by name is not approximated to a near one:
    // it stops here, and the bot is told what does exist.
    const found = Operations.findOperation(input.operation);
    if (Option.isNone(found)) {
      return yield* refuse(
        `No connection operation is called '${input.operation}'. Available: ${Operations.CONNECTION_OPERATIONS.map(
          (operation) => operation.operationId,
        ).join(", ")}.`,
      );
    }
    const operation = found.value;
    const definition = connectionDefinition(operation.vendorId);

    // Read now, not at session start: a connection disabled a minute ago is
    // disabled for this call.
    const resolved = yield* connections
      .resolveForOperation(operation.vendorId)
      .pipe(Effect.mapError((error) => refuse(error.message)));
    if (Option.isNone(resolved)) {
      return yield* refuse(
        `${definition.displayName} is not connected, or the user disabled it. Ask the user to connect it in Settings; you cannot connect it yourself.`,
      );
    }
    const connection = resolved.value;

    const prepared = yield* operation
      .prepare(input.arguments)
      .pipe(Effect.mapError((error) => refuse(error.message)));

    /**
     * The second connection a server-side credential transfer writes into.
     *
     * Resolved here, before the owner is asked anything, so a transfer with
     * nowhere to write refuses rather than raising a card for an action that
     * could never run.
     */
    const secondaryVendorId = operation.secondaryVendorId;
    const secondaryDefinition =
      secondaryVendorId === null ? null : connectionDefinition(secondaryVendorId);
    const resolveSecondary = () =>
      secondaryVendorId === null
        ? Effect.succeedNone
        : connections
            .resolveForOperation(secondaryVendorId)
            .pipe(Effect.mapError((error) => refuse(error.message)));
    const secondary = yield* resolveSecondary();
    if (secondaryDefinition !== null && Option.isNone(secondary)) {
      return yield* refuse(
        `${operation.operationId} puts a secret into ${secondaryDefinition.displayName}, which is not connected or was disabled. Ask the user to connect ${secondaryDefinition.displayName} in Settings; nothing was read and nothing was written.`,
      );
    }

    // Before the owner is asked anything: there is no point raising a card for
    // an action we already know we will not run.
    const adapter = adapters.forVendor(operation.vendorId);
    if (Option.isNone(adapter)) {
      return yield* refuse(
        `${definition.displayName} operations are not available yet in this build. Tell the user this capability is not wired up.`,
      );
    }
    const vendorSchema = yield* adapter.value.vendorSchema(operation.operationId).pipe(
      // The adapter's own words: an operation it deliberately does not
      // implement says so by name, which reads very differently from a
      // vendor whose contract we could not check.
      Effect.mapError((error) =>
        refuse(
          `${definition.displayName} cannot run ${operation.operationId} in this build: ${error.detail} Nothing ran.`,
        ),
      ),
    );
    if (vendorSchema !== operation.reviewedVendorSchema) {
      return yield* refuse(
        `${definition.displayName} changed its ${operation.operationId} contract (${vendorSchema}) from the one this build was reviewed against (${operation.reviewedVendorSchema}). Nothing ran. Tell the user the connection needs updating.`,
      );
    }

    // The browser guard, for the channel it cannot see. On thread state, not
    // on the arguments, and with no approval on offer.
    const carrying = yield* browser.sensitiveExposure(input.caller.threadId);
    const blocked = connectionEgressRefusal({
      sources: carrying,
      vendorName: definition.displayName,
    });
    if (blocked !== null) return yield* refuse(blocked);

    /**
     * What the approval binds to.
     *
     * The primary connection and its credential version are digest fields of
     * their own. The second connection is bound here instead, as a resource,
     * so it is both part of the digest and a line the owner reads: an approval
     * to write a secret into one Vercel account must not be spendable after
     * that account is swapped or its token rotated.
     */
    const boundResources = Option.isNone(secondary)
      ? prepared.targetResources
      : [
          ...prepared.targetResources,
          `${secondary.value.vendorId}:connection:${secondary.value.connectionId}@v${secondary.value.credentialVersion}`,
        ];

    const actionDigest = Operations.normalizedActionDigest({
      operationId: operation.operationId,
      arguments: prepared.arguments,
      connectionId: connection.connectionId,
      credentialVersion: connection.credentialVersion,
      targetResources: boundResources,
    });

    /**
     * A plan already decided covers this action, or it does not.
     *
     * Checked here rather than folded into `require` because it answers a
     * different question: `require` asks "has the owner said yes to this exact
     * action", and this asks "did the owner say yes to a plan that includes
     * it". An action outside the plan is refused outright rather than turned
     * into a card, because the run that asked has to go back for a fresh plan
     * decision — quietly raising a one-off card would let a run drift outside
     * what was approved, one card at a time.
     */
    const planAuthorization = input.planAuthorization;
    if (planAuthorization !== undefined) {
      const decided = yield* approvals
        .get(planAuthorization.approvalId)
        .pipe(Effect.mapError((error) => refuse(error.message)));
      if (Option.isNone(decided) || decided.value.status !== "approved") {
        return yield* refuse(
          "The plan this step belongs to is no longer approved, so nothing ran.",
        );
      }
      if (decided.value.executedAt !== null) {
        // The plan's single receipt is written when the run finishes. A plan
        // that already has one is a run that already ended.
        return yield* refuse("That plan was already carried out, so nothing ran.");
      }
      if (decided.value.actionDigest !== createAppPlanDigest(planAuthorization.plan)) {
        return yield* refuse("The plan does not match the decision it claims, so nothing ran.");
      }
      const coverage = planCovers(planAuthorization.plan, {
        operationId: operation.operationId,
        targetResources: prepared.targetResources,
      });
      if (!coverage.covered) {
        return yield* refuse(
          `${coverage.reason ?? "The approved plan does not cover this."} Nothing ran.`,
        );
      }
    }

    const approval =
      planAuthorization === undefined && prepared.risk.approvalRequired
        ? yield* approvals
            .require({
              actionDigest,
              connectionId: connection.connectionId,
              vendorId: operation.vendorId,
              operationId: operation.operationId,
              riskReason: prepared.risk.reason,
              summary: prepared.risk.summary,
              targetResources: boundResources,
              credentialVersion: connection.credentialVersion,
              threadId: input.caller.threadId,
              botId: input.caller.botId,
              taskId: input.caller.taskId,
            })
            .pipe(Effect.mapError((error) => refuse(error.message)))
        : null;

    if (approval !== null && approval._tag !== "approved") {
      if (approval._tag === "pending") {
        return {
          _tag: "awaiting_approval" as const,
          approvalId: approval.approval.approvalId,
          summary: approval.approval.summary,
          note: AWAITING_APPROVAL_NOTE,
        };
      }
      return yield* refuse(
        approval._tag === "denied"
          ? ApprovalService.denialResumeNote(approval.approval)
          : ApprovalService.expiryResumeNote(approval.approval),
      );
    }
    const approvalId = approval === null ? null : approval.approval.approvalId;

    /** Marks an approved action that never reached the vendor, so it is not replayed. */
    const notDispatched = (reason: string) =>
      Effect.gen(function* () {
        if (approvalId !== null) {
          yield* approvals
            .recordExecution({ approvalId, outcome: "not_dispatched" })
            .pipe(Effect.ignore);
        }
        return yield* refuse(reason);
      });

    // Immediately before dispatch, not at the top: the owner may have taken
    // minutes to answer, and a disable or a rotation in that window means the
    // approval was given for a connection that no longer exists.
    const current = yield* connections
      .resolveForOperation(operation.vendorId)
      .pipe(Effect.mapError((error) => refuse(error.message)));
    if (
      Option.isNone(current) ||
      current.value.connectionId !== connection.connectionId ||
      current.value.credentialVersion !== connection.credentialVersion
    ) {
      return yield* notDispatched(
        `The ${definition.displayName} connection changed while this was waiting, so nothing ran. Ask the user to confirm the connection, then start again.`,
      );
    }

    /**
     * A browser-session connection has no credential to read.
     *
     * Its credential is the logged-in session in the shared browser profile,
     * which this app never copies out, so there is nothing here to fetch and
     * nothing to hand the adapter. Whether that session is still good is
     * decided by the adapter looking at the page, and a signed-out one comes
     * back as `unauthorized` exactly like a rejected token.
     */
    const browserSession = usesBrowserSession(operation.vendorId);
    const stored = browserSession
      ? Option.some<Readonly<Record<string, Redacted.Redacted<string>>>>({})
      : yield* credentials
          .read({
            credentialRef: current.value.credentialRef,
            version: current.value.credentialVersion,
          })
          .pipe(Effect.mapError(() => refuse("Could not read the connection credential.")));
    if (Option.isNone(stored)) {
      return yield* notDispatched(
        `The ${definition.displayName} credential is missing. Ask the user to reconnect it.`,
      );
    }
    // The second connection gets the same treatment, in the same order: the
    // card may have been open for minutes, and a transfer written with a
    // credential the owner has since replaced is a write they did not approve.
    const currentSecondary = yield* resolveSecondary();
    if (
      secondaryDefinition !== null &&
      (Option.isNone(currentSecondary) ||
        Option.isNone(secondary) ||
        currentSecondary.value.connectionId !== secondary.value.connectionId ||
        currentSecondary.value.credentialVersion !== secondary.value.credentialVersion)
    ) {
      return yield* notDispatched(
        `The ${secondaryDefinition.displayName} connection this was going to write into changed while it was waiting, so nothing was read and nothing was written. Ask the user to confirm it, then start again.`,
      );
    }
    const storedSecondary = Option.isNone(currentSecondary)
      ? Option.none<Readonly<Record<string, Redacted.Redacted<string>>>>()
      : yield* credentials
          .read({
            credentialRef: currentSecondary.value.credentialRef,
            version: currentSecondary.value.credentialVersion,
          })
          .pipe(Effect.mapError(() => refuse("Could not read the connection credential.")));
    if (secondaryDefinition !== null && Option.isNone(storedSecondary)) {
      return yield* notDispatched(
        `The ${secondaryDefinition.displayName} credential is missing, so nothing was read and nothing was written. Ask the user to reconnect it.`,
      );
    }

    // Held only for the length of this call, and only to remove every
    // rendering of them from whatever the vendor says back. Both connections'
    // values, because both were read for this one call.
    const secrets = [
      ...Object.values(stored.value),
      ...(Option.isNone(storedSecondary) ? [] : Object.values(storedSecondary.value)),
      // And any value the caller is knowingly passing through the argument
      // channel: a vendor error quotes the request body back, and the
      // connection's own credentials are not the only secret in one.
      ...(input.scrub ?? []),
    ].map(Redacted.value);

    // Spend the approval before the vendor sees anything. Two identical calls
    // in one parallel tool batch both pass `require`; only one wins this
    // conditional write, and the loser runs nothing. A crash after this point
    // leaves the approval spent rather than replayable.
    if (approvalId !== null) {
      const claimed = yield* approvals
        .recordExecution({ approvalId, outcome: "dispatching" })
        .pipe(Effect.mapError(() => refuse("Could not record the approval, so nothing ran.")));
      if (!claimed) {
        return yield* refuse(
          "That approval was already used by another call, so nothing ran this time. Do not call it again; report the result of the call that ran.",
        );
      }
    }

    const outcome = yield* adapter.value
      .execute({
        operationId: operation.operationId,
        arguments: prepared.arguments,
        credentials: stored.value,
        connectionId: current.value.connectionId,
        // Read with the connection, immediately before dispatch, so a cap the
        // owner lowered while the card was open is the cap that applies.
        settings: current.value.settings,
        // From the re-read connection, so a vendor that scopes by team uses
        // the account the owner approved rather than resolving its own.
        account: current.value.account,
        ...(Option.isNone(currentSecondary) || Option.isNone(storedSecondary)
          ? {}
          : {
              secondary: {
                vendorId: currentSecondary.value.vendorId,
                credentials: storedSecondary.value,
                account: currentSecondary.value.account,
              },
            }),
      })
      .pipe(
        Effect.map((result) => ({ ok: true as const, result, unauthorized: false })),
        // The detail is the vendor's own words about our own request, so it
        // is scrubbed before it reaches a model, a log or an error message.
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            unauthorized: error.unauthorized === true,
            secondaryRejected: error.rejectedCredential === "secondary",
            // Only a 4xx is a definite "no": anything else may have acted.
            ambiguous: !(error.status !== undefined && error.status >= 400 && error.status < 500),
            detail: Operations.scrubCredentialValues(error.detail, secrets),
          }),
        ),
        // A defect carries a stack that quotes the call it came from.
        Effect.catchCause((cause) =>
          Effect.succeed({
            ok: false as const,
            unauthorized: false,
            secondaryRejected: false,
            ambiguous: true,
            detail: Operations.scrubCredentialValues(cause, secrets),
          }),
        ),
      );

    if (approvalId !== null) {
      yield* approvals
        .recordExecution({ approvalId, outcome: outcome.ok ? "succeeded" : "failed" })
        .pipe(Effect.ignore);
    }

    if (!outcome.ok) {
      yield* Effect.logWarning("connection gateway call failed", {
        operationId: operation.operationId,
        vendorId: operation.vendorId,
        detail: outcome.detail,
      });
      if (outcome.unauthorized) {
        // Personal access tokens expire on the provider's schedule, so this is
        // an ordinary path. Moving the connection now means the owner sees it
        // in Settings instead of a run of identical failures in a chat. A
        // transfer's second half runs on the other account, and that is the
        // one whose token was refused.
        const rejected =
          outcome.secondaryRejected &&
          secondaryDefinition !== null &&
          Option.isSome(currentSecondary)
            ? {
                connectionId: currentSecondary.value.connectionId,
                displayName: secondaryDefinition.displayName,
              }
            : { connectionId: connection.connectionId, displayName: definition.displayName };
        yield* connections.markNeedsReauth(rejected.connectionId).pipe(Effect.ignore);
        return yield* refuse(
          `${rejected.displayName} would not accept the saved credential (${outcome.detail}), so the connection now needs reconnecting. Tell the user to reconnect ${rejected.displayName} in Settings; you cannot do it yourself.`,
        );
      }
      return yield* new PersonalConnectionGatewayError({
        reason: `${definition.displayName} refused ${operation.operationId}: ${outcome.detail}`,
        ...(outcome.ambiguous ? { ambiguous: true } : {}),
      });
    }

    return {
      _tag: "completed" as const,
      operationId: operation.operationId,
      result: Operations.allowlistResult(operation, outcome.result),
      approvalId,
    };
  });

  const describe: PersonalConnectionGateway["Service"]["describe"] = () =>
    connections.list().pipe(
      Effect.mapError((error) => refuse(error.message)),
      Effect.map(({ connections: rows }) =>
        rows
          // Only connected accounts: an operation a bot cannot run is an
          // invitation to try, and the refusal would read like a bug.
          .filter((row) => row.status === "connected")
          .map((row) => ({
            vendorId: row.vendorId,
            displayName: connectionDefinition(row.vendorId).displayName,
            operations: Operations.operationsForVendor(row.vendorId).map((operation) => ({
              operation: operation.operationId,
              description: operation.description,
              argumentsJsonSchema: operation.argumentsJsonSchema,
            })),
          })),
      ),
    );

  return PersonalConnectionGateway.of({ call, describe });
});

export const layer = Layer.effect(PersonalConnectionGateway, make);
