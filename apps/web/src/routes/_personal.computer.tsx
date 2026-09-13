import { createFileRoute } from "@tanstack/react-router";
import { Laptop } from "lucide-react";

import { PersonalEmptyTab } from "~/features/personal/PersonalEmptyTab";

function ComputerRouteView() {
  return (
    <PersonalEmptyTab
      title="Computer"
      heading="No browser connected yet"
      description="When a bot uses a browser on your computer, you can watch and take control here."
      icon={Laptop}
    />
  );
}

export const Route = createFileRoute("/_personal/computer")({
  component: ComputerRouteView,
});
