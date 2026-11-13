import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as CodexSchema from "effect-codex-app-server/schema";

import {
  applyPreferredCodexDefaultModel,
  logCodexSkillsListErrors,
  codexCustomEndpoint,
  codexRoutesSpendNativeQuota,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
    {
      id: "cyberAccessProgram",
      label: "Cyber Access",
      type: "select",
      options: [
        { id: "standard", label: "Standard", isDefault: true },
        { id: "daybreakBlue", label: "Daybreak Blue" },
      ],
      currentValue: "standard",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

const decodeSkillsListResponse = Schema.decodeUnknownSync(CodexSchema.V2SkillsListResponse);

it.effect("warns once for each skill Codex refused in `skills/list`", () => {
  const lines: Array<Record<string, unknown>> = [];
  const sink = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel !== "Warn") return;
    const [text, fields] = Array.isArray(message) ? message : [message, {}];
    lines.push({ text: String(text), ...((fields ?? {}) as Record<string, unknown>) });
  });
  const response = decodeSkillsListResponse({
    data: [
      {
        cwd: "/work",
        errors: [
          {
            path: "/work/.agents/skills/bom/SKILL.md",
            message: "missing YAML frontmatter delimited by ---",
          },
        ],
        skills: [],
      },
      { cwd: "/other", errors: [], skills: [] },
    ],
  });

  return logCodexSkillsListErrors(response).pipe(
    Effect.map(() => {
      assert.deepStrictEqual(lines, [
        {
          text: "Codex skill failed to load",
          cwd: "/work",
          path: "/work/.agents/skills/bom/SKILL.md",
          reason: "missing YAML frontmatter delimited by ---",
        },
      ]);
    }),
    Effect.provide(Logger.layer([sink], { mergeWithExisting: false })),
  );
});

it("reports native quota only for an OpenAI login on a native route", () => {
  const chatgpt = { type: "chatgpt", email: "a@example.com", planType: "pro" } as const;
  const hub = {
    model_provider: "hub",
    model_providers: { hub: { base_url: "https://hub.example.com/v1" } },
  };
  const cases = [
    ["default route", chatgpt, true, {}, true],
    ["openai base url", chatgpt, true, { openai_base_url: "https://chatgpt.com/x" }, true],
    ["openai proxy url", chatgpt, true, { openai_base_url: "https://proxy.example.com" }, false],
    ["custom provider", chatgpt, true, hub, false],
    ["unknown provider id", chatgpt, true, { model_provider: "missing" }, false],
    ["unreadable config", chatgpt, true, null, false],
    ["login not required", chatgpt, false, {}, false],
    ["api key", { type: "apiKey" }, true, {}, false],
  ] as const;
  for (const [name, account, requiresOpenaiAuth, config, expected] of cases) {
    assert.strictEqual(
      codexRoutesSpendNativeQuota({ account, requiresOpenaiAuth }, config),
      expected,
      name,
    );
  }
  // The custom endpoint is what a usage-limit hub is matched against.
  assert.strictEqual(codexCustomEndpoint(hub), "https://hub.example.com");
  assert.strictEqual(
    codexCustomEndpoint({ openai_base_url: "http://127.0.0.1:8317/v1" }),
    "http://127.0.0.1:8317",
  );
  assert.strictEqual(codexCustomEndpoint({ openai_base_url: "https://chatgpt.com/x" }), undefined);
  assert.strictEqual(codexCustomEndpoint({}), undefined);
});
