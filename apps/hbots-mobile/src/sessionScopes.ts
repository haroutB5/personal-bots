import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

/** The scopes the server granted at pairing, ignoring names this client does not know. */
export function grantedScopes(scope: string): ReadonlyArray<AuthEnvironmentScope> {
  return scope.split(/\s+/).filter(isAuthEnvironmentScope);
}

/** The Devices screen lists and revokes sessions, so it needs both access scopes. */
export function canManageDevices(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry.length > 0));
  return granted.has(AuthAccessReadScope) && granted.has(AuthAccessWriteScope);
}
