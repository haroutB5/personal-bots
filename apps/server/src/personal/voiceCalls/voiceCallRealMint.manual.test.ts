/**
 * The one test that talks to Google for real, and only when it is asked to:
 * it mints a single-use Gemini Live token with the `GEMINI_API_KEY` saved in a
 * data root's own secret store, through the same broker request the service
 * sends. It never prints, logs or returns the key.
 *
 * It is skipped by default, because it needs a saved key and a network:
 *
 *   $env:VOICE_CALL_REAL_MINT_ROOT = "$env:TEMP\hbots-tw-voicemint"
 *   $env:VOICE_CALL_REAL_MINT = "1"
 *   cd apps/server; vp test run src/personal/voiceCalls/voiceCallRealMint
 *
 * The root is an ordinary hbots data root (a throwaway server's is ideal):
 * the key goes in through Settings there, exactly as it does live. Nothing is
 * written to the root beyond what the secret store already holds.
 */
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { callWithSecrets, SecretBrokerError } from "../secrets/secretBroker.ts";
import { voiceCallMintRequest } from "./voiceCallGemini.ts";
import { personalSecretStoreKey } from "../secrets/PersonalSecretService.ts";

const root = process.env.VOICE_CALL_REAL_MINT_ROOT;
const enabled = process.env.VOICE_CALL_REAL_MINT === "1" && root !== undefined && root !== "";

describe("voiceCallGemini real mint", () => {
  it.effect.skipIf(!enabled)("mints a real single-use Live token from the saved key", () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const stored = yield* store.get(personalSecretStoreKey("GEMINI_API_KEY"));
      if (Option.isNone(stored)) {
        // The root has no key saved: nothing to prove, and no value to leak.
        return;
      }
      const value = new TextDecoder().decode(stored.value);
      expect(value.length).toBeGreaterThan(0);

      const now = yield* DateTime.now;
      const result = yield* Effect.tryPromise({
        try: () =>
          callWithSecrets(
            voiceCallMintRequest({
              expireTime: DateTime.formatIso(DateTime.add(now, { minutes: 30 })),
              newSessionExpireTime: DateTime.formatIso(DateTime.add(now, { seconds: 60 })),
            }),
            [
              {
                name: "GEMINI_API_KEY",
                mode: "brokered",
                origins: ["https://generativelanguage.googleapis.com"],
                placement: { header: "x-goog-api-key" },
                value,
              },
            ],
          ),
        catch: (cause) =>
          cause instanceof SecretBrokerError ? cause : new SecretBrokerError("call failed"),
      });

      // Only the shape is asserted and reported: never the token, never the key.
      expect(result.status).toBe(200);
      expect(result.body ?? "").toContain("auth_tokens/");
      yield* Effect.logInfo("real mint ok", {
        status: result.status,
        bodyBytes: result.bodyBytes,
        ms: result.ms,
        keyChars: value.length,
      });
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), root!)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
