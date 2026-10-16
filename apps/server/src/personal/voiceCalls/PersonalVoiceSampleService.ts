/**
 * Voice samples for Settings > Voice calls (spec section 8, Harout 15/16 Oct).
 *
 * "Tap play to hear a voice": the picker plays a short clip of the voice the
 * owner is choosing. Two things make that safe and cheap:
 *
 * - **The text is a constant.** Every request says the same one line
 *   (`VOICE_CALL_SAMPLE_TEXT`) and the voice must be one of the thirty Gemini
 *   Live offers, so this endpoint can never be turned into a free
 *   text-to-speech proxy for arbitrary words.
 * - **Each clip is made once.** The WAV is written under the data root's
 *   `voice-samples/` folder and served from there after that, so the model is
 *   billed once per voice, not once per tap, and a restart keeps the cache.
 *
 * The clip is one voice, not a call: it never touches a chat, a transcript or
 * the sensitive-chat gate. Only the shared `GEMINI_API_KEY` is read, through
 * the same broker a call mints its token with.
 */
import {
  isVoiceCallVoice,
  VOICE_CALL_SAMPLE_MAX_BYTES,
  VOICE_CALL_SAMPLE_MODEL,
  VOICE_CALL_SAMPLE_TEXT,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  type VoiceCallErrorCode,
  type VoiceCallSampleResult,
  PersonalVoiceCallsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import * as VoiceCallGemini from "./voiceCallGemini.ts";

/** The folder under the data root that holds one cached clip per voice. */
export const VOICE_CALL_SAMPLE_DIR = "voice-samples";

/** Any file smaller than a WAV header is not a clip: it is regenerated. */
const WAV_HEADER_BYTES = 44;

const fail = (code: VoiceCallErrorCode, message: string) =>
  new PersonalVoiceCallsError({ code, message });

export class PersonalVoiceSampleService extends Context.Service<
  PersonalVoiceSampleService,
  {
    /**
     * One voice's clip, from the cache or freshly made. Refuses an unknown
     * voice, a missing key or a Google answer that carries no audio.
     */
    readonly sample: (input: {
      readonly voiceName: string;
    }) => Effect.Effect<VoiceCallSampleResult, PersonalVoiceCallsError>;
  }
>()("t3/personal/voiceCalls/PersonalVoiceSampleService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* PersonalSessionAccess.PersonalSessionAccess;
  const http = yield* VoiceCallGemini.VoiceCallHttp;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // One clip at a time: a double tap must not make the same voice twice.
  const lock = yield* Semaphore.make(1);
  const samplePath = (voiceName: string) =>
    path.join(config.stateDir, VOICE_CALL_SAMPLE_DIR, `${voiceName}.wav`);

  const readCached = (voiceName: string) =>
    Effect.gen(function* () {
      const file = samplePath(voiceName);
      const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return null;
      const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => null));
      if (bytes === null || bytes.byteLength <= WAV_HEADER_BYTES) return null;
      return bytes;
    });

  const writeCached = (voiceName: string, bytes: Uint8Array) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(samplePath(voiceName)), { recursive: true });
      yield* fs.writeFile(samplePath(voiceName), bytes);
    }).pipe(
      // A cache that cannot be written is only a slower next tap, never a
      // failed one: the clip in hand is returned either way.
      Effect.catch((cause) =>
        Effect.logWarning("personal voice sample could not be cached", {
          voiceName,
          errorTag: (cause as { readonly _tag?: unknown })?._tag ?? "unknown",
        }),
      ),
    );

  const sample: PersonalVoiceSampleService["Service"]["sample"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const voiceName = input.voiceName;
        if (!isVoiceCallVoice(voiceName)) {
          return yield* fail("invalid_input", "That is not a voice Gemini Live offers.");
        }
        const cached = yield* readCached(voiceName);
        if (cached !== null) {
          return {
            voiceName,
            mimeType: "audio/wav",
            base64: Buffer.from(cached).toString("base64"),
            cached: true,
          } satisfies VoiceCallSampleResult;
        }
        const saved = yield* sessions.sharedSecrets();
        const key = saved.find(
          (secret) =>
            secret.name === VOICE_CALL_SECRET_NAME &&
            secret.mode === "brokered" &&
            secret.origins.includes(VOICE_CALL_SECRET_ORIGIN),
        );
        if (key === undefined) {
          return yield* fail(
            "no_key",
            "Add a Gemini key to hear samples. Settings > Voice calls takes it once, and it stays on your laptop.",
          );
        }
        const outcome = yield* http
          .call(
            VoiceCallGemini.voiceCallSampleRequest({
              model: VOICE_CALL_SAMPLE_MODEL,
              voiceName,
              text: VOICE_CALL_SAMPLE_TEXT,
            }),
            [key],
          )
          .pipe(
            Effect.catch(() =>
              Effect.fail(fail("google_unavailable", "Google could not be reached for a sample.")),
            ),
          );
        const audio = VoiceCallGemini.voiceCallSampleAudio(outcome);
        if (audio === null) {
          return yield* fail(
            outcome.status === 429 ? "key_quota" : "sample_unavailable",
            "Google did not send a sample for that voice.",
          );
        }
        const bytes = Buffer.from(audio.base64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > VOICE_CALL_SAMPLE_MAX_BYTES) {
          return yield* fail("sample_unavailable", "That sample was not usable.");
        }
        yield* writeCached(voiceName, bytes);
        yield* Effect.logInfo("personal voice sample made", {
          voiceName,
          bytes: bytes.byteLength,
        });
        return {
          voiceName,
          mimeType: audio.mimeType,
          base64: audio.base64,
          cached: false,
        } satisfies VoiceCallSampleResult;
      }),
    );

  return { sample } satisfies PersonalVoiceSampleService["Service"];
});

export const layer = Layer.effect(PersonalVoiceSampleService, make);

/** The broker HTTP path and the session's own secrets; the rest is in the chain. */
export const layerLive = layer.pipe(
  Layer.provideMerge(PersonalSessionAccess.layerLive),
  Layer.provideMerge(VoiceCallGemini.layerLive),
);
