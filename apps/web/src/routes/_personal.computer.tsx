import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ComputerScreen } from "~/features/personal/computer/ComputerScreen";
import {
  computerSearchOrigin,
  parseComputerSearch,
} from "~/features/personal/computer/computerModel";

function ComputerRouteView() {
  const navigate = useNavigate();
  const origin = computerSearchOrigin(Route.useSearch());
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ComputerScreen
        origin={origin}
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
  // Optional, so the tab bar can link to a bare /computer with no origin.
  validateSearch: parseComputerSearch,
  component: ComputerRouteView,
});
