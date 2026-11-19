import * as NodeCrypto from "node:crypto";

import type { ConnectionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

/** Opaque handle the phone holds while the owner signs in on Microsoft's page. */
export type DeviceSignInId = string & { readonly _brand: "DeviceSignInId" };

export interface PendingDeviceSignIn {
  readonly deviceCode: Redacted.Redacted<string>;
  readonly userCode: string;
  readonly expiresAtMs: number;
  readonly intervalSec: number;
  /** The row this sign-in replaces the saved login of, when the owner chose Reconnect. */
  readonly reconnect: ConnectionId | null;
}

export type PendingLookup =
  | { readonly _tag: "found"; readonly entry: PendingDeviceSignIn }
  | { readonly _tag: "expired" }
  | { readonly _tag: "unknown" };

const MAX_PENDING = 8;

export class EmailPendingDevices extends Context.Service<
  EmailPendingDevices,
  {
    readonly begin: (entry: PendingDeviceSignIn) => Effect.Effect<DeviceSignInId>;
    /** A sign-in past its deadline is dropped and reported as expired once; asked again it is unknown. */
    readonly lookup: (id: string, nowMs: number) => Effect.Effect<PendingLookup>;
    readonly slowDown: (id: string, extraSec: number) => Effect.Effect<void>;
    /** Single use: whoever finishes a sign-in removes it, so a second poll cannot connect twice. */
    readonly finish: (id: string) => Effect.Effect<void>;
  }
>()("t3/personal/connections/email/pendingDevices/EmailPendingDevices") {}

export const make = Effect.sync(() => {
  const entries = new Map<string, PendingDeviceSignIn>();
  return EmailPendingDevices.of({
    begin: (entry) =>
      Effect.sync(() => {
        while (entries.size >= MAX_PENDING) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
        const id = NodeCrypto.randomBytes(32).toString("base64url") as DeviceSignInId;
        entries.set(id, entry);
        return id;
      }),
    lookup: (id, nowMs) =>
      Effect.sync(() => {
        const entry = entries.get(id);
        if (entry === undefined) return { _tag: "unknown" as const };
        if (nowMs >= entry.expiresAtMs) {
          entries.delete(id);
          return { _tag: "expired" as const };
        }
        return { _tag: "found" as const, entry };
      }),
    slowDown: (id, extraSec) =>
      Effect.sync(() => {
        const entry = entries.get(id);
        if (entry !== undefined)
          entries.set(id, { ...entry, intervalSec: entry.intervalSec + extraSec });
      }),
    finish: (id) =>
      Effect.sync(() => {
        entries.delete(id);
      }),
  });
});

export const layer = Layer.effect(EmailPendingDevices, make);
