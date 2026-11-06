import { AuthAccessReadScope, AuthAccessWriteScope } from "@t3tools/contracts";

/** The Devices screen lists and revokes sessions, so it needs both access scopes. */
export function canManageDevices(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry.length > 0));
  return granted.has(AuthAccessReadScope) && granted.has(AuthAccessWriteScope);
}
