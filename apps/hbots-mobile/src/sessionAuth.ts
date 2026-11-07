export type SessionAuthMethod = "bearer" | "dpop";

export function authMethodOf(session: {
  readonly authMethod?: SessionAuthMethod;
}): SessionAuthMethod {
  return session.authMethod ?? "bearer";
}
