export const FCM_SERVICE_ACCOUNT_SECRET_NAME = "HBOTS_FCM_SERVICE_ACCOUNT";

const SERVER_ONLY_SECRET_NAMES: ReadonlySet<string> = new Set([FCM_SERVICE_ACCOUNT_SECRET_NAME]);

/** A key only the server itself uses. No bot is ever granted it, in any slot or mode. */
export const isServerOnlySecretName = (name: string): boolean => SERVER_ONLY_SECRET_NAMES.has(name);

export const serverOnlySecretNote = (name: string): string =>
  `${name} is a server-only key. The user can save it so the server can use it, but bots cannot use it: it is not an environment variable and secret_request cannot send it. Do not try to use it.`;
