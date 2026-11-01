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

export type Failure =
  | {
      readonly kind: "authDead";
      readonly reason: "unauthorized" | "session-ended" | "environment-mismatch";
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

export function classifyFailure(error: unknown): Failure {
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
