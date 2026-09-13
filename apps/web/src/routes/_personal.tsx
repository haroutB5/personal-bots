import { createFileRoute, redirect } from "@tanstack/react-router";

import { PersonalShell } from "~/features/personal/PersonalShell";

export const Route = createFileRoute("/_personal")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PersonalShell,
});
