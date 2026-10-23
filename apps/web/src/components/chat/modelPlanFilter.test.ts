import { describe, expect, it } from "vite-plus/test";

import { filterModelsByPlan, offersModelPlanFilter, modelPlanOf } from "./modelPlanFilter";

const go = { slug: "opencode-go/deepseek-v4.1-flash", subProvider: "OpenCode Go" };
const payg = { slug: "opencode/deepseek-v4.1-flash", subProvider: "OpenCode" };
const other = { slug: "claude-sonnet-5-5", subProvider: "Anthropic" };

describe("modelPlanFilter", () => {
  it("splits OpenCode 2's catalogue into Go and pay-as-you-go", () => {
    expect(modelPlanOf(go)).toBe("go");
    expect(modelPlanOf(payg)).toBe("payg");
    expect(modelPlanOf({ slug: "opencode-go/glm-5.3" })).toBe("go");
    expect(modelPlanOf({ slug: "opencode/glm-5.3" })).toBe("payg");
    expect(modelPlanOf(other)).toBeNull();
  });

  it("offers the filter only where both plans are listed", () => {
    expect(offersModelPlanFilter([go, payg, other])).toBe(true);
    expect(offersModelPlanFilter([go])).toBe(false);
    expect(offersModelPlanFilter([payg, other])).toBe(false);
    expect(offersModelPlanFilter([other])).toBe(false);
  });

  it("keeps the chosen plan and returns the list untouched for All", () => {
    const models = [go, payg, other];
    expect(filterModelsByPlan(models, "all")).toBe(models);
    expect(filterModelsByPlan(models, "go")).toEqual([go]);
    expect(filterModelsByPlan(models, "payg")).toEqual([payg]);
  });
});
