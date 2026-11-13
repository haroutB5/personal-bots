import { createFileRoute, redirect } from "@tanstack/react-router";

// Work lives inside Tasks now. Old links and saved tabs still land on it.
export const Route = createFileRoute("/_personal/work")({
  beforeLoad: () => {
    throw redirect({ to: "/tasks", search: {}, replace: true });
  },
});
