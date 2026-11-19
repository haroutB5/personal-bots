import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

export const LOCKED_SECRETS_MESSAGE =
  "Saved keys are locked on this computer. They were sealed on another machine, so hbots can't open or add keys until the secret key is moved over. Your value was not saved.";

export const storeFailureMessage = (cause: unknown, fallback: string): string =>
  cause instanceof ServerSecretStore.SecretStoreLockedError ? LOCKED_SECRETS_MESSAGE : fallback;
