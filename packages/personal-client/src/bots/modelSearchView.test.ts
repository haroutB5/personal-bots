import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelSearchView } from "./modelSearchView.ts";

const modelOf = (slug: string, name: string, subProvider?: string) =>
  ({
    slug,
    name,
    isCustom: false,
    ...(subProvider === undefined ? {} : { subProvider }),
  }) as ServerProvider["models"][number];

const models: ServerProvider["models"] = [
  modelOf("opencode-go/glm-5.3", "GLM 5.3", "OpenCode Go"),
  modelOf("opencode/glm-5.3", "GLM 5.3", "OpenCode"),
  modelOf("opencode/qwen-4", "Qwen 4", "OpenCode"),
];

describe("modelSearchView", () => {
  it("shows nothing until the field is open", () => {
    const view = modelSearchView({ models, value: "", query: "", open: false, planFilter: "all" });
    expect(view.results).toEqual([]);
    expect(view.placeholder).toBe("Search models");
    expect(view.summary).toBe("3 models. Pick one, or type to narrow the list.");
  });

  it("lists every model when browsing and names the selected one", () => {
    const view = modelSearchView({
      models,
      value: "opencode/qwen-4",
      query: "",
      open: true,
      planFilter: "all",
    });
    expect(view.results).toHaveLength(3);
    expect(view.summary).toBe("Selected: Qwen 4 · OpenCode");
    expect(view.showPlanFilter).toBe(true);
  });

  it("narrows by the plan chip", () => {
    const view = modelSearchView({ models, value: "", query: "", open: true, planFilter: "go" });
    expect(view.results.map((model) => model.slug)).toEqual(["opencode-go/glm-5.3"]);
  });

  it("counts matches and reports a miss", () => {
    const hit = modelSearchView({ models, value: "", query: "glm", open: true, planFilter: "all" });
    expect(hit.summary).toBe("2 matching");
    const miss = modelSearchView({
      models,
      value: "",
      query: "zzz",
      open: true,
      planFilter: "all",
    });
    expect(miss.summary).toBe('No models match "zzz".');
  });
});
