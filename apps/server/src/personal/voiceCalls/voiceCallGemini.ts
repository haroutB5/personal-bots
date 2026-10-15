// @effect-diagnostics globalFetch:off - the call is made by the secret broker, never by this module.
/**
 * The Gemini side of a voice call: mint one single-use Live token from the
 * saved `GEMINI_API_KEY`, and read Google's answer.
 *
 * The key never passes through this module. The request carries the broker
 * placeholder `{{secret:GEMINI_API_KEY}}` in the `x-goog-api-key` header, and
 * the broker puts the value in for the one origin the key is bound to. That
 * means the value cannot appear in a log, an error or a response body, and the
 * module can be tested by faking the one HTTP call it makes.
 *
 * Nothing here talks to the network on its own: the transport is a service, so
 * a test provides its own and the real one is the broker.
 */
import {
  personalSecretPlaceholder,
  VOICE_CALL_SECRET_HEADER,
  VOICE_CALL_SECRET_NAME,
  type VoiceCallErrorCode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  callWithSecrets,
  SecretBrokerError,
  type BrokerDeps,
  type BrokerRequest,
  type BrokerResult,
  type BrokerSecret,
} from "../secrets/secretBroker.ts";

/** Where a Live token is minted. The only Google address a call's start uses. */
export const VOICE_CALL_MINT_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";

/**
 * The one request the mint makes. Exported so a test can assert the exact
 * shape (URL, header the placeholder sits in, body) without a network.
 */
export const voiceCallMintRequest = (input: {
  readonly expireTime: string;
  readonly newSessionExpireTime: string;
}): BrokerRequest => ({
  method: "POST",
  url: VOICE_CALL_MINT_URL,
  headers: {
    "content-type": "application/json",
    [VOICE_CALL_SECRET_HEADER]: personalSecretPlaceholder(VOICE_CALL_SECRET_NAME),
  },
  body: JSON.stringify({
    uses: 1,
    expireTime: input.expireTime,
    newSessionExpireTime: input.newSessionExpireTime,
  }),
  timeoutMs: 20_000,
  maxResponseBytes: 32_768,
});

const MintResponse = Schema.Struct({ name: Schema.String });
const decodeMintResponse = Schema.decodeUnknownOption(Schema.fromJsonString(MintResponse));

/** Google's answer, before it is turned into the app's own error codes. */
export interface VoiceCallMintOutcome {
  readonly status: number;
  /** The token itself when the mint worked; null otherwise. */
  readonly token: string | null;
  /** The body, for deciding between "bad key", "out of quota" and "Google is down". */
  readonly body: string;
}

/**
 * Google's own error text decides between a refused key and a key that is
 * fine but paused. Both are real answers about the key, and the call screen
 * words them differently.
 */
export const voiceCallMintErrorCode = (outcome: VoiceCallMintOutcome): VoiceCallErrorCode => {
  const body = outcome.body.toLowerCase();
  if (outcome.status === 401 || outcome.status === 403) return "key_rejected";
  if (outcome.status === 429) return "key_quota";
  if (outcome.status === 400) {
    return /api[_ -]?key|invalid.*credential|permission/.test(body)
      ? "key_rejected"
      : "google_unavailable";
  }
  if (outcome.status >= 500) return "google_unavailable";
  return body.includes("quota") ? "key_quota" : "google_unavailable";
};

/** A broker refusal that means the key is missing or unusable, not that Google is down. */
export const voiceCallBrokerRefusalCode = (message: string): VoiceCallErrorCode =>
  /no saved key named/i.test(message)
    ? "no_key"
    : /not allowed to be sent|environment variable|not as a brokered key/i.test(message)
      ? "key_rejected"
      : "google_unavailable";

/**
 * The one HTTP call the voice-call feature makes. The real layer is the secret
 * broker; a test provides a function instead and never opens a socket.
 */
export class VoiceCallHttp extends Context.Service<
  VoiceCallHttp,
  {
    readonly call: (
      request: BrokerRequest,
      secrets: ReadonlyArray<BrokerSecret>,
    ) => Effect.Effect<VoiceCallMintOutcome, SecretBrokerError>;
  }
>()("t3/personal/voiceCalls/voiceCallGemini/VoiceCallHttp") {}

/** Extra broker hooks (a private CA, a resolver) for the integration test. */
export class VoiceCallHttpConfig extends Context.Service<VoiceCallHttpConfig, BrokerDeps>()(
  "t3/personal/voiceCalls/voiceCallGemini/VoiceCallHttpConfig",
) {}

const outcomeOf = (result: BrokerResult): VoiceCallMintOutcome => {
  const body = result.body ?? "";
  const decoded = result.status === 200 ? decodeMintResponse(body) : Option.none();
  return {
    status: result.status,
    token: Option.isSome(decoded) ? decoded.value.name : null,
    body,
  };
};

export const layerLive: Layer.Layer<VoiceCallHttp> = Layer.effect(
  VoiceCallHttp,
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(VoiceCallHttpConfig);
    const deps = Option.getOrUndefined(config) ?? {};
    return VoiceCallHttp.of({
      call: (request, secrets) =>
        Effect.tryPromise({
          try: () => callWithSecrets(request, secrets, deps),
          catch: (cause) =>
            cause instanceof SecretBrokerError
              ? cause
              : new SecretBrokerError("The request failed before a response arrived."),
        }).pipe(Effect.map(outcomeOf)),
    });
  }),
);
