import { createPushController, type PushRegistrar } from "./pushController";
import { nativeNotify } from "./nativeNotify";
import { androidPermission } from "./pushPermission";
import { secureRegistrationStore } from "./registrationStore";

let registrar: PushRegistrar | null = null;
let appVersion = "";

/** The one controller of this app run. The UI reads it, the bridge feeds it. */
export const pushController = createPushController({
  native: () => nativeNotify,
  registrar: () => registrar,
  permission: androidPermission,
  store: secureRegistrationStore,
  appVersion: () => (appVersion.length > 0 ? appVersion.slice(0, 40) : "unknown"),
});

/** A live connection can (or can no longer) reach the server. Registering starts as soon as it can. */
export function setPushRegistrar(next: PushRegistrar | null, version: string): void {
  registrar = next;
  if (version.length > 0) appVersion = version;
  if (next !== null) void pushController.refresh();
}
