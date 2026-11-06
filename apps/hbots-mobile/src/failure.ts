import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

export const SESSION_REVOKED_CLOSE_CODE = 4401;

export type RequestRoute =
  | "descriptor"
  | "compat"
  | "pair"
  | "renew"
  | "ticket"
  | "revoke"
  | "socket";

export type FailureDetail =
  | {
      readonly kind: "http";
      readonly route: RequestRoute;
      readonly status: number;
      readonly jsonBody: boolean;
    }
  | { readonly kind: "network" }
  | { readonly kind: "timeout" }
  | { readonly kind: "not-json" }
  | { readonly kind: "environment-mismatch" };

export class RequestFailure extends Error {
  readonly detail: FailureDetail;

  constructor(detail: FailureDetail) {
    super(describeDetail(detail));
    this.name = "RequestFailure";
    this.detail = detail;
  }
}

/** The server answered a pairing exchange without binding the token to the phone key. */
export class DpopRequiredError extends Error {
  constructor() {
    super("The server issued a Bearer session to a phone.");
    this.name = "DpopRequiredError";
  }
}

export type Failure =
  | {
      readonly kind: "authDead";
      readonly reason:
        | "unauthorized"
        | "session-ended"
        | "session-revoked"
        | "environment-mismatch";
    }
  | { readonly kind: "unreachable" };

function describeDetail(detail: FailureDetail): string {
  switch (detail.kind) {
    case "http":
      return `HTTP ${String(detail.status)} from ${detail.route}`;
    case "network":
      return "The network request failed.";
    case "timeout":
      return "The request timed out.";
    case "not-json":
      return "The server answered with something other than JSON.";
    case "environment-mismatch":
      return "This address now belongs to a different hbots server.";
    default:
      return detail satisfies never;
  }
}

function isSessionRevokedClose(error: unknown): boolean {
  return (
    error instanceof RpcClientError &&
    error.reason._tag === "SocketCloseError" &&
    error.reason.code === SESSION_REVOKED_CLOSE_CODE
  );
}

export function classifyFailure(error: unknown): Failure {
  if (isSessionRevokedClose(error)) {
    return { kind: "authDead", reason: "session-revoked" };
  }
  if (!(error instanceof RequestFailure)) {
    return { kind: "unreachable" };
  }
  const { detail } = error;
  switch (detail.kind) {
    case "environment-mismatch":
      return { kind: "authDead", reason: "environment-mismatch" };
    case "http":
      if (!detail.jsonBody) {
        return { kind: "unreachable" };
      }
      if (detail.status === 401) {
        return { kind: "authDead", reason: "unauthorized" };
      }
      if (detail.status === 403 && detail.route === "renew") {
        return { kind: "authDead", reason: "session-ended" };
      }
      return { kind: "unreachable" };
    case "network":
    case "timeout":
    case "not-json":
      return { kind: "unreachable" };
    default:
      return detail satisfies never;
  }
}

export function assertSameEnvironment(stored: string, current: string): void {
  if (stored !== current) {
    throw new RequestFailure({ kind: "environment-mismatch" });
  }
}
