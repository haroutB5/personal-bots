import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import golden from "./personalV1Wire.golden.json" with { type: "json" };
import {
  ModelSelection,
  OrchestrationMessageRole,
  OrchestrationThreadShell,
  ThreadTurnFollowUp,
} from "./personalV1Wire.ts";

const goldenSchemas = golden as Record<string, unknown>;

const jsonSchema = (schema: Schema.Top): unknown => {
  const document = Schema.toJsonSchemaDocument(schema);
  return { schema: document.schema, definitions: document.definitions };
};

describe("personalV1Wire", () => {
  // The golden file is the recorded wire shape: the v1 original plus the fields added on
  // purpose since (`usageLimit` on the session). Regenerate it in the change that adds one.
  it("encodes every vendored schema exactly as the recorded wire shape", () => {
    const pairs = [
      ["ModelSelection", ModelSelection],
      ["OrchestrationMessageRole", OrchestrationMessageRole],
      ["OrchestrationThreadShell", OrchestrationThreadShell],
      ["ThreadTurnFollowUp", ThreadTurnFollowUp],
    ] as const;

    for (const [name, vendored] of pairs) {
      expect(jsonSchema(vendored), name).toEqual(goldenSchemas[name]);
    }
  });
});
