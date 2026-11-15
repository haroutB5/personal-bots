import { describe, expect, it } from "vite-plus/test";

import { projectResultNudge } from "./projectText.ts";

describe("projectResultNudge", () => {
  it("asks for why when the goal has none", () => {
    expect(projectResultNudge({ name: "Kino", why: null })).toBe(
      "Project Kino: update its steps and estimate with update_project.\nAdd why it matters with update_project: one plain line.",
    );
  });

  it("asks once the goal has why", () => {
    expect(projectResultNudge({ name: "Kino", why: "Harout cannot keep up" })).toBe(
      "Project Kino: update its steps and estimate with update_project.",
    );
  });

  it("treats an old server's missing why and an empty why as none", () => {
    expect(projectResultNudge({ name: "Kino" })).toContain("Add why it matters");
    expect(projectResultNudge({ name: "Kino", why: "   " })).toContain("Add why it matters");
  });
});
