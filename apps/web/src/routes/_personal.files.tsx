import { createFileRoute } from "@tanstack/react-router";

import { FilesScreen } from "~/features/personal/FilesScreen";

export const Route = createFileRoute("/_personal/files")({
  component: FilesScreen,
});
