import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ComputerScreen } from "~/features/personal/computer/ComputerScreen";

function ComputerRouteView() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ComputerScreen
        onBackToChat={(target) =>
          void (target === null
            ? navigate({ to: "/bots" })
            : navigate({ to: "/bots/$botId/$threadId", params: target }))
        }
      />
    </div>
  );
}

export const Route = createFileRoute("/_personal/computer")({
  component: ComputerRouteView,
});
