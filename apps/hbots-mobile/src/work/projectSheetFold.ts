export interface ProjectSheetFold {
  readonly projectId: string | null;
  readonly showAll: boolean;
  readonly tasksOpen: boolean;
}

export const foldedGoal = (projectId: string | null): ProjectSheetFold => ({
  projectId,
  showAll: false,
  tasksOpen: false,
});

/** Folds belong to one goal. A new goal opens folded, never with the last one's folds. */
export function foldForProject(fold: ProjectSheetFold, projectId: string | null): ProjectSheetFold {
  return fold.projectId === projectId ? fold : foldedGoal(projectId);
}

export type ProjectSheetFoldPart = "showAll" | "tasksOpen";

export function toggledFold(fold: ProjectSheetFold, part: ProjectSheetFoldPart): ProjectSheetFold {
  return { ...fold, [part]: !fold[part] };
}
