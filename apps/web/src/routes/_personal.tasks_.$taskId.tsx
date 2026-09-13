import { PersonalTaskId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { TaskDetailScreen } from "~/features/personal/TaskDetailScreen";

function TaskDetailRouteView() {
  const { taskId } = Route.useParams();
  return <TaskDetailScreen key={taskId} taskId={PersonalTaskId.make(taskId)} />;
}

export const Route = createFileRoute("/_personal/tasks_/$taskId")({
  component: TaskDetailRouteView,
});
