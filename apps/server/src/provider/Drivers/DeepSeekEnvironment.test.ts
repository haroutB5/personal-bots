import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_AUTH_TOKEN_ENV,
  DEEPSEEK_AUTO_COMPACT_WINDOW,
  DEEPSEEK_FLASH_1M_MODEL,
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
          { engine: "dsh", homePath: "" },
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key", PATH: "/usr/bin" },
        );
        expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
        expect(env[DEEPSEEK_AUTH_TOKEN_ENV]).toBe("fake-deepseek-key");
      }),
    );

    it.effect("replaces ambient endpoint and model overrides so they cannot reroute us", () =>
      Effect.gen(function* () {
        const env = yield* makeDeepSeekEnvironment(
          { engine: "dsh", homePath: "" },
          {
            ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key",
            ANTHROPIC_BASE_URL: "https://evil.example.com",
            ANTHROPIC_MODEL: "claude-opus-5-5",
          },
        );
        expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
        expect(env.ANTHROPIC_MODEL).toBe(DEEPSEEK_FLASH_1M_MODEL);
      }),
    );

    it.effect("pins every model alias and the compact window, overriding ambient values", () =>
      Effect.gen(function* () {
        // The Claude runtime resolves alias-named internal calls (subagents,
        // background jobs) through these variables, and DeepSeek's endpoint
        // bills an unresolved claude-opus id as Pro (about 4.4x Flash). The
        // DeepSeek Claude Code guide pins every one; ambient machine values
        // must not survive.
        const env = yield* makeDeepSeekEnvironment(
          { engine: "dsh", homePath: "" },
          {
            ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5",
            CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5-5",
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
            // Legacy names whose roles the pins above already carry.
            ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
            ANTHROPIC_DEFAULT_MODEL: "claude-opus-5-5",
          },
        );
        expect(env.ANTHROPIC_MODEL).toBe("deepseek-flash[1m]");
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-flash[1m]");
        expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-flash[1m]");
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-flash");
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-flash");
        expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("786432");
        expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(DEEPSEEK_AUTO_COMPACT_WINDOW);
        expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
        expect(env.ANTHROPIC_DEFAULT_MODEL).toBeUndefined();
      }),
    );

    it.effect("still pins the model environment when the base env is empty", () =>
      Effect.gen(function* () {
        const env = yield* makeDeepSeekEnvironment({ engine: "dsh", homePath: "" }, {});
        expect(env.ANTHROPIC_MODEL).toBe("deepseek-flash[1m]");
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-flash");
      }),
    );

    it.effect("quiets the Claude CLI's own background traffic on the Claude engine", () =>
      Effect.gen(function* () {
        // The CLI opens api.anthropic.com (tunnelled, so unreadable) even with
        // DeepSeek as the model endpoint. Nothing on this engine needs that
        // host, so both documented switches are set.
        const env = yield* makeDeepSeekEnvironment(
          { engine: "claude-code", homePath: "" },
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
        );
        expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
        expect(env.DISABLE_TELEMETRY).toBe("1");
      }),
    );

    it.effect("the harness engine gets no Claude CLI switches", () =>
      Effect.gen(function* () {
        const env = yield* makeDeepSeekEnvironment(
          { engine: "dsh", homePath: "" },
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
        );
        expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
        expect(env.DISABLE_TELEMETRY).toBeUndefined();
      }),
    );

    it.effect("the kill switch quiets the CLI too, because the CLI is what runs", () =>
      Effect.gen(function* () {
        const env = yield* makeDeepSeekEnvironment(
          { engine: "dsh", homePath: "" },
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key", PERSONAL_DEEPSEEK_ENGINE: "claude-code" },
        );
        expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
        expect(env.DISABLE_TELEMETRY).toBe("1");
      }),
    );

    it.effect("treats a mixed-case spelling as the same name, for the pins and for PATH", () =>
      Effect.gen(function* () {
        // Windows resolves environment names case-insensitively, so these are
        // the same variables as the pinned ones whatever the block holds. A
        // surviving mixed-case spelling would sit beside the pinned value and
        // leave which one wins to the OS.
        const env = yield* makeDeepSeekEnvironment(
          { engine: "claude-code", homePath: "" },
          {
            ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key",
            anthropic_base_url: "https://evil.example.com",
            anthropic_model: "claude-opus-5-5",
            anthropic_default_model: "claude-opus-5-5",
            Path: "C:\\first",
            PATH: "C:\\last",
          },
        );
        const spellingsOf = (name: string) =>
          Object.keys(env).filter((key) => key.toLowerCase() === name);

        expect(spellingsOf("anthropic_base_url")).toEqual(["ANTHROPIC_BASE_URL"]);
        expect(env.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
        expect(spellingsOf("anthropic_model")).toEqual(["ANTHROPIC_MODEL"]);
        expect(env.ANTHROPIC_MODEL).toBe(DEEPSEEK_FLASH_1M_MODEL);
        expect(spellingsOf("anthropic_default_model")).toEqual([]);
        // One entry per name, keeping the first spelling and the last value,
        // exactly as the harness engine builds its own child environment.
        expect(spellingsOf("path")).toEqual(["Path"]);
        expect(env.Path).toBe("C:\\last");
      }),
    );

    it.effect("strips secret placeholders and unrelated provider tokens", () =>
      Effect.gen(function* () {
        const env = yield* makeDeepSeekEnvironment(
          { engine: "dsh", homePath: "" },
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
        const env = yield* makeDeepSeekEnvironment({ engine: "dsh", homePath: "" }, {});
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
