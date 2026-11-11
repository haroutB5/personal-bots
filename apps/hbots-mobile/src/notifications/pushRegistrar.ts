import type { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useMemo } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { type PushRegistrar, type RegisterOutcome, TOO_OLD } from "./pushController";

/**
 * R2's `personalPush.registerFcm` and `unregisterFcm` are not in this tree's `WS_METHODS` yet,
 * so the tags are cast to a known one. After R2 merges, use `WS_METHODS.personalPushRegisterFcm`
 * and `personalPushUnregisterFcm` and delete `rpcTag`.
 */
type KnownTag = typeof WS_METHODS.personalPushTest;
const rpcTag = (tag: string): KnownTag => tag as never;

export const REGISTER_TAG = "personalPush.registerFcm";
export const UNREGISTER_TAG = "personalPush.unregisterFcm";

/** Maps a failed call to a sentence the Notifications screen can show. */
export function registerFailureMessage(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { readonly message: unknown }).message)
      : "";
  // An old hbots on the computer has no such call. The client answers with a missing-method defect.
  if (/unknown (request|rpc|method)|no handler|method not found|not implemented/i.test(message)) {
    return TOO_OLD;
  }
  return message.trim().length > 0 ? message : "Could not register this phone.";
}

/** Reads the server's answer. Anything but the two known values is a failure, never a guess. */
export function parseRegisterResult(value: unknown): RegisterOutcome {
  const delivery =
    typeof value === "object" && value !== null && "delivery" in value
      ? (value as { readonly delivery: unknown }).delivery
      : undefined;
  if (delivery === "ready") return { kind: "ready" };
  if (delivery === "disabled") return { kind: "disabled" };
  return { kind: "failed", message: "Your computer answered in a way this app does not know." };
}

export function outcomeOfResult(result: AtomCommandResult<unknown, unknown>): RegisterOutcome {
  if (result._tag === "Success") return parseRegisterResult(result.value);
  return { kind: "failed", message: registerFailureMessage(squashAtomCommandFailure(result)) };
}

function createCommands(native: NativePersonal) {
  const register = createEnvironmentRpcCommand(native.runtime, {
    label: "personal-push:register-fcm",
    tag: rpcTag(REGISTER_TAG),
  });
  const unregister = createEnvironmentRpcCommand(native.runtime, {
    label: "personal-push:unregister-fcm",
    tag: rpcTag(UNREGISTER_TAG),
  });
  return { register, unregister };
}

/** The registrar for this connection. Rebuilt only when the connection changes. */
export function usePushRegistrar(native: NativePersonal): PushRegistrar {
  const commands = useMemo(() => createCommands(native), [native]);
  const register = native.client.useAtomCommand(commands.register, { reportFailure: false });
  const unregister = native.client.useAtomCommand(commands.unregister, { reportFailure: false });
  const environmentId = native.environmentId as EnvironmentId;
  return useMemo<PushRegistrar>(
    () => ({
      register: async ({ token, appVersion }) =>
        outcomeOfResult(await register({ environmentId, input: { token, appVersion } as never })),
      unregister: async (token) => {
        await unregister({ environmentId, input: { token } as never });
      },
    }),
    [environmentId, register, unregister],
  );
}
