import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { buildAntigravityModelsFromSession } from "../../provider/Layers/AntigravityProvider.ts";
import { resolveLeadModelSelection } from "./leadBotModel.ts";

describe("Gemini effort in create_bot and update_bot model resolution", () => {
  const instanceId = ProviderInstanceId.make("antigravity");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: "1.4.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-20T12:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: buildAntigravityModelsFromSession({
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "gemini-4-argon",
          options: ["gemini-4-argon", "gemini-3.8-flash"].map((value) => ({ value, name: value })),
        },
        {
          id: "thinking_level",
          name: "Thinking Level",
          type: "select",
          currentValue: "high",
          options: ["low", "medium", "high"].map((value) => ({ value, name: value })),
        },
      ],
    }),
  };

  it.each([true, false])(
    "accepts all three efforts on both native families (create=%s)",
    (seedFallback) => {
      for (const model of ["gemini-4-argon", "gemini-3.8-flash"]) {
        for (const effort of ["low", "medium", "high"]) {
          const result = resolveLeadModelSelection({
            providers: [provider],
            seedFallback,
            base: { instanceId, model },
            request: { provider: instanceId, model, effort },
          });
          expect(result.ok).toBe(true);
          if (result.ok)
            expect(result.selection).toMatchObject({
              instanceId,
              model,
              options: [{ id: "effort", value: effort }],
            });
        }
      }
    },
  );
});
