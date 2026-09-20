import type { PersonalConnectionVendorId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * The boundary between the gateway and a provider.
 *
 * An adapter is the only thing that talks to a vendor, and the only thing that
 * ever holds a credential value. It receives the already-validated arguments
 * and the credential fields as `Redacted`, so a value cannot reach a log or a
 * message by being interpolated somewhere careless upstream.
 *
 * No adapter ships in this milestone: the gateway, its gate and its receipts
 * are the work, and a vendor with no adapter is refused rather than guessed
 * at. Milestone 3 adds GitHub and Vercel here.
 */

export class ConnectionVendorError extends Schema.TaggedError<ConnectionVendorError>()(
  "ConnectionVendorError",
  {
    operationId: Schema.String,
    /** May quote the request back, so the gateway scrubs it before anyone reads it. */
    detail: Schema.String,
  },
) {}

export interface ConnectionVendorCall {
  readonly operationId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly credentials: Readonly<Record<string, Redacted.Redacted<string>>>;
}

export interface ConnectionVendorAdapter {
  readonly vendorId: PersonalConnectionVendorId;
  /**
   * The vendor request/response shape this adapter currently speaks. The
   * gateway compares it with the shape the operation was reviewed against and
   * stops when they differ: a provider that changed its contract under us is
   * not something to execute against unattended.
   */
  readonly vendorSchema: (operationId: string) => Effect.Effect<string, ConnectionVendorError>;
  readonly execute: (
    call: ConnectionVendorCall,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, ConnectionVendorError>;
}

export class ConnectionVendorAdapters extends Context.Service<
  ConnectionVendorAdapters,
  {
    readonly forVendor: (
      vendorId: PersonalConnectionVendorId,
    ) => Option.Option<ConnectionVendorAdapter>;
  }
>()("t3/personal/connections/adapters/ConnectionVendorAdapters") {}

export const layerOf = (adapters: ReadonlyArray<ConnectionVendorAdapter>) =>
  Layer.succeed(
    ConnectionVendorAdapters,
    ConnectionVendorAdapters.of({
      forVendor: (vendorId) =>
        Option.fromNullishOr(adapters.find((adapter) => adapter.vendorId === vendorId)),
    }),
  );

/** What ships today: nothing executes, and the gateway says so plainly. */
export const layer = layerOf([]);
