import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_AUTH_TOKEN_ENV,
  makeDeepSeekCapabilitiesCacheKey,
  makeDeepSeekContinuationGroupKey,
  makeDeepSeekEnvironment,
  resolveDeepSeekHomePath,
} from "./DeepSeekEnvironment.ts";

it.layer(NodeServices.layer)("DeepSeekEnvironment", (it) => {
  describe("endpoint and credential", () => {
    it.effect("fixes the Anthropic-compatible endpoint and keeps the instance token", () =>
      Effect.gen(function* () {
        expect(DEEPSEEK_ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
        const env = yield* makeDeepSeekEnvironment(
          { homePath: "" },
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key", PATH: "/usr/bin" },
        );
        expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
        expect(env[DEEPSEEK_AUTH_TOKEN_ENV]).toBe("fake-deepseek-key");
      }),
    );

    it.effect("drops ambient endpoint/model overrides so they cannot reroute us", () =>
      Effect.gen(function* () {
        const env = yield* makeDeepSeekEnvironment(
          { homePath: "" },
          {
            ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key",
            ANTHROPIC_BASE_URL: "https://evil.example.com",
            ANTHROPIC_MODEL: "claude-opus-5-5",
          },
        );
        expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
        expect(env.ANTHROPIC_MODEL).toBeUndefined();
      }),
    );

    it.effect("strips secret placeholders and unrelated provider tokens", () =>
      Effect.gen(function* () {
        const env = yield* makeDeepSeekEnvironment(
          { homePath: "" },
          {
            ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key",
            PB_SECRET_SOMETHING: "must-not-leak",
            OPENAI_API_KEY: "must-not-leak",
            ANTHROPIC_API_KEY: "must-not-leak",
            CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
            XAI_API_KEY: "must-not-leak",
            PATH: "/usr/bin",
          },
        );
        expect(env.PB_SECRET_SOMETHING).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        expect(env.XAI_API_KEY).toBeUndefined();
        expect(env.PATH).toBe("/usr/bin");
        // Our own credential survives the strip.
        expect(env[DEEPSEEK_AUTH_TOKEN_ENV]).toBe("fake-deepseek-key");
      }),
    );
  });

  describe("isolated home", () => {
    it.effect("defaults to an isolated dir, never the real ~/.claude", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude-t3-deepseek"));
        expect(yield* resolveDeepSeekHomePath({ homePath: "" }, {})).toBe(resolved);
        const env = yield* makeDeepSeekEnvironment({ homePath: "" }, {});
        expect(env.CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(resolved).not.toBe(path.resolve(path.join(NodeOS.homedir(), ".claude")));
      }),
    );

    it.effect("honors an explicit homePath and keys continuation/cache on it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".deepseek-work");
        expect(yield* resolveDeepSeekHomePath({ homePath: "~/.deepseek-work" })).toBe(resolved);
        expect(yield* makeDeepSeekContinuationGroupKey({ homePath: "~/.deepseek-work" })).toBe(
          `deepseek:home:${resolved}`,
        );
        expect(
          yield* makeDeepSeekCapabilitiesCacheKey({
            binaryPath: "claude",
            homePath: "~/.deepseek-work",
          }),
        ).toBe(`claude\0${resolved}\0`);
      }),
    );
  });
});
