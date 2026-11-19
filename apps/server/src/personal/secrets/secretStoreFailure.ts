import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

export const lockedSecretsMessage = (reason: ServerSecretStore.SecretStoreLockedError["reason"]) =>
  reason === "key-missing"
    ? "Saved keys are locked on this computer. The secret key file is missing, so hbots can't open or add keys until it is restored. Your value was not saved."
    : "Saved keys are locked on this computer. They were sealed on another machine, so hbots can't open or add keys until the secret key is moved over. Your value was not saved.";

export const storeFailureMessage = (cause: unknown, fallback: string): string =>
  cause instanceof ServerSecretStore.SecretStoreLockedError
    ? lockedSecretsMessage(cause.reason)
    : fallback;
