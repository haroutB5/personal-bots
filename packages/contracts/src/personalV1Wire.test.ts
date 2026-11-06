import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ModelSelection as V1ModelSelection,
  OrchestrationMessageRole as V1OrchestrationMessageRole,
  OrchestrationThreadShell as V1OrchestrationThreadShell,
  ThreadTurnFollowUp as V1ThreadTurnFollowUp,
} from "./orchestration.ts";
import {
  ModelSelection,
  OrchestrationMessageRole,
  OrchestrationThreadShell,
  ThreadTurnFollowUp,
} from "./personalV1Wire.ts";

const jsonSchema = (schema: Schema.Top): unknown => {
  const document = Schema.toJsonSchemaDocument(schema);
  return { schema: document.schema, definitions: document.definitions };
};

describe("personalV1Wire", () => {
  it("encodes every vendored schema exactly as the v1 original does", () => {
    const pairs = [
      ["ModelSelection", ModelSelection, V1ModelSelection],
      ["OrchestrationMessageRole", OrchestrationMessageRole, V1OrchestrationMessageRole],
      ["OrchestrationThreadShell", OrchestrationThreadShell, V1OrchestrationThreadShell],
      ["ThreadTurnFollowUp", ThreadTurnFollowUp, V1ThreadTurnFollowUp],
    ] as const;

    for (const [name, vendored, original] of pairs) {
      expect(jsonSchema(vendored), name).toEqual(jsonSchema(original));
    }
  });
});
