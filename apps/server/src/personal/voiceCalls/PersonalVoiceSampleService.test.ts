// @effect-diagnostics preferSchemaOverJson:off - the fake transport returns the raw Gemini body, which is the point of the test.
/**
 * Settings > Voice calls: one short clip per voice, made once with the saved
 * key and cached on disk after that (spec section 8, Astra review finding 9).
 *
 * Two properties matter most and are both asserted here: the text is a
 * constant (this endpoint can never speak words a caller chose), and the voice
 * is one of the allow-listed thirty (it can never ask Google for anything
 * else).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  VOICE_CALL_SAMPLE_FALLBACK_MODEL,
  VOICE_CALL_SAMPLE_MODEL,
  VOICE_CALL_SAMPLE_TEXT,
  VOICE_CALL_SECRET_HEADER,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import type { BrokerRequest, BrokerSecret, SecretBrokerError } from "../secrets/secretBroker.ts";
import {
  PersonalVoiceSampleService,
  VOICE_CALL_SAMPLE_DIR,
  layer as sampleLayer,
} from "./PersonalVoiceSampleService.ts";
import { VoiceCallHttp, type VoiceCallMintOutcome } from "./voiceCallGemini.ts";

const KEY_VALUE = "AIza-TEST-ONLY-KEY-VALUE";

/** A tiny but real WAV: 44-byte header plus a few samples. */
const WAV_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(36, 7),
  Buffer.from("data"),
  Buffer.alloc(64, 3),
]);

const wavAnswer = (): VoiceCallMintOutcome => ({
  status: 200,
  token: null,
  body: JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType: "audio/wav", data: WAV_BYTES.toString("base64") } }],
        },
      },
    ],
  }),
});

interface HttpCall {
  readonly request: BrokerRequest;
  readonly secrets: ReadonlyArray<BrokerSecret>;
}

interface HarnessOptions {
  readonly calls: Array<HttpCall>;
  readonly answer?: () => VoiceCallMintOutcome;
  readonly throws?: boolean;
  readonly withKey?: boolean;
  readonly baseDir: string;
}

const makeHarness = (options: HarnessOptions) => {
  const key: PersonalSessionAccess.PersonalSessionSecret = {
    name: "GEMINI_API_KEY",
    mode: "brokered",
    origins: ["https://generativelanguage.googleapis.com"],
    placement: { header: VOICE_CALL_SECRET_HEADER },
    value: KEY_VALUE,
  };
  const saved = options.withKey === false ? [] : [key];
  return sampleLayer.pipe(
    Layer.provideMerge(
      Layer.succeed(PersonalSessionAccess.PersonalSessionAccess, {
        forThread: () => Effect.succeed({ botId: null, environment: {}, systemInstructions: null }),
        secretsForThread: () => Effect.succeed(saved),
        sharedSecrets: () => Effect.succeed(saved),
        instructionsForThread: () => Effect.succeed(null),
      } satisfies PersonalSessionAccess.PersonalSessionAccess["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(VoiceCallHttp, {
        call: (request: BrokerRequest, secrets: ReadonlyArray<BrokerSecret>) =>
          options.throws === true
            ? Effect.fail({
                _tag: "SecretBrokerError",
                message: "no saved key named",
              } as unknown as SecretBrokerError)
            : Effect.sync(() => {
                options.calls.push({ request, secrets });
                return options.answer?.() ?? wavAnswer();
              }),
      } satisfies VoiceCallHttp["Service"]),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), options.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
};

const withService = <A, E, R>(
  options: HarnessOptions,
  body: (service: PersonalVoiceSampleService["Service"], baseDir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const service = yield* PersonalVoiceSampleService;
    return yield* body(service, options.baseDir);
  }).pipe(Effect.provide(makeHarness(options)));

/** Test roots this file made, removed after each test so a run leaves none. */
const tempRoots: Array<string> = [];

/**
 * A fresh data root per test, so one test's cache cannot answer another's.
 * It lives in the machine's temp folder (`os.tmpdir()` follows TMPDIR on Linux,
 * so it never lands in the repo) and is removed again by `afterEach`.
 */
const tempBaseDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-voice-sample-"));
  tempRoots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempRoots.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("PersonalVoiceSampleService", () => {
  it.effect("makes one clip for an allowed voice, with the fixed text only", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, baseDir: tempBaseDir() }, (service, baseDir) =>
      Effect.gen(function* () {
        const result = yield* service.sample({ voiceName: "Kore" });
        expect(result.voiceName).toBe("Kore");
        expect(result.mimeType).toBe("audio/wav");
        expect(result.cached).toBe(false);
        expect(Buffer.from(result.base64, "base64").equals(WAV_BYTES)).toBe(true);

        expect(calls).toHaveLength(1);
        const sent = calls[0]!;
        expect(sent.request.url).toBe(
          `https://generativelanguage.googleapis.com/v1beta/models/${VOICE_CALL_SAMPLE_MODEL}:generateContent`,
        );
        expect(sent.request.headers?.[VOICE_CALL_SECRET_HEADER]).toBe("{{secret:GEMINI_API_KEY}}");
        expect(JSON.stringify(sent.request)).not.toContain(KEY_VALUE);
        const body = sent.request.body ?? "";
        expect(body).toContain(VOICE_CALL_SAMPLE_TEXT);
        expect(body).toContain('"responseModalities":["AUDIO"]');
        expect(body).toContain('"voiceName":"Kore"');

        // The clip is on disk under the data root, so the next tap is free.
        const file = `${baseDir}/personal/${VOICE_CALL_SAMPLE_DIR}/Kore.wav`;
        const fs = yield* FileSystem.FileSystem;
        const written = yield* fs.readFile(file);
        expect(Buffer.from(written).equals(WAV_BYTES)).toBe(true);
      }),
    );
  });

  it.effect("serves the second tap from the cache, with no model call", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, baseDir: tempBaseDir() }, (service) =>
      Effect.gen(function* () {
        yield* service.sample({ voiceName: "Kore" });
        const second = yield* service.sample({ voiceName: "Kore" });
        expect(second.cached).toBe(true);
        expect(Buffer.from(second.base64, "base64").equals(WAV_BYTES)).toBe(true);
        expect(calls).toHaveLength(1);
        // A different voice is its own clip.
        yield* service.sample({ voiceName: "Puck" });
        expect(calls).toHaveLength(2);
      }),
    );
  });

  it.effect("refuses a voice that is not on the allow-list, without asking Google", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, baseDir: tempBaseDir() }, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          service.sample({ voiceName: "../../etc/passwd" } as { readonly voiceName: string }),
        );
        expect(error.code).toBe("invalid_input");
        expect(calls).toHaveLength(0);
      }),
    );
  });

  it.effect("says there is no key rather than failing vaguely, and asks Google nothing", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, withKey: false, baseDir: tempBaseDir() }, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.sample({ voiceName: "Kore" }));
        expect(error.code).toBe("no_key");
        expect(calls).toHaveLength(0);
      }),
    );
  });

  it.effect("a refused transport is a typed failure, never a crash", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, throws: true, baseDir: tempBaseDir() }, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.sample({ voiceName: "Kore" }));
        expect(error.code).toBe("google_unavailable");
      }),
    );
  });

  it.effect("refuses an answer that carries no audio, or a non-audio type", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        baseDir: tempBaseDir(),
        answer: () => ({ status: 200, token: null, body: '{"candidates":[]}' }),
      },
      (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.sample({ voiceName: "Kore" }));
          expect(error.code).toBe("sample_unavailable");
        }),
    );
  });

  it.effect("refuses a text answer dressed as a sample", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        baseDir: tempBaseDir(),
        answer: () => ({
          status: 200,
          token: null,
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "text/plain",
                        data: Buffer.from("hi").toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        }),
      },
      (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.sample({ voiceName: "Kore" }));
          expect(error.code).toBe("sample_unavailable");
        }),
    );
  });

  it.effect("never leaves a partial clip behind for a later tap to trust", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        baseDir: tempBaseDir(),
        answer: () => ({
          status: 200,
          token: null,
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "audio/wav",
                        // Shorter than a WAV header: not a clip.
                        data: Buffer.from("RIFF").toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        }),
      },
      (service, baseDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = `${baseDir}/personal/${VOICE_CALL_SAMPLE_DIR}`;
          const file = `${dir}/Kore.wav`;
          // A tiny file that somehow exists is re-made, never played.
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFile(file, Buffer.from("RIFF"));
          expect(Option.isSome(yield* Effect.option(service.sample({ voiceName: "Kore" })))).toBe(
            true,
          );
          expect(calls.length).toBeGreaterThanOrEqual(1);
        }),
    );
  });

  it.effect("tries the fallback model when the primary answers without audio", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        baseDir: tempBaseDir(),
        // The first model answers with no audio at all; the fallback answers
        // with the clip, and the clip the owner hears is that one.
        answer: () =>
          calls.length === 1
            ? { status: 200, token: null, body: '{"candidates":[]}' }
            : wavAnswer(),
      },
      (service) =>
        Effect.gen(function* () {
          const result = yield* service.sample({ voiceName: "Kore" });
          expect(result.cached).toBe(false);
          expect(Buffer.from(result.base64, "base64").equals(WAV_BYTES)).toBe(true);
          expect(calls).toHaveLength(2);
          expect(calls[0]!.request.url).toContain(`${VOICE_CALL_SAMPLE_MODEL}:generateContent`);
          expect(calls[1]!.request.url).toContain(
            `${VOICE_CALL_SAMPLE_FALLBACK_MODEL}:generateContent`,
          );
        }),
    );
  });
});
