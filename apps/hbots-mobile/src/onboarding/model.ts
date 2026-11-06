import { DpopRequiredError, RequestFailure } from "../failure";
import { parsePairingLink, type PairingTarget } from "../pairingLink";
import type { ServerIdentity } from "../pairing";

export type PairFailure =
  | "expired"
  | "used"
  | "unreachable"
  | "not-hbots"
  | "not-secure"
  | "app-too-old"
  | "camera-denied";

export type PairRetry =
  | { readonly kind: "welcome" }
  | { readonly kind: "scan" }
  | { readonly kind: "link"; readonly link: PairingTarget };

export type PairingState =
  | { readonly step: "welcome" }
  | { readonly step: "scan" }
  | { readonly step: "paste"; readonly draft: string; readonly invalid: boolean }
  | { readonly step: "checking"; readonly link: PairingTarget }
  | { readonly step: "confirm"; readonly link: PairingTarget; readonly server: ServerIdentity }
  | {
      readonly step: "label";
      readonly link: PairingTarget;
      readonly server: ServerIdentity;
      readonly label: string;
    }
  | {
      readonly step: "pairing";
      readonly link: PairingTarget;
      readonly server: ServerIdentity;
      readonly label: string;
    }
  | { readonly step: "failed"; readonly reason: PairFailure; readonly retry: PairRetry };

export type PairingAction =
  | { readonly type: "scan" }
  | { readonly type: "paste" }
  | { readonly type: "draft"; readonly value: string }
  | { readonly type: "submitPaste" }
  | { readonly type: "submitLink"; readonly value: string }
  | { readonly type: "checked"; readonly server: ServerIdentity }
  | { readonly type: "checkFailed"; readonly reason: PairFailure }
  | { readonly type: "confirm"; readonly defaultLabel: string }
  | { readonly type: "cancel" }
  | { readonly type: "label"; readonly value: string }
  | { readonly type: "pair" }
  | { readonly type: "pairFailed"; readonly reason: PairFailure }
  | { readonly type: "cameraDenied" }
  | { readonly type: "retry" }
  | { readonly type: "reset" }
  | { readonly type: "back" };

export const failureCopy: Record<
  PairFailure,
  { readonly headline: string; readonly help: string; readonly action: string }
> = {
  expired: {
    headline: "This code expired",
    help: "Codes last 5 minutes. Make a new one on your laptop.",
    action: "Scan again",
  },
  used: {
    headline: "This code was already used",
    help: "Each code pairs one phone.",
    action: "Scan again",
  },
  unreachable: {
    headline: "Can't reach your laptop",
    help: "Check this phone is on the same Wi-Fi or VPN as hbots.",
    action: "Try again",
  },
  "not-hbots": {
    headline: "That isn't an hbots code",
    help: "Scan the code from hbots Settings.",
    action: "Scan again",
  },
  "not-secure": {
    headline: "Pairing failed",
    help: "Your laptop did not secure this phone's session. Update hbots on your laptop, then make a new code.",
    action: "Try again",
  },
  "app-too-old": {
    headline: "Update hbots first",
    help: "Your laptop runs a newer hbots.",
    action: "Update",
  },
  "camera-denied": {
    headline: "Camera is off for hbots",
    help: "Turn it on, or paste the link.",
    action: "Open settings",
  },
};

function checkLink(link: PairingTarget): PairingState {
  return { step: "checking", link };
}

export function failureFor(cause: unknown): PairFailure {
  if (cause instanceof DpopRequiredError) {
    return "not-secure";
  }
  if (!(cause instanceof RequestFailure)) {
    return "unreachable";
  }
  switch (cause.detail.kind) {
    case "http":
      if ((cause.detail.status === 401 || cause.detail.status === 403) && cause.detail.jsonBody) {
        return "used";
      }
      return "not-hbots";
    case "not-json":
    case "environment-mismatch":
      return "not-hbots";
    case "network":
    case "timeout":
      return "unreachable";
  }
}

export function reducePairing(state: PairingState, action: PairingAction): PairingState {
  switch (action.type) {
    case "scan":
      return state.step === "welcome" || state.step === "failed" ? { step: "scan" } : state;
    case "paste":
      return state.step === "welcome" || state.step === "failed" || state.step === "scan"
        ? { step: "paste", draft: "", invalid: false }
        : state;
    case "draft":
      return state.step === "paste"
        ? { step: "paste", draft: action.value, invalid: false }
        : state;
    case "submitPaste": {
      if (state.step !== "paste") return state;
      const parsed = parsePairingLink(state.draft);
      return parsed.ok
        ? checkLink(parsed.target)
        : { step: "paste", draft: state.draft, invalid: true };
    }
    case "submitLink": {
      if (state.step !== "scan") return state;
      const parsed = parsePairingLink(action.value);
      return parsed.ok ? checkLink(parsed.target) : state;
    }
    case "checked":
      return state.step === "checking"
        ? { step: "confirm", link: state.link, server: action.server }
        : state;
    case "checkFailed":
      return state.step === "checking"
        ? {
            step: "failed",
            reason: action.reason,
            retry: { kind: "link", link: state.link },
          }
        : state;
    case "confirm":
      return state.step === "confirm"
        ? {
            step: "label",
            link: state.link,
            server: state.server,
            label: action.defaultLabel,
          }
        : state;
    case "cancel":
      return state.step === "confirm" || state.step === "label" ? { step: "welcome" } : state;
    case "label":
      return state.step === "label" ? { ...state, label: action.value } : state;
    case "pair": {
      if (state.step !== "label" || state.label.trim().length === 0) return state;
      return {
        step: "pairing",
        link: state.link,
        server: state.server,
        label: state.label.trim(),
      };
    }
    case "pairFailed":
      return state.step === "pairing"
        ? {
            step: "failed",
            reason: action.reason,
            retry: { kind: "link", link: state.link },
          }
        : state;
    case "cameraDenied":
      return state.step === "scan"
        ? { step: "failed", reason: "camera-denied", retry: { kind: "scan" } }
        : state;
    case "retry": {
      if (state.step !== "failed") return state;
      if (state.retry.kind === "link") return checkLink(state.retry.link);
      if (state.retry.kind === "scan") return { step: "scan" };
      return { step: "welcome" };
    }
    case "reset":
      return { step: "welcome" };
    case "back": {
      switch (state.step) {
        case "scan":
        case "paste":
          return { step: "welcome" };
        case "confirm":
          return { step: "welcome" };
        case "label":
          return {
            step: "confirm",
            link: state.link,
            server: state.server,
          };
        case "failed":
          return { step: "welcome" };
        case "welcome":
        case "checking":
        case "pairing":
          return state;
      }
    }
  }
}
