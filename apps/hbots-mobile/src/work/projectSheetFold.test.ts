import { describe, expect, it } from "vite-plus/test";

import { foldForProject, foldedGoal, toggledFold, type ProjectSheetFold } from "./projectSheetFold";

const open = (projectId: string | null): ProjectSheetFold => foldedGoal(projectId);

const expandBoth = (fold: ProjectSheetFold): ProjectSheetFold =>
  toggledFold(toggledFold(fold, "showAll"), "tasksOpen");

describe("the goal sheet's folds", () => {
  it("opens a goal with both sections folded", () => {
    const fold = open("goal-a");
    expect(fold.projectId).toBe("goal-a");
    expect(fold.showAll).toBe(false);
    expect(fold.tasksOpen).toBe(false);
  });

  it("keeps the folds while the sheet stays on the same goal", () => {
    const expanded = expandBoth(open("goal-a"));
    expect(foldForProject(expanded, "goal-a")).toBe(expanded);
  });

  it("returns to folded when the sheet opens another goal", () => {
    // Verifier 2: Show all open on "Many steps", then "Clean proof" opened expanded.
    const next = foldForProject(expandBoth(open("goal-a")), "goal-b");
    expect(next.projectId).toBe("goal-b");
    expect(next.showAll).toBe(false);
    expect(next.tasksOpen).toBe(false);
  });

  it("does not remember the first goal's folds when it comes back", () => {
    const expanded = expandBoth(open("goal-a"));
    const other = foldForProject(expanded, "goal-b");
    expect(foldForProject(other, "goal-a").showAll).toBe(false);
  });

  it("folds both sections again when the sheet closes", () => {
    const closed = foldForProject(expandBoth(open("goal-a")), null);
    expect(closed.projectId).toBeNull();
    expect(closed.showAll).toBe(false);
    expect(closed.tasksOpen).toBe(false);
  });

  it("toggles one section without touching the other", () => {
    const shown = toggledFold(open("goal-a"), "showAll");
    expect(shown).toMatchObject({ showAll: true, tasksOpen: false });
    expect(toggledFold(shown, "showAll")).toMatchObject({ showAll: false, tasksOpen: false });
    expect(toggledFold(shown, "tasksOpen")).toMatchObject({ showAll: true, tasksOpen: true });
  });
});
