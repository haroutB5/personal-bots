import {
  PERSONAL_SECRET_BROKER_METHODS,
  PERSONAL_SECRET_MAX_ORIGINS,
  normalizePersonalSecretOrigins,
  normalizePersonalSecretPlacement,
  type PersonalSecretBrokerMethod,
  type PersonalSecretMode,
  type PersonalSecretPlacement,
} from "@t3tools/contracts";

/** What the owner chose for how a bot may use a key. */
export interface SecretAccessChoice {
  readonly mode: PersonalSecretMode;
  /** Canonical origins; empty for an environment variable. */
  readonly origins: ReadonlyArray<string>;
  /** Where the key's placeholder may go; `{}` is the Authorization header only. */
  readonly placement: PersonalSecretPlacement;
}

/** The "where may the key go" boxes as typed, before they are checked. */
export interface SecretPlacementState {
  readonly header: string;
  readonly anywhere: boolean;
  readonly pathPrefix: string;
  /** None ticked means every method. */
  readonly methods: ReadonlyArray<PersonalSecretBrokerMethod>;
}

export interface SecretAccessState {
  readonly mode: PersonalSecretMode;
  /** What is typed in the address box: one address, or several separated by spaces or commas. */
  readonly originsText: string;
  readonly placement: SecretPlacementState;
}

/** The boxes for a key's saved placement (all empty when it has none: the strictest default). */
export const placementStateOf = (
  placement: PersonalSecretPlacement | undefined,
): SecretPlacementState => ({
  header: placement?.header ?? "",
  anywhere: placement?.anywhere === true,
  pathPrefix: placement?.pathPrefix ?? "",
  methods: placement?.methods ?? [],
});

/** The state for a saved key's access panel. */
export const secretAccessStateOf = (secret: {
  readonly mode: PersonalSecretMode;
  readonly origins: ReadonlyArray<string>;
  readonly placement?: PersonalSecretPlacement | undefined;
}): SecretAccessState => ({
  mode: secret.mode === "brokered" ? "brokered" : "env",
  originsText: secret.origins.join(", "),
  placement: placementStateOf(secret.placement),
});

const placementOf = (state: SecretPlacementState): PersonalSecretPlacement | null =>
  normalizePersonalSecretPlacement({
    header: state.header,
    anywhere: state.anywhere,
    pathPrefix: state.pathPrefix,
    methods: state.methods,
  });

/** One line saying where a saved key may go, for the keys list. */
export function describeSecretPlacement(placement: PersonalSecretPlacement | undefined): string {
  const parts: Array<string> = [
    placement?.header === undefined
      ? "Sent in the Authorization header only"
      : `Sent in the Authorization or ${placement.header} header`,
  ];
  if (placement?.anywhere === true)
    parts[0] = `${parts[0]!.replace(" only", "")}, the URL and the body`;
  if (placement?.pathPrefix !== undefined) parts.push(`paths under ${placement.pathPrefix}`);
  if (placement?.methods !== undefined) parts.push(`${placement.methods.join(", ")} only`);
  return parts.join("; ");
}

const splitOrigins = (text: string): ReadonlyArray<string> =>
  text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/** The state a form starts in: brokered, with the address a bot asked for (if any). */
export const initialSecretAccess = (origins: ReadonlyArray<string> = []): SecretAccessState => ({
  mode: "brokered",
  originsText: origins.join(", "),
  placement: placementStateOf(undefined),
});

/** Why the choice cannot be saved yet, or null when it can. */
export function secretAccessProblem(state: SecretAccessState): string | null {
  if (state.mode === "env") return null;
  const entries = splitOrigins(state.originsText);
  if (entries.length === 0) {
    return "Enter the address this key may be sent to, like https://api.vercel.com.";
  }
  if (entries.length > PERSONAL_SECRET_MAX_ORIGINS) {
    return `At most ${PERSONAL_SECRET_MAX_ORIGINS} addresses.`;
  }
  if (normalizePersonalSecretOrigins(entries) === null) {
    return "Use a public https:// address such as https://api.vercel.com (no IP addresses or localhost).";
  }
  if (placementOf(state.placement) === null) {
    return "Check where the key may go: a plain header name, and a path that starts with / with no .. or ?.";
  }
  return null;
}

/** The choice to send to the server; call only when {@link secretAccessProblem} is null. */
export function secretAccessChoice(state: SecretAccessState): SecretAccessChoice {
  if (state.mode === "env") return { mode: "env", origins: [], placement: {} };
  return {
    mode: "brokered",
    origins: normalizePersonalSecretOrigins(splitOrigins(state.originsText)) ?? [],
    placement: placementOf(state.placement) ?? {},
  };
}

export { PERSONAL_SECRET_BROKER_METHODS };
