import { createFileRoute } from "@tanstack/react-router";

import { parseTaskListFilter, type TaskListFilter } from "~/features/personal/taskPresentation";
import { TasksScreen } from "~/features/personal/TasksScreen";

interface TasksSearch {
  readonly view?: TaskListFilter;
}

function TasksRouteView() {
  const { view } = Route.useSearch();
  return <TasksScreen view={parseTaskListFilter(view)} />;
}

export const Route = createFileRoute("/_personal/tasks")({
  // Optional, so the tab bar can link to /tasks without a search param.
  validateSearch: (raw: Record<string, unknown>): TasksSearch =>
    raw.view === "waiting" || raw.view === "scheduled" || raw.view === "completed"
      ? { view: raw.view }
      : {},
  component: TasksRouteView,
});
