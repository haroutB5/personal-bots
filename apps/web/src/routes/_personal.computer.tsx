import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ComputerScreen } from "~/features/personal/computer/ComputerScreen";

function ComputerRouteView() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ComputerScreen onBackToChat={() => void navigate({ to: "/bots" })} />
    </div>
  );
}

export const Route = createFileRoute("/_personal/computer")({
  component: ComputerRouteView,
});
