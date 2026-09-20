import {
  type PersonalBotId,
  type PersonalTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { connectionDefinition } from "./catalog.ts";
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
  { reason: Schema.String },
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

    // Before the owner is asked anything: there is no point raising a card for
    // an action we already know we will not run.
    const adapter = adapters.forVendor(operation.vendorId);
    if (Option.isNone(adapter)) {
      return yield* refuse(
        `${definition.displayName} operations are not available yet in this build. Tell the user this capability is not wired up.`,
      );
    }
    const vendorSchema = yield* adapter.value
      .vendorSchema(operation.operationId)
      .pipe(
        Effect.mapError(() =>
          refuse(`Could not check what shape ${definition.displayName} speaks. Nothing ran.`),
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

    const actionDigest = Operations.normalizedActionDigest({
      operationId: operation.operationId,
      arguments: prepared.arguments,
      connectionId: connection.connectionId,
      credentialVersion: connection.credentialVersion,
      targetResources: prepared.targetResources,
    });

    const approval = prepared.risk.approvalRequired
      ? yield* approvals
          .require({
            actionDigest,
            connectionId: connection.connectionId,
            vendorId: operation.vendorId,
            operationId: operation.operationId,
            riskReason: prepared.risk.reason,
            summary: prepared.risk.summary,
            targetResources: prepared.targetResources,
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

    const stored = yield* credentials
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
    // Held only for the length of this call, and only to remove every
    // rendering of them from whatever the vendor says back.
    const secrets = Object.values(stored.value).map(Redacted.value);

    const outcome = yield* adapter.value
      .execute({
        operationId: operation.operationId,
        arguments: prepared.arguments,
        credentials: stored.value,
      })
      .pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        // The detail is the vendor's own words about our own request, so it
        // is scrubbed before it reaches a model, a log or an error message.
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            detail: Operations.scrubCredentialValues(error.detail, secrets),
          }),
        ),
        // A defect carries a stack that quotes the call it came from.
        Effect.catchCause((cause) =>
          Effect.succeed({
            ok: false as const,
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
      return yield* refuse(
        `${definition.displayName} refused ${operation.operationId}: ${outcome.detail}`,
      );
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
