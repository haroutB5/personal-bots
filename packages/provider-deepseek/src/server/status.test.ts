import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderCatalog } from "@t3tools/provider-core/server/ModelCatalog";

import { resolveDeepSeekModelCatalog } from "./catalog.ts";
import { DeepSeekSettings } from "../settings.ts";
import {
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
  DEEPSEEK_KEY_MISSING_MESSAGE,
} from "./status.ts";

const decode = Schema.decodeUnknownSync(DeepSeekSettings);

const catalog: ProviderCatalog = {
  defaultChatModel: "deepseek-flash",
  models: [
    {
      slug: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      aliases: ["deepseek-v4-flash", "vision-exp"],
      status: "current",
      capabilities: { optionDescriptors: [] },
      adapter: {},
      profileAdapter: {},
    },
  ],
};

const deepSeekCatalog = resolveDeepSeekModelCatalog(catalog);

it.layer(NodeServices.layer)("DeepSeekProvider", (it) => {
  it.effect("reports a disabled instance as disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(
        decode({ enabled: false }),
        deepSeekCatalog,
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek-flash"]);
    }),
  );

  it.effect("asks for the key field when enabled and no key is set", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDeepSeekProviderStatus(
        decode({ enabled: true, engine: "dsh" }),
        {},
        deepSeekCatalog,
      );
      expect({
        auth: snapshot.auth.status,
        installed: snapshot.installed,
        status: snapshot.status,
        message: snapshot.message,
      }).toEqual({
        auth: "unauthenticated",
        installed: true,
        status: "warning",
        message: DEEPSEEK_KEY_MISSING_MESSAGE,
      });
      expect(snapshot.message).not.toMatch(/ANTHROPIC_AUTH_TOKEN/);
    }),
  );

  it.effect("offers the agent mode on the harness engine and not on the other", () =>
    Effect.gen(function* () {
      const dsh = yield* checkDeepSeekProviderStatus(
        decode({ enabled: true, engine: "dsh" }),
        { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
        deepSeekCatalog,
      );
      const flash = dsh.models.find((model) => model.slug === "deepseek-flash");
      const agentMode = flash?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agentMode",
      );
      expect(agentMode?.type).toBe("select");
      expect(
        agentMode?.type === "select" ? agentMode.options.map((option) => option.id) : [],
      ).toEqual(["standard", "code", "minimal"]);

      const claude = yield* checkDeepSeekProviderStatus(
        decode({ enabled: true, engine: "claude-code" }),
        { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
        deepSeekCatalog,
      );
      const claudeFlash = claude.models.find((model) => model.slug === "deepseek-flash");
      expect(
        claudeFlash?.capabilities?.optionDescriptors?.some(
          (descriptor) => descriptor.id === "agentMode",
        ),
      ).toBe(false);
    }),
  );
});
