/**
 * What hbots knows about a registry agent's sign-in, and the words it uses.
 *
 * ACP only lets an agent list how it can be signed in (`authMethods`); it does
 * not say whether the user already is. Some agents also accept a session and
 * a prompt while signed out and then never answer (Kilo does this). So the
 * state is learned: a turn that produces output proves the agent works, and a
 * turn that stays silent past the first-output deadline says it needs a
 * sign-in. Generic sign-in flows are not built; the agent's own hint is shown.
 *
 * @module provider/catalog/registryAuth
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as AcpErrors from "effect-acp/errors";

export interface RegistryAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

/** `unknown`: nothing learned yet. `signedIn`: output arrived. `needed`: the agent stayed silent or asked. */
export type RegistryAuthVerdict = "unknown" | "signedIn" | "needed";

export interface RegistryAuthState {
  readonly methods: ReadonlyArray<RegistryAuthMethod>;
  readonly verdict: RegistryAuthVerdict;
}

/** How long a turn may stay completely silent before it counts as "needs sign-in". */
export const REGISTRY_FIRST_OUTPUT_TIMEOUT_MS = 45_000;

const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

/** The ACP `auth_required` error code, as Antigravity and the ACP spec use it. */
export function isAuthRequiredError(error: unknown): boolean {
  return isAcpRequestError(error) && error.code === -32000;
}

export function toAuthMethods(
  methods: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description?: string | null | undefined;
  }>,
): ReadonlyArray<RegistryAuthMethod> {
  return methods.map((method) => ({
    id: method.id,
    name: method.name,
    description: method.description?.trim() ? method.description.trim() : null,
  }));
}

const sentence = (text: string) => text.trim().replace(/[.!\s]+$/u, "");

/** The agent's own words for how to sign in, as one short instruction. */
export function signInHint(name: string, methods: ReadonlyArray<RegistryAuthMethod>): string {
  const described = methods.find((method) => method.description !== null);
  if (described?.description) return `${sentence(described.description)}, then test it again.`;
  if (methods.length > 0) {
    return `Sign in to ${name} with ${methods.map((method) => method.name).join(" or ")}, then test it again.`;
  }
  return `Sign in to ${name}, then test it again.`;
}

/**
 * The snapshot message. The first line is the hint (the web shows that line
 * on the provider page); the second names the agent's sign-in options.
 */
export function signInSnapshotMessage(
  name: string,
  methods: ReadonlyArray<RegistryAuthMethod>,
): string {
  const options =
    methods.length > 0
      ? `\nSign-in options: ${methods.map((method) => method.name).join(", ")}.`
      : "";
  return `${signInHint(name, methods)}${options}`;
}

/** What a turn shows when the agent would not answer. */
export function signInTurnMessage(
  name: string,
  methods: ReadonlyArray<RegistryAuthMethod>,
): string {
  return `${name} needs you to sign in. ${signInHint(name, methods)}`;
}

export interface RegistryAuthMemory {
  readonly state: SubscriptionRef.SubscriptionRef<RegistryAuthState>;
  readonly setMethods: (methods: ReadonlyArray<RegistryAuthMethod>) => Effect.Effect<void>;
  readonly markSignedIn: Effect.Effect<void>;
  readonly markNeeded: Effect.Effect<void>;
}

export const makeRegistryAuthMemory = Effect.fn("makeRegistryAuthMemory")(function* () {
  const state = yield* SubscriptionRef.make<RegistryAuthState>({ methods: [], verdict: "unknown" });
  const setVerdict = (verdict: RegistryAuthVerdict) =>
    SubscriptionRef.update(state, (current) =>
      current.verdict === verdict ? current : { ...current, verdict },
    );
  return {
    state,
    setMethods: (methods) =>
      SubscriptionRef.update(state, (current) =>
        current.methods.length === methods.length &&
        current.methods.every((method, index) => method.id === methods[index]?.id)
          ? current
          : { ...current, methods },
      ),
    markSignedIn: setVerdict("signedIn"),
    markNeeded: setVerdict("needed"),
  } satisfies RegistryAuthMemory;
});
